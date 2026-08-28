import pg from 'pg';
import { config } from './config.ts';

/**
 * Postgres returns bigint as a string by default to avoid precision loss.
 * Our bigints are identity columns well inside Number.MAX_SAFE_INTEGER, and
 * having them arrive as numbers keeps the calling code simple.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

/**
 * Pool size, sized against the burst rather than the steady state.
 *
 * Steady state was never the problem: 3,000 devices reporting every 30 seconds
 * is about 36 inserts a second. The number to size against is a gateway restart
 * with the whole fleet reconnecting and replaying its buffered positions, which
 * is roughly 5,000 frames a second — fifty times the steady peak, and not an
 * exotic event, since it is what Restart=always produces after any crash.
 *
 * Different defaults per process because they do different work: the gateway
 * absorbs ingest, the API serves a handful of operators. Both env-tunable,
 * because the right number depends on the box and finding it out should not
 * need a release.
 *
 * Postgres's own max_connections is the real ceiling — gateway + API + psql
 * sessions must all fit inside it.
 */
const isGateway = process.argv[1]?.includes('gateway') ?? false;
const poolMax = Number(process.env.DB_POOL_MAX ?? (isGateway ? 25 : 15));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  /**
   * Fail rather than queue forever when the pool is exhausted. Without this a
   * request waits indefinitely for a connection and the caller has no way to
   * tell that from a slow query — the queue is invisible, which is exactly what
   * made pool saturation hard to see.
   */
  connectionTimeoutMillis: 5_000,
  /**
   * Names this process in pg_stat_activity. When the database is the thing
   * that is struggling, "which of my processes is doing this" is the first
   * question, and without this every row just says "node".
   */
  application_name: isGateway ? 'zee-gateway' : 'zee-api',
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export type Db = pg.Pool | pg.PoolClient;

/**
 * A supervised LISTEN/NOTIFY connection.
 *
 * `connected` is what /api/health reports. It is the listener's own view, kept
 * honest by the heartbeat below rather than by waiting for an 'error' event
 * that may never arrive.
 */
export interface Listener {
  readonly connected: boolean;
  /** Stop supervising and close. */
  close(): Promise<void>;
}

export interface ListenerOptions {
  /**
   * Called after a reconnect, once LISTEN is back in place. Everything that
   * happened while the connection was down was missed, so this is where the
   * caller catches up — an immediate sweep in the gateway, a resync nudge to
   * the browsers in the API.
   */
  onReconnect?: () => void;
  /** Seam for tests. Defaults to a real client. */
  createClient?: () => pg.Client;
}

const LISTENER_HEARTBEAT_MS = 30_000;
const LISTENER_BACKOFF_MAX_MS = 30_000;

/**
 * Dedicated long-lived connection for LISTEN/NOTIFY, kept out of the pool, and
 * supervised.
 *
 * Unsupervised, this was a single point of silent failure: if the connection
 * dropped, command dispatch degraded to the 60-second sweep permanently, and
 * the only trace was one console.error nobody was watching. An operator's
 * unlock would take up to a minute to reach a truck instead of going out at
 * once, with nothing anywhere saying why.
 *
 * The failure that matters is not the one that raises 'error'. It is a
 * half-open TCP connection — the far side gone, no FIN, no RST — where the
 * socket stays open forever and simply never delivers another notification. No
 * event fires for that, ever. Only sending something detects it, which is what
 * the heartbeat is for.
 */
export async function createListener(
  channel: string,
  onNotify: (payload: string) => void,
  options: ListenerOptions = {},
): Promise<Listener> {
  const makeClient = options.createClient ?? (() => new pg.Client({ connectionString: config.databaseUrl }));

  let client: pg.Client | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let backoffMs = 500;
  let connected = false;
  let closed = false;
  let reconnecting = false;

  async function connect(isReconnect: boolean): Promise<void> {
    const next = makeClient();
    // Attached before connect: a client that fails during the handshake still
    // emits, and an unhandled 'error' on a pg.Client takes the process down.
    next.on('error', (err) => {
      console.error(`[db] listener ${channel} error`, (err as Error).message);
      scheduleReconnect();
    });
    next.on('end', () => scheduleReconnect());
    next.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) onNotify(msg.payload);
    });

    await next.connect();
    // The channel name is a compile-time constant from this codebase, never
    // user input, so interpolation is safe here — LISTEN takes no parameters.
    await next.query(`LISTEN ${channel}`);

    client = next;
    connected = true;
    backoffMs = 500;

    if (isReconnect) {
      console.log(`[db] listener ${channel} reconnected`);
      // Notifications sent while we were away are gone: NOTIFY has no replay.
      // The caller has to assume it missed something.
      options.onReconnect?.();
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnecting) return;
    reconnecting = true;
    connected = false;

    const old = client;
    client = null;
    // The old client is finished with; ignore whatever it throws on the way out.
    void old?.end().catch(() => {});

    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, LISTENER_BACKOFF_MAX_MS);
    console.warn(`[db] listener ${channel} down; reconnecting in ${wait}ms`);

    setTimeout(() => {
      reconnecting = false;
      if (closed) return;
      connect(true).catch(() => scheduleReconnect());
    }, wait).unref();
  }

  await connect(false);

  // The only thing that detects a half-open connection. A failed round trip
  // here is the signal; there is no event for it.
  heartbeat = setInterval(() => {
    const c = client;
    if (!c || closed) return;
    c.query('SELECT 1').catch(() => scheduleReconnect());
  }, LISTENER_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    get connected(): boolean {
      return connected;
    },
    async close(): Promise<void> {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await client?.end().catch(() => {});
      client = null;
      connected = false;
    },
  };
}

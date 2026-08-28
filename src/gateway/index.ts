/**
 * Device TCP gateway.
 *
 * Listens on a bare port for JT701D/E locks. This is deliberately NOT behind
 * Nginx: the devices speak a binary/ASCII protocol over raw TCP with no HTTP
 * involved anywhere, so a reverse proxy has nothing to contribute.
 */

import net from 'node:net';
import os from 'node:os';
import { config } from '../config.ts';
import { createListener, pool, type Listener } from '../db.ts';
import { DeviceSession } from './session.ts';
import {
  admitDevice,
  clearAllConnections,
  dueCommandDeviceIds,
  expireLapsedCommands,
  requeueUnansweredCommands,
  reportGatewayHealth,
  setConnected,
} from './store.ts';
import { evaluationPeriod } from '../evaluation.ts';

/**
 * What this process publishes to gateway_health, for /api/health to read back.
 * Named by hostname so a restart updates its own row rather than accumulating
 * one per boot.
 */
const instance = process.env.GATEWAY_INSTANCE ?? os.hostname();
const startedAt = new Date();
/**
 * The supervised NOTIFY listener, once main() has built it.
 *
 * Read through rather than mirrored into a boolean: the listener's own view is
 * the one kept honest by its heartbeat, and a copy here would go stale exactly
 * when it mattered — the failure this supervises is a half-open connection that
 * emits no event at all.
 */
let listener: Listener | null = null;
let lastSweepMs: number | null = null;
let lastSweepAt: Date | null = null;

/**
 * Live sockets by device ID. In-memory is correct at single-instance scale;
 * running multiple gateway processes would need a shared registry so the API
 * can route a command to whichever instance holds the socket.
 */
const sessions = new Map<string, DeviceSession>();

/**
 * Write this process's state to gateway_health. Never allowed to throw: a
 * health report failing is not a reason to take the gateway down, and the
 * staleness of the row is itself the signal that something is wrong.
 */
async function publishHealth(): Promise<void> {
  try {
    await reportGatewayHealth({
      instance,
      startedAt,
      sessions: sessions.size,
      listenerConnected: listener?.connected ?? false,
      lastSweepMs,
      lastSweepAt,
    });
  } catch (err) {
    console.error('[gateway] health report failed', (err as Error).message);
  }
}

/*
 * Connection-state writes, serialised per device.
 *
 * INVARIANT: only this file writes device_state.is_connected. Nothing in the
 * session and nothing in the ingest path may touch it.
 *
 * It had three writers, and they disagreed. A session set it true on identify;
 * a closing session set it false without knowing whether it was still the
 * registered one; and updateDeviceState asserted true on every position frame.
 * A device reconnecting before the old socket's FIN arrived — routine on
 * cellular — could therefore end up recorded as offline while connected, which
 * makes an operator think an unlock will not be delivered when it will be.
 *
 * The registry is the only thing that knows which socket currently owns a
 * device, so it is the only thing entitled to say whether that device is
 * connected. The queue keeps two writes for the same device in the order the
 * registry decided them, rather than the order two round trips happen to
 * finish in.
 */
const stateWrites = new Map<string, Promise<void>>();

function queueStateWrite(deviceId: string, connected: boolean): void {
  const next = (stateWrites.get(deviceId) ?? Promise.resolve())
    .then(() => setConnected(deviceId, connected))
    .catch((err) => {
      console.error(`[gateway] ${deviceId} connection-state write failed`, (err as Error).message);
    });
  stateWrites.set(deviceId, next);
  void next.finally(() => {
    if (stateWrites.get(deviceId) === next) stateWrites.delete(deviceId);
  });
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);

  new DeviceSession(socket, {
    async onIdentified(deviceId, session) {
      // One round trip: the allowlist check and the connected flag are the same
      // statement. This is the only write to is_connected on the connect path.
      const allowlisted = await admitDevice(deviceId).catch((err) => {
        console.error(`[gateway] ${deviceId} admission failed`, (err as Error).message);
        return false;
      });

      // A device the allowlist refuses is never registered. With the allowlist
      // disabled it is registered anyway — that mode is what makes the
      // simulator usable, and it is off everywhere real.
      if (!allowlisted && config.requireKnownDevice) return false;

      // A device reconnecting before the old socket's FIN arrives is routine
      // on cellular. Newest socket wins; drop the stale one.
      //
      // Destroyed BEFORE the registry is updated, so the old session's close
      // handler finds the registry already pointing elsewhere and takes itself
      // out of the running rather than clearing the new session's state.
      const existing = sessions.get(deviceId);
      if (existing && existing !== session) {
        existing.log('superseded by a new connection');
        existing.socket.destroy();
      }
      sessions.set(deviceId, session);
      return allowlisted;
    },
    onClosed(deviceId, session) {
      // Inside the guard: a superseded session must not mark the device
      // offline, because a newer socket for it is open right now.
      if (!deviceId || sessions.get(deviceId) !== session) return;
      sessions.delete(deviceId);
      queueStateWrite(deviceId, false);
    },
  });
});

/**
 * The periodic sweep, and the only thing allowed to run it.
 *
 * `sweeping` is an overlap guard. Without one, a sweep that takes longer than
 * its interval starts again on top of itself, and each copy competes for the
 * same connection pool — so the slower it gets, the more copies there are.
 * A missed tick is nothing; the next one picks the work up.
 */
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) {
    console.warn('[gateway] sweep still running; skipping this tick');
    return;
  }
  sweeping = true;
  const started = Date.now();

  try {
    // Fleet-wide, not per device. The per-drain expiry inside
    // claimPendingCommands only ever reaches a truck that is connected, so a
    // lapsed unlock on a sleeping one kept reading 'queued' to the operator
    // indefinitely — a pending unlock that was never going to fire, with
    // nothing saying so.
    const expired = await expireLapsedCommands().catch(() => 0);
    if (expired > 0) console.log(`[gateway] expired ${expired} lapsed command(s)`);

    // A command written into a dying socket is lost with no error. Put
    // unanswered ones back in the queue before draining, so the retry goes out
    // on this pass rather than the next.
    const requeued = await requeueUnansweredCommands().catch(() => 0);
    if (requeued > 0) console.log(`[gateway] re-queued ${requeued} unanswered command(s)`);

    /*
     * Drain only the sessions that actually have work.
     *
     * This used to await drainCommands for every live session in turn: at 3,000
     * devices that is ~6,000 statements a minute, almost all of them finding an
     * empty queue, run one after another. One fleet query replaces the
     * discovery, and the drains that remain run a few at a time.
     *
     * Bounded rather than unbounded: Promise.all over 3,000 sessions would ask
     * for 3,000 connections from a pool of 25 and simply queue them all inside
     * pg, where nothing can see the backlog.
     */
    const due = await dueCommandDeviceIds().catch(() => [] as string[]);
    const toDrain = due
      .map((id) => sessions.get(id))
      .filter((s): s is DeviceSession => s !== undefined);

    await forEachBounded(toDrain, SWEEP_CONCURRENCY, async (session) => {
      await session.drainCommands().catch((err) => {
        console.error(`[gateway] drain failed for ${session.deviceId ?? '?'}`, (err as Error).message);
      });
    });

    if (toDrain.length > 0) {
      console.log(`[gateway] swept ${toDrain.length} of ${due.length} device(s) with work due`);
    }
  } finally {
    lastSweepMs = Date.now() - started;
    lastSweepAt = new Date();
    sweeping = false;
    await publishHealth();
  }
}

/** How many device drains may be in flight at once. Sized against the pool. */
const SWEEP_CONCURRENCY = 10;

/** Run `fn` over `items`, at most `limit` at a time, in no particular order. */
async function forEachBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * Whether the listen socket is up yet. Splits the two very different things
 * `server.on('error')` reports.
 */
let listening = false;

server.on('listening', () => {
  listening = true;
});

/*
 * A server error used to call process.exit(1) unconditionally, under
 * Restart=always.
 *
 * Before listening, that is right: EADDRINUSE or EACCES means this process
 * cannot do its job at all, and failing loudly is better than sitting there
 * deaf.
 *
 * After listening it is a serious mistake. An accept-time error — EMFILE when
 * the file-descriptor limit is reached, ECONNABORTED when a device hangs up
 * mid-handshake — is transient and affects one connection. Exiting on one turns
 * it into a crash loop, and every restart runs a 3,000-row clearAllConnections
 * and then invites the entire fleet to reconnect at once. That reconnect
 * stampede is the exact load this phase is sized against, and the gateway was
 * generating it for itself out of a single dropped connection.
 */
server.on('error', (err) => {
  if (!listening) {
    console.error('[gateway] could not start listening', err);
    process.exit(1);
  }
  console.error('[gateway] accept error (continuing)', (err as Error).message);
});

async function main(): Promise<void> {
  await pool.query('SELECT 1');
  console.log('[gateway] database connection ok');

  // No sockets exist yet, so any surviving "connected" flag is stale.
  const cleared = await clearAllConnections();
  if (cleared > 0) console.log(`[gateway] cleared ${cleared} stale connection flag(s)`);

  // Dispatch the instant a command is queued, instead of polling.
  listener = await createListener(
    'command_queued',
    (deviceId) => {
      const session = sessions.get(deviceId);
      if (session) {
        void session.drainCommands();
      } else {
        console.log(`[gateway] ${deviceId} command queued but device is offline; will send on connect`);
      }
    },
    {
      // NOTIFY has no replay, so everything queued while the connection was
      // down was missed. Sweep at once rather than leaving those commands to
      // wait up to a minute for the next tick — which for an unlock is an
      // operator standing at a truck wondering why nothing happened.
      onReconnect: () => {
        console.log('[gateway] listener reconnected; sweeping for missed commands');
        void sweep();
      },
    },
  );
  console.log('[gateway] listening for command_queued notifications');

  await publishHealth();

  // A command held by not_before becomes due while the device may already be
  // connected, and NOTIFY only fires on insert. Sweep so scheduled work is not
  // stranded until the next reconnect.
  setInterval(() => void sweep(), 60_000).unref();

  /**
   * Evaluation-period expiry: stop accepting devices and drop the connected
   * ones. See src/evaluation.ts and README "Evaluation period".
   *
   * Closing the listener is what stops arrival unlocks too. They are evaluated
   * from incoming positions, so with no positions arriving there is no path
   * left that can open a lock on its own — which is the behaviour we want, and
   * not something to leave to a second check somewhere else.
   *
   * The process stays alive and inert. Restart=always means exiting here would
   * restart-loop every five seconds and bury the reason in the log.
   */
  const stopWatching = evaluationPeriod.watch(() => {
    console.error(`[gateway] ${evaluationPeriod.banner()}`);
    server.close();
    for (const session of sessions.values()) session.socket.destroy();
    sessions.clear();
    void clearAllConnections().catch(() => {});
  });

  if (evaluationPeriod.isExpired()) {
    // Already lapsed at boot: never open the port in the first place.
    console.error(`[gateway] ${evaluationPeriod.banner()}`);
  } else {
    if (evaluationPeriod.enabled) {
      console.log(
        `[gateway] evaluation period active — ${evaluationPeriod.daysRemaining()} day(s) left, ends ${evaluationPeriod.expiresAt?.toISOString().slice(0, 10)}`,
      );
    }
    /*
     * backlog 1024, against Node's default of 511.
     *
     * The backlog is how many connections the kernel will hold between the
     * SYN and this process calling accept(). When 3,000 devices reconnect
     * together after a restart, 511 is reached in the first moments and the
     * kernel drops the rest — the devices retry, which lengthens the stampede
     * rather than shortening it.
     *
     * It is also capped by net.core.somaxconn, which deploy/install.sh raises;
     * asking for 1024 against a somaxconn of 128 silently gets you 128.
     */
    server.listen(config.gateway.port, config.gateway.host, 1024, () => {
      console.log(`[gateway] listening on ${config.gateway.host}:${config.gateway.port}`);
      console.log(`[gateway] device allowlist ${config.requireKnownDevice ? 'ENFORCED' : 'DISABLED (dev only)'}`);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[gateway] ${signal} received, shutting down`);
    stopWatching();
    server.close();
    for (const session of sessions.values()) session.socket.destroy();
    await listener?.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[gateway] failed to start', err);
  process.exit(1);
});

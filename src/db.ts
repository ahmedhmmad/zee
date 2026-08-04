import pg from 'pg';
import { config } from './config.ts';

/**
 * Postgres returns bigint as a string by default to avoid precision loss.
 * Our bigints are identity columns well inside Number.MAX_SAFE_INTEGER, and
 * having them arrive as numbers keeps the calling code simple.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export type Db = pg.Pool | pg.PoolClient;

/** Dedicated long-lived connection for LISTEN/NOTIFY, kept out of the pool. */
export async function createListener(
  channel: string,
  onNotify: (payload: string) => void,
): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  client.on('notification', (msg) => {
    if (msg.channel === channel && msg.payload) onNotify(msg.payload);
  });
  client.on('error', (err) => console.error('[db] listener error', err));
  await client.query(`LISTEN ${channel}`);
  return client;
}

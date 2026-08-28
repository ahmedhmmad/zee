/**
 * Apply pending migrations, once each.
 *
 * Until now migrations were applied by hand with psql, which means remembering
 * which have run. Re-running one fails on the first CREATE that already
 * exists, rolls the whole file back, and leaves you unsure what state the
 * database is in. A record of what has been applied removes the question.
 *
 *   node --env-file-if-exists=.env scripts/migrate.ts
 *   node --env-file-if-exists=.env scripts/migrate.ts --status
 *
 * Two properties this runner has to provide, and did not before:
 *
 * 1. **Atomicity.** The migration and the row recording it commit together. The
 *    previous version sent the file (which committed itself) and then recorded
 *    it in a second, separate statement, so a crash in between silently re-ran
 *    the migration on the next start. The file's own BEGIN/COMMIT is stripped
 *    and replaced with a transaction that spans both.
 *
 * 2. **A lock.** Two gateways starting at once, or a deploy racing a manual
 *    run, would otherwise apply the same migration twice. One advisory lock is
 *    held for the whole run.
 *
 * A migration that cannot run inside a transaction — CREATE INDEX CONCURRENTLY,
 * chiefly — opts out with `-- migrate: no-transaction` on its own line. Those
 * are sent one statement per round trip, because Postgres wraps a
 * multi-statement simple query in an *implicit* transaction and CONCURRENTLY
 * fails inside it. They cannot be atomic, so **they must be idempotent**: use
 * IF NOT EXISTS, and expect a re-run after a failure partway through.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { pool } from '../src/db.ts';
import { splitStatements, isNonTransactional, unwrapTransaction } from './sql-split.ts';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** One lock for the whole run, keyed on a name rather than a magic number. */
const LOCK_KEY = 'zee_migrate';

async function listFiles(): Promise<string[]> {
  return (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Apply one migration and record it in the same transaction, so the two cannot
 * disagree.
 */
async function applyTransactional(client: PoolClient, file: string, sql: string): Promise<void> {
  const { body, wasWrapped } = unwrapTransaction(sql);
  if (!wasWrapped) {
    console.warn(`  ${file}: no BEGIN/COMMIT of its own; wrapping it`);
  }

  await client.query('BEGIN');
  try {
    await client.query(body);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Apply one migration a statement at a time, outside any transaction. Recording
 * it is a separate statement and cannot be made atomic with the work - which is
 * exactly why these files have to be idempotent.
 */
async function applyNonTransactional(client: PoolClient, file: string, sql: string): Promise<void> {
  const statements = splitStatements(sql);
  console.log(`  ${file}: no-transaction, ${statements.length} statements sent individually`);

  for (const [i, statement] of statements.entries()) {
    try {
      await client.query(statement);
    } catch (err) {
      // Say how far it got: the file is idempotent, so a re-run is the fix, but
      // only if you know it was partial.
      console.error(`  ${file}: statement ${i + 1}/${statements.length} failed; earlier statements are already applied`);
      throw err;
    }
  }

  await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
}

/**
 * A CREATE INDEX CONCURRENTLY that fails leaves the index behind, marked
 * invalid, and a re-run guarded by IF NOT EXISTS will skip it — so the index
 * exists, is never used, and nothing says so. Surface it.
 */
async function warnOnInvalidIndexes(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );

  for (const { name } of rows) {
    console.warn(`WARNING: index ${name} is INVALID — drop it and re-create it, it is not being used`);
  }
}

async function main(): Promise<void> {
  const files = await listFiles();

  if (process.argv.includes('--status')) {
    const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    for (const f of files) console.log(`${applied.has(f) ? '✓' : ' '} ${f}`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  let locked = false;

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    // Blocks rather than failing: a concurrent deploy should wait its turn, not
    // abort halfway through a rollout.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    locked = true;

    // Read the applied set only after the lock: another runner may have applied
    // something between startup and here.
    const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('nothing to apply');
      return;
    }

    for (const file of pending) {
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      if (isNonTransactional(sql)) {
        await applyNonTransactional(client, file, sql);
      } else {
        await applyTransactional(client, file, sql);
      }
      console.log(`applied ${file}`);
    }

    await warnOnInvalidIndexes(client);
  } catch (err) {
    console.error('FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

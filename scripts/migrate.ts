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
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.ts';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  if (process.argv.includes('--status')) {
    for (const f of files) console.log(`${applied.has(f) ? '✓' : ' '} ${f}`);
    await pool.end();
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log('nothing to apply');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      // Each migration file already wraps itself in BEGIN/COMMIT; recording it
      // separately is enough, and avoids nesting transactions.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      console.log(`applied ${file}`);
    } catch (err) {
      console.error(`FAILED ${file}:`, (err as Error).message);
      await pool.end();
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

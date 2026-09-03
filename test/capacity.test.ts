/**
 * The guardrails that decide whether a fleet-wide reconnect is survivable.
 *
 * A gateway restart is not an exotic event — it is what Restart=always produces
 * after any crash — and it brings 3,000 devices back at once, each replaying
 * the positions it buffered while away. That is roughly 5,000 frames a second,
 * about fifty times the steady-state peak the platform was originally sized
 * for.
 *
 * Every property here is invisible in normal operation and would look like a
 * harmless simplification to remove. That is what they are pinned for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(root + p, 'utf8');

const index = read('src/gateway/index.ts');
const db = read('src/db.ts');
const install = read('deploy/install.sh');

test('an accept error does not take the gateway down', () => {
  /*
   * process.exit(1) on any server error, under Restart=always, turned one
   * transient EMFILE or ECONNABORTED into a crash loop — and every restart runs
   * a 3,000-row clearAllConnections and then invites the whole fleet back at
   * once. The gateway was manufacturing the exact stampede this phase is sized
   * to survive, out of a single dropped connection.
   */
  const handler = /server\.on\('error', \(err\) => \{[\s\S]*?\n\}\);/.exec(index);
  assert.ok(handler, "the server error handler is gone or has changed shape");
  assert.match(handler[0]!, /if \(!listening\) \{/);
  assert.match(handler[0]!, /accept error \(continuing\)/);

  // Before listening it is still fatal: EADDRINUSE means this process cannot
  // do its job at all, and sitting there deaf is worse than exiting.
  const exits = handler[0]!.match(/process\.exit\(1\)/g) ?? [];
  assert.equal(exits.length, 1, 'exactly one exit path, and only before listening');
  assert.match(index, /server\.on\('listening', \(\) => \{/);
});

test('the listen backlog is raised above the Node default', () => {
  // 511 is reached in the first moments of a fleet-wide reconnect; the kernel
  // then drops the rest and those devices retry, lengthening the stampede.
  assert.match(index, /server\.listen\(config\.gateway\.port, config\.gateway\.host, 1024,/);
  // And it is clamped by somaxconn, so asking without raising that achieves
  // nothing.
  assert.match(install, /net\.core\.somaxconn = 4096/);
  assert.match(install, /net\.ipv4\.tcp_max_syn_backlog = 8192/);
});

test('the pool is sized per process and tunable without a release', () => {
  assert.match(db, /Number\(process\.env\.DB_POOL_MAX \?\? \(isGateway \? 25 : 15\)\)/);
});

test('a request waiting for a connection fails instead of hanging', () => {
  // Without a timeout the wait is indefinite and indistinguishable from a slow
  // query — the pool queue is invisible, which is what made saturation so hard
  // to see.
  assert.match(db, /connectionTimeoutMillis: 5_000/);
});

test('each process names itself in pg_stat_activity', () => {
  // When the database is the thing struggling, "which of my processes is doing
  // this" is the first question. Without this every row says "node".
  assert.match(db, /application_name: isGateway \? 'zee-gateway' : 'zee-api'/);
});

test('the file-descriptor limit is set explicitly on both units', () => {
  // One descriptor per connected device. Node raises the soft limit to the
  // hard one at startup and modern systemd defaults are generous, so this is
  // usually already fine — set so it does not depend on which systemd the box
  // happens to run.
  for (const unit of ['deploy/zee-gateway.service', 'deploy/zee-api.service']) {
    assert.match(read(unit), /^LimitNOFILE=65535$/m, `${unit} has no LimitNOFILE`);
  }
});

test('statement timeouts are enforced database-side', () => {
  // So a query that hangs cannot hold a pool connection indefinitely, whatever
  // the application forgot.
  assert.match(install, /ALTER ROLE zee_app SET statement_timeout = '15s'/);
  assert.match(install, /ALTER ROLE zee_app SET idle_in_transaction_session_timeout = '30s'/);
});

test('Postgres is tuned in conf.d, not by editing the main config', () => {
  // A package upgrade cannot silently revert a conf.d file, and removing it
  // removes the change.
  assert.match(install, /\/etc\/postgresql\/\$PG_VER\/main\/conf\.d\/60-zee\.conf/);
  for (const setting of [
    'shared_buffers',
    'effective_cache_size',
    'work_mem',
    'maintenance_work_mem',
    'max_wal_size',
    'checkpoint_timeout',
    'wal_compression',
    'random_page_cost',
    'log_min_duration_statement',
    'shared_preload_libraries',
  ]) {
    assert.match(install, new RegExp(`^${setting} =`, 'm'), `60-zee.conf does not set ${setting}`);
  }
  // shared_buffers and shared_preload_libraries need a restart, not a reload.
  assert.match(install, /systemctl restart postgresql/);
});

test('the tables that churn get their own autovacuum thresholds', () => {
  // Per-table settings cannot live in a config file. positions is append-only
  // but still needs its visibility map maintained; commands is updated on every
  // state change and bloats without it.
  assert.match(install, /ALTER TABLE IF EXISTS positions SET \(autovacuum_vacuum_scale_factor/);
  assert.match(install, /ALTER TABLE IF EXISTS commands  SET \(autovacuum_vacuum_scale_factor/);
});

test('one device replaying a backlog cannot take the pool', () => {
  const config = read('src/config.ts');
  assert.match(config, /replayFramesPerSecond: Number\(process\.env\.GATEWAY_REPLAY_FRAMES_PER_SEC \?\? 20\)/);
  assert.match(read('src/gateway/session.ts'), /async #admitReplay\(\)/);
});

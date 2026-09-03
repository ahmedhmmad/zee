/**
 * The 60-second sweep, and the queries under it.
 *
 * It used to await drainCommands for every live session in turn — roughly 6,000
 * statements a minute at 3,000 devices, nearly all of them finding an empty
 * queue — with no guard against a slow sweep starting again on top of itself.
 *
 * These are shape assertions over the source. The behaviour needs a database
 * and 3,000 sockets; what can be pinned here is that the properties which make
 * that behaviour correct have not been quietly removed, since every one of them
 * would look like a harmless simplification.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(root + p, 'utf8');

const store = read('src/gateway/store.ts');
const index = read('src/gateway/index.ts');
const arrivals = read('src/gateway/arrivals.ts');

function fn(src: string, name: string): string {
  const m = new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(src);
  assert.ok(m, `${name} not found`);
  return m[0]!;
}

// --- 1.7: the fleet due query and its index ---------------------------------

test('the due query never picks up an uncertain command', () => {
  // An uncertain command may already have opened a valve. The entire reason it
  // is not 'queued' is so that nothing resends it — a due query that swept it
  // back in would undo the timeout policy in one line.
  const due = fn(store, 'dueCommandDeviceIds');
  assert.match(due, /status IN \('queued', 'approved'\)/);
  assert.doesNotMatch(due, /uncertain/);
  // And an expired or not-yet-due command is not work either.
  assert.match(due, /expires_at > now\(\)/);
  assert.match(due, /not_before IS NULL OR not_before <= now\(\)/);
});

test('the due query is bounded', () => {
  // Without a cap this returns every device in the fleet on a bad day, and the
  // sweep then tries to drain all of them in one tick.
  assert.match(fn(store, 'dueCommandDeviceIds'), /LIMIT \$1/);
});

test('the dispatch indexes are built without locking out unlocks', () => {
  const m = read('migrations/018_command_dispatch_indexes.sql');

  // A plain CREATE INDEX blocks writes to commands for its duration, and
  // blocking writes there means an operator's unlock cannot be queued.
  assert.match(m, /CREATE INDEX CONCURRENTLY IF NOT EXISTS commands_due_idx/);
  assert.match(m, /CREATE INDEX CONCURRENTLY IF NOT EXISTS commands_sent_idx/);

  // CONCURRENTLY cannot run inside a transaction, and removing BEGIN/COMMIT is
  // not enough on its own: a multi-statement simple query gets an implicit one.
  assert.match(m, /^-- migrate: no-transaction$/m);
  assert.doesNotMatch(m, /^BEGIN;$/m);

  // A failed CONCURRENTLY build leaves an INVALID index behind, so re-running
  // the file has to be the fix rather than a second problem.
  assert.match(m, /DROP INDEX CONCURRENTLY IF EXISTS commands_due_idx/);

  // Not device-leading — a fleet query has no device_id predicate, which is
  // exactly why commands_dispatch_idx cannot serve it.
  assert.match(m, /ON commands \(not_before NULLS FIRST, requested_at\)/);
});

// --- 1.9: the sweep itself ---------------------------------------------------

test('a slow sweep does not start again on top of itself', () => {
  // Each copy competes for the same pool, so the slower it gets the more
  // copies there are. A missed tick costs nothing; the next one picks it up.
  assert.match(index, /let sweeping = false/);
  const sweep = fn(index, 'sweep');
  assert.match(sweep, /if \(sweeping\) \{/);
  assert.match(sweep, /\} finally \{[\s\S]*?sweeping = false/, 'the guard must clear even on a throw');
});

test('the sweep drains only devices with work, a few at a time', () => {
  const sweep = fn(index, 'sweep');
  assert.match(sweep, /await dueCommandDeviceIds\(\)/);
  assert.match(sweep, /sessions\.get\(id\)/, 'only the intersection with live sockets is drainable');
  // Promise.all over 3,000 sessions would ask a pool of 25 for 3,000
  // connections and queue them all inside pg, where nothing can see them.
  assert.match(sweep, /forEachBounded\(toDrain, SWEEP_CONCURRENCY/);
  assert.doesNotMatch(sweep, /for \(const session of sessions\.values\(\)\)/);
});

test('one failing drain does not abandon the rest of the sweep', () => {
  assert.match(fn(index, 'sweep'), /drainCommands\(\)\.catch/);
});

test('the per-drain expiry is gone, now that the fleet pass replaces it', () => {
  // It ran on every drain, almost always updating nothing, and could only ever
  // reach a truck that was connected.
  const claim = fn(store, 'claimPendingCommands');
  assert.doesNotMatch(claim, /SET status = 'expired'/);
  // But the claim must still refuse a lapsed command on its own, or one could
  // be dispatched in the window between two sweeps.
  assert.match(claim, /expires_at > now\(\)/);
  assert.match(store, /export async function expireLapsedCommands/);
});

test('an arrival check costs one pooled query when nothing is armed', () => {
  // It is awaited on the position path. Taking a dedicated client and running
  // BEGIN/UPDATE/COMMIT for every positioned frame — when almost no truck has
  // a rule armed — was the pool contention everything else queued behind.
  const check = /export async function checkArrivalUnlocks[\s\S]*?const client = await pool\.connect\(\)/.exec(arrivals);
  assert.ok(check, 'the pre-check or the connect has moved');
  assert.match(check[0]!, /SELECT 1 FROM arrival_unlocks/);
  assert.match(check[0]!, /if \(!armed\) return \[\]/);
  // The transactional claim below remains the authority, so no correctness
  // property rests on this.
  assert.match(arrivals, /UPDATE arrival_unlocks a\s+SET is_armed = false/);
});

test('the allowlist check and the connected flag are one round trip', () => {
  // Two queries asking overlapping questions ran back to back on every
  // connect. When the whole fleet reconnects after a restart that is 6,000
  // statements in about a minute, against a pool that is simultaneously
  // absorbing the replayed position backlog.
  const admit = fn(store, 'admitDevice');
  assert.match(admit, /WITH known AS/);
  assert.match(admit, /INSERT INTO device_state/);
  assert.match(admit, /SELECT EXISTS \(SELECT 1 FROM known\) AS known/);
  assert.doesNotMatch(store, /export async function isKnownDevice/);
});

test('a device the allowlist refuses has nothing written for it', () => {
  // The INSERT selects from `known`, which is empty for an unrecognised
  // device, so there is no row to insert.
  const admit = fn(store, 'admitDevice');
  assert.match(admit, /SELECT device_id, true, now\(\), now\(\), now\(\) FROM known/);
});

test('the allowlist can still be switched off for the simulator', () => {
  const session = read('src/gateway/session.ts');
  assert.match(session, /config\.requireKnownDevice \? allowlisted : true/);
  assert.match(index, /if \(!allowlisted && config\.requireKnownDevice\) return false/);
});

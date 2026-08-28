/**
 * The command lifecycle vocabulary, asserted across everything that reads it.
 *
 * `commands.status` is written by the gateway, constrained by the schema, and
 * rendered to an operator in Arabic. Those three live in three different
 * languages and nothing connects them, so a state added to one and forgotten in
 * another shows a dispatcher a raw English code — or worse, a status the
 * console silently styles as success.
 *
 * These tests are static: they read the SQL and the source rather than a
 * database, which is what the repo can do today and still catches the whole
 * class of drift. They are not a substitute for behavioural tests over the
 * store; those need the seam plan item 1.0 built and a database to run against.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

const evidenceMigration = read('migrations/014_command_evidence.sql');
const appJs = read('public/app.js');
const routes = read('src/api/routes.ts');
const store = read('src/gateway/store.ts');
const session = read('src/gateway/session.ts');
const arrivals = read('src/gateway/arrivals.ts');

/** The statuses the schema will actually accept, after 014. */
function schemaStatuses(): string[] {
  const m = /commands_status_check\s+CHECK \(status IN \(([\s\S]*?)\)\)/.exec(evidenceMigration);
  assert.ok(m, 'could not find the status CHECK in 014_command_evidence.sql');
  return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

/** The seeded command types and whether each one actuates hardware. */
function seededTypes(): Map<string, boolean> {
  const m = /INSERT INTO command_types \(command_type, is_physical, description\) VALUES([\s\S]*?)ON CONFLICT/.exec(
    evidenceMigration,
  );
  assert.ok(m, 'could not find the command_types seed');
  const seeded = new Map<string, boolean>();
  for (const row of m[1]!.matchAll(/\('([a-z_0-9]+)',\s+(true|false),/g)) {
    seeded.set(row[1]!, row[2] === 'true');
  }
  return seeded;
}

/**
 * Every command type the code can actually queue.
 *
 * Three shapes, because that is how the routes are written: a literal inside
 * the INSERT, an object in a settings list, and a tuple in a step list. Audit
 * action names look like command types — `unlock_requested`, `unlock_refused` —
 * so this deliberately reads only the insert sites rather than every snake_case
 * string in the file.
 */
function typesInUse(): Set<string> {
  const sources = [routes, store, arrivals, session];
  const found = new Set<string>();

  for (const src of sources) {
    // INSERT INTO commands ... VALUES ($1, 'unlock_static', ...)
    // INSERT INTO commands ... SELECT $1, 'query_position', ...
    //
    // Split rather than a single global regex: consecutive insert sites are
    // close enough together that one lazy match can swallow the next one, and
    // a type silently dropped from this set is exactly the failure the test is
    // supposed to catch.
    for (const chunk of src.split('INSERT INTO commands').slice(1)) {
      const m = /^[\s\S]{0,300}?(?:VALUES \(|SELECT )\$1,\s*'([a-z_0-9]+)'/.exec(chunk);
      if (m) found.add(m[1]!);
    }
    // queued.push({ type: 'set_tracking', ... })
    for (const m of src.matchAll(/\btype: '([a-z_0-9]+)'/g)) found.add(m[1]!);
    // ['query_firmware', '(P01)', ...]
    for (const m of src.matchAll(/\['([a-z_0-9]+)',\s*'\(/g)) found.add(m[1]!);
    // command_type = 'set_password' / command_type IN ('unlock_static', ...)
    for (const m of src.matchAll(/command_type (?:=|IN \()\s*'?\(?([a-z_0-9', ]+)/g)) {
      for (const t of m[1]!.matchAll(/[a-z_0-9]+/g)) if (t[0]!.includes('_')) found.add(t[0]!);
    }
  }
  return found;
}

test('the schema can express uncertainty', () => {
  assert.ok(
    schemaStatuses().includes('uncertain'),
    "'uncertain' must be writable, or every later part of the lifecycle work has nowhere to record that the platform does not know",
  );
});

test('every status the schema accepts has an Arabic label and a severity', () => {
  const block = /const COMMAND_STATUS = \{([\s\S]*?)\n\};/.exec(appJs);
  assert.ok(block, 'COMMAND_STATUS not found in app.js');

  const labelled = new Map<string, string>();
  for (const m of block[1]!.matchAll(/^\s*([a-z_]+): \['([^']*)', '([a-z]*)'\]/gm)) {
    labelled.set(m[1]!, m[3]!);
  }

  for (const status of schemaStatuses()) {
    assert.ok(labelled.has(status), `console has no Arabic label for status '${status}'`);
    assert.notEqual(labelled.get(status), '', `status '${status}' renders with no severity class`);
  }
});

test('uncertain is styled as its own thing, not as success or as pending', () => {
  const block = /const COMMAND_STATUS = \{([\s\S]*?)\n\};/.exec(appJs)![1]!;
  const cls = /uncertain: \['[^']*', '([a-z]*)'\]/.exec(block)?.[1];
  assert.equal(cls, 'uncertain');
  assert.match(read('public/styles.css'), /\.feed li\.uncertain\b/);
});

test('an uncertain command is not offered as cancellable', () => {
  // It may already have executed. Offering a cancel would promise something
  // the platform cannot deliver, on a command that opens a valve.
  for (const [name, src] of [['routes.ts', routes], ['app.js', appJs]] as const) {
    for (const m of src.matchAll(/\[('(?:queued|approved|draft|pending_approval)'[^\]]*)\]/g)) {
      assert.ok(!m[1]!.includes('uncertain'), `${name} treats uncertain as cancellable`);
    }
  }
});

test('every command type the code can queue is registered', () => {
  const seeded = seededTypes();
  const used = typesInUse();

  // If a refactor changes the shape of the insert sites this extraction goes
  // quiet rather than wrong, and the test would pass having checked nothing.
  assert.ok(used.size >= 25, `only found ${used.size} command types in use; the extraction has drifted`);

  for (const type of [...used].sort()) {
    assert.ok(
      seeded.has(type),
      `command type '${type}' is queued by the code but not registered in command_types — ` +
        'the foreign key will reject it at runtime, and nobody has said whether it actuates hardware',
    );
  }
});

test('exactly the unlock types are physical', () => {
  const seeded = seededTypes();
  const physical = [...seeded].filter(([, p]) => p).map(([t]) => t).sort();
  assert.deepEqual(physical, ['unlock_dynamic', 'unlock_static', 'unlock_sublock']);
});

test('a confirmed command cannot be moved to failed', () => {
  // Defect (e): the device answers, the row resolves to confirmed, and a later
  // write failure on the same id overwrites it — the audit trail then denies an
  // unlock that demonstrably happened.
  const fn = /export async function markCommandFailed\([\s\S]*?\n\}/.exec(store);
  assert.ok(fn, 'markCommandFailed not found');
  assert.match(fn[0]!, /status NOT IN \('confirmed', 'failed'\)/);
});

test('a transport failure is never recorded as the device rejecting us', () => {
  // Only device_rejected may ever reach the repeated-failure lockout.
  assert.match(session, /markCommandFailed\(cmd\.id, 'socket write failed', 'transport'\)/);

  const causes = new Set(
    [...(/commands_failure_cause_check[\s\S]*?\(([^)]*)\)\)/.exec(evidenceMigration)?.[1] ?? '').matchAll(
      /'([a-z_]+)'/g,
    )].map((m) => m[1]!),
  );
  assert.ok(causes.size > 0, 'could not read the failure_cause CHECK');
  for (const src of [store, session, routes]) {
    for (const m of src.matchAll(/failure_cause\s*=\s*'([a-z_]+)'/g)) {
      assert.ok(causes.has(m[1]!), `failure_cause '${m[1]}' is not allowed by the CHECK constraint`);
    }
  }
});

test('evidence is all-or-nothing', () => {
  // A movement timestamp with nothing to point at is precisely the
  // confident-but-unsupported record this work exists to stop.
  assert.match(evidenceMigration, /commands_physical_evidence_check/);
  const check = /commands_physical_evidence_check\s+CHECK \(([\s\S]*?)\n  \);/.exec(evidenceMigration);
  assert.ok(check, 'evidence CHECK not found');
  assert.match(check[1]!, /physical_evidence_id IS NULL/);
  assert.match(check[1]!, /physical_evidence_id IS NOT NULL/);
});

test('the console shows movement evidence apart from the command status', () => {
  // 'confirmed' means the device answered. It has been read as "the valve
  // opened" and it never meant that.
  assert.match(appJs, /function evidenceLine\(/);
  assert.match(appJs, /\$\{evidenceLine\(c\)\}/);
  assert.match(routes, /physically_evidenced_at/);
  assert.match(routes, /is_physical/);
});

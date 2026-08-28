/**
 * The timeout policy, and the evidence that can arrive after it.
 *
 * Two things have to hold together and are useless apart:
 *
 *   - a command that can move a valve is never resent, so silence takes it to
 *     'uncertain' rather than back to 'queued';
 *   - a lock event arriving after that still upgrades it.
 *
 * Ship the first without the second and every unanswered unlock is stranded as
 * uncertain forever, even when the device tells us minutes later exactly what
 * happened. That is the orphaning bug, arrived at through the fix for a
 * different one.
 *
 * The store's queries need a database to execute, so what is asserted here is
 * the SQL itself. The clock-offset rule underneath them is real behaviour and
 * is tested as such.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PositionFrame } from '../src/protocol/index.ts';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
const { clockOffsetSample } = await import('../src/gateway/store.ts');

const root = fileURLToPath(new URL('..', import.meta.url));
const store = readFileSync(root + 'src/gateway/store.ts', 'utf8');

/** The body of a named exported function, so an assertion cannot drift file-wide. */
function body(name: string): string {
  const m = new RegExp(`export (?:async )?function ${name}\\([\\s\\S]*?\\n\\}`).exec(store);
  assert.ok(m, `${name} not found in store.ts`);
  return m[0]!;
}

/** Minutes in the first `interval 'N minutes'` matching a surrounding pattern. */
function intervalMinutes(src: string, near: RegExp): number {
  const m = near.exec(src);
  assert.ok(m, `pattern ${near} not found`);
  const iv = /interval '(\d+) minutes?'/.exec(m[0]!);
  assert.ok(iv, `no interval in the matched region: ${m[0]}`);
  return Number(iv[1]);
}

test('a command that can move a valve is never returned to the queue', () => {
  const fn = body('requeueUnansweredCommands');

  // Both the retry and the give-up-after-three-attempts branch must exclude
  // physical types. Either one on its own still resends an unlock.
  const requeue = /SET status = 'queued'[\s\S]*?attempts < 3`/.exec(fn);
  assert.ok(requeue, 'the re-queue branch is gone or has changed shape');
  assert.match(requeue[0]!, /NOT t\.is_physical/);

  const giveUp = /SET status = 'failed'[\s\S]*?attempts >= 3`/.exec(fn);
  assert.ok(giveUp, 'the give-up branch is gone or has changed shape');
  assert.match(giveUp[0]!, /NOT t\.is_physical/);
});

test('an unanswered physical command times out to uncertain, not to failed', () => {
  const fn = body('requeueUnansweredCommands');
  const physical = /SET status = 'uncertain'[\s\S]*?3 minutes'`/.exec(fn);
  assert.ok(physical, 'physical commands have no timeout branch at all');
  assert.match(physical[0]!, /AND t\.is_physical/);
  // 'failed' would claim the command did not happen. It may well have.
  assert.doesNotMatch(physical[0]!, /'failed'/);
});

test('the evidence window closes after the timeout, not before it', () => {
  // The original window ended at sent_at + 2 minutes while the timeout was 3,
  // so it shut a full minute before a command could become uncertain — and
  // widening the accepted statuses alone would have changed nothing.
  const timeout = intervalMinutes(
    body('requeueUnansweredCommands'),
    /SET status = 'uncertain'[\s\S]*?sent_at < now\(\) - interval '\d+ minutes?'/,
  );
  const window = intervalMinutes(
    body('linkEventToCommand'),
    /c\.sent_at \+ interval '\d+ minutes?'/,
  );
  assert.ok(
    window > timeout,
    `the link window (${window}m) must outlast the timeout (${timeout}m), or a lock event arriving after the timeout is orphaned`,
  );
});

test('evidence is accepted for a command that already timed out', () => {
  for (const name of ['linkEventToCommand', 'confirmSubLockUnlock']) {
    assert.match(body(name), /status IN \([^)]*'uncertain'/, `${name} ignores uncertain commands`);
  }
});

test('evidence upgrades uncertain to confirmed and records what proved it', () => {
  const fn = body('linkEventToCommand');
  assert.match(fn, /physically_evidenced_at = now\(\)/);
  assert.match(fn, /physical_evidence_kind\s*= 'lock_event'/);
  assert.match(fn, /physical_evidence_id\s*= \$1/);
  assert.match(fn, /CASE WHEN c\.status = 'uncertain' THEN 'confirmed'/);

  const sub = body('confirmSubLockUnlock');
  assert.match(sub, /physical_evidence_kind\s*= 'peripheral_report'/);
  assert.match(sub, /physical_evidence_id\s*= \$3/);
});

test('an ambiguous match resolves nothing', () => {
  // Refusing to choose is the point. Two open unlocks and one event that could
  // belong to either must leave both uncertain.
  for (const name of ['linkEventToCommand', 'confirmSubLockUnlock']) {
    assert.match(
      body(name),
      /SELECT count\(\*\) FROM candidates\) = 1/,
      `${name} picks a winner when more than one command matches`,
    );
  }
});

test('a command collects evidence once', () => {
  for (const name of ['linkEventToCommand', 'confirmSubLockUnlock']) {
    assert.match(body(name), /physically_evidenced_at IS NULL/, `${name} can double-attribute`);
  }
});

test('no clock offset means no attribution', () => {
  const fn = body('linkEventToCommand');
  assert.match(fn, /s\.clock_offset_ms IS NOT NULL/);
  // A months-old offset is not a correction, it is a guess wearing one.
  assert.match(fn, /s\.clock_offset_at > now\(\) - interval '\d+ hours?'/);
});

/** Only the three fields clockOffsetSample reads. */
function frame(fields: Partial<PositionFrame>): PositionFrame {
  return { isHistorical: false, isBacklog: false, reportedAt: new Date(), ...fields } as PositionFrame;
}

test('the clock offset is measured only from real-time frames', () => {
  const hoursAgo = new Date(Date.now() - 4 * 3600_000);

  // Blind-area data is deliberately old. Sampling it would record a device as
  // four hours behind when its clock is perfectly correct — and that wrong
  // correction would then misattribute a lock event.
  assert.equal(clockOffsetSample(frame({ isHistorical: true, reportedAt: hoursAgo })), null);
  assert.equal(clockOffsetSample(frame({ isBacklog: true, reportedAt: hoursAgo })), null);
});

test('the clock offset is device time minus ours', () => {
  const ahead = clockOffsetSample(frame({ reportedAt: new Date(Date.now() + 180_000) }));
  assert.ok(ahead !== null);
  // Positive means the device is ahead, which is what subtracting it corrects.
  assert.ok(Math.abs(ahead - 180_000) < 2_000, `expected about +180000ms, got ${ahead}`);

  const behind = clockOffsetSample(frame({ reportedAt: new Date(Date.now() - 90_000) }));
  assert.ok(behind !== null && behind < 0, `expected a negative offset, got ${behind}`);
});

/**
 * The two ways a bad command query took the whole fleet offline.
 *
 * `claimPendingCommands` shipped with a missing comma between two CTEs —
 * `WITH claimed AS (...) upd AS (...)`. Postgres read `upd` as a bare alias and
 * refused the statement, every time any truck connected. Neither gate could see
 * it: `tsc` type-checks a template literal as a string, and no test in this
 * suite touches a real database.
 *
 * It then became a fleet outage rather than a command failure, because the two
 * fire-and-forget drains had no catch. Node ends a process on an unhandled
 * rejection, so one unparseable query restarted the gateway 494 times in a day,
 * and not one position was written in any of them.
 *
 * These are the standing guards for each half. The first is a shape check,
 * which is all that is possible without a database; the second is behavioural.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { buildPositionFrame } from '../scripts/build-frames.ts';
import { FakeSocket, settle } from './fake-socket.ts';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';

const { DeviceSession } = await import('../src/gateway/session.ts');
type SessionDeps = import('../src/gateway/session.ts').SessionDeps;

const root = fileURLToPath(new URL('..', import.meta.url));

/** A stretch of SQL, and where in its file it starts. */
interface Region {
  text: string;
  offset: number;
}

/**
 * Every template literal in a source file.
 *
 * Deliberately naive — it would end a literal early on an escaped backtick.
 * No SQL here contains one, and the cost of being wrong is a region scanned
 * short, never a false accusation.
 */
const TEMPLATE_LITERAL = /`[^`]*`/g;
/** Enough of one to be SQL rather than a log line. */
const LOOKS_LIKE_SQL = /\b(?:WITH|SELECT|INSERT|UPDATE|DELETE)\b/i;

/**
 * The SQL in one file, as Postgres would see it.
 *
 * A .sql file is SQL throughout. A .ts file keeps its SQL in template literals,
 * and only those are searched — because an apostrophe in English prose ("the
 * truck's position") is indistinguishable from the opening quote of a SQL
 * string literal, so a scanner let loose on a whole .ts file reads the rest of
 * it as one long string and then finds nothing at all. This test did exactly
 * that, and passed against the broken query it exists to catch.
 *
 * Within each region, interpolations, quoted strings and comments are blanked,
 * so a bracket inside '(P43,' cannot be mistaken for syntax.
 */
function sqlRegions(file: string, source: string): Region[] {
  const regions: Region[] = file.endsWith('.sql')
    ? [{ text: source, offset: 0 }]
    : [...source.matchAll(TEMPLATE_LITERAL)]
        .filter((m) => LOOKS_LIKE_SQL.test(m[0]))
        .map((m) => ({ text: m[0], offset: m.index }));

  return regions.map(({ text, offset }) => ({
    offset,
    text: text
      .replace(/\$\{[^}]*\}/g, ' _ ')
      .replace(/'(?:[^']|'')*'/g, "'_'")
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, ' '),
  }));
}

test('no CTE chain is missing the comma that separates it', () => {
  // Every tracked source file, rather than a list someone has to remember to
  // extend: the defect is not specific to store.ts.
  const files = execFileSync('git', ['ls-files', 'src', 'scripts', 'migrations'], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split(/\r?\n/);

  // `)` then a name then `AS (` — a second CTE with nothing joining it to the
  // first. A correctly written chain has a comma in between and will not match.
  const orphanCte = /\)\s*\n\s*([A-Za-z_]\w*)\s+AS\s*\(/g;

  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const region of sqlRegions(file, source)) {
      for (const m of region.text.matchAll(orphanCte)) {
        // Counted over the whole file, so a failure names a line you can open.
        const line = source.slice(0, region.offset + m.index).split('\n').length;
        found.push(`${file}:${line} — "${m[1]}" begins a CTE with no comma before it`);
      }
    }
  }

  assert.deepEqual(found, [], found.join('\n'));
});

test('a command query that will not parse does not take the gateway down with it', async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown): void => void rejections.push(err);
  process.on('unhandledRejection', onUnhandled);

  const inserted: string[] = [];
  const store = {
    isKnownDevice: async () => true,
    setConnected: async () => {},
    insertPosition: async () => {
      inserted.push('position');
      return true;
    },
    updateDeviceState: async () => {},
    // What Postgres actually returned: 42601, syntax error at or near "upd".
    claimPendingCommands: async () => {
      throw Object.assign(new Error('syntax error at or near "upd"'), { code: '42601' });
    },
    audit: async () => {},
  } as unknown as SessionDeps['store'];

  const socket = new FakeSocket();
  new DeviceSession(
    socket as unknown as Socket,
    { onIdentified: async () => true, onClosed: () => {} },
    { store, checkArrivalUnlocks: (async () => []) as unknown as SessionDeps['checkArrivalUnlocks'] },
  );

  // Identification triggers the drain that throws. The position in the same
  // frame must still be recorded: telemetry does not depend on the command
  // queue answering, and it is the truck's real position either way.
  socket.emit('data', buildPositionFrame({
    deviceId: '8000620011', lat: 32.8872, lon: 13.1913, speedKph: 0, headingDeg: 0,
    mileageKm: 1000, batteryPercent: 80, motorLocked: true, ropeInserted: true, serial: 1,
  }));
  await settle();
  // The rejection would arrive asynchronously; give the loop a turn to deliver it.
  await new Promise((r) => setTimeout(r, 10));
  process.off('unhandledRejection', onUnhandled);

  assert.deepEqual(rejections, [], 'a failing drain must be caught, not left to end the process');
  assert.deepEqual(inserted, ['position'], 'the position must be recorded even though the drain failed');

  socket.destroy();
});

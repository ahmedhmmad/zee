/**
 * One socket, one chunk at a time.
 *
 * `socket.on('data', chunk => void this.#onData(chunk))` was fired and not
 * awaited. With any database latency two chunks from the same socket then ran
 * concurrently, and two things followed: both could observe `#deviceId === null`
 * and identify the same device twice, and frames persisted in whatever order
 * their queries happened to finish rather than the order the truck sent them.
 *
 * At two devices neither is ever seen. At three thousand against a pool of ten
 * it is the ordinary case — which matters because position ordering is what the
 * map, the mileage rollup and the arrival checks all read.
 *
 * Also pinned here: only the session registry may write is_connected. It had
 * three writers that disagreed with each other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { buildPositionFrame } from '../scripts/build-frames.ts';
import { FakeSocket, settle } from './fake-socket.ts';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
const { DeviceSession } = await import('../src/gateway/session.ts');
type SessionDeps = import('../src/gateway/session.ts').SessionDeps;

const DEVICE = '8000620011';
const root = fileURLToPath(new URL('..', import.meta.url));

const frame = (serial: number): Buffer =>
  buildPositionFrame({
    deviceId: DEVICE, lat: 32.8872, lon: 13.1913, speedKph: 40, headingDeg: 90,
    mileageKm: 1000 + serial, batteryPercent: 80, motorLocked: true,
    ropeInserted: true, serial,
  });

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Calls {
  identifications: number;
  mileage: number[];
  order: string[];
}

/**
 * A store whose every call takes a tick, which is what makes the interleaving
 * visible. With the old fire-and-forget handler these are the awaits two chunks
 * would overlap on.
 */
function slowDeps(opts: { throwOnInsert?: boolean } = {}): { deps: SessionDeps; calls: Calls } {
  const calls: Calls = { identifications: 0, mileage: [], order: [] };
  const store = {
    insertPosition: async (p: { mileageKm: number }) => {
      await delay(5);
      if (opts.throwOnInsert) throw new Error('database went away mid-parse');
      calls.mileage.push(p.mileageKm);
      calls.order.push('insertPosition');
      return true;
    },
    updateDeviceState: async () => { await delay(5); calls.order.push('updateDeviceState'); },
    setConnected: async () => {},
    claimPendingCommands: async () => [],
    audit: async () => {},
    recordRejectedFrame: async () => {},
  } as unknown as SessionDeps['store'];

  return {
    deps: { store, checkArrivalUnlocks: (async () => []) as unknown as SessionDeps['checkArrivalUnlocks'] },
    calls,
  };
}

function session(deps: SessionDeps, calls?: Calls): FakeSocket {
  const socket = new FakeSocket();
  new DeviceSession(socket as unknown as Socket, {
    // Admission is a database round trip in production — the allowlist check
    // and the connected flag in one statement — so it is slow here too. It is
    // the await two concurrent chunks would both have raced through.
    onIdentified: async () => {
      if (calls) calls.identifications++;
      await delay(15);
      return true;
    },
    onClosed: () => {},
  }, deps);
  return socket;
}

test('two data events in the same tick identify the device exactly once', async () => {
  const { deps, calls } = slowDeps();
  const socket = session(deps, calls);

  // Both emitted before either can finish. This is the shape of a device
  // reconnecting and immediately replaying its buffer.
  socket.emit('data', frame(1));
  socket.emit('data', frame(2));
  await settle(200);

  assert.equal(calls.identifications, 1, 'the allowlist check must not run twice for one socket');
  socket.destroy();
});

test('frames are persisted in the order the truck sent them', async () => {
  const { deps, calls } = slowDeps();
  const socket = session(deps);

  for (let i = 1; i <= 4; i++) socket.emit('data', frame(i));
  await settle(300);

  assert.deepEqual(
    calls.mileage,
    [1001, 1002, 1003, 1004],
    'chunks must be handled in arrival order, not in the order their queries finish',
  );
  socket.destroy();
});

test('two frames in one chunk are still both handled', async () => {
  const { deps, calls } = slowDeps();
  const socket = session(deps);

  socket.emit('data', Buffer.concat([frame(7), frame(8)]));
  await settle(200);

  assert.deepEqual(calls.mileage, [1007, 1008]);
  socket.destroy();
});

test('the socket is paused while a chunk is in flight, and resumed after', async () => {
  const { deps } = slowDeps();
  const socket = session(deps);

  socket.emit('data', frame(1));
  // Still inside the handler: the pause is what gives the device real TCP
  // backpressure when the database is slow.
  assert.equal(socket.paused, true);

  await settle(200);
  assert.equal(socket.paused, false);
  assert.equal(socket.flow.at(-1), 'resume');
  socket.destroy();
});

test('a throw mid-parse still resumes the socket', async () => {
  // An unguarded resume left the socket paused forever: the device stays
  // connected, keeps sending, and nothing is ever read. It looks alive while
  // being deaf, and nothing detects that — worse than a clean disconnect.
  const { deps } = slowDeps({ throwOnInsert: true });
  const socket = session(deps);

  socket.emit('data', frame(1));
  await settle(200);

  assert.equal(socket.paused, false, 'a socket left paused by an error is never read again');
  socket.destroy();
});

test('a throw on one chunk does not stop the next one being handled', async () => {
  let fail = true;
  const { deps, calls } = slowDeps();
  const store = {
    ...deps.store,
    insertPosition: async (p: { mileageKm: number }) => {
      if (fail) { fail = false; throw new Error('transient'); }
      calls.mileage.push(p.mileageKm);
      return true;
    },
  } as unknown as SessionDeps['store'];

  const socket = session({ store, checkArrivalUnlocks: deps.checkArrivalUnlocks });
  socket.emit('data', frame(1));
  socket.emit('data', frame(2));
  await settle(200);

  assert.deepEqual(calls.mileage, [1002], 'the chunk queue must survive a failed chunk');
  socket.destroy();
});

// --- Ownership of is_connected ----------------------------------------------

test('only the session registry writes is_connected', () => {
  const store = readFileSync(root + 'src/gateway/store.ts', 'utf8');
  const session = readFileSync(root + 'src/gateway/session.ts', 'utf8');
  const index = readFileSync(root + 'src/gateway/index.ts', 'utf8');

  // The session cannot know whether it is still the socket that owns this
  // device — only the registry can.
  assert.doesNotMatch(session, /setConnected\(/, 'a session must not write its own connection state');

  // The ingest path asserted is_connected = true on every position frame,
  // including a blind-area replay from a truck that had already hung up.
  const upsert = /export async function updateDeviceState[\s\S]*?\n\}/.exec(store);
  assert.ok(upsert, 'updateDeviceState not found');
  assert.doesNotMatch(upsert[0]!, /is_connected\s*=/, 'the ingest path must not touch is_connected');

  // The connect-side write is folded into admitDevice — the allowlist check
  // and the connected flag are one statement — and it is called from the
  // registry, not from the session.
  assert.match(index, /const allowlisted = await admitDevice\(deviceId\)/);
  assert.doesNotMatch(session, /admitDevice/, 'admission belongs to the registry');
  assert.match(index, /queueStateWrite\(deviceId, false\)/);
});

test('a superseded session cannot mark a reconnected device offline', () => {
  const index = readFileSync(root + 'src/gateway/index.ts', 'utf8');
  const onClosed = /onClosed\(deviceId, session\) \{[\s\S]*?\n    \},/.exec(index);
  assert.ok(onClosed, 'onClosed not found');

  // The guard has to come first. Clearing the flag outside it is how a device
  // that reconnected before the old socket's FIN arrived ended up recorded as
  // offline while connected.
  const guard = onClosed[0]!.indexOf('sessions.get(deviceId) !== session');
  const write = onClosed[0]!.indexOf('queueStateWrite');
  assert.ok(guard !== -1 && write !== -1 && guard < write, 'the state write must sit inside the ownership guard');
});

test('the superseded socket is destroyed before the registry moves on', () => {
  const index = readFileSync(root + 'src/gateway/index.ts', 'utf8');
  const onIdentified = /onIdentified\(deviceId, session\) \{[\s\S]*?\n    \},/.exec(index)![0]!;
  const destroy = onIdentified.indexOf('existing.socket.destroy()');
  const register = onIdentified.indexOf('sessions.set(deviceId, session)');
  assert.ok(destroy !== -1 && register !== -1 && destroy < register);
});

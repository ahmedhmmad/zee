/**
 * What the gateway records about a command it has just written to a socket.
 *
 * Three things look alike here and are not: the kernel accepting the bytes, the
 * kernel asking us to slow down, and the socket being gone. The old code
 * returned one boolean for all three, so a busy socket produced a database row
 * saying an unlock had failed — for an unlock that had in fact been delivered.
 * Two of those rows then refused the operator's next attempt.
 *
 * These drive a real DeviceSession over a fake socket, so they assert the
 * behaviour rather than the shape of the SQL.
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

interface Recorded {
  audits: { action: string; commandId?: number }[];
  failures: { id: number; error: string; cause?: string }[];
}

function makeDeps(pending: unknown[]): { deps: SessionDeps; rec: Recorded } {
  const rec: Recorded = { audits: [], failures: [] };
  const store = {
    isKnownDevice: async () => true,
    setConnected: async () => {},
    insertPosition: async () => true,
    updateDeviceState: async () => {},
    claimPendingCommands: async () => pending.splice(0, pending.length),
    markCommandFailed: async (id: number, error: string, cause?: string) => {
      rec.failures.push({ id, error, cause });
    },
    audit: async (action: string, _d: string, _detail: unknown, commandId?: number) => {
      rec.audits.push({ action, commandId });
    },
  } as unknown as SessionDeps['store'];

  const checkArrivalUnlocks = (async () => []) as unknown as SessionDeps['checkArrivalUnlocks'];
  return { deps: { store, checkArrivalUnlocks }, rec };
}

const unlock = { id: 77, device_id: DEVICE, command_type: 'unlock_static', payload: '(P43,123456)' };


/**
 * A session identified by one position frame, with `pending` queued only once
 * identification is done.
 *
 * The session drains on identify — devices sleep, so that is usually the only
 * moment they are reachable — so anything queued beforehand would go out on
 * that drain rather than on the explicit one each test makes.
 */
async function identifiedSession(pending: unknown[]): Promise<{
  socket: FakeSocket;
  session: InstanceType<typeof DeviceSession>;
  rec: Recorded;
}> {
  const socket = new FakeSocket();
  const queue: unknown[] = [];
  const { deps, rec } = makeDeps(queue);
  const session = new DeviceSession(socket as unknown as Socket, {
    onIdentified: async () => true,
    onClosed: () => {},
  }, deps);

  socket.emit('data', buildPositionFrame({
    deviceId: DEVICE, lat: 32.8872, lon: 13.1913, speedKph: 0, headingDeg: 0,
    mileageKm: 1000, batteryPercent: 80, motorLocked: true, ropeInserted: true, serial: 1,
  }));
  await settle();
  queue.push(...pending);
  socket.written.length = 0;
  rec.audits.length = 0;
  rec.failures.length = 0;
  return { socket, session, rec };
}

test('a backpressured unlock is recorded as sent, not as failed', async () => {
  const { socket, session, rec } = await identifiedSession([unlock]);
  socket.behaviour = 'backpressure';

  const draining = session.drainCommands();
  // The session waits for the socket to drain before writing anything else.
  await settle();
  socket.emit('drain');
  await draining;

  assert.deepEqual(rec.failures, [], 'backpressure is not a failure — the bytes are queued and will go out');
  assert.deepEqual(
    rec.audits.map((a) => a.action),
    ['command_sent'],
    'a backpressured command must still be audited as sent',
  );
  assert.equal(rec.audits[0]!.commandId, 77);
  assert.equal(socket.written.length, 1, 'the payload should have been written once');

  socket.destroy();
});

test('the next command waits for the socket to drain', async () => {
  const second = { ...unlock, id: 78 };
  const { socket, session, rec } = await identifiedSession([unlock, second]);
  socket.behaviour = 'backpressure';

  const draining = session.drainCommands();
  await settle();

  assert.equal(socket.written.length, 1, 'the second command must not be written before the first drains');

  socket.behaviour = 'accept';
  socket.emit('drain');
  await draining;

  assert.equal(socket.written.length, 2);
  assert.deepEqual(rec.audits.map((a) => a.commandId), [77, 78]);

  socket.destroy();
});

test('a write that throws is a real failure, and a transport one', async () => {
  const { socket, session, rec } = await identifiedSession([unlock]);
  socket.behaviour = 'throw';

  await session.drainCommands();

  assert.equal(rec.failures.length, 1, 'a throwing write is a genuine failure');
  assert.equal(rec.failures[0]!.id, 77);
  assert.equal(
    rec.failures[0]!.cause,
    'transport',
    'the device never saw this, so it says nothing about our password',
  );
  assert.deepEqual(rec.audits, [], 'nothing was sent, so nothing should be audited as sent');

  socket.destroy();
});

test('a dead socket leaves the command queued rather than claiming it', async () => {
  const { socket, session, rec } = await identifiedSession([unlock]);
  socket.destroyed = true;

  await session.drainCommands();

  // Nothing is claimed, so the command keeps its place in the queue and goes
  // out when the truck reconnects. Recording anything here would be a claim
  // about an exchange that never started.
  assert.deepEqual(rec.audits, []);
  assert.deepEqual(rec.failures, []);
});

test('a socket that dies between the claim and the write fails as transport', async () => {
  // The window the pre-write destroyed check exists for. The command has
  // already been marked sent in the database by the claim, so leaving it
  // untouched would strand it; it never reached the wire, so 'transport' is
  // the truthful cause.
  const socket = new FakeSocket();
  const { deps, rec } = makeDeps([]);
  const dying = {
    ...deps.store,
    // The connection drops while the claim is in flight.
    claimPendingCommands: async () => { socket.destroyed = true; return [unlock]; },
  } as unknown as SessionDeps['store'];

  const session = new DeviceSession(socket as unknown as Socket, {
    onIdentified: async () => true,
    onClosed: () => {},
  }, { store: dying, checkArrivalUnlocks: deps.checkArrivalUnlocks });

  socket.emit('data', buildPositionFrame({
    deviceId: DEVICE, lat: 32.8872, lon: 13.1913, speedKph: 0, headingDeg: 0,
    mileageKm: 1000, batteryPercent: 80, motorLocked: true, ropeInserted: true, serial: 1,
  }));
  await settle();
  // The drain that fires on identify has already run; reset and do the one
  // this test is actually about.
  socket.destroyed = false;
  rec.audits.length = 0;
  rec.failures.length = 0;

  await session.drainCommands();

  assert.equal(rec.failures.length, 1);
  assert.equal(rec.failures[0]!.cause, 'transport');
  assert.deepEqual(rec.audits, [], 'nothing reached the wire, so nothing is audited as sent');
});

test('an accepted write is audited as sent exactly once', async () => {
  const { socket, session, rec } = await identifiedSession([unlock]);

  await session.drainCommands();

  assert.deepEqual(rec.failures, []);
  assert.equal(rec.audits.filter((a) => a.action === 'command_sent').length, 1);

  socket.destroy();
});

test('only a device rejection can lock an operator out', () => {
  const routes = readFileSync(root + 'src/api/routes.ts', 'utf8');
  const query = /SELECT count\(\*\)::int AS failures[\s\S]*?`/.exec(routes);
  assert.ok(query, 'the repeated-failure count is gone or has changed shape');
  assert.match(
    query[0]!,
    /failure_cause = 'device_rejected'/,
    'a broken socket must not count toward the lockout',
  );
  assert.doesNotMatch(query[0]!, /'uncertain'/, 'an uncertain command says nothing about the password');
});

test('the historical rows are reclassified, or the lockout survives its own fix', () => {
  // Fixing the code stops new rows appearing. Two old 'socket write failed'
  // rows still refuse the operator's next unlock until they are reclassified.
  const migration = readFileSync(root + 'migrations/016_classify_historical_failures.sql', 'utf8');
  assert.match(migration, /last_error = 'socket write failed'/);
  assert.match(migration, /SET failure_cause = 'transport'/);
  // Never guess a password rejection onto a row that may not have been one.
  assert.doesNotMatch(migration, /SET failure_cause = 'device_rejected'/);
});

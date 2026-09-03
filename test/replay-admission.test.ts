/**
 * What happens when a truck comes back from a coverage gap.
 *
 * The JT701D buffers positions while out of coverage and dumps them the moment
 * it reconnects. Four hours of gap is ~480 frames from one device; a regional
 * outage returning two hundred trucks together is ~96,000; a gateway restart
 * with the whole fleet reconnecting is roughly 5,000 frames a second — fifty
 * times the steady-state peak this was originally sized against.
 *
 * Two properties keep that survivable, and both are asserted here: the ack does
 * not wait on the database, and one device's backlog cannot take the pool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { buildPositionFrame } from '../scripts/build-frames.ts';
import { FakeSocket, settle } from './fake-socket.ts';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
// Small enough to reach quickly in a test, large enough that the live-frame
// cases below are nowhere near it.
process.env.GATEWAY_REPLAY_FRAMES_PER_SEC = '4';

const { DeviceSession } = await import('../src/gateway/session.ts');
type SessionDeps = import('../src/gateway/session.ts').SessionDeps;

const DEVICE = '8000620011';

/**
 * dataType 3 is blind-area data: recorded with no coverage and replayed later.
 * Everything else here is a live frame.
 */
const frame = (serial: number, dataType = 1): Buffer =>
  buildPositionFrame({
    deviceId: DEVICE, lat: 32.8872, lon: 13.1913, speedKph: 40, headingDeg: 90,
    mileageKm: 1000 + serial, batteryPercent: 80, motorLocked: true,
    ropeInserted: true, serial, dataType,
  });

interface Harness {
  socket: FakeSocket;
  acks: number[];
  inserted: number[];
}

function harness(insertDelayMs = 0): Harness {
  const socket = new FakeSocket();
  const acks: number[] = [];
  const inserted: number[] = [];

  const origWrite = socket.write.bind(socket);
  socket.write = (buf: Buffer | string): boolean => {
    acks.push(inserted.length);
    return origWrite(buf);
  };

  const store = {
    isKnownDevice: async () => true,
    setConnected: async () => {},
    insertPosition: async (p: { mileageKm: number }) => {
      if (insertDelayMs) await new Promise((r) => setTimeout(r, insertDelayMs));
      inserted.push(p.mileageKm);
      return true;
    },
    updateDeviceState: async () => {},
    claimPendingCommands: async () => [],
    audit: async () => {},
    recordRejectedFrame: async () => {},
  } as unknown as SessionDeps['store'];

  new DeviceSession(socket as unknown as Socket, {
    onIdentified: async () => true,
    onClosed: () => {},
  }, { store, checkArrivalUnlocks: (async () => []) as unknown as SessionDeps['checkArrivalUnlocks'] });

  return { socket, acks, inserted };
}

test('the ack does not wait on a slow database', async () => {
  // 80ms per insert. If the ack were behind persistence it would land after
  // the write; the device would re-send in the meantime, which is the loop.
  const h = harness(80);
  h.socket.emit('data', frame(1));
  await settle(30);

  assert.equal(h.acks.length, 1, 'the frame should be acked while the insert is still in flight');
  assert.equal(h.acks[0], 0, 'nothing should have been persisted at the moment of the ack');
  assert.equal(h.inserted.length, 0);

  await settle(150);
  assert.equal(h.inserted.length, 1, 'and the write still happens');
  h.socket.destroy();
});

test('a replayed backlog is paced, and nothing in it is dropped', async () => {
  const h = harness();
  // Ten blind-area frames against a limit of four per second.
  for (let i = 1; i <= 10; i++) h.socket.emit('data', frame(i, 3));

  await settle(200);
  assert.ok(
    h.inserted.length <= 5,
    `expected the backlog to be held back, but ${h.inserted.length} frames went straight through`,
  );

  // Paced, not discarded: replayed positions are real history.
  await settle(2200);
  assert.equal(h.inserted.length, 10, 'every replayed frame must eventually be persisted');
  h.socket.destroy();
});

test('live frames are never throttled', async () => {
  // The trucks somebody is actually watching must not queue behind a backlog.
  const h = harness();
  for (let i = 1; i <= 10; i++) h.socket.emit('data', frame(i, 1));

  await settle(200);
  assert.equal(h.inserted.length, 10, 'real-time reporting must pass through unpaced');
  h.socket.destroy();
});

test('a replayed frame is still acked immediately, throttle or not', async () => {
  // Throttling the writes must not throttle the acks: an unacked frame is a
  // frame the device re-sends, which is the loop this exists to break.
  const h = harness();
  for (let i = 1; i <= 10; i++) h.socket.emit('data', frame(i, 3));

  await settle(200);
  assert.ok(
    h.acks.length > h.inserted.length,
    `acks (${h.acks.length}) should outrun persisted frames (${h.inserted.length})`,
  );
  h.socket.destroy();
});

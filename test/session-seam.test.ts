/**
 * The first test that drives a DeviceSession rather than a decoder.
 *
 * Its job is to prove the injection seam works end to end — a session built
 * with stub dependencies persists, acks and identifies without a database
 * anywhere near it. The concurrency and command-lifecycle assertions the plan
 * calls for (plan items 1.1 and 1.2) build on this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { buildPositionFrame } from '../scripts/build-frames.ts';
import { FakeSocket, settle } from './fake-socket.ts';

/*
 * Injecting the store is necessary but not sufficient: session.ts also imports
 * config.ts, which throws on a missing DATABASE_URL at module load. So the
 * import has to come after the variable exists, which means a dynamic one.
 *
 * Nothing connects. `pg.Pool` builds lazily and no query is ever issued on this
 * path, so the URL only has to parse. Making config lazy would remove the need
 * for this, and is worth doing when more of the gateway comes under test.
 */
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';

const { DeviceSession } = await import('../src/gateway/session.ts');
type SessionDeps = import('../src/gateway/session.ts').SessionDeps;

const DEVICE = '8000620011';

interface Calls {
  insertPosition: number;
  updateDeviceState: number;
  identifications: number;
  arrivals: number;
  order: string[];
}

function makeDeps(): { deps: SessionDeps; calls: Calls } {
  const calls: Calls = {
    insertPosition: 0,
    updateDeviceState: 0,
    identifications: 0,
    arrivals: 0,
    order: [],
  };

  const store = {
    setConnected: async () => { calls.order.push('setConnected'); },
    insertPosition: async () => {
      calls.insertPosition++;
      calls.order.push('insertPosition');
      return true;
    },
    updateDeviceState: async () => {
      calls.updateDeviceState++;
      calls.order.push('updateDeviceState');
    },
    claimPendingCommands: async () => [],
    audit: async () => {},
    recordProbe: async () => {},
  } as unknown as SessionDeps['store'];

  const checkArrivalUnlocks = (async () => {
    calls.arrivals++;
    return [];
  }) as unknown as SessionDeps['checkArrivalUnlocks'];

  return { deps: { store, checkArrivalUnlocks }, calls };
}

function positionFrame(serial: number): Buffer {
  return buildPositionFrame({
    deviceId: DEVICE,
    lat: 32.8872,
    lon: 13.1913,
    speedKph: 40,
    headingDeg: 90,
    mileageKm: 1000,
    batteryPercent: 80,
    motorLocked: true,
    ropeInserted: true,
    serial,
  });
}


test('a session runs on injected dependencies, with no database', async () => {
  const socket = new FakeSocket();
  const { deps, calls } = makeDeps();
  let identified: string | null = null;

  new DeviceSession(socket as unknown as Socket, {
    onIdentified: async (id) => { identified = id; return true; },
    onClosed: () => {},
  }, deps);

  socket.emit('data', positionFrame(1));
  await settle();

  assert.equal(identified, DEVICE, 'the session should identify from the first frame');
  assert.equal(calls.insertPosition, 1);
  assert.equal(calls.updateDeviceState, 1);
  assert.ok(socket.written.length > 0, 'the device should be acked');

  socket.destroy();
});

test('the device is acked before the position is persisted', async () => {
  const socket = new FakeSocket();
  const { deps } = makeDeps();

  /*
   * The ordering that breaks the retransmit amplifier.
   *
   * The device re-sends until acknowledged. With the ack behind two awaited
   * round trips against a pool of ten, database latency caused retransmits,
   * retransmits caused more load, and that caused more latency — engaging
   * precisely when the pool was already saturated.
   *
   * Pinned as a test because it is invisible in normal operation and reverting
   * it would look like a harmless tidy-up.
   */
  const events: string[] = [];
  const tracking = {
    ...deps.store,
    insertPosition: async () => { events.push('insertPosition'); return true; },
    updateDeviceState: async () => { events.push('updateDeviceState'); },
  } as unknown as SessionDeps['store'];

  const s = new FakeSocket();
  const origWrite = s.write.bind(s);
  s.write = (buf: Buffer | string) => { events.push('ack'); return origWrite(buf); };

  new DeviceSession(s as unknown as Socket, {
    onIdentified: async () => true,
    onClosed: () => {},
  }, { store: tracking, checkArrivalUnlocks: deps.checkArrivalUnlocks });

  s.emit('data', positionFrame(2));
  await settle();

  assert.deepEqual(
    events,
    ['ack', 'insertPosition', 'updateDeviceState'],
    'the ack must not wait on the database, or slow queries generate more inbound frames',
  );

  socket.destroy();
  s.destroy();
});

test('two frames in one chunk are both handled', async () => {
  const socket = new FakeSocket();
  const { deps, calls } = makeDeps();

  new DeviceSession(socket as unknown as Socket, {
    // Admission is the registry's, and it is one database round trip, so it
    // must happen once per socket however many frames arrive together.
    onIdentified: async () => { calls.identifications++; return true; },
    onClosed: () => {},
  }, deps);

  socket.emit('data', Buffer.concat([positionFrame(3), positionFrame(4)]));
  await settle();

  assert.equal(calls.insertPosition, 2, 'both frames in the chunk should persist');
  assert.equal(calls.identifications, 1, 'the device should be identified exactly once');

  socket.destroy();
});

/**
 * Which command a device response answers.
 *
 * The old rule was "the most recent open command with a matching command word".
 * With one command outstanding that is right by luck. With two it is a coin
 * toss, and losing it files one truck's valve opening against another truck's
 * unlock — a confident wrong record in the trail the Ministry relies on.
 *
 * The rule now: use the serial where the protocol carries one, and where it
 * does not, refuse. Refusing leaves both commands 'uncertain', which is worse
 * to look at and better to be.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { decodeAsciiFrame } from '../src/protocol/decode-ascii.ts';
import { buildPositionFrame } from '../scripts/build-frames.ts';
import { FakeSocket, settle } from './fake-socket.ts';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';

const { DeviceSession } = await import('../src/gateway/session.ts');
type SessionDeps = import('../src/gateway/session.ts').SessionDeps;
type MatchedCommand = import('../src/gateway/store.ts').MatchedCommand;

const DEVICE = '8055430364';

// --- The serial the decoder used to throw away ------------------------------

const ascii = (s: string) => decodeAsciiFrame(Buffer.from(s, 'latin1'));

test('a WLNET reply carries its serial through to the decoder', () => {
  const reply = ascii('(8055430364,1,001,WLNET,8,0,E03B60000A)');
  assert.equal(reply.kind, 'command_response');
  if (reply.kind === 'command_response') {
    assert.equal(reply.command, 'WLNET,8');
    // Without this the platform has nothing at all to tell two outstanding
    // sub-lock unlocks apart.
    assert.equal(reply.serial, '001');
  }
});

test('a P-command response has no serial, and says so rather than inventing one', () => {
  const reply = ascii('(8130630001,P43,1,0)');
  assert.equal(reply.kind, 'command_response');
  if (reply.kind === 'command_response') assert.equal(reply.serial, null);
});

// --- What the session does with the match -----------------------------------

interface Recorded {
  applied: { id: number; ok: boolean }[];
  unresolvable: number[][];
  promoted: number[];
  audits: string[];
}

function makeDeps(match: { matched: MatchedCommand | null; candidates: MatchedCommand[] }): {
  deps: SessionDeps;
  rec: Recorded;
} {
  const rec: Recorded = { applied: [], unresolvable: [], promoted: [], audits: [] };
  const store = {
    isKnownDevice: async () => true,
    setConnected: async () => {},
    insertPosition: async () => true,
    updateDeviceState: async () => {},
    claimPendingCommands: async () => [],
    audit: async (action: string) => { rec.audits.push(action); },
    matchCommandForResponse: async () => match,
    applyCommandResponse: async (id: number, ok: boolean) => { rec.applied.push({ id, ok }); },
    markCommandsUnresolvable: async (ids: number[]) => { rec.unresolvable.push(ids); },
    promotePendingPassword: async (_d: string, id: number) => { rec.promoted.push(id); return '654321'; },
    queueLockStateRefresh: async () => {},
    recordFirmware: async () => {},
    recordBoundPeripherals: async () => {},
  } as unknown as SessionDeps['store'];

  const checkArrivalUnlocks = (async () => []) as unknown as SessionDeps['checkArrivalUnlocks'];
  return { deps: { store, checkArrivalUnlocks }, rec };
}


/** Identify a session, then feed it one ASCII response frame. */
async function respond(
  frame: string,
  match: { matched: MatchedCommand | null; candidates: MatchedCommand[] },
): Promise<Recorded> {
  const socket = new FakeSocket();
  const { deps, rec } = makeDeps(match);
  new DeviceSession(socket as unknown as Socket, {
    onIdentified: async () => true,
    onClosed: () => {},
  }, deps);

  socket.emit('data', buildPositionFrame({
    deviceId: DEVICE, lat: 32.8872, lon: 13.1913, speedKph: 0, headingDeg: 0,
    mileageKm: 1000, batteryPercent: 80, motorLocked: true, ropeInserted: true, serial: 1,
  }));
  await settle();
  rec.audits.length = 0;

  socket.emit('data', Buffer.from(frame, 'latin1'));
  await settle();
  socket.destroy();
  return rec;
}

const unlockA: MatchedCommand = { id: 101, command_type: 'unlock_static' };
const unlockB: MatchedCommand = { id: 102, command_type: 'unlock_static' };

test('two open unlocks and one response confirm neither', async () => {
  const rec = await respond(`(${DEVICE},P43,1,0)`, {
    matched: null,
    candidates: [unlockA, unlockB],
  });

  assert.deepEqual(rec.applied, [], 'neither command may be confirmed on a guess');
  assert.deepEqual(rec.unresolvable, [[101, 102]], 'both must be recorded as unresolvable');
});

test('one open unlock resolves normally', async () => {
  const rec = await respond(`(${DEVICE},P43,1,0)`, {
    matched: unlockA,
    candidates: [unlockA],
  });

  assert.deepEqual(rec.applied, [{ id: 101, ok: true }]);
  assert.deepEqual(rec.unresolvable, []);
});

test('a refused unlock is recorded as refused, against the right command', async () => {
  const rec = await respond(`(${DEVICE},P43,0,3)`, {
    matched: unlockA,
    candidates: [unlockA],
  });

  assert.deepEqual(rec.applied, [{ id: 101, ok: false }]);
  assert.ok(rec.audits.includes('unlock_refused'));
});

test('a P44 "1" adopts the password of the rotation it actually answers', async () => {
  const rotation: MatchedCommand = { id: 55, command_type: 'set_password' };
  const rec = await respond(`(${DEVICE},P44,1)`, {
    matched: rotation,
    candidates: [rotation],
  });

  assert.deepEqual(rec.promoted, [55], 'adoption must key off the matched command, not the newest');
  assert.ok(rec.audits.includes('password_rotated'));
});

test('a P44 "1" that cannot be tied to one rotation adopts nothing', async () => {
  // A query_password and a set_password both outstanding. "1" read against the
  // wrong one adopts a password the device never took — and locks the platform
  // out of its own hardware, with no way back but a physical visit.
  const rotation: MatchedCommand = { id: 55, command_type: 'set_password' };
  const query: MatchedCommand = { id: 56, command_type: 'query_password' };
  const rec = await respond(`(${DEVICE},P44,1)`, {
    matched: null,
    candidates: [rotation, query],
  });

  assert.deepEqual(rec.promoted, [], 'no password may be adopted on an ambiguous response');
  assert.ok(rec.audits.includes('password_rotation_unresolved'));
  assert.deepEqual(rec.unresolvable, [[55, 56]]);
});

test('a P44 answering a query does not adopt anything', async () => {
  const query: MatchedCommand = { id: 56, command_type: 'query_password' };
  // The device answering a read with the digit 1 is not a rotation.
  const rec = await respond(`(${DEVICE},P44,1)`, { matched: query, candidates: [query] });

  assert.deepEqual(rec.promoted, []);
  assert.deepEqual(rec.applied, [{ id: 56, ok: true }]);
});

test('a WLNET reply is resolved through the session like any other response', async () => {
  const relay: MatchedCommand = { id: 90, command_type: 'unlock_sublock' };
  const rec = await respond(`(${DEVICE},1,001,WLNET,8,0,E03B60000A)`, {
    matched: relay,
    candidates: [relay],
  });

  // The WLNET,8 reply is a bare echo — it closes the exchange and proves
  // nothing about the valve. The evidence comes later, from the sub-lock.
  assert.deepEqual(rec.applied, [{ id: 90, ok: true }]);
});

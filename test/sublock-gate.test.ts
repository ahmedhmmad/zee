/**
 * Retracting valve sub-lock unlocking, and cancelling what an arrival rule
 * spawned.
 *
 * A JT709 valve unlock has no confirmation path. The WLNET,8 reply is a bare
 * echo from the master, and a sleeping sub-lock reports nothing at all — so the
 * platform can queue an unlock, watch it sit for hours, and never be able to
 * say whether a valve opened. Until a bench test on real hardware says whether
 * a LoRa heartbeat wake collects a queued unlock, the capability is off.
 *
 * Turning a shipped capability off takes more than a flag. Rules armed with
 * sub-locks are already in the table, relays are already queued, and an
 * operator who ticked a box needs to be told why it stopped being true.
 *
 * This file runs with the gate in its default state: OFF.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { buildPositionFrame } from '../scripts/build-frames.ts';
import { FakeSocket, settle } from './fake-socket.ts';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
delete process.env.SUBLOCK_UNLOCK_ENABLED;

const { DeviceSession } = await import('../src/gateway/session.ts');
const { config } = await import('../src/config.ts');
type SessionDeps = import('../src/gateway/session.ts').SessionDeps;

const DEVICE = '8055430364';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(root + p, 'utf8');

test('sub-lock unlocking is off unless someone deliberately turns it on', () => {
  assert.equal(config.subLockUnlockEnabled, false);
});

// --- The gateway will not put one on the wire -------------------------------

interface Recorded {
  expired: { id: number; reason: string }[];
  audits: string[];
}


async function drain(pending: unknown[]): Promise<{ socket: FakeSocket; rec: Recorded }> {
  const rec: Recorded = { expired: [], audits: [] };
  const socket = new FakeSocket();
  // Queued only after identification: the session drains on identify, so
  // anything waiting beforehand would go out on that drain instead.
  const queue: unknown[] = [];
  const store = {
    isKnownDevice: async () => true,
    setConnected: async () => {},
    insertPosition: async () => true,
    updateDeviceState: async () => {},
    claimPendingCommands: async () => queue.splice(0, queue.length),
    expireCommand: async (id: number, reason: string) => { rec.expired.push({ id, reason }); },
    markCommandFailed: async () => {},
    audit: async (action: string) => { rec.audits.push(action); },
  } as unknown as SessionDeps['store'];

  const session = new DeviceSession(socket as unknown as Socket, {
    onIdentified: async () => true,
    onClosed: () => {},
  }, { store, checkArrivalUnlocks: (async () => []) as unknown as SessionDeps['checkArrivalUnlocks'] });

  socket.emit('data', buildPositionFrame({
    deviceId: DEVICE, lat: 32.8872, lon: 13.1913, speedKph: 0, headingDeg: 0,
    mileageKm: 1000, batteryPercent: 80, motorLocked: true, ropeInserted: true, serial: 1,
  }));
  await settle();
  queue.push(...pending);
  socket.written.length = 0;
  rec.audits.length = 0;
  rec.expired.length = 0;

  await session.drainCommands();
  return { socket, rec };
}

test('a sub-lock unlock queued before the gate went up is never delivered', async () => {
  const { socket, rec } = await drain([
    {
      id: 300,
      device_id: DEVICE,
      command_type: 'unlock_sublock',
      payload: '(8055430364,1,004,WLNET,8,1,1,5,E03B60000A)',
    },
  ]);

  assert.equal(socket.written.length, 0, 'nothing may go on the wire for a gated capability');
  assert.equal(rec.expired.length, 1, 'it must be retired, not left in the queue to fire later');
  assert.equal(rec.expired[0]!.id, 300);
  assert.ok(rec.audits.includes('sublock_unlock_suppressed'));
  assert.ok(!rec.audits.includes('command_sent'));
});

test('the master unlock is untouched by the sub-lock gate', async () => {
  const { socket, rec } = await drain([
    { id: 301, device_id: DEVICE, command_type: 'unlock_static', payload: '(P43,123456)' },
  ]);

  assert.equal(socket.written.length, 1, 'gating valves must not gate the master lock');
  assert.deepEqual(rec.expired, []);
  assert.ok(rec.audits.includes('command_sent'));
});

// --- The routes and the migration -------------------------------------------

test('the routes refuse, with a reason a dispatcher can act on', () => {
  const routes = read('src/api/routes.ts');
  assert.match(routes, /if \(!config\.subLockUnlockEnabled\) return reply\.code\(409\)\.send\(subLockGateRefusal\(\)\)/);
  // Arming a rule with sub-locks is refused too, not silently downgraded: a
  // rule that quietly drops the valves leaves an operator at the depot gate
  // with no idea why they are shut.
  assert.match(routes, /includeSubLocks && !config\.subLockUnlockEnabled/);

  const refusal = /function subLockGateRefusal[\s\S]*?\n\}/.exec(routes);
  assert.ok(refusal, 'subLockGateRefusal not found');
  assert.match(refusal[0]!, /reason:/, 'a bare error code reads as a malfunction');
  assert.match(refusal[0]!, /[؀-ۿ]/, 'the reason must be in Arabic, like the rest of the console');
});

test('the console hides what the server will refuse', () => {
  const app = read('public/app.js');
  assert.match(app, /state\.subLockUnlockEnabled = subLockUnlockEnabled === true/);
  assert.match(app, /unlockEnabled &&/, 'the per-sub-lock unlock button is gated');
  // A checkbox hidden by CSS can still be checked from a previous session.
  assert.match(app, /includeSubLocks: state\.subLockUnlockEnabled && /);
  assert.match(read('public/index.html'), /id="arrival-sublocks-line" hidden/);
});

test('rules and relays already out in the field are dealt with explicitly', () => {
  const m = read('migrations/017_arrival_command_link.sql');

  // Queued relays are retired — they are exactly the commands that fire hours
  // later with nobody watching.
  assert.match(m, /UPDATE commands\s+SET status = 'expired'[\s\S]*?command_type = 'unlock_sublock'/);
  // Armed rules are downgraded rather than left to spawn more.
  assert.match(m, /UPDATE arrival_unlocks\s+SET include_sublocks = false/);
  // And both are recorded, because an operator who ticked the box has to be
  // able to find out why it stopped being true.
  assert.match(m, /'arrival_sublocks_suppressed'/);
  assert.match(m, /'sublock_unlock_suppressed'/);
});

// --- Disarming cancels everything the rule spawned ---------------------------

test('a disarmed rule cancels every command it spawned, not just the master', () => {
  const routes = read('src/api/routes.ts');
  const disarm = /app\.delete\('\/api\/devices\/:id\/arrivals\/:arrivalId'[\s\S]*?\n  \}\);/.exec(routes);
  assert.ok(disarm, 'the disarm route is gone or has changed shape');

  // triggered_command_id holds one id — the master's. The N sub-lock relays
  // were recorded nowhere, so cancelling by that column left them armed.
  assert.match(disarm[0]!, /triggered_by_arrival_id = \$1/);
  assert.doesNotMatch(disarm[0]!, /triggered_command_id/);
});

test('commands that are past recall are reported rather than glossed over', () => {
  const routes = read('src/api/routes.ts');
  const disarm = /app\.delete\('\/api\/devices\/:id\/arrivals\/:arrivalId'[\s\S]*?\n  \}\);/.exec(routes)![0]!;
  // An empty `cancelled` list must not be readable as "nothing was queued"
  // when it means "it has all already gone out" — the operator has to know to
  // go and physically check.
  assert.match(disarm, /beyondRecall/);
  assert.match(disarm, /status IN \('queued', 'approved', 'draft', 'pending_approval'\)/);
});

test('every command an arrival rule spawns carries the rule', () => {
  const arrivals = read('src/gateway/arrivals.ts');
  const inserts = [...arrivals.matchAll(/INSERT INTO commands \(([^)]*)\)/g)];
  assert.ok(inserts.length >= 2, 'expected both the master unlock and the sub-lock relay');
  for (const m of inserts) {
    assert.match(m[1]!, /triggered_by_arrival_id/, `an arrival insert does not record its rule: ${m[0]}`);
  }
});

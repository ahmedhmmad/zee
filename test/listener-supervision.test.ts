/**
 * The LISTEN/NOTIFY connection, supervised.
 *
 * Unsupervised, this was a single point of silent failure. If it dropped,
 * command dispatch degraded to the 60-second sweep permanently: an operator's
 * unlock would take up to a minute to reach a truck instead of going out at
 * once, and the only trace was one console.error nobody was watching.
 *
 * The failure that matters is not the one that raises 'error'. It is a
 * half-open TCP connection — far side gone, no FIN, no RST — where the socket
 * stays open forever and simply never delivers another notification. Nothing
 * fires for that. Only sending something detects it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
const { createListener } = await import('../src/db.ts');

const root = fileURLToPath(new URL('..', import.meta.url));

/** A pg.Client that never touches a network. */
class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  connectFails = false;
  queryFails = false;

  async connect(): Promise<void> {
    if (this.connectFails) throw new Error('ECONNREFUSED');
  }
  async query(sql: string): Promise<unknown> {
    if (this.queryFails) throw new Error('connection terminated');
    this.queries.push(sql);
    return { rows: [] };
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

/** Hand out a fresh client per connection attempt, keeping every one. */
function clientFactory(): { make: () => pg.Client; made: FakeClient[] } {
  const made: FakeClient[] = [];
  return {
    make: () => {
      const c = new FakeClient();
      made.push(c);
      return c as unknown as pg.Client;
    },
    made,
  };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a listener starts connected and listening on its channel', async () => {
  const { make, made } = clientFactory();
  const listener = await createListener('command_queued', () => {}, { createClient: make });

  assert.equal(listener.connected, true);
  assert.deepEqual(made[0]!.queries, ['LISTEN command_queued']);

  await listener.close();
  assert.equal(listener.connected, false);
  assert.equal(made[0]!.ended, true);
});

test('notifications on the channel reach the caller; others do not', async () => {
  const { make, made } = clientFactory();
  const seen: string[] = [];
  const listener = await createListener('command_queued', (p) => seen.push(p), { createClient: make });

  made[0]!.emit('notification', { channel: 'command_queued', payload: '8000620011' });
  made[0]!.emit('notification', { channel: 'device_update', payload: 'not ours' });
  made[0]!.emit('notification', { channel: 'command_queued', payload: '' });

  assert.deepEqual(seen, ['8000620011']);
  await listener.close();
});

test('a dropped connection reconnects and re-LISTENs', async () => {
  const { make, made } = clientFactory();
  let reconnects = 0;
  const listener = await createListener('command_queued', () => {}, {
    createClient: make,
    onReconnect: () => reconnects++,
  });

  made[0]!.emit('error', new Error('connection terminated unexpectedly'));
  // Reported down immediately: /api/health must not keep claiming a listener
  // that is not there.
  assert.equal(listener.connected, false);

  await settle(900);

  assert.equal(made.length, 2, 'a new client should have been built');
  assert.deepEqual(made[1]!.queries, ['LISTEN command_queued'], 'LISTEN does not survive a reconnect');
  assert.equal(listener.connected, true);
  assert.equal(reconnects, 1, 'the caller has to be told, because NOTIFY has no replay');

  await listener.close();
});

test('a failed reconnect keeps trying, with backoff', async () => {
  const made: FakeClient[] = [];
  let attempt = 0;
  const make = (): pg.Client => {
    const c = new FakeClient();
    // First reconnect attempt fails; the one after it succeeds.
    c.connectFails = attempt === 1;
    attempt++;
    made.push(c);
    return c as unknown as pg.Client;
  };

  const listener = await createListener('command_queued', () => {}, { createClient: make });
  made[0]!.emit('error', new Error('gone'));

  await settle(2500);

  assert.ok(made.length >= 3, `expected repeated attempts, got ${made.length}`);
  assert.equal(listener.connected, true, 'it must recover rather than give up');
  await listener.close();
});

test('closing stops the supervision rather than reconnecting forever', async () => {
  const { make, made } = clientFactory();
  const listener = await createListener('command_queued', () => {}, { createClient: make });

  await listener.close();
  // A close emits 'end' on a real client, which must not be read as a fault.
  made[0]!.emit('end');
  await settle(900);

  assert.equal(made.length, 1, 'a closed listener must not build another client');
  assert.equal(listener.connected, false);
});

test('the heartbeat is the only thing that can detect a half-open connection', () => {
  const db = readFileSync(root + 'src/db.ts', 'utf8');
  // No event fires for a socket whose far side has gone without a FIN. Only a
  // round trip that fails reveals it.
  assert.match(db, /setInterval\(\(\) => \{[\s\S]*?SELECT 1[\s\S]*?scheduleReconnect/);
  assert.match(db, /LISTENER_HEARTBEAT_MS/);
  // Capped, or a database that is down for an hour is retried every 30s from
  // 500ms of backoff and never gets there.
  assert.match(db, /Math\.min\(backoffMs \* 2, LISTENER_BACKOFF_MAX_MS\)/);
});

test('both callers catch up after a reconnect', () => {
  // Everything that happened while the connection was down was missed.
  const gateway = readFileSync(root + 'src/gateway/index.ts', 'utf8');
  const api = readFileSync(root + 'src/api/server.ts', 'utf8');

  // The gateway sweeps at once rather than leaving a queued unlock to wait for
  // the next tick.
  assert.match(gateway, /onReconnect: \(\) => \{[\s\S]*?void sweep\(\)/);
  // The API nudges every console, which is otherwise showing a fleet frozen at
  // the moment the connection dropped, with nothing saying so.
  assert.match(api, /onReconnect: \(\) => \{[\s\S]*?broadcast\(JSON\.stringify\(\{ kind: 'resync' \}\)\)/);
});

test('health reports the listener rather than a copy of it', () => {
  const gateway = readFileSync(root + 'src/gateway/index.ts', 'utf8');
  // A mirrored boolean goes stale exactly when it matters, because the failure
  // being supervised emits no event to update it from.
  assert.match(gateway, /listenerConnected: listener\?\.connected \?\? false/);
});

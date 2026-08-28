/**
 * Drive N fake locks against the gateway, in one process.
 *
 * This is the instrument every capacity claim in docs/scaling-plan.md is
 * measured with. Nothing in Phase 1 is verifiable without it: "one server holds
 * 3,000 devices" is not a statement you can check by reasoning about the code.
 *
 *   node --env-file-if-exists=.env scripts/simulate-fleet.ts [options]
 *
 *   --count <n>        devices to run          (default 100)
 *   --first <id>       first device id         (default 8000620011)
 *   --host <host>      gateway host            (default 127.0.0.1)
 *   --port <port>      gateway port            (default 10001)
 *   --interval <ms>    reporting interval      (default 30000)
 *   --ramp <ms>        spread connections over (default 60000)
 *   --burst            after the ramp, take the fleet through a blind area and
 *                      let it all reconnect and replay at once
 *   --burst-after <ms> when to start the burst (default 120000)
 *   --blind <ms>       how long the fleet stays out of coverage (default 240000)
 *   --duration <ms>    stop after this long    (default: run until killed)
 *
 * Ramp exists because connecting 3,000 sockets in one tick measures the ramp,
 * not the platform. Burst exists because the steady state was never the hard
 * part — see the load table in the plan: a restart plus blind-area replay is
 * roughly fifty times the steady peak, and that is the number Phase 1 has to
 * survive.
 *
 * ---------------------------------------------------------------------------
 * NEVER POINT THIS AT PRODUCTION.
 *
 * The gateway's allowlist (devices.is_active) is the only authentication the
 * device protocol has. Making these ids work means inserting them into a
 * `devices` table, and a production table with three thousand fake tankers in
 * it is no longer an allowlist. Use a staging database, and see the note this
 * script prints on startup.
 * ---------------------------------------------------------------------------
 */

import { SimulatedDevice, type SimEvent } from './simulated-device.ts';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

function str(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const count = arg('count', 100);
const firstId = str('first', '8000620011');
const host = str('host', process.env.SIM_HOST ?? '127.0.0.1');
const port = arg('port', Number(process.env.SIM_PORT ?? process.env.GATEWAY_PORT ?? 10001));
const intervalMs = arg('interval', 30_000);
const rampMs = arg('ramp', 60_000);
const burst = process.argv.includes('--burst');
const burstAfterMs = arg('burst-after', 120_000);
const blindMs = arg('blind', 240_000);
const durationMs = arg('duration', 0);

/** Device ids are ten digits; increment the numeric tail of the first one. */
function deviceIdAt(index: number): string {
  const n = BigInt(firstId) + BigInt(index);
  return n.toString().padStart(firstId.length, '0');
}

const stats = {
  connected: 0,
  disconnected: 0,
  positions: 0,
  replayed: 0,
  replayFrames: 0,
  unlocksAccepted: 0,
  unlocksRejected: 0,
  errors: 0,
  errorSamples: new Map<string, number>(),
};

function onEvent(e: SimEvent): void {
  switch (e.kind) {
    case 'connected': stats.connected++; break;
    case 'disconnected': stats.disconnected++; break;
    case 'position': stats.positions++; break;
    case 'replayed':
      stats.replayed++;
      stats.replayFrames += e.count ?? 0;
      break;
    case 'unlock-accepted': stats.unlocksAccepted++; break;
    case 'unlock-rejected': stats.unlocksRejected++; break;
    case 'error': {
      stats.errors++;
      const key = e.detail ?? 'unknown';
      stats.errorSamples.set(key, (stats.errorSamples.get(key) ?? 0) + 1);
      break;
    }
  }
}

const devices: SimulatedDevice[] = [];
for (let i = 0; i < count; i++) {
  devices.push(
    new SimulatedDevice({
      deviceId: deviceIdAt(i),
      host,
      port,
      intervalMs,
      // Spread the fleet around the route so they are not one stack of markers,
      // and so position writes are not all for the same coordinates.
      routeOffset: i % 9,
      verbose: false,
      onEvent,
    }),
  );
}

console.log('---------------------------------------------------------------');
console.log(`  fleet simulator: ${count} devices -> ${host}:${port}`);
console.log(`  ids ${deviceIdAt(0)} .. ${deviceIdAt(count - 1)}`);
console.log(`  interval ${intervalMs}ms, ramped over ${rampMs}ms`);
if (burst) console.log(`  burst: blind area at +${burstAfterMs}ms for ${blindMs}ms`);
console.log('');
console.log('  These ids must be on the gateway allowlist to be accepted.');
console.log('  Seed them into a STAGING devices table, never production.');
console.log('---------------------------------------------------------------');

// --- ramp -----------------------------------------------------------------

const gapMs = count > 1 ? rampMs / count : 0;
devices.forEach((device, i) => {
  setTimeout(() => device.connect(), Math.round(i * gapMs));
});

// --- burst ----------------------------------------------------------------

if (burst) {
  setTimeout(() => {
    console.log(`\n>>> blind area: dropping all ${count} devices for ${blindMs}ms`);
    console.log('>>> they keep generating position frames and will replay them on reconnect\n');
    for (const d of devices) d.enterBlindArea();

    setTimeout(() => {
      const pending = devices.reduce((n, d) => n + d.bufferedFrames, 0);
      console.log(`\n>>> coverage restored: ${count} devices reconnecting, ~${pending} buffered frames\n`);
      // Deliberately no ramp here. A regional outage ending does not stagger
      // itself, and this is the case the platform has to absorb.
      for (const d of devices) d.leaveBlindArea();
    }, blindMs);
  }, burstAfterMs);
}

// --- reporting ------------------------------------------------------------

const startedAt = Date.now();
let lastPositions = 0;

const ticker = setInterval(() => {
  const live = devices.filter((d) => d.connected).length;
  const buffered = devices.reduce((n, d) => n + d.bufferedFrames, 0);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const rate = ((stats.positions - lastPositions) / 5).toFixed(1);
  lastPositions = stats.positions;

  console.log(
    `t+${String(elapsed).padStart(4)}s  live ${String(live).padStart(4)}/${count}  ` +
      `pos ${String(stats.positions).padStart(7)} (${rate}/s)  ` +
      `buffered ${String(buffered).padStart(6)}  ` +
      `replayed ${stats.replayFrames}  errors ${stats.errors}`,
  );
}, 5_000);
ticker.unref();

// --- shutdown -------------------------------------------------------------

function summarise(): void {
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log('\n--- fleet summary ---------------------------------------------');
  console.log(`  ran for            ${elapsed.toFixed(0)}s`);
  console.log(`  devices            ${count}`);
  console.log(`  connects           ${stats.connected}`);
  console.log(`  disconnects        ${stats.disconnected}`);
  console.log(`  positions sent     ${stats.positions} (${(stats.positions / elapsed).toFixed(1)}/s average)`);
  console.log(`  replay events      ${stats.replayed}, ${stats.replayFrames} frames`);
  console.log(`  unlocks accepted   ${stats.unlocksAccepted}`);
  console.log(`  unlocks rejected   ${stats.unlocksRejected}`);
  console.log(`  socket errors      ${stats.errors}`);
  for (const [message, n] of stats.errorSamples) {
    console.log(`    ${n} x ${message}`);
  }
  console.log('---------------------------------------------------------------');
}

function shutdown(): void {
  clearInterval(ticker);
  for (const d of devices) d.stop();
  summarise();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (durationMs > 0) setTimeout(shutdown, durationMs);

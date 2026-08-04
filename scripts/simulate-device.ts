/**
 * Fake JT701D for development.
 *
 * Connects to the gateway and behaves like a real lock: reports position on an
 * interval, sends heartbeats, and responds to unlock commands with a P45
 * report the way real firmware does.
 *
 * Drives a loop around Tripoli so the map has something to show.
 *
 *   npm run simulate <deviceId> [host] [port]
 *
 *   npm run simulate 8000620011
 *   npm run simulate 8000620011 gw.ahmedhammad.page
 *
 * Arguments rather than environment variables, so the same line works in
 * cmd.exe, PowerShell and bash without modification.
 */

import net from 'node:net';
import { Framer } from '../src/protocol/framer.ts';
import { buildPositionFrame, buildLockEvent } from './build-frames.ts';

const deviceId = process.argv[2] ?? '8000620011';
const host = process.argv[3] ?? process.env.SIM_HOST ?? '127.0.0.1';
const port = Number(process.argv[4] ?? process.env.SIM_PORT ?? process.env.GATEWAY_PORT ?? 10001);
const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 10_000);
const unlockPassword = process.env.SIM_PASSWORD ?? '888888';

// A rough loop through Tripoli: port area -> city centre -> airport road.
const ROUTE: Array<[lat: number, lon: number]> = [
  [32.8925, 13.1802],
  [32.8872, 13.1913],
  [32.879, 13.2035],
  [32.8654, 13.221],
  [32.8412, 13.2388],
  [32.819, 13.2455],
  [32.8412, 13.2388],
  [32.8654, 13.221],
  [32.879, 13.2035],
];

let step = 0;
let serial = 0;
let mileage = 1200;
let battery = 87;
let motorLocked = true;
let ropeInserted = true;
let autoLockTimer: NodeJS.Timeout | null = null;

const nextSerial = () => (serial = (serial + 1) & 0xff);
const here = (): [number, number] => ROUTE[step % ROUTE.length]!;

const socket = net.createConnection({ host, port }, () => {
  console.log(`[sim ${deviceId}] connected to ${host}:${port}`);
  report();
  setInterval(report, intervalMs);
});

function report(): void {
  const [lat, lon] = here();
  const [nextLat, nextLon] = ROUTE[(step + 1) % ROUTE.length]!;
  const heading = (Math.atan2(nextLon - lon, nextLat - lat) * 180) / Math.PI;
  const speedKph = motorLocked ? 42 + Math.round(Math.random() * 18) : 0;

  socket.write(
    buildPositionFrame({
      deviceId,
      lat,
      lon,
      speedKph,
      headingDeg: (heading + 360) % 360,
      mileageKm: mileage,
      batteryPercent: battery,
      motorLocked,
      ropeInserted,
      serial: nextSerial(),
    }),
  );

  console.log(
    `[sim ${deviceId}] position ${lat.toFixed(5)},${lon.toFixed(5)} ` +
      `${speedKph}km/h battery ${battery}% ${motorLocked ? 'locked' : 'UNLOCKED'}`,
  );

  step++;
  mileage += 1;
  if (step % 20 === 0 && battery > 5) battery--;
}

/**
 * Platform -> device frames carry NO device id: `(P43,888888)`, not
 * `(8000620011,P43,...)`. The protocol decoder is built for the device ->
 * platform direction and rejects them, so parse the raw text here instead.
 */
const framer = new Framer();
socket.on('data', (chunk) => {
  for (const raw of framer.push(chunk)) {
    if (raw.type !== 'ascii') continue;
    const text = raw.bytes.toString('latin1');
    const body = text.slice(1, -1);
    const [command, ...args] = body.split(',');

    if (command === 'P69') continue; // data acknowledgement, nothing to do
    console.log(`[sim ${deviceId}] <- ${text}`);

    switch (command) {
      case 'P43': {
        const ok = args[0] === unlockPassword;
        console.log(`[sim ${deviceId}] unlock ${ok ? 'ACCEPTED' : 'REJECTED'} (password ${args[0]})`);
        if (ok) {
          motorLocked = false;
          ropeInserted = false;
        }
        // Real firmware reports the outcome immediately after acting. That
        // report, not the socket write, is what confirms the command.
        setTimeout(() => sendLockEvent(4, ok), 800);
        if (ok) scheduleAutoLock();
        break;
      }

      case 'P02':
        report();
        break;

      case 'P22':
        console.log(`[sim ${deviceId}] time synced to ${args[0]}`);
        break;

      default:
        console.log(`[sim ${deviceId}] (no handler for ${command})`);
    }
  }
});

function sendLockEvent(sourceCode: number, allowed: boolean): void {
  if (socket.destroyed) return;
  const [lat, lon] = here();
  socket.write(buildLockEvent({ deviceId, lat, lon, sourceCode, allowed, serial: nextSerial(), mileageKm: mileage }));
}

/** The device auto-locks if the rope is not pulled within the configured time. */
function scheduleAutoLock(): void {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(() => {
    motorLocked = true;
    ropeInserted = true;
    sendLockEvent(5, false);
    console.log(`[sim ${deviceId}] auto-locked`);
  }, 60_000);
}

// Heartbeat, as the device does when its reporting interval exceeds 80s.
setInterval(() => {
  if (!socket.destroyed) socket.write(Buffer.from(`(${deviceId},@JT)`, 'latin1'));
}, 60_000);

socket.on('error', (err) => console.error(`[sim ${deviceId}] error`, err.message));
socket.on('close', () => {
  console.log(`[sim ${deviceId}] disconnected`);
  process.exit(0);
});

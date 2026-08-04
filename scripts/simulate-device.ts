/**
 * Fake JT701D for development.
 *
 * Connects to the gateway and behaves like a real lock: reports position on an
 * interval, sends heartbeats, acknowledges nothing (the platform acks us), and
 * responds to unlock commands with a P45 report the way real firmware does.
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
import { Framer, decodeFrame } from '../src/protocol/index.ts';

const deviceId = process.argv[2] ?? '8000620011';
const host = process.argv[3] ?? process.env.SIM_HOST ?? '127.0.0.1';
const port = Number(process.argv[4] ?? process.env.SIM_PORT ?? process.env.GATEWAY_PORT ?? 10001);
const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 10_000);

// A rough loop through Tripoli: port area -> city centre -> airport road.
const ROUTE: Array<[lat: number, lon: number]> = [
  [32.8925, 13.1802],
  [32.8872, 13.1913],
  [32.8790, 13.2035],
  [32.8654, 13.2210],
  [32.8412, 13.2388],
  [32.8190, 13.2455],
  [32.8412, 13.2388],
  [32.8654, 13.2210],
  [32.8790, 13.2035],
];

let step = 0;
let serial = 0;
let mileage = 1200;
let battery = 87;
let motorLocked = true;
let ropeInserted = true;

/** Encode digits as BCD, two per byte. */
function bcd(digits: string): Buffer {
  const padded = digits.length % 2 ? digits + '0' : digits;
  const out = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (Number(padded[i * 2]) << 4) | Number(padded[i * 2 + 1]);
  }
  return out;
}

/** Decimal degrees -> packed DDMM.MMMM / DDDMM.MMMM digit string. */
function packCoord(value: number, degreeDigits: number): string {
  const abs = Math.abs(value);
  const deg = Math.trunc(abs);
  const minutes = (abs - deg) * 60;
  return (
    String(deg).padStart(degreeDigits, '0') +
    minutes.toFixed(4).padStart(7, '0').replace('.', '')
  );
}

function buildPositionFrame(lat: number, lon: number, speedKph: number, heading: number): Buffer {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');

  const payload = Buffer.concat([
    bcd(p2(now.getUTCDate()) + p2(now.getUTCMonth() + 1) + p2(now.getUTCFullYear() % 100)),
    bcd(p2(now.getUTCHours()) + p2(now.getUTCMinutes()) + p2(now.getUTCSeconds())),
    bcd(packCoord(lat, 2)),                                  // 4 bytes
    // 9 longitude nibbles + direction nibble F (east, north, positioned)
    bcd(packCoord(lon, 3) + 'F'),                            // 5 bytes
    Buffer.from([Math.round(speedKph / 1.85) & 0xff]),
    Buffer.from([Math.round(heading / 2) & 0xff]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(mileage); return b; })(),
    Buffer.from([9]),                                        // satellites
    Buffer.alloc(4),                                         // bound vehicle id
    // Status: byte2 then byte1. Back cover closed; ack required always set.
    Buffer.from([
      0b00100000,
      0b00100000 | (ropeInserted ? 0x40 : 0) | (motorLocked ? 0x80 : 0),
    ]),
    Buffer.from([battery]),
    Buffer.from([0x10, 0x92, 0x28, 0x66]),                   // cell id low + LAC
    Buffer.from([28]),                                       // GSM signal
    Buffer.from([0]),                                        // fence alarm id
    Buffer.from([1]),                                        // extended status: RTC wake
    Buffer.from([0]),                                        // MNC high
    Buffer.from([0]),                                        // extended status 2
    bcd('868822040248195F'),                                 // IMEI, 8 bytes
    Buffer.from([0x00, 0x00]),                               // cell id high
    Buffer.from([0x02, 0x5b]),                               // MCC 603 = Libya
    Buffer.from([0x01]),                                     // MNC 1 = Libyana
    Buffer.from([serial]),
  ]);

  const header = Buffer.concat([
    Buffer.from([0x24]),
    bcd(deviceId),
    Buffer.from([0x19, 0x11]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })(),
  ]);

  serial = (serial + 1) & 0xff;
  return Buffer.concat([header, payload]);
}

function buildLockEvent(sourceCode: number, allowed: boolean): Buffer {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const [lat, lon] = ROUTE[step % ROUTE.length]!;
  const body = [
    deviceId,
    'P45',
    p2(now.getUTCDate()) + p2(now.getUTCMonth() + 1) + p2(now.getUTCFullYear() % 100),
    p2(now.getUTCHours()) + p2(now.getUTCMinutes()) + p2(now.getUTCSeconds()),
    lat.toFixed(5), 'N',
    lon.toFixed(5), 'E',
    'A', '0', '0',
    String(sourceCode),
    allowed ? '1' : '0',
    '0000000000',
    allowed ? '1' : '0',
    '0',
    String(serial),
    String(mileage),
  ].join(',');
  return Buffer.from(`(${body})`, 'latin1');
}

const socket = net.createConnection({ host, port }, () => {
  console.log(`[sim ${deviceId}] connected to ${host}:${port}`);
  report();
  setInterval(report, intervalMs);
});

function report(): void {
  const [lat, lon] = ROUTE[step % ROUTE.length]!;
  const next = ROUTE[(step + 1) % ROUTE.length]!;
  const heading = (Math.atan2(next[1] - lon, next[0] - lat) * 180) / Math.PI;
  const speed = 42 + Math.round(Math.random() * 18);

  socket.write(buildPositionFrame(lat, lon, speed, (heading + 360) % 360));
  console.log(`[sim ${deviceId}] position ${lat.toFixed(5)},${lon.toFixed(5)} ${speed}km/h battery ${battery}%`);

  step++;
  mileage += 1;
  if (step % 20 === 0 && battery > 5) battery--;
}

const framer = new Framer();
socket.on('data', (chunk) => {
  for (const raw of framer.push(chunk)) {
    const frame = decodeFrame(raw);
    if (frame.kind !== 'command_response') continue;

    const text = raw.bytes.toString('latin1');
    console.log(`[sim ${deviceId}] <- ${text}`);

    // P69 is just an ack; nothing to do.
    if (text.startsWith('(P69')) continue;

    // Static-password unlock: real firmware opens the motor and immediately
    // sends a P45 report. That report is what confirms the command.
    if (text.startsWith('(P43')) {
      const password = text.slice(5, -1);
      const ok = password === (process.env.SIM_PASSWORD ?? '888888');
      console.log(`[sim ${deviceId}] unlock ${ok ? 'ACCEPTED' : 'REJECTED'} (password ${password})`);
      if (ok) {
        motorLocked = false;
        ropeInserted = false;
      }
      setTimeout(() => socket.write(buildLockEvent(4, ok)), 800);
      // Auto-lock after a minute, as the device would.
      if (ok) {
        setTimeout(() => {
          motorLocked = true;
          ropeInserted = true;
          socket.write(buildLockEvent(5, false));
          console.log(`[sim ${deviceId}] auto-locked`);
        }, 60_000);
      }
    }

    if (text.startsWith('(P02')) socket.write(buildPositionFrame(...(ROUTE[step % ROUTE.length] as [number, number]), 0, 0));
  }
});

// Heartbeat, as the device does when its reporting interval exceeds 80s.
setInterval(() => socket.write(Buffer.from(`(${deviceId},@JT)`, 'latin1')), 60_000);

socket.on('error', (err) => console.error(`[sim ${deviceId}] error`, err.message));
socket.on('close', () => {
  console.log(`[sim ${deviceId}] disconnected`);
  process.exit(0);
});

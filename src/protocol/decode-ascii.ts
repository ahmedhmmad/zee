/**
 * ASCII frame decoder: `(deviceId,COMMAND,params...)`.
 *
 * Covers P45 lock/unlock reports, @JT heartbeats, P22,2 time-sync requests,
 * P52,2 dynamic-password reports, WLNET,5 peripheral data, and the generic
 * command responses.
 */

import { bcdDateTimeToUtc } from './bcd.ts';
import {
  EventSource,
  type CommandResponseFrame,
  type DecodedFrame,
  type DynamicPasswordFrame,
  type EventSourceName,
  type HeartbeatFrame,
  type LockEventFrame,
  type PeripheralFrame,
  type TimeSyncRequestFrame,
  type UnknownFrame,
} from './types.ts';

export function decodeAsciiFrame(frame: Buffer): DecodedFrame {
  // Strip the wrapping parens. Peripheral payloads are binary, so work on
  // bytes and only decode as latin1 (byte-preserving) for the text fields.
  const inner = frame.subarray(1, frame.length - 1);
  const text = inner.toString('latin1');
  const parts = text.split(',');

  const deviceId = parts[0] ?? '';
  if (!/^\d{10}$/.test(deviceId)) {
    return unknown(null, `ascii frame has no valid 10-digit device id: ${text.slice(0, 40)}`, frame);
  }

  // WLNET can appear at varying field positions depending on the wrapper the
  // firmware uses, so detect it by presence rather than index.
  if (parts.includes('WLNET')) {
    return decodePeripheral(deviceId, inner, text);
  }

  const command = parts[1] ?? '';

  if (command === '@JT') {
    return { kind: 'heartbeat', deviceId, raw: text } satisfies HeartbeatFrame;
  }

  if (command === 'P22' && parts[2] === '2') {
    return { kind: 'time_sync_request', deviceId, raw: text } satisfies TimeSyncRequestFrame;
  }

  if (command === 'P52' && parts[2] === '2') {
    const password = parts[3] ?? '';
    return { kind: 'dynamic_password', deviceId, password, raw: text } satisfies DynamicPasswordFrame;
  }

  if (command === 'P45') {
    return decodeLockEvent(deviceId, parts, text, frame);
  }

  return {
    kind: 'command_response',
    deviceId,
    command,
    params: parts.slice(2),
    raw: text,
  } satisfies CommandResponseFrame;
}

/**
 * P45 field layout, by index after splitting on commas:
 *
 *   0  device id      1  "P45"          2  date DDMMYY     3  time hhmmss
 *   4  latitude       5  N/S            6  longitude       7  E/W
 *   8  A|V fix        9  speed km/h    10  heading deg    11  event source
 *  12  verification  13  RFID card     14  password ok    15  wrong pw count
 *  16  event serial  17  mileage km    18  IMEI*          19  fence ID*
 *  20  MCC:MNC:LAC:CELLID*             21+ customised firmware fields
 *
 * (* only present when enabled with P94.)
 *
 * The manual warns explicitly: index the event serial from the FRONT (the
 * field after the 16th comma), never from the end, because Jointech reserve
 * the right to append fields.
 */
function decodeLockEvent(
  deviceId: string,
  parts: string[],
  text: string,
  frame: Buffer,
): LockEventFrame | UnknownFrame {
  if (parts.length < 18) {
    return unknown(deviceId, `P45 has only ${parts.length} fields, need at least 18`, frame);
  }

  const at = (i: number) => parts[i] ?? '';

  const latitude = parseP45Coord(at(4), at(5), 'lat');
  const longitude = parseP45Coord(at(6), at(7), 'lon');

  const eventSourceCode = Number(at(11));
  const verificationCode = Number(at(12));

  // For RFID (1) and dynamic-password (6) unlocks the verification field
  // doubles as a fence result. 99 is the one that matters operationally: the
  // device REFUSED to open because it was outside its authorised geofence.
  const fenceAware = eventSourceCode === 1 || eventSourceCode === 6;
  const refusedOutsideFence = fenceAware && verificationCode === 99;
  const unlockAllowed = refusedOutsideFence
    ? false
    : fenceAware
      ? verificationCode !== 0
      : verificationCode === 1;

  const rfidCard = at(13);

  return {
    kind: 'lock_event',
    deviceId,
    reportedAt: bcdDateTimeToUtc(at(2), at(3)),
    latitude,
    longitude,
    positioned: at(8) === 'A',
    speedKph: Number(at(9)) || 0,
    headingDeg: Number(at(10)) || 0,
    eventSource: (EventSource as Record<number, EventSourceName>)[eventSourceCode] ?? 'unknown',
    eventSourceCode,
    verificationCode,
    unlockAllowed,
    refusedOutsideFence,
    rfidCard: rfidCard === '0000000000' || rfidCard === '' ? null : rfidCard,
    passwordCorrect: at(14) === '1',
    wrongPasswordCount: Number(at(15)) || 0,
    eventSerial: Number(at(16)),
    mileageKm: Number(at(17)) || 0,
    imei: parts[18] && /^\d{15}$/.test(parts[18]) ? parts[18] : null,
    fenceId: parts[19] !== undefined && parts[19] !== '' ? Number(parts[19]) : null,
    raw: text,
  };
}

/**
 * P45 coordinates are ambiguous across firmware builds and the vendor manual
 * contradicts itself: the main worked examples use decimal degrees
 * ("22.56035"), but the P94 example uses packed DDMM.MMMM ("2233.3218").
 *
 * Both encode the same point, so we discriminate by magnitude: a latitude
 * above 90 (or longitude above 180) cannot be decimal degrees and must be
 * packed. This is unambiguous everywhere on Earth.
 *
 * Sanity check for Tripoli (32.88 N, 13.19 E):
 *   decimal  -> "32.88123",  "13.19456"
 *   packed   -> "3252.8738", "1311.6736"
 *
 * TODO: once a real device is on the bench, confirm which form its firmware
 * emits and consider pinning it, so a malformed field can't silently pick the
 * wrong branch and place a truck in the wrong country.
 */
export function parseP45Coord(value: string, hemisphere: string, kind: 'lat' | 'lon'): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;

  const limit = kind === 'lat' ? 90 : 180;

  let degrees: number;
  if (Math.abs(n) <= limit) {
    degrees = n; // already decimal degrees
  } else {
    // Packed DDMM.MMMM / DDDMM.MMMM: the last two integer digits are minutes.
    const deg = Math.trunc(Math.trunc(Math.abs(n)) / 100);
    const minutes = Math.abs(n) - deg * 100;
    degrees = deg + minutes / 60;
  }

  const negative = hemisphere === 'S' || hemisphere === 'W';
  return negative ? -Math.abs(degrees) : Math.abs(degrees);
}

/**
 * WLNET,5 is the only payload the firmware escapes, because it carries raw
 * binary that could otherwise contain frame delimiters:
 *
 *   0x3D 0x15 -> 0x28 '('      0x3D 0x14 -> 0x29 ')'
 *   0x3D 0x11 -> 0x2C ','      0x3D 0x00 -> 0x3D '='
 *
 * A single left-to-right pass consumes both bytes of each pair, which handles
 * the manual's "replace 0x3D 0x00 last" caveat correctly by construction.
 */
export function unescapePeripheral(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let w = 0;
  for (let r = 0; r < buf.length; r++) {
    const b = buf[r]!;
    if (b === 0x3d && r + 1 < buf.length) {
      const next = buf[r + 1]!;
      const mapped =
        next === 0x15 ? 0x28 : next === 0x14 ? 0x29 : next === 0x11 ? 0x2c : next === 0x00 ? 0x3d : null;
      if (mapped !== null) {
        out[w++] = mapped;
        r++;
        continue;
      }
    }
    out[w++] = b;
  }
  return out.subarray(0, w);
}

function decodePeripheral(deviceId: string, inner: Buffer, text: string): PeripheralFrame {
  // Payload begins after the "WLNET,5," marker; keep it raw until we have the
  // JT709/JT126 integration manual to decode sub-lock status properly.
  const marker = Buffer.from('WLNET,5,', 'latin1');
  const idx = inner.indexOf(marker);
  const payload = idx === -1 ? Buffer.alloc(0) : unescapePeripheral(inner.subarray(idx + marker.length));
  return { kind: 'peripheral', deviceId, payload, raw: text };
}

function unknown(deviceId: string | null, reason: string, raw: Buffer): UnknownFrame {
  return { kind: 'unknown', deviceId, reason, raw };
}

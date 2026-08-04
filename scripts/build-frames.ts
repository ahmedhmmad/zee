/**
 * Device-side frame construction, used by the simulator and by the round-trip
 * tests.
 *
 * Kept out of `simulate-device.ts` so the encoders can be tested: a silent
 * hemisphere flip here puts a truck on the wrong continent, and that must fail
 * a test rather than reach a map.
 */

/**
 * Encode a digit string as BCD, two nibbles per byte.
 *
 * Uses parseInt base 16 rather than Number(), because some fields carry hex
 * nibbles: the direction indicator 'F' and the IMEI's trailing filler.
 * Number('F') is NaN, which silently collapses to a zero nibble.
 */
export function bcd(digits: string): Buffer {
  const padded = digits.length % 2 ? digits + '0' : digits;
  const out = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(padded[i * 2]!, 16);
    const lo = parseInt(padded[i * 2 + 1]!, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new Error(`bcd(): non-hex digit in ${JSON.stringify(digits)} at offset ${i * 2}`);
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Decimal degrees -> packed DDMM.MMMM / DDDMM.MMMM digit string. */
export function packCoord(value: number, degreeDigits: number): string {
  const abs = Math.abs(value);
  const deg = Math.trunc(abs);
  const minutes = (abs - deg) * 60;
  return String(deg).padStart(degreeDigits, '0') + minutes.toFixed(4).padStart(7, '0').replace('.', '');
}

const p2 = (n: number) => String(n).padStart(2, '0');

function bcdDate(at: Date): Buffer {
  return bcd(p2(at.getUTCDate()) + p2(at.getUTCMonth() + 1) + p2(at.getUTCFullYear() % 100));
}

function bcdTime(at: Date): Buffer {
  return bcd(p2(at.getUTCHours()) + p2(at.getUTCMinutes()) + p2(at.getUTCSeconds()));
}

export interface PositionInput {
  deviceId: string;
  lat: number;
  lon: number;
  speedKph: number;
  headingDeg: number;
  mileageKm: number;
  batteryPercent: number;
  motorLocked: boolean;
  ropeInserted: boolean;
  serial: number;
  satellites?: number;
  gsmSignal?: number;
  /** 1 realtime, 2 alarm, 3 blind area, 4 sub-new. */
  dataType?: number;
  at?: Date;
}

export function buildPositionFrame(i: PositionInput): Buffer {
  const at = i.at ?? new Date();

  // Direction indicator nibble: bit3 fixed, bit2 east, bit1 north, bit0 fix.
  const dirNibble = 0b1000 | (i.lon >= 0 ? 0b0100 : 0) | (i.lat >= 0 ? 0b0010 : 0) | 0b0001;

  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
  };

  const payload = Buffer.concat([
    bcdDate(at),
    bcdTime(at),
    bcd(packCoord(i.lat, 2)), // 4 bytes
    bcd(packCoord(i.lon, 3) + dirNibble.toString(16)), // 4.5 + 0.5 bytes
    Buffer.from([Math.round(i.speedKph / 1.85) & 0xff]),
    Buffer.from([Math.round(i.headingDeg / 2) & 0xff]),
    u32(i.mileageKm),
    Buffer.from([i.satellites ?? 9]),
    Buffer.alloc(4), // bound vehicle id, reserved
    // Status word: byte2 then byte1. Back cover closed; ack always required.
    Buffer.from([
      0b00100000,
      0b00100000 | (i.ropeInserted ? 0x40 : 0) | (i.motorLocked ? 0x80 : 0),
    ]),
    Buffer.from([i.batteryPercent]),
    Buffer.from([0x10, 0x92, 0x28, 0x66]), // cell id low + LAC
    Buffer.from([i.gsmSignal ?? 28]),
    Buffer.from([0]), // fence alarm id
    Buffer.from([1]), // extended status: RTC wake
    Buffer.from([0]), // MNC high byte
    Buffer.from([0]), // extended status 2
    bcd('868822040248195F'), // IMEI, 15 digits + F filler
    Buffer.from([0x00, 0x00]), // cell id high
    Buffer.from([0x02, 0x5b]), // MCC 603 = Libya
    Buffer.from([0x01]), // MNC 1 = Libyana
    Buffer.from([i.serial & 0xff]),
  ]);

  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length);

  return Buffer.concat([
    Buffer.from([0x24]),
    bcd(i.deviceId),
    Buffer.from([0x19, ((1 << 4) | (i.dataType ?? 1)) & 0xff]),
    len,
    payload,
  ]);
}

export interface LockEventInput {
  deviceId: string;
  lat: number;
  lon: number;
  /** 1 rfid, 4 static password, 5 auto-lock, 6 dynamic password, 8 rope out. */
  sourceCode: number;
  allowed: boolean;
  serial: number;
  mileageKm: number;
  at?: Date;
}

export function buildLockEvent(i: LockEventInput): Buffer {
  const at = i.at ?? new Date();
  const body = [
    i.deviceId,
    'P45',
    p2(at.getUTCDate()) + p2(at.getUTCMonth() + 1) + p2(at.getUTCFullYear() % 100),
    p2(at.getUTCHours()) + p2(at.getUTCMinutes()) + p2(at.getUTCSeconds()),
    Math.abs(i.lat).toFixed(5),
    i.lat >= 0 ? 'N' : 'S',
    Math.abs(i.lon).toFixed(5),
    i.lon >= 0 ? 'E' : 'W',
    'A',
    '0',
    '0',
    String(i.sourceCode),
    i.allowed ? '1' : '0',
    '0000000000',
    i.allowed ? '1' : '0',
    '0',
    String(i.serial),
    String(i.mileageKm),
  ].join(',');
  return Buffer.from(`(${body})`, 'latin1');
}

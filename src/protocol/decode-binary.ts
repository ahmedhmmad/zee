/**
 * Binary position / alarm frame decoder.
 *
 * Layout (offsets relative to the frame start), per protocol manual V1.9.5:
 *
 *   0       0x24 '$'
 *   1..5    terminal ID, 5 bytes BCD -> 10 digits
 *   6       protocol version (0x19 = JT701D/E, 0x17 = JT701)
 *   7       high nibble = device type, low nibble = data type
 *   8..9    payload length, uint16 BE (52 for a standard frame)
 *   10..    payload
 *
 * Payload, offsets relative to byte 10:
 *
 *   +0    3   date DDMMYY (BCD)
 *   +3    3   time hhmmss (BCD)
 *   +6    4   latitude  DDMM.MMMM (BCD)
 *   +10   4.5 longitude DDDMM.MMMM (BCD, 9 nibbles)
 *   +14.5 0.5 direction indicator nibble
 *   +15   1   speed, KNOTS
 *   +16   1   heading / 2
 *   +17   4   mileage km, uint32 BE
 *   +21   1   satellite count
 *   +22   4   bound vehicle ID (reserved)
 *   +26   2   device status  [byte2 high][byte1 low]
 *   +28   1   battery percent, 0xFF = charging
 *   +29   2   cell ID low 16 bits
 *   +31   2   LAC
 *   +33   1   GSM signal (99 = no signal)
 *   +34   1   fence alarm ID
 *   +35   1   extended device status
 *   +36   1   MNC high byte (0x0F = legacy firmware, ignore)
 *   +37   1   extended device status 2
 *   +38   8   IMEI, 15 BCD digits + F filler
 *   +46   2   cell ID high 16 bits
 *   +48   2   MCC
 *   +50   1   MNC low byte
 *   +51   1   data serial number
 */

import { bcdToString, nibblesToString, nibbleAt, packedCoordToDegrees, bcdDateTimeToUtc } from './bcd.ts';
import { BINARY_HEADER_LEN } from './framer.ts';
import {
  WakeSource,
  type DeviceStatus,
  type ExtendedStatus2,
  type PositionFrame,
  type UnknownFrame,
  type WakeSourceName,
} from './types.ts';

/** Knots to km/h. The manual's worked example: 0x12 = 18 -> 33.3 km/h. */
const KNOTS_TO_KPH = 1.85;

const MIN_PAYLOAD = 52;

export function decodeBinaryFrame(frame: Buffer): PositionFrame | UnknownFrame {
  if (frame.length < BINARY_HEADER_LEN + MIN_PAYLOAD) {
    return unknown(null, `binary frame too short: ${frame.length} bytes`, frame);
  }

  const deviceId = bcdToString(frame, 1, 5);
  const protocolVersion = bcdToString(frame, 6, 1);
  const typeByte = frame[7]!;
  const deviceType = typeByte >> 4;
  const dataType = typeByte & 0x0f;

  const p = BINARY_HEADER_LEN;

  const date = bcdToString(frame, p + 0, 3);
  const time = bcdToString(frame, p + 3, 3);

  const latDigits = bcdToString(frame, p + 6, 4);
  const lonDigits = nibblesToString(frame, p + 10, 9);
  // The direction indicator shares a byte with the last longitude nibble.
  const dir = nibbleAt(frame, p + 14, false);

  const east = (dir & 0b0100) !== 0;
  const north = (dir & 0b0010) !== 0;
  const positioned = (dir & 0b0001) !== 0;

  let latitude = packedCoordToDegrees(latDigits, 2);
  let longitude = packedCoordToDegrees(lonDigits, 3);
  if (!north) latitude = -latitude;
  if (!east) longitude = -longitude;

  const status = decodeDeviceStatus(frame[p + 26]!, frame[p + 27]!);
  const extended2 = decodeExtendedStatus2(frame[p + 37]!);

  const batteryRaw = frame[p + 28]!;
  const gsmSignal = frame[p + 33]!;

  const mncHigh = frame[p + 36]!;
  const mncLow = frame[p + 50]!;
  // 0x0F is the legacy sentinel: firmware older than 20211224 had a 1-byte MNC.
  const mnc = mncHigh === 0x0f ? mncLow : (mncHigh << 8) | mncLow;

  const imeiRaw = bcdToString(frame, p + 38, 8);
  // Unreported IMEI is filled with 0F repeated; a real one is 15 digits + 'f'.
  const imei = /^(0f)+$/i.test(imeiRaw) ? null : imeiRaw.slice(0, 15);

  const cellIdLow = frame.readUInt16BE(p + 29);
  const cellIdHigh = frame.readUInt16BE(p + 46);

  return {
    kind: 'position',
    deviceId,
    protocolVersion,
    deviceType,
    dataType,
    isHistorical: dataType === 3 || dataType === 4,
    isAlarm: dataType === 2,
    reportedAt: bcdDateTimeToUtc(date, time),
    latitude,
    longitude,
    positioned,
    speedKph: Math.round(frame[p + 15]! * KNOTS_TO_KPH * 10) / 10,
    headingDeg: frame[p + 16]! * 2,
    mileageKm: frame.readUInt32BE(p + 17),
    satellites: frame[p + 21]!,
    status,
    batteryPercent: batteryRaw === 0xff ? null : batteryRaw,
    charging: batteryRaw === 0xff || extended2.charging,
    cellId: (cellIdHigh << 16) | cellIdLow,
    lac: frame.readUInt16BE(p + 31),
    gsmSignal,
    gsmSignalValid: gsmSignal !== 99,
    fenceAlarmId: frame[p + 34]!,
    wakeSource: decodeWakeSource(frame[p + 35]!),
    extended2,
    imei,
    mcc: frame.readUInt16BE(p + 48),
    mnc,
    serial: frame[p + 51]!,
    raw: frame,
  };
}

/**
 * The status word arrives high byte first, and the manual calls the HIGH byte
 * "Byte2" and the LOW byte "Byte1" — the reverse of the intuitive reading.
 * Worked example: 0x20E0 -> Byte2=0x20 (back cover closed), Byte1=0xE0
 * (motor locked, rope inserted, ack required).
 */
export function decodeDeviceStatus(byte2: number, byte1: number): DeviceStatus {
  const bit = (b: number, n: number) => (b & (1 << n)) !== 0;
  return {
    baseStationPositioning: bit(byte1, 0),
    enterFenceAlarm: bit(byte1, 1),
    exitFenceAlarm: bit(byte1, 2),
    ropeCutAlarm: bit(byte1, 3),
    vibrationAlarm: bit(byte1, 4),
    ackRequired: bit(byte1, 5),
    ropeInserted: bit(byte1, 6),
    motorLocked: bit(byte1, 7),
    longUnlockAlarm: bit(byte2, 0),
    wrongPasswordAlarm: bit(byte2, 1),
    illegalCardAlarm: bit(byte2, 2),
    lowBatteryAlarm: bit(byte2, 3),
    backCoverOpenedAlarm: bit(byte2, 4),
    backCoverClosed: bit(byte2, 5),
    motorStuckAlarm: bit(byte2, 6),
  };
}

export function decodeExtendedStatus2(b: number): ExtendedStatus2 {
  const bit = (n: number) => (b & (1 << n)) !== 0;
  return {
    charging: bit(0),
    // Bit1 reserved. Bits 2-5 are JT701E-only compartment covers.
    upCoverAlarm: bit(2),
    upCoverClosed: bit(3),
    downCoverAlarm: bit(4),
    downCoverClosed: bit(5),
  };
}

export function decodeWakeSource(b: number): WakeSourceName {
  const code = b & 0x0f;
  return (WakeSource as Record<number, WakeSourceName>)[code] ?? 'unknown';
}

function unknown(deviceId: string | null, reason: string, raw: Buffer): UnknownFrame {
  return { kind: 'unknown', deviceId, reason, raw };
}

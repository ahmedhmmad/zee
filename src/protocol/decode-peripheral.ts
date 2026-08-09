/**
 * WLNET,5 peripheral payload decoder.
 *
 * IMPORTANT: this layout is NOT from the vendor's integration manual, which we
 * still do not have. It was reconstructed from a third-party description and
 * then verified byte-for-byte against a real frame from master 8055430364 with
 * sub-lock E03B60000A bound.
 *
 * What is verified:
 *   - the sub-lock ID position, cross-checked against the Jointech config tool
 *   - the device type code (0x04 = JT709), matching the actual hardware
 *   - voltage 3.12 V, correct for the JT709's 3.0 V lithium-manganese cell
 *   - battery 99% and RSSI -22 dBm, both plausible for a new unit beside the master
 *
 * What is NOT verified, and must be treated as provisional:
 *   - the STATUS byte meanings. A single frame cannot confirm them; we have
 *     only ever seen 0x00. Confirm by capturing frames either side of a known
 *     lock and unlock before anyone relies on this to say a valve is shut.
 *   - the trailing bytes after the status byte
 *
 * Layout, offsets from the start of the payload that follows "WLNET,5,":
 *
 *   +0    2   data-type marker, ASCII, e.g. "2,"
 *   +2    6   date DDMMYY + time HHMMSS (BCD), master's clock
 *   +8    4   master latitude  DDMM.MMMM (BCD), zeros when unfixed
 *   +12   4.5 master longitude DDDMM.MMMM
 *   +16.5 0.5 direction nibble
 *   +17   2   unknown
 *   +19   6   timestamp, repeated
 *   +25   5   PERIPHERAL ID
 *   +30   1   undocumented; the third-party example shows FE here, ours 83
 *   +31   2   battery voltage, uint16 BE, hundredths of a volt
 *   +33   1   battery percent
 *   +34   1   RSSI magnitude; the real value is negative dBm
 *   +35   1   device type
 *   +36   1   status
 *   +37   .   remainder, meaning unknown
 */

import { bcdToString, nibblesToString, packedCoordToDegrees, bcdDateTimeToUtc } from './bcd.ts';

/** Offset of the peripheral record within the payload. */
const PERIPHERAL_OFFSET = 25;
/** Bytes required to read every field we understand. */
const MIN_LENGTH = PERIPHERAL_OFFSET + 12;

export const PeripheralType = {
  1: 'jt126_temp_humidity',
  4: 'jt709_sub_lock',
  9: 'jt802_valve_lock',
} as const;

export type PeripheralTypeName = (typeof PeripheralType)[keyof typeof PeripheralType] | 'unknown';

export interface DecodedPeripheral {
  reportedAt: Date;
  /** Master's position at the time. Null when it had no GPS fix. */
  masterLatitude: number | null;
  masterLongitude: number | null;

  peripheralId: string;
  deviceTypeCode: number;
  deviceType: PeripheralTypeName;

  voltage: number;
  batteryPercent: number;
  /** Negative dBm. Closer to zero is stronger. */
  rssi: number;

  statusCode: number;
  /**
   * Provisional. 0x01 is believed to mean locked and 0x00 unlocked, but that
   * has not been confirmed against a known state change - so null rather than
   * a confident boolean for anything we have not seen.
   */
  locked: boolean | null;
  ropeCutAlarm: boolean;

  /** JT126 only. */
  temperatureC: number | null;
  humidityPercent: number | null;

  raw: Buffer;
}

export function decodePeripheralPayload(payload: Buffer): DecodedPeripheral | null {
  if (payload.length < MIN_LENGTH) return null;

  const date = bcdToString(payload, 2, 3);
  const time = bcdToString(payload, 5, 3);

  const latDigits = bcdToString(payload, 8, 4);
  const lonDigits = nibblesToString(payload, 12, 9);
  // All-zero coordinates mean the master had no fix, not a point off Africa.
  const hasFix = !/^0+$/.test(latDigits) || !/^0+$/.test(lonDigits);

  const p = PERIPHERAL_OFFSET;
  const peripheralId = payload.subarray(p, p + 5).toString('hex').toUpperCase();
  const voltage = payload.readUInt16BE(p + 6) / 100;
  const batteryPercent = payload[p + 8]!;
  const rssi = -payload[p + 9]!;
  const deviceTypeCode = payload[p + 10]!;
  const statusCode = payload[p + 11]!;

  const deviceType =
    (PeripheralType as Record<number, PeripheralTypeName>)[deviceTypeCode] ?? 'unknown';

  const isLock = deviceTypeCode === 4 || deviceTypeCode === 9;
  const ropeCutAlarm = isLock && (statusCode === 0xff || statusCode === 0x02);

  // Only claim a lock state for the two codes we have a basis for; anything
  // else is unknown rather than "unlocked".
  const locked = !isLock ? null : statusCode === 0x01 ? true : statusCode === 0x00 ? false : null;

  let temperatureC: number | null = null;
  let humidityPercent: number | null = null;
  if (deviceTypeCode === 1 && payload.length >= p + 15) {
    const raw = payload.readUInt16BE(p + 11);
    temperatureC = (raw > 0x8000 ? raw - 0x10000 : raw) / 10;
    humidityPercent = payload[p + 13]!;
  }

  return {
    reportedAt: bcdDateTimeToUtc(date, time),
    masterLatitude: hasFix ? packedCoordToDegrees(latDigits, 2) : null,
    masterLongitude: hasFix ? packedCoordToDegrees(lonDigits, 3) : null,
    peripheralId,
    deviceTypeCode,
    deviceType,
    voltage,
    batteryPercent,
    rssi,
    statusCode,
    locked,
    ropeCutAlarm,
    temperatureC,
    humidityPercent,
    raw: payload,
  };
}

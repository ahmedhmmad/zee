/**
 * WLNET,5 peripheral payload decoder.
 *
 * Now written against the real vendor document — "JT126 Temperature Sensor /
 * JT709 Sub Lock / JT802 Valve Lock Integration Manual V1.7.1" — which
 * replaced an earlier reconstruction. Two things the reconstruction got wrong
 * and this fixes:
 *
 *   - the byte after the sensor ID is the SENSOR'S OWN data serial number, not
 *     an anomaly to be skipped blindly
 *   - lock state is not one status byte. It is Event (2 bytes) followed by
 *     Device Status (2 bytes), and the motor state lives in Device Status
 *     bit 1. Reading a single byte there reported our own bench sub-lock as
 *     unlocked when it was in fact locked with its back cover off.
 *
 * Common layout, offsets from the payload that follows "WLNET,5,":
 *
 *   +0    2   data-type marker, ASCII "2,"
 *   +2    3   date DD MM YY (BCD)      master's clock
 *   +5    3   time HH MM SS (BCD)
 *   +8    4   master latitude  DDMM.MMMM
 *   +12   4.5 master longitude DDDMM.MMMM
 *   +16.5 0.5 location indicator nibble
 *   +17   1   master speed, knots
 *   +18   1   master direction, degrees / 2
 *   +19   3   sensor date
 *   +22   3   sensor time
 *   +25   5   sensor / sub-lock ID
 *   +30   1   sensor's own data serial number
 *   +31   2   battery voltage, hundredths of a volt
 *   +33   1   battery percent
 *   +34   1   RSSI magnitude (negate for dBm)
 *   +35   1   sensor type: 01 JT126, 04 JT709, 09 JT802
 *   +36   .   type-specific
 *
 * JT709 (type 04) tail:
 *   +36   2   event
 *   +38   2   device status
 *   +40   2   lock/unlock cycle count
 *   +42   1   gateway status
 *   +43   4   RFID card number (firmware 20230703 and later)
 */

import { bcdToString, nibblesToString, packedCoordToDegrees, bcdDateTimeToUtc } from './bcd.ts';

const SENSOR = 25;
const TAIL = 36;
const MIN_LENGTH = TAIL + 1;

export const PeripheralType = {
  1: 'jt126_temp_humidity',
  4: 'jt709_sub_lock',
  9: 'jt802_valve_lock',
} as const;

export type PeripheralTypeName = (typeof PeripheralType)[keyof typeof PeripheralType] | 'unknown';

/**
 * JT709 event codes. The manual presents these as a single value in bits 14-0,
 * not a bitmask — bit 15 separately flags re-uploaded data.
 *
 * Only the codes the document states unambiguously are named here. Its table
 * is laid out in a way that interleaves bit numbers with values further up the
 * range, so those are left as raw numbers rather than guessed at.
 */
export const JT709_EVENTS: Record<number, string> = {
  1: 'device_locked',
  2: 'unlock_via_bluetooth',
  4: 'back_cover_opened_alarm',
  8: 'unlock_via_lora',
};

export interface JT709Status {
  /** Bit 0. False means the rope is seated in the lock. */
  ropePulledOut: boolean;
  /** Bit 1. The authoritative lock state. */
  motorUnlocked: boolean;
  /** Bit 2. Firmware 20230703 and later. */
  backCoverOpen: boolean;
  /** Bit 3. Firmware 20230703 and later. */
  charging: boolean;
}

export interface DecodedPeripheral {
  reportedAt: Date;
  masterLatitude: number | null;
  masterLongitude: number | null;
  masterSpeedKph: number;
  masterHeadingDeg: number;

  peripheralId: string;
  /** The sensor's own transmission counter, not the frame serial. */
  sensorSerial: number;
  deviceTypeCode: number;
  deviceType: PeripheralTypeName;

  voltage: number;
  batteryPercent: number;
  /** Negative dBm. The manual notes -90 is about the limit of usable. */
  rssi: number;

  /** True when this is cached data being replayed, not a live reading. */
  reupload: boolean;
  /** Master reports it has lost contact with this sub-lock. */
  commsLostAlarm: boolean;
  lowVoltageAlarm: boolean;

  // --- Locks (JT709 / JT802) ---
  eventCode: number | null;
  eventName: string | null;
  status: JT709Status | null;
  /** True = locked. Null for sensors, or a payload too short to say. */
  locked: boolean | null;
  lockCycles: number | null;
  rfidCard: string | null;

  // --- JT126 sensor ---
  temperatureC: number | null;
  humidityPercent: number | null;

  raw: Buffer;
}

export function decodePeripheralPayload(payload: Buffer): DecodedPeripheral | null {
  if (payload.length < MIN_LENGTH) return null;

  const latDigits = bcdToString(payload, 8, 4);
  const lonDigits = nibblesToString(payload, 12, 9);
  const indicator = payload[16]! & 0x0f;
  // Bit0 of the indicator is the GPS fix flag; without it the coordinates are
  // a cell-tower estimate or zeros, and must not be plotted as a position.
  const hasFix = (indicator & 0b0001) !== 0 && !/^0+$/.test(latDigits);
  const east = (indicator & 0b0100) !== 0;
  const north = (indicator & 0b0010) !== 0;

  const deviceTypeCode = payload[35]!;
  const deviceType = (PeripheralType as Record<number, PeripheralTypeName>)[deviceTypeCode] ?? 'unknown';

  const result: DecodedPeripheral = {
    reportedAt: bcdDateTimeToUtc(bcdToString(payload, 2, 3), bcdToString(payload, 5, 3)),
    masterLatitude: hasFix
      ? (north ? 1 : -1) * packedCoordToDegrees(latDigits, 2)
      : null,
    masterLongitude: hasFix
      ? (east ? 1 : -1) * packedCoordToDegrees(lonDigits, 3)
      : null,
    masterSpeedKph: Math.round(payload[17]! * 1.852 * 10) / 10,
    masterHeadingDeg: payload[18]! * 2,

    peripheralId: payload.subarray(SENSOR, SENSOR + 5).toString('hex').toUpperCase(),
    sensorSerial: payload[30]!,
    deviceTypeCode,
    deviceType,

    voltage: payload.readUInt16BE(31) / 100,
    batteryPercent: payload[33]!,
    rssi: -payload[34]!,

    reupload: false,
    commsLostAlarm: false,
    lowVoltageAlarm: false,

    eventCode: null,
    eventName: null,
    status: null,
    locked: null,
    lockCycles: null,
    rfidCard: null,
    temperatureC: null,
    humidityPercent: null,
    raw: payload,
  };

  if (deviceTypeCode === 1) decodeJt126(payload, result);
  else if (deviceTypeCode === 4 || deviceTypeCode === 9) decodeLock(payload, result);

  return result;
}

function decodeJt126(payload: Buffer, out: DecodedPeripheral): void {
  if (payload.length < TAIL + 6) return;

  const raw = payload.readUInt16BE(TAIL);
  if (raw !== 0xffff) {
    // Sign is the top nibble, magnitude the low 12 bits — NOT two's
    // complement. 0x1190 is -40.0 C, not 4496.
    const magnitude = (raw & 0x0fff) / 10;
    out.temperatureC = (raw & 0xf000) !== 0 ? -magnitude : magnitude;
  }
  out.humidityPercent = payload[TAIL + 2]!;
  decodeGatewayStatus(payload[TAIL + 5], out);
}

function decodeLock(payload: Buffer, out: DecodedPeripheral): void {
  if (payload.length < TAIL + 4) return;

  const event = payload.readUInt16BE(TAIL);
  // Bit 15 marks replayed data; the event itself is the remaining bits.
  out.reupload = (event & 0x8000) !== 0;
  out.eventCode = event & 0x7fff;
  out.eventName = out.deviceTypeCode === 4 ? (JT709_EVENTS[out.eventCode] ?? null) : null;

  const status = payload.readUInt16BE(TAIL + 2);
  out.status = {
    ropePulledOut: (status & 0b0001) !== 0,
    motorUnlocked: (status & 0b0010) !== 0,
    backCoverOpen: (status & 0b0100) !== 0,
    charging: (status & 0b1000) !== 0,
  };
  out.locked = !out.status.motorUnlocked;

  if (payload.length >= TAIL + 6) out.lockCycles = payload.readUInt16BE(TAIL + 4);
  if (payload.length >= TAIL + 7) decodeGatewayStatus(payload[TAIL + 6], out);

  // Present only on sub-lock firmware 20230703 and later.
  if (payload.length >= TAIL + 11) {
    const card = payload.readUInt32BE(TAIL + 7);
    out.rfidCard = card === 0 ? null : String(card).padStart(10, '0');
  }
}

function decodeGatewayStatus(byte: number | undefined, out: DecodedPeripheral): void {
  if (byte === undefined) return;
  if ((byte & 0b0001) !== 0) out.reupload = true;
  out.commsLostAlarm = (byte & 0b0010) !== 0;
  out.lowVoltageAlarm = (byte & 0b0100) !== 0;
}

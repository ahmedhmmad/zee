import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBinaryFrame } from '../src/protocol/decode-binary.ts';
import type { PositionFrame } from '../src/protocol/types.ts';

/**
 * Both frames are lifted verbatim from JT701D/E Protocol Manual V1.9.5,
 * "Position and alarm data format (HEX)", along with the decoded values the
 * manual states for each field.
 */
const EXAMPLE_1 =
  '2480006200111911003418042116225922348310113550543F12980000002D060000000020E0' +
  '28109228661F000100000F0F0F0F0F0F0F0F000001CC0156';

const EXAMPLE_2_WITH_IMEI =
  '2480006200111911003418042116225922348310113550543F12980000002D060000000020E0' +
  '28109228661F00010000868822040248195F000001CC0156';

function decode(hex: string): PositionFrame {
  const frame = decodeBinaryFrame(Buffer.from(hex, 'hex'));
  assert.equal(frame.kind, 'position', 'expected a position frame');
  return frame as PositionFrame;
}

test('frame is 62 bytes: 10-byte header plus the declared 52-byte payload', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  assert.equal(buf.length, 62);
  assert.equal(buf.readUInt16BE(8), 52, 'declared payload length should be 0x34');
});

test('decodes header fields', () => {
  const f = decode(EXAMPLE_1);
  assert.equal(f.deviceId, '8000620011');
  assert.equal(f.protocolVersion, '19');
  assert.equal(f.deviceType, 1);
  assert.equal(f.dataType, 1);
  assert.equal(f.isAlarm, false);
  assert.equal(f.isHistorical, false);
});

test('decodes timestamp as UTC (DDMMYY hhmmss = 18 Apr 2021 16:22:59)', () => {
  const f = decode(EXAMPLE_1);
  assert.equal(f.reportedAt.toISOString(), '2021-04-18T16:22:59.000Z');
});

test('decodes packed coordinates to the degrees the manual states', () => {
  const f = decode(EXAMPLE_1);
  // 22348310 -> 22 + 34.8310/60 = 22.580517
  assert.equal(f.latitude.toFixed(6), '22.580517');
  // 113550543 -> 113 + 55.0543/60 = 113.917572
  assert.equal(f.longitude.toFixed(6), '113.917572');
});

test('direction nibble F means east, north, GPS positioned', () => {
  const f = decode(EXAMPLE_1);
  assert.equal(f.positioned, true);
  assert.ok(f.latitude > 0, 'north latitude is positive');
  assert.ok(f.longitude > 0, 'east longitude is positive');
});

test('speed converts from knots (0x12 = 18 kn -> 33.3 km/h)', () => {
  assert.equal(decode(EXAMPLE_1).speedKph, 33.3);
});

test('heading is the raw byte doubled (0x98 = 152 -> 304 deg)', () => {
  assert.equal(decode(EXAMPLE_1).headingDeg, 304);
});

test('decodes mileage and satellite count', () => {
  const f = decode(EXAMPLE_1);
  assert.equal(f.mileageKm, 45); // 0x0000002D
  assert.equal(f.satellites, 6);
});

test('device status 0x20E0 unpacks per the manual worked example', () => {
  const { status } = decode(EXAMPLE_1);
  // Byte2 = 0x20 -> bit5 set
  assert.equal(status.backCoverClosed, true);
  // Byte1 = 0xE0 -> bits 7,6,5 set
  assert.equal(status.motorLocked, true);
  assert.equal(status.ropeInserted, true);
  assert.equal(status.ackRequired, true);
  // bit0 clear
  assert.equal(status.baseStationPositioning, false);
  // no alarms asserted
  assert.equal(status.ropeCutAlarm, false);
  assert.equal(status.lowBatteryAlarm, false);
  assert.equal(status.motorStuckAlarm, false);
  assert.equal(status.illegalCardAlarm, false);
});

test('battery 0x28 is 40 percent and not charging', () => {
  const f = decode(EXAMPLE_1);
  assert.equal(f.batteryPercent, 40);
  assert.equal(f.charging, false);
});

test('battery 0xFF means charging, with no percentage available', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  buf[10 + 28] = 0xff;
  const f = decodeBinaryFrame(buf) as PositionFrame;
  assert.equal(f.batteryPercent, null);
  assert.equal(f.charging, true);
});

test('coulomb-counter units signal charging via extended status 2 instead', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  buf[10 + 28] = 0x55; // a real 85% reading
  buf[10 + 37] = 0x01; // extended2 bit0
  const f = decodeBinaryFrame(buf) as PositionFrame;
  assert.equal(f.batteryPercent, 85);
  assert.equal(f.charging, true);
});

test('decodes cellular fields (GSM 0x1F = 31, MCC 0x01CC = 460)', () => {
  const f = decode(EXAMPLE_1);
  assert.equal(f.gsmSignal, 31);
  assert.equal(f.gsmSignalValid, true);
  assert.equal(f.mcc, 460);
  assert.equal(f.mnc, 1);
  assert.equal(f.lac, 0x2866);
});

test('GSM signal of 99 is flagged as no signal', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  buf[10 + 33] = 99;
  const f = decodeBinaryFrame(buf) as PositionFrame;
  assert.equal(f.gsmSignalValid, false);
});

test('extended status low nibble 0x01 is an RTC timer wake-up', () => {
  assert.equal(decode(EXAMPLE_1).wakeSource, 'rtc_timer');
});

test('wake source decodes across the documented range', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  const cases: Array<[number, string]> = [
    [0, 'device_restart'],
    [2, 'vibration'],
    [3, 'back_cover_opened'],
    [4, 'lock_rope_changed'],
    [6, 'rfid_card'],
    [10, 'bluetooth'],
  ];
  for (const [code, expected] of cases) {
    buf[10 + 35] = code;
    assert.equal((decodeBinaryFrame(buf) as PositionFrame).wakeSource, expected, `code ${code}`);
  }
});

test('placeholder IMEI (0F repeated) decodes as null', () => {
  assert.equal(decode(EXAMPLE_1).imei, null);
});

test('real IMEI is 15 digits with the F filler stripped', () => {
  assert.equal(decode(EXAMPLE_2_WITH_IMEI).imei, '868822040248195');
});

test('serial number 0x56 = 86, which is what the P69 ack must echo', () => {
  assert.equal(decode(EXAMPLE_1).serial, 86);
});

test('data type 2 is an alarm, 3 and 4 are historical', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  const typeByte = buf[7]!;

  buf[7] = (typeByte & 0xf0) | 2;
  const alarm = decodeBinaryFrame(buf) as PositionFrame;
  assert.equal(alarm.isAlarm, true);
  assert.equal(alarm.isHistorical, false);

  buf[7] = (typeByte & 0xf0) | 3;
  assert.equal((decodeBinaryFrame(buf) as PositionFrame).isHistorical, true, 'blind-area data');

  buf[7] = (typeByte & 0xf0) | 4;
  assert.equal((decodeBinaryFrame(buf) as PositionFrame).isHistorical, true, 'sub-new position');
});

test('southern and western hemispheres negate the coordinates', () => {
  const buf = Buffer.from(EXAMPLE_1, 'hex');
  // Direction nibble 0x9 = 1001: west, south, positioned.
  buf[10 + 14] = (buf[10 + 14]! & 0xf0) | 0x9;
  const f = decodeBinaryFrame(buf) as PositionFrame;
  assert.ok(f.latitude < 0, 'south latitude is negative');
  assert.ok(f.longitude < 0, 'west longitude is negative');
  assert.equal(f.positioned, true);
});

test('a truncated frame is reported rather than throwing', () => {
  const short = Buffer.from(EXAMPLE_1, 'hex').subarray(0, 30);
  const f = decodeBinaryFrame(short);
  assert.equal(f.kind, 'unknown');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAsciiFrame, unescapePeripheral, parseP45Coord } from '../src/protocol/decode-ascii.ts';
import type { DynamicPasswordFrame, LockEventFrame } from '../src/protocol/types.ts';

const f = (s: string) => decodeAsciiFrame(Buffer.from(s, 'latin1'));
const lockEvent = (s: string): LockEventFrame => {
  const frame = f(s);
  assert.equal(frame.kind, 'lock_event', `expected lock_event, got ${frame.kind}`);
  return frame as LockEventFrame;
};

// --- Examples verbatim from protocol manual V1.9.5 -------------------------

test('heartbeat', () => {
  const frame = f('(8000620011,@JT)');
  assert.equal(frame.kind, 'heartbeat');
  assert.equal(frame.deviceId, '8000620011');
});

test('time sync request', () => {
  const frame = f('(8000620011,P22,2)');
  assert.equal(frame.kind, 'time_sync_request');
  assert.equal(frame.deviceId, '8000620011');
});

test('dynamic password report', () => {
  const frame = f('(8000620011,P52,2,113271)');
  assert.equal(frame.kind, 'dynamic_password');
  assert.equal((frame as DynamicPasswordFrame).password, '113271');
});

test('P45 RFID unlock decodes every field', () => {
  const e = lockEvent('(8000620011,P45,170720,020614,22.56035,N,114.01640,E,A,36,270,1,1,0008627839,0,0,24,5)');
  assert.equal(e.deviceId, '8000620011');
  assert.equal(e.reportedAt.toISOString(), '2020-07-17T02:06:14.000Z');
  assert.equal(e.latitude.toFixed(5), '22.56035');
  assert.equal(e.longitude.toFixed(5), '114.01640');
  assert.equal(e.positioned, true);
  assert.equal(e.speedKph, 36);
  assert.equal(e.headingDeg, 270);
  assert.equal(e.eventSource, 'rfid_authorized');
  assert.equal(e.rfidCard, '0008627839');
  assert.equal(e.unlockAllowed, true);
  assert.equal(e.refusedOutsideFence, false);
  // The manual states the ack for this frame is (P69,0,24).
  assert.equal(e.eventSerial, 24);
  assert.equal(e.mileageKm, 5);
});

test('P45 verification 99 means the device REFUSED to unlock outside its fence', () => {
  const e = lockEvent('(8000400055,P45,040121,104728,22.55801,N,114.00846,E,A,0,244,1,99,0008627839,0,0,2,29)');
  assert.equal(e.eventSource, 'rfid_authorized');
  assert.equal(e.verificationCode, 99);
  assert.equal(e.refusedOutsideFence, true);
  assert.equal(e.unlockAllowed, false, 'a refused unlock must never read as success');
});

test('P45 verification 98 means fence association is off, so unlocking is normal', () => {
  const e = lockEvent('(8000400055,P45,070121,074116,22.58071,N,113.91734,E,A,0,0,6,98,0000000000,1,0,13,0)');
  assert.equal(e.eventSource, 'remote_dynamic_password');
  assert.equal(e.unlockAllowed, true);
  assert.equal(e.refusedOutsideFence, false);
  assert.equal(e.rfidCard, null, 'all-zero card number is not a real card');
});

test('P45 automatic lock', () => {
  const e = lockEvent('(8000400055,P45,060121,081012,22.58080,N,113.91751,E,A,0,0,5,0,0000000000,0,0,3,58)');
  assert.equal(e.eventSource, 'auto_locked');
  assert.equal(e.eventSerial, 3);
});

test('P45 remote static password unlock', () => {
  const e = lockEvent('(8000400055,P45,060121,081257,22.58047,N,113.91753,E,A,0,0,4,1,0000000000,1,0,5,58)');
  assert.equal(e.eventSource, 'remote_static_password');
  assert.equal(e.unlockAllowed, true);
  assert.equal(e.passwordCorrect, true);
  assert.equal(e.eventSerial, 5);
});

test('P45 with P94 extended fields: IMEI and fence ID, packed coordinates', () => {
  const e = lockEvent(
    '(8130630001,P45,260915,102329,2233.3218,N,11325.3659,E,A,0,15,1,1,0026589876,0,0,1,234,863977039060871,7,460:0:19526:584115)',
  );
  // Serial is taken from the front (field after the 16th comma), NOT from the
  // end - the manual warns that trailing fields get appended over time.
  assert.equal(e.eventSerial, 1);
  assert.equal(e.mileageKm, 234);
  assert.equal(e.imei, '863977039060871');
  assert.equal(e.fenceId, 7);
  // This example uses packed DDMM.MMMM rather than decimal degrees.
  assert.equal(e.latitude.toFixed(6), '22.555363');
  assert.equal(e.longitude.toFixed(6), '113.422765');
});

test('appending future trailing fields does not shift the event serial', () => {
  const base = '(8000620011,P45,170720,020614,22.56035,N,114.01640,E,A,36,270,1,1,0008627839,0,0,24,5';
  const withExtras = lockEvent(`${base},868822040248195,7,460:0:19526:584115,1741013910,+218911234567,USER_X)`);
  assert.equal(withExtras.eventSerial, 24);
  assert.equal(withExtras.mileageKm, 5);
});

// --- Coordinate format discrimination --------------------------------------

test('P45 coordinates: decimal degrees pass through unchanged', () => {
  assert.equal(parseP45Coord('22.56035', 'N', 'lat').toFixed(5), '22.56035');
  assert.equal(parseP45Coord('114.01640', 'E', 'lon').toFixed(5), '114.01640');
});

test('P45 coordinates: values above the degree limit are read as packed DDMM', () => {
  assert.equal(parseP45Coord('2233.3218', 'N', 'lat').toFixed(6), '22.555363');
  assert.equal(parseP45Coord('11325.3659', 'E', 'lon').toFixed(6), '113.422765');
});

test('P45 coordinates: Tripoli decodes correctly in both encodings', () => {
  // 32.8872 N, 13.1913 E -> packed 3253.232 N, 1311.478 E
  assert.equal(parseP45Coord('32.88720', 'N', 'lat').toFixed(4), '32.8872');
  assert.equal(parseP45Coord('3253.2320', 'N', 'lat').toFixed(4), '32.8872');
  assert.equal(parseP45Coord('13.19130', 'E', 'lon').toFixed(4), '13.1913');
  assert.equal(parseP45Coord('1311.4780', 'E', 'lon').toFixed(4), '13.1913');
});

test('P45 coordinates: S and W hemispheres negate', () => {
  assert.ok(parseP45Coord('22.56035', 'S', 'lat') < 0);
  assert.ok(parseP45Coord('114.01640', 'W', 'lon') < 0);
});

// --- Peripheral escaping ---------------------------------------------------

test('peripheral escape sequences are restored', () => {
  const escaped = Buffer.from([0x3d, 0x15, 0x3d, 0x14, 0x3d, 0x11, 0x3d, 0x00, 0x41]);
  assert.deepEqual(unescapePeripheral(escaped), Buffer.from([0x28, 0x29, 0x2c, 0x3d, 0x41]));
});

test('escaped 0x3D 0x00 does not cascade into a following escape', () => {
  // 3D 00 -> 3D, and the following 15 must stay a literal 0x15.
  assert.deepEqual(unescapePeripheral(Buffer.from([0x3d, 0x00, 0x15])), Buffer.from([0x3d, 0x15]));
});

test('bytes that are not escape sequences pass through untouched', () => {
  const plain = Buffer.from([0x01, 0x3d, 0x99, 0x02]);
  assert.deepEqual(unescapePeripheral(plain), plain);
});

// --- Fallbacks -------------------------------------------------------------

test('unrecognised command words become command responses', () => {
  const frame = f('(8130630001,P01,JT701D/E_20210311_China_Jointech,41%)');
  assert.equal(frame.kind, 'command_response');
  if (frame.kind === 'command_response') {
    assert.equal(frame.command, 'P01');
    assert.deepEqual(frame.params, ['JT701D/E_20210311_China_Jointech', '41%']);
  }
});

test('a frame without a valid device id is rejected, not guessed at', () => {
  assert.equal(f('(garbage,P45,x)').kind, 'unknown');
});

test('a truncated P45 is reported rather than yielding NaN fields', () => {
  assert.equal(f('(8000620011,P45,170720,020614,22.56035,N)').kind, 'unknown');
});

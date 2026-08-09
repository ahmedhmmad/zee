import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePeripheralPayload } from '../src/protocol/decode-peripheral.ts';
import { unescapePeripheral } from '../src/protocol/decode-ascii.ts';

/**
 * The reference frame: captured from master 8055430364 on 2026-08-06, with
 * JT709 sub-lock E03B60000A bound. The ID was independently confirmed in the
 * Jointech configuration tool's Sub List, which is what anchors the whole
 * layout - every other field is positioned relative to it.
 */
const REAL_FRAME =
  '322c0608261155070000000000000000080000060826115507e03b60000a8301386316040004000400130000000000';

const decode = (hex: string) => {
  const d = decodePeripheralPayload(Buffer.from(hex, 'hex'));
  assert.ok(d, 'payload should decode');
  return d;
};

test('sub-lock ID matches the Jointech tool exactly', () => {
  assert.equal(decode(REAL_FRAME).peripheralId, 'E03B60000A');
});

test('device type 0x04 is a JT709 sub-lock', () => {
  const d = decode(REAL_FRAME);
  assert.equal(d.deviceTypeCode, 4);
  assert.equal(d.deviceType, 'jt709_sub_lock');
});

test('battery voltage is plausible for a 3.0V lithium cell', () => {
  // 3.12 V. The single most convincing check that the offset is right: one
  // byte either way gives 335 V or 0.01 V.
  assert.equal(decode(REAL_FRAME).voltage, 3.12);
});

test('battery percent and RSSI decode to sane values', () => {
  const d = decode(REAL_FRAME);
  assert.equal(d.batteryPercent, 99);
  assert.equal(d.rssi, -22); // sub-lock sitting beside the master
});

test('timestamp is DDMMYY, not YYMMDD', () => {
  // 06 08 26 is 6 August 2026. Read as YYMMDD it would be 2006, which is what
  // the third-party description claims and is wrong.
  assert.equal(decode(REAL_FRAME).reportedAt.toISOString(), '2026-08-06T11:55:07.000Z');
});

test('all-zero coordinates mean no fix, not a position off Africa', () => {
  const d = decode(REAL_FRAME);
  assert.equal(d.masterLatitude, null);
  assert.equal(d.masterLongitude, null);
});

test('lock state is only claimed for status codes we have a basis for', () => {
  // 0x00 is believed to be unlocked...
  assert.equal(decode(REAL_FRAME).locked, false);

  // ...but an unrecognised code must read as unknown, never as "unlocked".
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf[25 + 11] = 0x7b;
  const d = decodePeripheralPayload(buf)!;
  assert.equal(d.locked, null);
  assert.equal(d.ropeCutAlarm, false);
});

test('locked and rope-cut status codes', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');

  buf[25 + 11] = 0x01;
  assert.equal(decodePeripheralPayload(buf)!.locked, true);

  for (const code of [0xff, 0x02]) {
    buf[25 + 11] = code;
    const d = decodePeripheralPayload(buf)!;
    assert.equal(d.ropeCutAlarm, true, `0x${code.toString(16)} is a rope-cut alarm`);
  }
});

test('a JT126 sensor decodes temperature and humidity instead', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf[25 + 10] = 0x01; // device type: JT126
  buf.writeUInt16BE(275, 25 + 11); // 27.5 C
  buf[25 + 13] = 71; // 71% RH

  const d = decodePeripheralPayload(buf)!;
  assert.equal(d.deviceType, 'jt126_temp_humidity');
  assert.equal(d.temperatureC, 27.5);
  assert.equal(d.humidityPercent, 71);
  assert.equal(d.locked, null, 'a sensor has no lock state');
});

test('sub-zero temperatures decode as negative', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf[25 + 10] = 0x01;
  buf.writeUInt16BE(0x10000 - 55, 25 + 11); // -5.5 C
  assert.equal(decodePeripheralPayload(buf)!.temperatureC, -5.5);
});

test('a truncated payload is rejected rather than half-read', () => {
  assert.equal(decodePeripheralPayload(Buffer.from(REAL_FRAME, 'hex').subarray(0, 30)), null);
});

// --- Frame-level fields and acknowledgement ---------------------------------

import { decodeAsciiFrame } from '../src/protocol/decode-ascii.ts';
import * as encode from '../src/protocol/encode.ts';
import type { PeripheralFrame } from '../src/protocol/types.ts';

test('peripheral frame exposes the serial the P69 ack must echo', () => {
  // Structure from the integration manual:
  //   (deviceId, protocolVersion, serial, WLNET, 5, dataType, payload)
  const frame = Buffer.concat([
    Buffer.from('(7500313620,1,077,WLNET,5,', 'latin1'),
    Buffer.from(REAL_FRAME, 'hex'),
    Buffer.from(')', 'latin1'),
  ]);
  const d = decodeAsciiFrame(frame);
  assert.equal(d.kind, 'peripheral');
  const p = d as PeripheralFrame;
  assert.equal(p.protocolVersion, '1');
  // "077" is decimal 77 — the leading zeros are decorative.
  assert.equal(p.serial, 77);
  assert.equal(encode.ackData(p.serial).toString(), '(P69,0,77)');
});

test('WLNET commands carry the device id, unlike P-commands', () => {
  assert.equal(encode.wlnetQueryBound('7500313609').toString(), '(7500313609,1,001,WLNET,1,0)');
  assert.equal(encode.wlnetQueryFirmware('7500313609').toString(), '(7500313609,1,001,WLNET,4)');
});

test('binding sends the complete list, because each write erases the previous', () => {
  assert.equal(
    encode.wlnetBindPeripherals('7500313609', ['E0171A00DC', 'E0171A00F1', 'E0171A00A0']).toString(),
    '(7500313609,1,001,WLNET,1,1,3,E0171A00DC,E0171A00F1,E0171A00A0)',
  );
  // An empty list is unbind-all, not a malformed command with a zero count.
  assert.equal(encode.wlnetBindPeripherals('7500313609', []).toString(), '(7500313609,1,001,WLNET,1,1,0)');
  assert.equal(encode.wlnetUnbindAll('7500313609').toString(), '(7500313609,1,001,WLNET,1,1,0)');
});

test('escape sequences match the XOR rule the manual describes', () => {
  // "add 0x3D firstly, then exclusive or this character with 0x3D"
  for (const real of [0x28, 0x29, 0x2c, 0x3d]) {
    const escaped = Buffer.from([0x3d, real ^ 0x3d]);
    assert.deepEqual(
      unescapePeripheral(escaped),
      Buffer.from([real]),
      `0x${real.toString(16)} XOR 0x3D round-trips`,
    );
  }
});

test('only WLNET,5 is peripheral data; other indices are command responses', () => {
  // A WLNET,8 unlock reply must not be fed to the binary sensor decoder.
  const reply = decodeAsciiFrame(
    Buffer.from('(8055430364,1,001,WLNET,8,0,E03B60000A)', 'latin1'),
  );
  assert.equal(reply.kind, 'command_response');
  if (reply.kind === 'command_response') {
    assert.equal(reply.command, 'WLNET,8');
    assert.deepEqual(reply.params, ['0', 'E03B60000A']);
  }
});

test('sub-lock unlock command shape, and the five-minute cap', () => {
  assert.equal(
    encode.wlnetUnlockSubLock('8055430364', 'e03b60000a', 5).toString(),
    '(8055430364,1,001,WLNET,8,1,1,5,E03B60000A)',
  );
  // The JT709EX wake window is five minutes; anything longer is meaningless.
  assert.match(encode.wlnetUnlockSubLock('8055430364', 'E03B60000A', 99).toString(), /,5,E03B60000A\)$/);
  assert.match(encode.wlnetUnlockSubLock('8055430364', 'E03B60000A', 0).toString(), /,1,E03B60000A\)$/);
});

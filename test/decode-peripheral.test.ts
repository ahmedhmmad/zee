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

test('our bench sub-lock reads as LOCKED with its back cover open', () => {
  const d = decode(REAL_FRAME);
  // Device Status 0x0004: bit2 set (cover open), bit1 clear (motor locked).
  // Corroborated twice over - event code 4 is the back-cover alarm, and the
  // photograph of the unit shows its case off with the battery exposed.
  assert.equal(d.locked, true);
  assert.equal(d.status?.motorUnlocked, false);
  assert.equal(d.status?.backCoverOpen, true);
  assert.equal(d.status?.ropePulledOut, false);
  assert.equal(d.eventCode, 4);
  assert.equal(d.eventName, 'back_cover_opened_alarm');
  assert.equal(d.lockCycles, 19);
});

test('device status bits decode independently', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  const statusAt = 36 + 2;

  buf.writeUInt16BE(0b0000, statusAt);
  let d = decodePeripheralPayload(buf)!;
  assert.equal(d.locked, true);
  assert.equal(d.status!.ropePulledOut, false);

  buf.writeUInt16BE(0b0011, statusAt); // motor unlocked + rope out
  d = decodePeripheralPayload(buf)!;
  assert.equal(d.locked, false);
  assert.equal(d.status!.ropePulledOut, true);

  buf.writeUInt16BE(0b1000, statusAt); // charging
  d = decodePeripheralPayload(buf)!;
  assert.equal(d.status!.charging, true);
  assert.equal(d.locked, true, 'charging says nothing about the motor');
});

test('bit15 of the event field marks replayed data, not an event', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf.writeUInt16BE(0x8000 | 8, 36);
  const d = decodePeripheralPayload(buf)!;
  assert.equal(d.reupload, true);
  assert.equal(d.eventCode, 8, 'the flag must not leak into the event code');
  assert.equal(d.eventName, 'unlock_via_lora');
});

test('gateway status carries the sub-lock loss alarm', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf[36 + 6] = 0b0110; // comms lost + low voltage
  const d = decodePeripheralPayload(buf)!;
  assert.equal(d.commsLostAlarm, true);
  assert.equal(d.lowVoltageAlarm, true);
});

test('a JT126 sensor decodes temperature and humidity instead', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf[35] = 0x01; // device type: JT126
  buf.writeUInt16BE(275, 36); // 27.5 C
  buf[38] = 71; // 71% RH

  const d = decodePeripheralPayload(buf)!;
  assert.equal(d.deviceType, 'jt126_temp_humidity');
  assert.equal(d.temperatureC, 27.5);
  assert.equal(d.humidityPercent, 71);
  assert.equal(d.locked, null, 'a sensor has no lock state');
});

test('sub-zero temperatures use a sign nibble, not twos complement', () => {
  const buf = Buffer.from(REAL_FRAME, 'hex');
  buf[35] = 0x01;
  // Manual: 0x1190 -> top nibble 1 means negative, 0x190 = 400 -> -40.0 C.
  // Read as twos complement this would be 4496.
  buf.writeUInt16BE(0x1190, 36);
  assert.equal(decodePeripheralPayload(buf)!.temperatureC, -40);

  buf.writeUInt16BE(0xffff, 36); // documented "no data collected"
  assert.equal(decodePeripheralPayload(buf)!.temperatureC, null);
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
  assert.match(encode.wlnetQueryBound('7500313609').toString(), /^\(7500313609,1,\d{3},WLNET,1,0\)$/);
  assert.match(encode.wlnetQueryFirmware('7500313609').toString(), /^\(7500313609,1,\d{3},WLNET,4\)$/);
});

test('every WLNET command gets a fresh serial', () => {
  // The manual: "the serial numbers of the two commands must be different
  // before and after to prevent repeated unlocking". A fixed serial means the
  // second unlock is silently discarded as a duplicate.
  const serials = new Set();
  for (let i = 0; i < 50; i++) {
    const m = /,1,(\d{3}),WLNET/.exec(encode.wlnetUnlockSubLock('8055430364', 'E03B60000A').toString());
    serials.add(m![1]);
  }
  assert.equal(serials.size, 50, 'fifty consecutive commands must all differ');
});

test('heartbeat interval controls whether a sub-lock can collect a queued unlock', () => {
  assert.match(encode.wlnetSetHeartbeat('7001608180', 15, 180).toString(), /WLNET,18,1,15,180\)$/);
  // 0 is a legal value meaning "off"; anything else is clamped to 5..86400.
  assert.match(encode.wlnetSetHeartbeat('7001608180', 0, 0).toString(), /WLNET,18,1,0,0\)$/);
  assert.match(encode.wlnetSetHeartbeat('7001608180', 1, 99999).toString(), /WLNET,18,1,5,86400\)$/);
  assert.match(encode.wlnetQueryHeartbeat('7001608180').toString(), /WLNET,18,0\)$/);
});

test('binding sends the complete list, because each write erases the previous', () => {
  assert.match(
    encode.wlnetBindPeripherals('7500313609', ['E0171A00DC', 'E0171A00F1', 'E0171A00A0']).toString(),
    /WLNET,1,1,3,E0171A00DC,E0171A00F1,E0171A00A0\)$/,
  );
  // An empty list is unbind-all, not a malformed command with a zero count.
  assert.match(encode.wlnetBindPeripherals('7500313609', []).toString(), /WLNET,1,1,0\)$/);
  assert.match(encode.wlnetUnbindAll('7500313609').toString(), /WLNET,1,1,0\)$/);
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
  // Manual example: (7500313609,1,001,WLNET,8,1,1,5,E017668836)
  assert.match(
    encode.wlnetUnlockSubLock('8055430364', 'e03b60000a', 5).toString(),
    /^\(8055430364,1,\d{3},WLNET,8,1,1,5,E03B60000A\)$/,
  );
  // The JT709EX wake window is five minutes; anything longer is meaningless.
  assert.match(encode.wlnetUnlockSubLock('8055430364', 'E03B60000A', 99).toString(), /,5,E03B60000A\)$/);
  assert.match(encode.wlnetUnlockSubLock('8055430364', 'E03B60000A', 0).toString(), /,1,E03B60000A\)$/);
});

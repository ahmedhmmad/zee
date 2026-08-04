import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bcd, packCoord, buildPositionFrame, buildLockEvent } from '../scripts/build-frames.ts';
import { decodeBinaryFrame } from '../src/protocol/decode-binary.ts';
import { decodeAsciiFrame } from '../src/protocol/decode-ascii.ts';
import type { LockEventFrame, PositionFrame } from '../src/protocol/types.ts';

/**
 * Round-trip encode -> decode. These exist because a hemisphere flip decodes
 * as a perfectly valid position on the wrong continent: no error, no crash,
 * just a truck drawn in the Atlantic. It has to fail a test instead.
 */

const TRIPOLI = { lat: 32.8872, lon: 13.1913 };

function roundTrip(lat: number, lon: number): PositionFrame {
  const frame = buildPositionFrame({
    deviceId: '8000620011',
    lat,
    lon,
    speedKph: 46.3,
    headingDeg: 90,
    mileageKm: 1200,
    batteryPercent: 87,
    motorLocked: true,
    ropeInserted: true,
    serial: 7,
  });
  const decoded = decodeBinaryFrame(frame);
  assert.equal(decoded.kind, 'position', 'frame should decode as a position');
  return decoded as PositionFrame;
}

test('BCD encoder handles hex nibbles, not just decimal digits', () => {
  // Number('F') is NaN. This is the bug that flipped both hemispheres:
  // the direction indicator collapsed to 0, meaning south-west, no fix.
  assert.deepEqual(bcd('F'), Buffer.from([0xf0]));
  assert.deepEqual(bcd('1F'), Buffer.from([0x1f]));
  assert.deepEqual(bcd('868822040248195F'), Buffer.from('868822040248195f', 'hex'));
});

test('BCD encoder rejects non-hex input loudly rather than emitting zeroes', () => {
  assert.throws(() => bcd('12X4'), /non-hex/);
});

test('coordinate packing matches the DDMM.MMMM form', () => {
  assert.equal(packCoord(32.8872, 2), '32532320');
  assert.equal(packCoord(13.1913, 3), '013114780');
});

test('a Tripoli position round-trips with the correct hemisphere', () => {
  const p = roundTrip(TRIPOLI.lat, TRIPOLI.lon);
  assert.ok(p.latitude > 0, `latitude must be north, got ${p.latitude}`);
  assert.ok(p.longitude > 0, `longitude must be east, got ${p.longitude}`);
  assert.equal(p.latitude.toFixed(4), '32.8872');
  assert.equal(p.longitude.toFixed(4), '13.1913');
});

test('a round-tripped frame reports a GPS fix', () => {
  // The same nibble carries the fix bit, so a broken encoder loses this too.
  assert.equal(roundTrip(TRIPOLI.lat, TRIPOLI.lon).positioned, true);
});

test('all four hemispheres survive the round trip', () => {
  const cases: Array<[number, number, string]> = [
    [32.8872, 13.1913, 'Tripoli (N, E)'],
    [-33.8688, 151.2093, 'Sydney (S, E)'],
    [40.7128, -74.006, 'New York (N, W)'],
    [-34.6037, -58.3816, 'Buenos Aires (S, W)'],
  ];
  for (const [lat, lon, name] of cases) {
    const p = roundTrip(lat, lon);
    assert.equal(Math.sign(p.latitude), Math.sign(lat), `${name}: latitude sign`);
    assert.equal(Math.sign(p.longitude), Math.sign(lon), `${name}: longitude sign`);
    assert.equal(p.latitude.toFixed(3), lat.toFixed(3), `${name}: latitude`);
    assert.equal(p.longitude.toFixed(3), lon.toFixed(3), `${name}: longitude`);
  }
});

test('status, battery and speed survive the round trip', () => {
  const p = roundTrip(TRIPOLI.lat, TRIPOLI.lon);
  assert.equal(p.batteryPercent, 87);
  assert.equal(p.charging, false);
  assert.equal(p.status.motorLocked, true);
  assert.equal(p.status.ropeInserted, true);
  assert.equal(p.status.backCoverClosed, true);
  assert.equal(p.status.ackRequired, true);
  // Quantised by the knots round trip: 46.3 -> 25 kn -> 46.25 -> 46.3.
  assert.equal(p.speedKph, 46.3);
  assert.equal(p.serial, 7);
});

test('the simulated device reports as a Libyan carrier', () => {
  const p = roundTrip(TRIPOLI.lat, TRIPOLI.lon);
  assert.equal(p.mcc, 603, 'MCC 603 is Libya');
  assert.equal(p.mnc, 1, 'MNC 1 is Libyana');
  assert.equal(p.imei, '868822040248195');
});

test('a lock event round-trips', () => {
  const frame = buildLockEvent({
    deviceId: '8000620011',
    lat: TRIPOLI.lat,
    lon: TRIPOLI.lon,
    sourceCode: 4,
    allowed: true,
    serial: 12,
    mileageKm: 1200,
  });
  const decoded = decodeAsciiFrame(frame);
  assert.equal(decoded.kind, 'lock_event');
  const e = decoded as LockEventFrame;
  assert.equal(e.eventSource, 'remote_static_password');
  assert.equal(e.unlockAllowed, true);
  assert.equal(e.eventSerial, 12);
  assert.equal(e.latitude.toFixed(4), '32.8872');
  assert.equal(e.longitude.toFixed(4), '13.1913');
});

test('a refused unlock round-trips as refused', () => {
  const frame = buildLockEvent({
    deviceId: '8000620011',
    lat: TRIPOLI.lat,
    lon: TRIPOLI.lon,
    sourceCode: 4,
    allowed: false,
    serial: 13,
    mileageKm: 1200,
  });
  const e = decodeAsciiFrame(frame) as LockEventFrame;
  assert.equal(e.unlockAllowed, false);
  assert.equal(e.passwordCorrect, false);
});

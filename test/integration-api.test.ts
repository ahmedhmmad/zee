/**
 * The integration API's output shape.
 *
 * Worth testing because every failure here is silent: a partner's map draws
 * something, it just draws it in the wrong place, or omits a vehicle without
 * saying so. None of it raises an error on either side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVehicle, toFeatureCollection } from '../src/api/integration-shape.ts';

/** A truck on Tripoli's coast road, as device_state would return it. */
function tripoliRow(over: Record<string, unknown> = {}) {
  return {
    device_id: '8055430364',
    name: 'Truck 1',
    plate_number: 'TRP-001',
    last_seen_at: new Date('2026-08-15T14:31:32Z'),
    last_position_at: new Date('2026-08-15T14:31:32Z'),
    is_connected: true,
    latitude: 32.8872,
    longitude: 13.1913,
    speed_kph: '43.0',
    heading_deg: 124,
    battery_percent: 87,
    motor_locked: true,
    mileage_km: 1210,
    ...over,
  } as Parameters<typeof toVehicle>[0];
}

test('GeoJSON coordinates are longitude first', () => {
  const fc = toFeatureCollection([toVehicle(tripoliRow())]);
  const [lon, lat] = fc.features[0]!.geometry!.coordinates;

  // Tripoli is 32.9 N, 13.2 E. Reversed, this lands off Somalia - the classic
  // GeoJSON mistake, and one that looks like working software.
  assert.equal(lon, 13.1913, 'first coordinate must be longitude');
  assert.equal(lat, 32.8872, 'second coordinate must be latitude');
});

test('a vehicle with no fix keeps a null geometry rather than vanishing', () => {
  const fc = toFeatureCollection([
    toVehicle(tripoliRow({ latitude: null, longitude: null })),
  ]);

  assert.equal(fc.features.length, 1, 'the vehicle must still be reported');
  assert.equal(fc.features[0]!.geometry, null);
  assert.equal(fc.features[0]!.properties.positioned, false);
});

test('positioned reflects whether coordinates are actually present', () => {
  assert.equal(toVehicle(tripoliRow()).positioned, true);
  assert.equal(toVehicle(tripoliRow({ latitude: null, longitude: null })).positioned, false);
});

test('speed is a number, not the string Postgres returns for numeric', () => {
  const v = toVehicle(tripoliRow());
  assert.equal(typeof v.speedKph, 'number');
  assert.equal(v.speedKph, 43);
  // A partner doing speed > 80 on the string "43.0" gets nonsense, so null
  // must stay null rather than becoming 0.
  assert.equal(toVehicle(tripoliRow({ speed_kph: null })).speedKph, null);
});

test('timestamps are ISO strings', () => {
  const v = toVehicle(tripoliRow());
  assert.equal(v.lastSeenAt, '2026-08-15T14:31:32.000Z');
  assert.equal(toVehicle(tripoliRow({ last_seen_at: null })).lastSeenAt, null);
});

test('no credential or subscriber data reaches an external caller', () => {
  const v = toVehicle(tripoliRow()) as Record<string, unknown>;
  // The console's projection carries these; this one must not. Asserted by
  // name so that widening the query later fails here rather than in Tripoli.
  for (const leaked of [
    'static_password',
    'staticPassword',
    'static_password_is_default',
    'staticPasswordIsDefault',
    'sim_msisdn',
    'simMsisdn',
    'imei',
  ]) {
    assert.equal(leaked in v, false, `${leaked} must not be exposed`);
  }
});

test('the device id is trimmed of char(10) padding', () => {
  // devices.device_id is char(10), so shorter ids arrive space-padded and
  // would not match on the partner's side.
  const v = toVehicle(tripoliRow({ device_id: '8055430364' }));
  assert.equal(v.deviceId, '8055430364');
  assert.equal(v.deviceId.length, 10);
});

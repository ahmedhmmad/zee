/**
 * The integration API's output shape.
 *
 * Worth testing because every failure here is silent: a partner's map draws
 * something, it just draws it in the wrong place, or omits a vehicle without
 * saying so. None of it raises an error on either side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVehicle, toSubLock, toFeatureCollection } from '../src/api/integration-shape.ts';

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
    rope_inserted: true,
    active_alarms: {},
    mileage_km: 1210,
    last_event_at: new Date('2026-08-15T14:20:00Z'),
    last_event_source: 'remote_static_password',
    last_event_allowed: true,
    last_event_command_id: 185,
    ...over,
  } as Parameters<typeof toVehicle>[0];
}

/** A JT709 valve sub-lock bound to that truck, as sub_devices would return it. */
function valveRow(over: Record<string, unknown> = {}) {
  return {
    peripheral_id: 'E03B60000A',
    master_id: '8055430364',
    name: 'صمام 1',
    device_type: 'jt709_sub_lock',
    locked: true,
    rope_pulled_out: false,
    back_cover_open: false,
    battery_percent: 96,
    voltage: '3.60',
    last_seen_at: new Date('2026-08-15T14:30:00Z'),
    comms_lost_alarm: false,
    low_voltage_alarm: false,
    ...over,
  } as Parameters<typeof toSubLock>[0];
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

test('a sub-lock carries no card id, which identifies a driver rather than a valve', () => {
  const s = toSubLock(valveRow({ rfid_card: '0004512345' })) as Record<string, unknown>;
  for (const leaked of ['rfid_card', 'rfidCard', 'card']) {
    assert.equal(leaked in s, false, `${leaked} must not be exposed`);
  }
});

/*
 * The sub-lock half. Every assertion here is about refusing to state something
 * the platform does not know: the JT709 status decoding is reconstructed from
 * real frames rather than documented, so `locked` is a three-state field and
 * flattening it to a boolean anywhere on this path puts a confident answer on
 * a Ministry screen that nothing behind it supports.
 */
test('a sub-lock whose state we cannot read stays null, and is never drawn as locked', () => {
  const v = toVehicle(tripoliRow(), [toSubLock(valveRow({ locked: null }))]);
  assert.equal(v.subLocks[0]!.locked, null, 'unknown must not become false');

  // And through GeoJSON, which is where a map client reads it.
  const fc = toFeatureCollection([v]);
  assert.equal(fc.features[0]!.properties.subLocks[0]!.locked, null);
});

test('the sub-lock counts keep unknown separate from locked', () => {
  const v = toVehicle(tripoliRow(), [
    toSubLock(valveRow({ peripheral_id: 'E03B60000A', locked: true })),
    toSubLock(valveRow({ peripheral_id: 'E03B60000B', locked: false })),
    toSubLock(valveRow({ peripheral_id: 'E03B60000C', locked: null })),
  ]);

  assert.equal(v.subLockCount, 3);
  assert.equal(v.subLocksLocked, 1, 'only a confirmed lock counts as locked');
  assert.equal(v.subLocksUnknown, 1, 'an unreadable valve is reported, not folded away');
});

test('subLocks and alarms are empty arrays rather than null', () => {
  const v = toVehicle(tripoliRow({ active_alarms: null }));
  // A consumer iterating these should not need a null guard, and an absent
  // field reads as "this version of the feed does not send it".
  assert.deepEqual(v.subLocks, []);
  assert.deepEqual(v.alarms, []);
});

test('alarms are published as the names that are actually raised', () => {
  const v = toVehicle(tripoliRow({ active_alarms: { ropeCutAlarm: true, lowBatteryAlarm: true } }));
  assert.deepEqual(v.alarms.sort(), ['lowBatteryAlarm', 'ropeCutAlarm']);
});

test('the last event is the newest event of any kind, not only an unlock', () => {
  const v = toVehicle(tripoliRow());
  assert.equal(v.lastEvent!.at, '2026-08-15T14:20:00.000Z');
  assert.equal(v.lastEvent!.source, 'remote_static_password');
  assert.equal(v.lastEvent!.commandId, 185);

  // auto_locked arrives on this field too. A consumer that read it as an
  // opening would report a valve movement that never happened.
  const locked = toVehicle(tripoliRow({ last_event_source: 'auto_locked', last_event_allowed: false }));
  assert.equal(locked.lastEvent!.source, 'auto_locked');
  assert.equal(locked.lastEvent!.allowed, false);

  assert.equal(toVehicle(tripoliRow({ last_event_at: null })).lastEvent, null);
});

test('sub-lock voltage is a number, like every other numeric on this wire', () => {
  const s = toSubLock(valveRow());
  assert.equal(s.voltage, 3.6);
  assert.equal(toSubLock(valveRow({ voltage: null })).voltage, null);
  assert.equal(s.lastSeenAt, '2026-08-15T14:30:00.000Z');
});

test('the device id is trimmed of char(10) padding', () => {
  // devices.device_id is char(10), so shorter ids arrive space-padded and
  // would not match on the partner's side.
  const v = toVehicle(tripoliRow({ device_id: '8055430364' }));
  assert.equal(v.deviceId, '8055430364');
  assert.equal(v.deviceId.length, 10);
});

/**
 * One vocabulary for the console and the partner feed.
 *
 * `/api/devices` returns what a partner receives plus the operator's own
 * fields, under the same names, so map-drawing code written against either one
 * runs unchanged against the other. That property is worth exactly as much as
 * it is enforced, and neither gate can see it: `tsc` is happy with a projection
 * that quietly drops a field, and `public/` is not type checked at all.
 *
 * Two guards, then. The first says the console's shape still contains the
 * published one. The second says the browser stopped asking for the names that
 * no longer exist — a missed rename there is not an error, it is `undefined`
 * rendered into an operator's screen as "—", which is the failure mode this
 * codebase exists to avoid: a confident display of something we did not check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toVehicle, toSubLock } from '../src/api/integration-shape.ts';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/*
 * The published field names, taken from the functions themselves rather than
 * written out again here. A list copied by hand is a list that goes stale.
 */
const publishedVehicleKeys = Object.keys(
  toVehicle({
    device_id: '8055430364',
    name: 'Truck 1',
    plate_number: 'TRP-001',
    last_seen_at: null,
    last_position_at: null,
    is_connected: false,
    latitude: null,
    longitude: null,
    speed_kph: null,
    heading_deg: null,
    battery_percent: null,
    motor_locked: null,
    rope_inserted: null,
    active_alarms: null,
    mileage_km: null,
    last_event_at: null,
    last_event_source: null,
    last_event_allowed: null,
    last_event_command_id: null,
  }),
);

test('every field a partner receives is on the console row under the same name', () => {
  const source = readFileSync(new URL('../src/api/devices-query.ts', import.meta.url), 'utf8');

  // toConsoleDevice spreads toVehicle. If someone replaces that spread with a
  // hand-written list, the two shapes start drifting the same week.
  assert.match(
    source,
    /\.\.\.toVehicle\(r, subLocks\)/,
    'the console row must be built by spreading the published one, not by restating it',
  );
  assert.match(
    source,
    /\.\.\.toSubLock\(r\)/,
    'the console sub-lock must be built by spreading the published one',
  );

  // And the extras must be additive: none may take a published name and mean
  // something else. `positioned` versus `hasCurrentFix` is the case that
  // nearly happened — two different questions, one word apart.
  const extras = source.slice(source.indexOf('...toVehicle(r, subLocks)'));
  for (const key of publishedVehicleKeys) {
    const redefined = new RegExp(`^\\s{4}${key}:`, 'm').test(extras);
    assert.equal(redefined, false, `${key} is published; the console must not redefine it`);
  }
});

test('the console asks for no device field that the projection stopped sending', () => {
  /*
   * Names the console used before the projection spoke one vocabulary. Reading
   * any of them now yields undefined, which renders as an em dash — a truck
   * that looks reported-on and is not.
   *
   * Scoped to a receiver, because other endpoints legitimately keep their own
   * snake_case rows: `r.device_id` is a password read, `u.device_id` an
   * unknown device, `x.is_armed` an arrival rule. Those are not this rename.
   */
  const gone = [
    'device_id', 'plate_number', 'speed_kph', 'heading_deg', 'battery_percent',
    'motor_locked', 'rope_inserted', 'mileage_km', 'is_connected', 'last_seen_at',
    'last_position_at', 'firmware_version', 'gsm_signal', 'wake_source',
    'static_password_is_default', 'today_km', 'week_km', 'mileage_has_anomaly',
    'active_alarms', 'last_event_at', 'last_event_source', 'last_event_command_id',
    'peripheral_id', 'device_type', 'bound_confirmed_at', 'comms_lost_alarm',
    'low_voltage_alarm', 'rope_pulled_out', 'back_cover_open', 'lock_cycles',
    'temperature_c', 'humidity_percent',
  ];

  const found: string[] = [];
  for (const field of gone) {
    // `d`, `device` and `x` hold a device row; `s` holds a sub-lock.
    const re = new RegExp(`\\b(?:d|device|x|s)\\.${field}\\b`, 'g');
    for (const m of appJs.matchAll(re)) {
      found.push(`public/app.js:${appJs.slice(0, m.index).split('\n').length} — ${m[0]}`);
    }
  }

  assert.deepEqual(found, [], found.join('\n'));
});

test('a sub-lock keeps its three-state locked all the way to the console', () => {
  // The console renders true, false and null as three different pills. The
  // superset must not have flattened the third one on its way through.
  const row = {
    peripheral_id: 'E03B60000A',
    master_id: '8055430364',
    name: null,
    device_type: 'jt709_sub_lock',
    locked: null,
    rope_pulled_out: null,
    back_cover_open: null,
    battery_percent: null,
    voltage: null,
    last_seen_at: null,
    comms_lost_alarm: false,
    low_voltage_alarm: false,
  };
  assert.equal(toSubLock(row).locked, null);
});

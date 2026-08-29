/**
 * The device list projection, in one place.
 *
 * Shared by the REST route and the WebSocket broadcaster: when a position
 * arrives we push that vehicle's updated row down the socket rather than
 * nudging the browser to refetch everything. At a five-second reporting
 * interval a "something changed" ping would have thirty trucks triggering
 * three hundred and sixty full list fetches a minute.
 *
 * ## One vocabulary, two audiences
 *
 * What the console receives is the partner feed's shape plus the fields only an
 * operator may see. Literally: `toConsoleDevice` spreads `toVehicle` and adds to
 * it, so `deviceId`, `locked`, `subLocks` and the rest mean the same thing and
 * carry the same names on both sides of the wall.
 *
 * That is the point of doing it this way. Map-drawing code written against one
 * runs unmodified against the other, so what an operator sees here and what the
 * partner's map draws cannot quietly diverge into two different pictures of the
 * same truck. The extras are additive and never overwrite a published field —
 * a test asserts that.
 *
 * What must never happen is the reverse: an operator-only field leaking into
 * the partner shape. It cannot happen by accident here, because the partner
 * feed is built by `toVehicle` alone and never sees this file.
 */

import { pool } from '../db.ts';
import {
  toVehicle,
  toSubLock,
  type VehicleRow,
  type SubLockRow,
  type SubLock,
} from './integration-shape.ts';

/** The published row, plus the columns only the console is given. */
interface ConsoleRow extends VehicleRow {
  model: string | null;
  imei: string | null;
  firmware_version: string | null;
  sim_msisdn: string | null;
  static_password_is_default: boolean | null;
  connected_at: Date | null;
  /** device_state.positioned: whether the LATEST report carried a fix. */
  has_current_fix: boolean | null;
  satellites: number | null;
  charging: boolean | null;
  gsm_signal: number | null;
  wake_source: string | null;
  mcc: number | null;
  mnc: number | null;
  today_km: number | null;
  week_km: number | null;
  mileage_has_anomaly: boolean | null;
}

/**
 * The console's row: everything a partner gets, and then the operator's part.
 *
 * `hasCurrentFix` is deliberately not `positioned`. The published `positioned`
 * answers "is there a location in this row"; this one answers "did the newest
 * report carry a fix", which is how the panel marks a shown position as the
 * last known one rather than the current one. Two different questions that were
 * one word away from being confused with each other.
 */
function toConsoleDevice(r: ConsoleRow, subLocks: SubLock[]) {
  return {
    ...toVehicle(r, subLocks),

    model: r.model,
    imei: r.imei,
    firmwareVersion: r.firmware_version,
    simMsisdn: r.sim_msisdn,
    // Never the password itself — only whether it is still a factory default.
    staticPasswordIsDefault: r.static_password_is_default,
    connectedAt: r.connected_at?.toISOString() ?? null,
    hasCurrentFix: r.has_current_fix,
    satellites: r.satellites,
    charging: r.charging,
    gsmSignal: r.gsm_signal,
    wakeSource: r.wake_source,
    mcc: r.mcc,
    mnc: r.mnc,
    todayKm: r.today_km,
    weekKm: r.week_km,
    mileageHasAnomaly: r.mileage_has_anomaly,
  };
}

export type ConsoleDevice = ReturnType<typeof toConsoleDevice>;

const SELECT = `
  SELECT d.device_id, d.name, d.plate_number, d.model,
         d.imei, d.firmware_version, d.sim_msisdn,
         -- Never send the password itself to the browser; only whether
         -- it is still one of the well-known factory defaults.
         (d.static_password IN ('888888', '123456')) AS static_password_is_default,
         s.last_seen_at, s.last_position_at,
         COALESCE(s.is_connected, false) AS is_connected,
         s.connected_at,
         -- The same null-island guard the partner feed applies, for the same
         -- reason: a device that has never had a fix stores 0,0, which is a
         -- real point in the Gulf of Guinea. Reported as no position at all.
         -- Both projections must agree about where a truck is not.
         CASE WHEN s.positioned
               AND s.location IS NOT NULL
               AND NOT (abs(ST_Y(s.location::geometry)) < 0.0001
                    AND abs(ST_X(s.location::geometry)) < 0.0001)
              THEN ST_Y(s.location::geometry) END AS latitude,
         CASE WHEN s.positioned
               AND s.location IS NOT NULL
               AND NOT (abs(ST_Y(s.location::geometry)) < 0.0001
                    AND abs(ST_X(s.location::geometry)) < 0.0001)
              THEN ST_X(s.location::geometry) END AS longitude,
         s.positioned AS has_current_fix,
         s.speed_kph, s.heading_deg, s.satellites,
         s.battery_percent, s.charging, s.motor_locked, s.rope_inserted,
         s.gsm_signal, s.wake_source, s.active_alarms,
         s.mileage_km, s.mcc, s.mnc,
         -- The device's odometer only ever counts up, so "distance travelled"
         -- is the span of that counter over a day. Derived from the counter
         -- rather than by summing GPS hops, which would accumulate fix noise
         -- into tens of phantom kilometres on a parked vehicle.
         --
         -- Read from the rollup maintained on write (019), not computed here.
         -- This query runs on every position frame — see the migration — and
         -- the seven-day LATERAL it replaces read about four thousand heap rows
         -- per device per call.
         dist.today_km,
         dist.week_km,
         dist.has_anomaly AS mileage_has_anomaly,
         -- Most recent lock activity, so the panel can show it without the
         -- operator having to go hunting through the event log. Denormalised
         -- onto device_state by store.insertLockEvent.
         s.last_event_at,
         s.last_event_source,
         s.last_event_allowed,
         s.last_event_command_id
    FROM devices d
    LEFT JOIN device_state s ON s.device_id = d.device_id
    LEFT JOIN LATERAL (
      -- Seven Africa/Tripoli days, including today. Both numbers are now
      -- measured against the same calendar: week_km used to be a rolling
      -- 168-hour UTC window while today_km was a Tripoli day, so the two
      -- figures on screen disagreed about what a day was.
      SELECT
        sum(m.last_km - m.first_km) FILTER (
          WHERE m.local_day = (now() AT TIME ZONE 'Africa/Tripoli')::date
        )::int AS today_km,
        sum(m.last_km - m.first_km)::int AS week_km,
        -- An odometer reset inside any of those days makes the span meaningless
        -- — one reset yields about 99,994 km. The console has to be able to say
        -- so rather than showing the number.
        bool_or(m.has_anomaly) AS has_anomaly
        FROM device_mileage_daily m
       WHERE m.device_id = d.device_id
         AND m.local_day > (now() AT TIME ZONE 'Africa/Tripoli')::date - 7
    ) dist ON true
   WHERE d.is_active`;

/**
 * Sub-locks for a set of masters, in one query.
 *
 * One statement for however many devices the caller asked about, not one per
 * device: this runs on the push path, which fires on every position frame, and
 * migration 019 exists because of exactly that mistake made once already.
 * `sub_devices_master_idx` serves it.
 */
const SUBLOCKS_SQL = `
  SELECT p.peripheral_id, p.master_id, p.name, p.device_type, p.locked,
         p.rope_pulled_out, p.back_cover_open, p.battery_percent, p.voltage,
         p.last_seen_at, p.comms_lost_alarm, p.low_voltage_alarm
    FROM sub_devices p
   WHERE p.master_id = ANY($1::char(10)[])
   ORDER BY p.master_id, p.peripheral_id`;

async function subLocksByMaster(deviceIds: string[]): Promise<Map<string, SubLock[]>> {
  const byMaster = new Map<string, SubLock[]>();
  if (deviceIds.length === 0) return byMaster;

  const { rows } = await pool.query<SubLockRow>(SUBLOCKS_SQL, [deviceIds]);
  for (const row of rows) {
    // char(10) on both sides of this map, so trim both or match neither.
    const master = row.master_id.trim();
    const list = byMaster.get(master);
    if (list) list.push(toSubLock(row));
    else byMaster.set(master, [toSubLock(row)]);
  }
  return byMaster;
}

/** Attach each device's sub-locks and shape the rows the console reads. */
async function shape(rows: ConsoleRow[]): Promise<ConsoleDevice[]> {
  const byMaster = await subLocksByMaster(rows.map((r) => r.device_id.trim()));
  return rows.map((r) => toConsoleDevice(r, byMaster.get(r.device_id.trim()) ?? []));
}

/**
 * The sub-lock panel's row: the published sub-lock, plus what the panel shows.
 *
 * Same arrangement as the device above, for the same reason — one vocabulary.
 * `locked` arrives from `toSubLock` still three-state, and the panel already
 * renders true, false and null as three different pills.
 */
interface ConsoleSubLockRow extends SubLockRow {
  rssi: number | null;
  charging: boolean | null;
  lock_cycles: number | null;
  temperature_c: string | null;
  humidity_percent: number | null;
  /** Null once a master stops listing it: bound before, not bound now. */
  bound_confirmed_at: Date | null;
}

function toConsoleSubLock(r: ConsoleSubLockRow) {
  return {
    ...toSubLock(r),
    rssi: r.rssi,
    charging: r.charging,
    lockCycles: r.lock_cycles,
    // numeric(5,1), so a string from pg like every other numeric.
    temperatureC: r.temperature_c === null ? null : Number(r.temperature_c),
    humidityPercent: r.humidity_percent,
    boundConfirmedAt: r.bound_confirmed_at?.toISOString() ?? null,
  };
}

/** Every peripheral bound to one master, for the detail panel. */
export async function fetchSubLocks(deviceId: string): Promise<ReturnType<typeof toConsoleSubLock>[]> {
  const { rows } = await pool.query<ConsoleSubLockRow>(
    `SELECT p.peripheral_id, p.master_id, p.name, p.device_type, p.locked,
            p.rope_pulled_out, p.back_cover_open, p.battery_percent, p.voltage,
            p.last_seen_at, p.comms_lost_alarm, p.low_voltage_alarm,
            p.rssi, p.charging, p.lock_cycles, p.temperature_c, p.humidity_percent,
            p.bound_confirmed_at
       FROM sub_devices p
      WHERE p.master_id = $1
      ORDER BY p.peripheral_id`,
    [deviceId],
  );
  return rows.map(toConsoleSubLock);
}

export async function fetchDevices(): Promise<ConsoleDevice[]> {
  const { rows } = await pool.query<ConsoleRow>(`${SELECT} ORDER BY d.name`);
  return shape(rows);
}

/** One device, or null if it is unknown or deactivated. */
export async function fetchDevice(deviceId: string): Promise<ConsoleDevice | null> {
  const { rows } = await pool.query<ConsoleRow>(`${SELECT} AND d.device_id = $1`, [deviceId]);
  return rows.length ? (await shape(rows))[0]! : null;
}

/**
 * Several devices in one round trip, for the batched WebSocket flush.
 *
 * The push path used to call fetchDevice once per changed device. Coalescing
 * was per device, so across 3,000 distinct trucks it collapsed nothing: at the
 * fleet's ~36 reports a second that is 36 separate executions of this query
 * every second, each with two LATERAL subqueries, against a pool of 15.
 *
 * One `= ANY` does the same work in one execution. Rows come back in whatever
 * order the planner likes; the caller does not care, because each row carries
 * its own deviceId.
 */
export async function fetchDevicesByIds(deviceIds: string[]): Promise<ConsoleDevice[]> {
  if (deviceIds.length === 0) return [];
  const { rows } = await pool.query<ConsoleRow>(
    `${SELECT} AND d.device_id = ANY($1::char(10)[])`,
    [deviceIds],
  );
  return shape(rows);
}

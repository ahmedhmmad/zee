/**
 * The device list projection, in one place.
 *
 * Shared by the REST route and the WebSocket broadcaster: when a position
 * arrives we push that vehicle's updated row down the socket rather than
 * nudging the browser to refetch everything. At a five-second reporting
 * interval a "something changed" ping would have thirty trucks triggering
 * three hundred and sixty full list fetches a minute.
 */

import { pool } from '../db.ts';

const SELECT = `
  SELECT d.device_id, d.name, d.plate_number, d.model,
         d.imei, d.firmware_version, d.sim_msisdn,
         -- Never send the password itself to the browser; only whether
         -- it is still one of the well-known factory defaults.
         (d.static_password IN ('888888', '123456')) AS static_password_is_default,
         s.last_seen_at, s.last_position_at, s.is_connected, s.connected_at,
         ST_Y(s.location::geometry) AS latitude,
         ST_X(s.location::geometry) AS longitude,
         s.positioned, s.speed_kph, s.heading_deg, s.satellites,
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

export async function fetchDevices(): Promise<unknown[]> {
  const { rows } = await pool.query(`${SELECT} ORDER BY d.name`);
  return rows;
}

/** One device, or null if it is unknown or deactivated. */
export async function fetchDevice(deviceId: string): Promise<unknown | null> {
  const { rows } = await pool.query(`${SELECT} AND d.device_id = $1`, [deviceId]);
  return rows[0] ?? null;
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
 * its own device_id.
 */
export async function fetchDevicesByIds(deviceIds: string[]): Promise<unknown[]> {
  if (deviceIds.length === 0) return [];
  const { rows } = await pool.query(`${SELECT} AND d.device_id = ANY($1::char(10)[])`, [deviceIds]);
  return rows;
}

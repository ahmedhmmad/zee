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
         -- The device's odometer only ever counts up, so "distance today" is
         -- the span of that counter across today's reports. Derived from the
         -- counter rather than by summing GPS hops, which would accumulate
         -- fix noise into tens of phantom kilometres on a parked vehicle.
         dist.today_km,
         dist.week_km,
         -- Most recent lock activity, so the panel can show it without
         -- the operator having to go hunting through the event log.
         le.reported_at       AS last_event_at,
         le.event_source_name AS last_event_source,
         le.unlock_allowed    AS last_event_allowed,
         le.command_id        AS last_event_command_id
    FROM devices d
    LEFT JOIN device_state s ON s.device_id = d.device_id
    LEFT JOIN LATERAL (
      SELECT reported_at, event_source_name, unlock_allowed, command_id
        FROM lock_events
       WHERE device_id = d.device_id
       ORDER BY reported_at DESC
       LIMIT 1
    ) le ON true
    LEFT JOIN LATERAL (
      -- Africa/Tripoli, not UTC: "today" has to mean the operator's day, or a
      -- delivery at 01:00 local would be counted against the previous one.
      SELECT
        max(mileage_km) FILTER (
          WHERE reported_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Tripoli')
                                AT TIME ZONE 'Africa/Tripoli'
        ) - min(mileage_km) FILTER (
          WHERE reported_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Tripoli')
                                AT TIME ZONE 'Africa/Tripoli'
        ) AS today_km,
        max(mileage_km) - min(mileage_km) AS week_km
        FROM positions
       WHERE device_id = d.device_id
         AND reported_at >= now() - interval '7 days'
         AND mileage_km IS NOT NULL
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

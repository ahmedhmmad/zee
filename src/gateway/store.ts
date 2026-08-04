/** Persistence for everything the gateway ingests. */

import { pool, type Db } from '../db.ts';
import type { LockEventFrame, PositionFrame } from '../protocol/index.ts';

export async function isKnownDevice(deviceId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM devices WHERE device_id = $1 AND is_active',
    [deviceId],
  );
  return rowCount === 1;
}

export async function recordRejectedFrame(
  deviceId: string | null,
  reason: string,
  remoteIp: string | null,
  raw: Buffer | string,
): Promise<void> {
  const hex = typeof raw === 'string' ? Buffer.from(raw, 'latin1').toString('hex') : raw.toString('hex');
  await pool.query(
    'INSERT INTO rejected_frames (device_id, reason, remote_ip, raw_hex) VALUES ($1, $2, $3, $4)',
    [deviceId, reason, remoteIp, hex.slice(0, 4000)],
  );
}

/**
 * Insert a position. Idempotent by (device_id, reported_at, serial), because
 * blind-area replays re-send data the device already delivered once.
 *
 * Returns true when the row was new.
 */
export async function insertPosition(p: PositionFrame, db: Db = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO positions (
       device_id, reported_at, location, positioned, speed_kph, heading_deg,
       mileage_km, satellites, battery_percent, charging, motor_locked,
       rope_inserted, status_flags, data_type, is_alarm, is_historical,
       gsm_signal, wake_source, mcc, mnc, cell_id, lac, serial
     ) VALUES (
       $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
     )
     ON CONFLICT (device_id, reported_at, serial) DO NOTHING`,
    [
      p.deviceId,
      p.reportedAt,
      p.longitude, // ST_MakePoint takes (x=lon, y=lat)
      p.latitude,
      p.positioned,
      p.speedKph,
      p.headingDeg,
      p.mileageKm,
      p.satellites,
      p.batteryPercent,
      p.charging,
      p.status.motorLocked,
      p.status.ropeInserted,
      JSON.stringify(p.status),
      p.dataType,
      p.isAlarm,
      p.isHistorical,
      p.gsmSignalValid ? p.gsmSignal : null,
      p.wakeSource,
      p.mcc,
      p.mnc,
      p.cellId,
      p.lac,
      p.serial,
    ],
  );
  return rowCount === 1;
}

/**
 * Update the live snapshot the map reads from.
 *
 * Guarded on reported_at so an out-of-order blind-area replay cannot overwrite
 * a newer live position — the device sends real-time data first by default,
 * so history routinely arrives after the present.
 */
export async function updateDeviceState(p: PositionFrame, db: Db = pool): Promise<void> {
  const alarms = Object.fromEntries(
    Object.entries(p.status).filter(([k, v]) => v === true && k.endsWith('Alarm')),
  );

  await db.query(
    `INSERT INTO device_state (
       device_id, last_seen_at, last_position_at, location, positioned,
       speed_kph, heading_deg, satellites, battery_percent, charging,
       motor_locked, rope_inserted, gsm_signal, wake_source, active_alarms,
       is_connected, updated_at
     ) VALUES (
       $1, now(), $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true, now()
     )
     ON CONFLICT (device_id) DO UPDATE SET
       last_seen_at     = now(),
       last_position_at = EXCLUDED.last_position_at,
       location         = EXCLUDED.location,
       positioned       = EXCLUDED.positioned,
       speed_kph        = EXCLUDED.speed_kph,
       heading_deg      = EXCLUDED.heading_deg,
       satellites       = EXCLUDED.satellites,
       battery_percent  = EXCLUDED.battery_percent,
       charging         = EXCLUDED.charging,
       motor_locked     = EXCLUDED.motor_locked,
       rope_inserted    = EXCLUDED.rope_inserted,
       gsm_signal       = EXCLUDED.gsm_signal,
       wake_source      = EXCLUDED.wake_source,
       active_alarms    = EXCLUDED.active_alarms,
       is_connected     = true,
       updated_at       = now()
     WHERE device_state.last_position_at IS NULL
        OR device_state.last_position_at <= EXCLUDED.last_position_at`,
    [
      p.deviceId,
      p.reportedAt,
      p.longitude,
      p.latitude,
      p.positioned,
      p.speedKph,
      p.headingDeg,
      p.satellites,
      p.batteryPercent,
      p.charging,
      p.status.motorLocked,
      p.status.ropeInserted,
      p.gsmSignalValid ? p.gsmSignal : null,
      p.wakeSource,
      JSON.stringify(alarms),
    ],
  );
}

export async function insertLockEvent(e: LockEventFrame): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO lock_events (
       device_id, reported_at, location, positioned, speed_kph,
       event_source, event_source_name, verification_code, unlock_allowed,
       refused_outside_fence, rfid_card, password_correct, wrong_password_count,
       mileage_km, fence_id, imei, event_serial, raw
     ) VALUES (
       $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6,
       $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
     )
     ON CONFLICT (device_id, reported_at, event_serial) DO NOTHING
     RETURNING id`,
    [
      e.deviceId,
      e.reportedAt,
      e.longitude,
      e.latitude,
      e.positioned,
      e.speedKph,
      e.eventSourceCode,
      e.eventSource,
      e.verificationCode,
      e.unlockAllowed,
      e.refusedOutsideFence,
      e.rfidCard,
      e.passwordCorrect,
      e.wrongPasswordCount,
      e.mileageKm,
      e.fenceId,
      e.imei,
      e.eventSerial,
      e.raw,
    ],
  );
  return rows[0]?.id ?? null;
}

export async function recordDynamicPassword(deviceId: string, password: string): Promise<void> {
  await pool.query(
    'UPDATE devices SET dynamic_password = $2, dynamic_password_at = now() WHERE device_id = $1',
    [deviceId, password],
  );
}

export async function setConnected(deviceId: string, connected: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO device_state (device_id, is_connected, connected_at, last_seen_at, updated_at)
     VALUES ($1, $2, CASE WHEN $2 THEN now() END, now(), now())
     ON CONFLICT (device_id) DO UPDATE SET
       is_connected = EXCLUDED.is_connected,
       connected_at = CASE WHEN $2 THEN now() ELSE device_state.connected_at END,
       last_seen_at = now(),
       updated_at   = now()`,
    [deviceId, connected],
  );
}

export async function touchLastSeen(deviceId: string): Promise<void> {
  await pool.query(
    `UPDATE device_state SET last_seen_at = now(), updated_at = now() WHERE device_id = $1`,
    [deviceId],
  );
}

// --- Command queue ---------------------------------------------------------

export interface PendingCommand {
  id: number;
  device_id: string;
  command_type: string;
  payload: string;
  expires_at: Date;
}

/** Claim dispatchable commands for a device, skipping ones already expired. */
export async function claimPendingCommands(deviceId: string): Promise<PendingCommand[]> {
  const { rows } = await pool.query<PendingCommand>(
    `UPDATE commands SET status = 'expired'
      WHERE device_id = $1 AND status IN ('queued','approved') AND expires_at <= now()`,
    [deviceId],
  ).then(() =>
    pool.query<PendingCommand>(
      `SELECT id, device_id, command_type, payload, expires_at
         FROM commands
        WHERE device_id = $1 AND status IN ('queued','approved') AND expires_at > now()
        ORDER BY requested_at ASC
        LIMIT 20`,
      [deviceId],
    ),
  );
  return rows;
}

export async function markCommandSent(id: number): Promise<void> {
  await pool.query(
    `UPDATE commands
        SET status = 'sent', sent_at = now(), attempts = attempts + 1
      WHERE id = $1`,
    [id],
  );
}

export async function markCommandFailed(id: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE commands SET status = 'failed', last_error = $2 WHERE id = $1`,
    [id, error],
  );
}

/**
 * Close the loop on an unlock: match a P45 report back to the command that
 * caused it. Only the device's own report can do this — a successful socket
 * write proves nothing about whether the lock actually opened.
 */
export async function confirmCommandFromEvent(
  deviceId: string,
  eventId: number,
  eventSourceCode: number,
): Promise<void> {
  const types =
    eventSourceCode === 4
      ? ['unlock_static']
      : eventSourceCode === 6
        ? ['unlock_dynamic']
        : [];
  if (types.length === 0) return;

  await pool.query(
    `WITH matched AS (
       SELECT id FROM commands
        WHERE device_id = $1 AND status = 'sent' AND command_type = ANY($2)
        ORDER BY sent_at DESC LIMIT 1
     )
     UPDATE commands c
        SET status = 'confirmed', confirmed_at = now()
       FROM matched m WHERE c.id = m.id`,
    [deviceId, types],
  );

  await pool.query(
    `UPDATE lock_events le
        SET command_id = c.id
       FROM commands c
      WHERE le.id = $1
        AND c.device_id = $2
        AND c.status = 'confirmed'
        AND c.confirmed_at > now() - interval '1 minute'`,
    [eventId, deviceId],
  );
}

export async function audit(
  action: string,
  deviceId: string | null,
  detail: Record<string, unknown>,
  commandId?: number,
): Promise<void> {
  await pool.query(
    'INSERT INTO audit_log (actor, action, device_id, command_id, detail) VALUES ($1, $2, $3, $4, $5)',
    ['gateway', action, deviceId, commandId ?? null, JSON.stringify(detail)],
  );
}

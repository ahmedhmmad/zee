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

/** Anonymous probe traffic, counted rather than stored. */
let anonymousRejects = 0;

export function anonymousRejectCount(): number {
  return anonymousRejects;
}

/**
 * Record a frame we refused.
 *
 * Only frames carrying a device ID are persisted. Those are the ones that
 * matter: a real lock missing from the allowlist, or an ID changing mid
 * session. Everything else is internet background noise - port scanners
 * probing 10001 - and storing each probe would fill a disk-constrained box
 * with data nobody will ever read. Those are counted instead.
 */
export async function recordRejectedFrame(
  deviceId: string | null,
  reason: string,
  remoteIp: string | null,
  raw: Buffer | string,
): Promise<void> {
  if (!deviceId) {
    anonymousRejects++;
    // Periodic heartbeat so probing is still visible without the volume.
    if (anonymousRejects % 100 === 0) {
      console.log(`[gateway] ${anonymousRejects} unidentified frames rejected since start`);
    }
    return;
  }

  const hex = typeof raw === 'string' ? Buffer.from(raw, 'latin1').toString('hex') : raw.toString('hex');
  await pool.query(
    'INSERT INTO rejected_frames (device_id, reason, remote_ip, raw_hex) VALUES ($1, $2, $3, $4)',
    [deviceId, sanitise(reason), remoteIp, hex.slice(0, 4000)],
  );
}

/**
 * Strip anything Postgres will not accept in a text column. Frame contents are
 * arbitrary bytes, and a single NUL aborts the insert - which previously took
 * down the whole rejection path with a UTF8 encoding error.
 */
function sanitise(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '.').slice(0, 500);
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
       mileage_km, mcc, mnc, is_connected, updated_at
     ) VALUES (
       $1, now(), $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, true, now()
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
       mileage_km       = EXCLUDED.mileage_km,
       mcc              = EXCLUDED.mcc,
       mnc              = EXCLUDED.mnc,
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
      p.mileageKm,
      p.mcc,
      p.mnc,
    ],
  );

  // The IMEI rides along in every position frame once P94 bit0 is enabled;
  // record it on the device rather than only per-row.
  if (p.imei) {
    await db.query(
      'UPDATE devices SET imei = $2 WHERE device_id = $1 AND (imei IS NULL OR imei <> $2)',
      [p.deviceId, p.imei],
    );
  }
}

/** Store the firmware string from a P01 response. */
export async function recordFirmware(deviceId: string, firmware: string): Promise<void> {
  await pool.query(
    'UPDATE devices SET firmware_version = $2, firmware_seen_at = now() WHERE device_id = $1',
    [deviceId, firmware.slice(0, 200)],
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

/**
 * Clear every connection flag at startup.
 *
 * Sockets live in this process's memory, so after a restart or a crash none
 * exist - but device_state may still say `is_connected = true` because the
 * close handlers never ran. Showing a truck as reachable when it isn't is
 * worse than showing it offline: an operator would expect an unlock to land
 * immediately. Devices re-flag themselves as they reconnect.
 */
export async function clearAllConnections(): Promise<number> {
  const { rowCount } = await pool.query(
    'UPDATE device_state SET is_connected = false, updated_at = now() WHERE is_connected',
  );
  return rowCount ?? 0;
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
        WHERE device_id = $1
          AND status IN ('queued','approved')
          AND expires_at > now()
          AND (not_before IS NULL OR not_before <= now())
        ORDER BY requested_at ASC
        LIMIT 20`,
      [deviceId],
    ),
  );
  return rows;
}

/**
 * Queue a position query to run after the device has had time to auto-lock.
 *
 * Without this the state we hold is frozen at the moment of unlocking: the
 * device closes the lock a minute later (P83) while asleep, and nobody ever
 * tells us. The console then shows "open" for a lock that is shut - which on a
 * fuel tanker is exactly the wrong way round to be wrong.
 */
export async function queueLockStateRefresh(deviceId: string, delayMinutes = 3): Promise<void> {
  await pool.query(
    `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, not_before, expires_at)
     SELECT $1, 'query_position', '(P02)', 'system', 'refresh lock state after unlock', 'queued',
            now() + ($2 || ' minutes')::interval, now() + interval '6 hours'
      WHERE NOT EXISTS (
        SELECT 1 FROM commands
         WHERE device_id = $1 AND command_type = 'query_position'
           AND status IN ('queued','approved')
      )`,
    [deviceId, delayMinutes],
  );
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
 * Attribute a lock event to the command that caused it, for the audit trail.
 *
 * Deliberately conservative. Event source 4 means "remote static password",
 * which covers BOTH an SMS unlock and a platform unlock - the protocol gives
 * us no way to tell them apart. Attributing a card swipe or an SMS unlock to a
 * platform command would put a false claim in the audit log, which is worse
 * than leaving the event unattributed.
 *
 * So we only link when a command of the matching type was confirmed by the
 * device seconds earlier, and the event itself reports a successful unlock.
 * Command *status* is driven by the P43/P52 response, not by this.
 */
export async function linkEventToCommand(
  deviceId: string,
  eventId: number,
  eventSourceCode: number,
  unlockAllowed: boolean,
): Promise<void> {
  if (!unlockAllowed) return;

  const types =
    eventSourceCode === 4 ? ['unlock_static'] : eventSourceCode === 6 ? ['unlock_dynamic'] : [];
  if (types.length === 0) return;

  // Match on when the DEVICE says the event happened versus when we sent the
  // command - not on delivery times. P45 reports are cached in flash and
  // arrive two to five minutes late, so anchoring on arrival misses them
  // entirely. The device's own reported_at for a platform unlock matches
  // sent_at to the second.
  await pool.query(
    `UPDATE lock_events le
        SET command_id = c.id
       FROM commands c
      WHERE le.id = $1
        AND c.device_id = $2
        AND c.command_type = ANY($3)
        AND c.status = 'confirmed'
        AND c.sent_at IS NOT NULL
        AND le.reported_at BETWEEN c.sent_at - interval '30 seconds'
                               AND c.sent_at + interval '2 minutes'`,
    [eventId, deviceId, types],
  );
}

/**
 * Resolve a command from the device's own response.
 *
 * The response is the authority on whether a command was accepted: an unlock
 * answers (P43,1,0) or (P43,0,n), and a query answers with its value. Without
 * this, query commands sat at 'sent' indefinitely because only unlocks ever
 * had a completion path.
 *
 * Matches on the command word at the start of the payload, so (P44,1) is
 * resolved by a P44 response and nothing else.
 */
export async function resolveCommandFromResponse(
  deviceId: string,
  commandWord: string,
  ok: boolean,
  response: string,
): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    `WITH matched AS (
       SELECT id FROM commands
        WHERE device_id = $1
          AND status = 'sent'
          AND payload LIKE $2
        ORDER BY sent_at DESC LIMIT 1
     )
     UPDATE commands c
        SET status       = CASE WHEN $3 THEN 'confirmed' ELSE 'failed' END,
            confirmed_at = CASE WHEN $3 THEN now() END,
            last_error   = CASE WHEN $3 THEN NULL ELSE $4 END,
            response     = $4
       FROM matched m
      WHERE c.id = m.id
      RETURNING c.id`,
    [deviceId, `(${commandWord}%`, ok, response.slice(0, 500)],
  );
  return rows[0]?.id ?? null;
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

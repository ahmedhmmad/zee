/** Persistence for everything the gateway ingests. */

import { pool, type Db } from '../db.ts';
import type { LockEventFrame, PositionFrame } from '../protocol/index.ts';

/**
 * Why a command failed, mirroring the CHECK in 014_command_evidence.sql.
 *
 * The distinction that matters is `device_rejected` versus everything else:
 * only the device answering "no" says anything about whether the password we
 * hold is right, and only that may feed the repeated-failure lockout. A socket
 * that broke says nothing about the password.
 */
export type FailureCause =
  | 'device_rejected'
  | 'transport'
  | 'no_response'
  | 'cancelled'
  | 'unclassified';

/**
 * Check the allowlist and mark the device connected, in one round trip.
 *
 * These were two queries asking overlapping questions — "is this device
 * allowed?" then "record that it is connected" — run back to back on every
 * connect. At two devices that is nothing. When the whole fleet reconnects
 * after a gateway restart it is 6,000 statements in about a minute, against a
 * pool that is simultaneously absorbing the replayed position backlog.
 *
 * Called only from the gateway's session registry, which is the sole writer of
 * is_connected. See the invariant in src/gateway/index.ts.
 *
 * Returns whether the device is on the allowlist. When it is not, nothing is
 * written: the data-modifying CTE selects from `known`, which is empty, so the
 * INSERT has no rows to insert. The device_state row is left alone rather than
 * being created for a device the platform does not recognise.
 *
 * The allowlist is the only authentication this protocol has, so this answer is
 * the whole of the gateway's access control.
 */
export async function admitDevice(deviceId: string): Promise<boolean> {
  const { rows } = await pool.query<{ known: boolean }>(
    `WITH known AS (
       SELECT device_id FROM devices WHERE device_id = $1 AND is_active
     ),
     admitted AS (
       INSERT INTO device_state (device_id, is_connected, connected_at, last_seen_at, updated_at)
       SELECT device_id, true, now(), now(), now() FROM known
       ON CONFLICT (device_id) DO UPDATE SET
         is_connected = true,
         connected_at = now(),
         last_seen_at = now(),
         updated_at   = now()
       RETURNING device_id
     )
     SELECT EXISTS (SELECT 1 FROM known) AS known`,
    [deviceId],
  );
  return rows[0]?.known === true;
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
/**
 * Coordinates for storage, or null when the device had no fix.
 *
 * A device without a fix reports 0,0 — a real point in the Gulf of Guinea.
 * Storing that as a position is a lie: it is not where the truck is, and it
 * contaminates every distance, track and report downstream. Absence of a fix
 * is absence of a position, and NULL says so.
 */
function locationOf(p: PositionFrame): { lon: number; lat: number } | null {
  if (!p.positioned) return null;
  if (Math.abs(p.latitude) < 0.0001 && Math.abs(p.longitude) < 0.0001) return null;
  return { lon: p.longitude, lat: p.latitude };
}

export async function insertPosition(p: PositionFrame, db: Db = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO positions (
       device_id, reported_at, location, positioned, speed_kph, heading_deg,
       mileage_km, satellites, battery_percent, charging, motor_locked,
       rope_inserted, status_flags, data_type, is_alarm, is_historical,
       gsm_signal, wake_source, mcc, mnc, cell_id, lac, serial
     ) VALUES (
       $1, $2,
       CASE WHEN $3::double precision IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography END,
       $5, $6, $7,
       $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
     )
     ON CONFLICT (device_id, reported_at, serial) DO NOTHING`,
    [
      p.deviceId,
      p.reportedAt,
      locationOf(p)?.lon ?? null, // ST_MakePoint takes (x=lon, y=lat)
      locationOf(p)?.lat ?? null,
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
 *
 * Also the one place the device's clock offset is sampled. See
 * `clockOffsetSample` below for why it happens here and not at the handshake.
 */
export async function updateDeviceState(p: PositionFrame, db: Db = pool): Promise<void> {
  const alarms = Object.fromEntries(
    Object.entries(p.status).filter(([k, v]) => v === true && k.endsWith('Alarm')),
  );

  await db.query(
    /*
     * The daily odometer rollup rides along in the same statement.
     *
     * A data-modifying CTE always executes, whether or not the primary query
     * reads it, so this costs no extra round trip — which matters because this
     * runs on every position frame from every truck.
     *
     * It is NOT inside the freshness guard below. A replayed blind-area frame
     * must not rewind the live snapshot, but it is still a true reading for its
     * own day and belongs in that day's span.
     */
    `WITH rollup AS (
       INSERT INTO device_mileage_daily
         (device_id, local_day, first_km, last_km, latest_reported_at, km_at_latest, updated_at)
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'Africa/Tripoli')::date, $16::integer, $16, $2, $16, now())
       ON CONFLICT (device_id, local_day) DO UPDATE SET
         first_km = least(device_mileage_daily.first_km, EXCLUDED.first_km),
         last_km  = greatest(device_mileage_daily.last_km, EXCLUDED.last_km),
         latest_reported_at =
           greatest(device_mileage_daily.latest_reported_at, EXCLUDED.latest_reported_at),
         -- Only a genuinely newer reading moves this. That is what keeps
         -- has_anomaly meaning "the odometer went backwards" rather than
         -- "some history arrived late".
         km_at_latest = CASE
           WHEN EXCLUDED.latest_reported_at >= device_mileage_daily.latest_reported_at
           THEN EXCLUDED.km_at_latest ELSE device_mileage_daily.km_at_latest END,
         updated_at = now()
     )
     INSERT INTO device_state (
       device_id, last_seen_at, last_position_at, location, positioned,
       speed_kph, heading_deg, satellites, battery_percent, charging,
       motor_locked, rope_inserted, gsm_signal, wake_source, active_alarms,
       mileage_km, mcc, mnc, clock_offset_ms, clock_offset_at, updated_at
     ) VALUES (
       $1, now(), $2,
       CASE WHEN $3::double precision IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography END,
       $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, CASE WHEN $19::bigint IS NOT NULL THEN now() END,
       now()
     )
     ON CONFLICT (device_id) DO UPDATE SET
       last_seen_at     = now(),
       last_position_at = EXCLUDED.last_position_at,
       -- Keep the last known good fix when the new report has none: a truck
       -- in a tunnel is still somewhere, and that somewhere is the last
       -- place we saw it. The positioned flag below marks it as stale.
       location         = COALESCE(EXCLUDED.location, device_state.location),
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
       -- NULL means this frame was not eligible to be sampled, not that the
       -- offset is unknown. Keep whatever was last measured.
       clock_offset_ms  = COALESCE(EXCLUDED.clock_offset_ms, device_state.clock_offset_ms),
       clock_offset_at  = COALESCE(EXCLUDED.clock_offset_at, device_state.clock_offset_at),
       -- is_connected is deliberately absent. The ingest path is the third
       -- writer that made the connection flag unreliable: it asserted true on
       -- every position frame, including a blind-area replay from a truck that
       -- had already hung up. Only the gateway's session registry writes it.
       updated_at       = now()
     WHERE device_state.last_position_at IS NULL
        OR device_state.last_position_at <= EXCLUDED.last_position_at`,
    [
      p.deviceId,
      p.reportedAt,
      locationOf(p)?.lon ?? null,
      locationOf(p)?.lat ?? null,
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
      clockOffsetSample(p),
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

/**
 * How far this device's clock is from ours, in milliseconds, or null if this
 * frame is not allowed to say.
 *
 * Only a real-time frame may be sampled. Blind-area (type 3) and backlog
 * (type 4) frames are deliberately old — sampling one would record a device as
 * hours behind when its clock is fine, and that wrong correction would then be
 * used to attribute a lock event to the wrong command.
 *
 * The plan proposed taking this from the time-sync handshake. That is not
 * possible: the P22,2 frame is a bare request for the time and carries no
 * device timestamp. A position frame carries reportedAt from the same clock
 * that stamps a P45, which is the clock actually being corrected.
 *
 * Network latency makes the device look a fraction of a second behind. The
 * windows this feeds are measured in tens of seconds and minutes, so it does
 * not matter and is not corrected for.
 */
export function clockOffsetSample(p: PositionFrame): number | null {
  if (p.isHistorical || p.isBacklog) return null;
  return p.reportedAt.getTime() - Date.now();
}

/** Store the firmware string from a P01 response. */
export async function recordFirmware(deviceId: string, firmware: string): Promise<void> {
  await pool.query(
    'UPDATE devices SET firmware_version = $2, firmware_seen_at = now() WHERE device_id = $1',
    [deviceId, firmware.slice(0, 200)],
  );
}

export async function insertLockEvent(e: LockEventFrame): Promise<number | null> {
  const { rows } = await pool.query<{
    id: number;
    reported_at: Date;
    event_source_name: string;
    unlock_allowed: boolean;
  }>(
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
     RETURNING id, reported_at, event_source_name, unlock_allowed`,
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

  const inserted = rows[0];
  if (!inserted) return null;

  /*
   * Keep the newest lock event on the device row.
   *
   * The device list used to find it with a per-device LATERAL, on a query that
   * runs on every position frame. Lock events are a handful per device per day,
   * so writing it here costs nothing measurable and the subquery disappears.
   *
   * Guarded on reported_at: a P45 is cached in flash and delivered late, so an
   * older event routinely arrives after a newer one and must not overwrite it.
   * lock_events remains the record; this is only a cache of its newest entry.
   */
  await pool.query(
    `UPDATE device_state
        SET last_event_at         = $2,
            last_event_source     = $3,
            last_event_allowed    = $4,
            last_event_command_id = NULL,
            updated_at            = now()
      WHERE device_id = $1
        AND (last_event_at IS NULL OR last_event_at <= $2)`,
    [e.deviceId, inserted.reported_at, inserted.event_source_name, inserted.unlock_allowed],
  );

  return inserted.id;
}

/**
 * Record a peripheral reading and update the sub-device's live state.
 *
 * Every reading is kept, not just the latest, so a status byte can later be
 * correlated with a physical state somebody observed - which is how the
 * provisional lock decoding gets confirmed.
 */
export async function recordPeripheralReading(
  masterId: string,
  p: import('../protocol/decode-peripheral.ts').DecodedPeripheral,
): Promise<number | null> {
  const fields = [
    p.peripheralId,
    masterId,
    p.deviceType,
    p.deviceTypeCode,
    p.reportedAt,
    p.voltage,
    p.batteryPercent,
    p.rssi,
    p.eventCode,
    p.eventName,
    p.locked,
    p.status?.ropePulledOut ?? null,
    p.status?.backCoverOpen ?? null,
    p.status?.charging ?? null,
    p.lockCycles,
    p.rfidCard,
    p.commsLostAlarm,
    p.lowVoltageAlarm,
    p.temperatureC,
    p.humidityPercent,
  ];

  await pool.query(
    `INSERT INTO sub_devices (
       peripheral_id, master_id, device_type, device_type_code, last_seen_at,
       voltage, battery_percent, rssi, event_code, event_name, locked,
       rope_pulled_out, back_cover_open, charging, lock_cycles, rfid_card,
       comms_lost_alarm, low_voltage_alarm, temperature_c, humidity_percent
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (peripheral_id) DO UPDATE SET
       master_id        = EXCLUDED.master_id,
       device_type      = EXCLUDED.device_type,
       device_type_code = EXCLUDED.device_type_code,
       last_seen_at     = EXCLUDED.last_seen_at,
       voltage          = EXCLUDED.voltage,
       battery_percent  = EXCLUDED.battery_percent,
       rssi             = EXCLUDED.rssi,
       event_code       = EXCLUDED.event_code,
       event_name       = EXCLUDED.event_name,
       locked           = EXCLUDED.locked,
       rope_pulled_out  = EXCLUDED.rope_pulled_out,
       back_cover_open  = EXCLUDED.back_cover_open,
       charging         = EXCLUDED.charging,
       lock_cycles      = EXCLUDED.lock_cycles,
       rfid_card        = EXCLUDED.rfid_card,
       comms_lost_alarm = EXCLUDED.comms_lost_alarm,
       low_voltage_alarm = EXCLUDED.low_voltage_alarm,
       temperature_c    = EXCLUDED.temperature_c,
       humidity_percent = EXCLUDED.humidity_percent
     WHERE sub_devices.last_seen_at IS NULL
        OR sub_devices.last_seen_at <= EXCLUDED.last_seen_at`,
    fields,
  );

  // Keep every reading. Replayed data is flagged rather than dropped: it is
  // still a true record of what the sub-lock did, just delivered late.
  //
  // The id comes back so a reading that says "this valve is open" can be cited
  // as a command's physical evidence. A duplicate returns no row — there is no
  // new evidence in a report already held, and re-confirming from it would put
  // a fresh timestamp on an old fact.
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sub_device_readings (
       peripheral_id, master_id, reported_at, voltage, battery_percent, rssi,
       event_code, event_name, locked, rope_pulled_out, back_cover_open,
       charging, lock_cycles, rfid_card, comms_lost_alarm, low_voltage_alarm,
       temperature_c, humidity_percent, reupload, sensor_serial, raw_hex
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (peripheral_id, reported_at, sensor_serial) DO NOTHING
     RETURNING id`,
    [
      p.peripheralId,
      masterId,
      p.reportedAt,
      p.voltage,
      p.batteryPercent,
      p.rssi,
      p.eventCode,
      p.eventName,
      p.locked,
      p.status?.ropePulledOut ?? null,
      p.status?.backCoverOpen ?? null,
      p.status?.charging ?? null,
      p.lockCycles,
      p.rfidCard,
      p.commsLostAlarm,
      p.lowVoltageAlarm,
      p.temperatureC,
      p.humidityPercent,
      p.reupload,
      p.sensorSerial,
      p.raw.toString('hex'),
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

/**
 * The only write to device_state.is_connected in the codebase.
 *
 * Called from the gateway's session registry and nowhere else — see the
 * invariant in src/gateway/index.ts. If you are about to call this from a
 * session or from the ingest path, that is the bug this comment exists to
 * prevent.
 */
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
  /**
   * Null when a credential the payload needs is not on record — the queue holds
   * placeholders, not passwords, and they are filled in at dispatch. The caller
   * must refuse to send it rather than putting a malformed frame on the wire.
   */
  payload: string | null;
  expires_at: Date;
}

/**
 * Claim dispatchable commands for a device.
 *
 * Claiming and marking sent happen in ONE statement. Selecting first and
 * marking afterwards let two concurrent drains - one from the socket opening,
 * one from a NOTIFY or the periodic sweep - both pick up the same rows and
 * send every command twice, which is exactly what happened to the
 * commissioning sequence.
 */
export async function claimPendingCommands(deviceId: string): Promise<PendingCommand[]> {
  // The per-device expiry UPDATE that used to run here is gone. It fired on
  // every drain — twice per device per sweep at fleet scale, almost always
  // updating nothing — and it could only ever reach a truck that was connected,
  // so a lapsed unlock on a sleeping one stayed 'queued' to the operator
  // forever. expireLapsedCommands does it once per sweep for the whole fleet.
  //
  // The claim below still refuses an expired command on its own
  // (`expires_at > now()`), so nothing lapsed can be dispatched in the window
  // between one sweep and the next.
  const { rows } = await pool.query<PendingCommand>(
    `WITH claimed AS (
       SELECT id FROM commands
        WHERE device_id = $1
          AND status IN ('queued','approved')
          AND expires_at > now()
          AND (not_before IS NULL OR not_before <= now())
        ORDER BY requested_at ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED
     ),
     upd AS (
       UPDATE commands c
          SET status = 'sent', sent_at = now(), attempts = c.attempts + 1
         FROM claimed
        WHERE c.id = claimed.id
        RETURNING c.id, c.device_id, c.command_type, c.payload, c.expires_at, c.metadata
     )
     /*
      * Fill in the credentials the queue deliberately does not hold.
      *
      * commands.payload keeps a row for the life of the authorisation and is
      * readable by anyone with database access, so it stores placeholders and
      * the real values are substituted here, at the last possible moment.
      *
      * A missing value yields NULL rather than a frame reading "(P43,)" — the
      * caller refuses to send a null payload. Checked per placeholder, because
      * a blanket replace() with a NULL argument would null out every ordinary
      * payload that has no placeholder in it at all.
      */
     SELECT u.id, u.device_id, u.command_type, u.expires_at,
            CASE
              WHEN u.payload LIKE '%{{static_password}}%' AND d.static_password IS NULL THEN NULL
              WHEN u.payload LIKE '%{{new_password}}%' AND u.metadata->>'newPassword' IS NULL THEN NULL
              ELSE replace(
                     replace(u.payload, '{{static_password}}', COALESCE(d.static_password, '')),
                     '{{new_password}}', COALESCE(u.metadata->>'newPassword', '')
                   )
            END AS payload
       FROM upd u
       JOIN devices d ON d.device_id = u.device_id`,
    [deviceId],
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

/**
 * Which devices have dispatchable work waiting, fleet-wide.
 *
 * The sweep used to call drainCommands for every connected session — roughly
 * 6,000 statements a minute at 3,000 devices, almost all of them finding
 * nothing. This asks once and the sweep drains only the intersection with the
 * sessions it actually holds.
 *
 * 'uncertain' is deliberately absent, and this is the point at which that
 * matters most. An uncertain command may already have opened a valve; the whole
 * reason it is not 'queued' is so that nothing resends it. A due query that
 * picked it up would undo the timeout policy in one line.
 *
 * Served by commands_due_idx (018), which is not device-leading — unlike
 * commands_dispatch_idx, which this query cannot use.
 */
export async function dueCommandDeviceIds(limit = 5_000): Promise<string[]> {
  const { rows } = await pool.query<{ device_id: string }>(
    `SELECT DISTINCT device_id
       FROM commands
      WHERE status IN ('queued', 'approved')
        AND expires_at > now()
        AND (not_before IS NULL OR not_before <= now())
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => r.device_id.trim());
}

/**
 * Expire commands fleet-wide, once per sweep.
 *
 * The per-device version of this runs inside claimPendingCommands, which only
 * fires for a device that is connected and being drained. A truck that has been
 * asleep for a day never gets one, so its lapsed unlock keeps reading 'queued'
 * — and `/api/devices/:id/commands` selects status raw, with no expiry
 * computed. An operator sees a pending unlock that will never fire, with
 * nothing to tell them so.
 *
 * `expires_at` is what stops an unlock authorised at 09:00 from opening a valve
 * at 14:00 somewhere else entirely, so this is the enforcement of that promise
 * as well as the display of it.
 *
 * failure_cause is left null on purpose: nothing failed and nobody cancelled
 * it. The authorisation simply ran out.
 */
export async function expireLapsedCommands(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE commands
        SET status = 'expired',
            last_error = 'authorisation expired before the device could be reached'
      WHERE status IN ('queued', 'approved', 'draft', 'pending_approval')
        AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

/**
 * Deal with commands that were sent and never answered — differently depending
 * on whether resending one can move a valve.
 *
 * Cellular links drop mid-exchange - one device here loses its socket every
 * few minutes - and a command written into a dying connection is simply gone.
 * Without this it sits at 'sent' forever: the operator sees "awaiting device
 * confirmation" indefinitely for something the device never received.
 *
 * But "the device never received it" is an assumption, and for an unlock it is
 * an unsafe one. Silence is not evidence that nothing happened: the command may
 * have arrived, opened the valve, and the response been lost on the way back.
 * The device auto-locks about a minute later, so a retry opens it a second
 * time, possibly in transit.
 *
 * So physical commands are never returned to 'queued'. They time out to
 * 'uncertain', which is the truthful record, and stay there unless physical
 * evidence turns up later and upgrades them - see linkEventToCommand and
 * confirmSubLockUnlock, which accept 'uncertain' precisely for this.
 *
 * Non-physical commands - queries and settings - retry as before. Resending a
 * (P54,0) costs nothing.
 *
 * Returns the number actually re-queued, which is what the caller logs.
 */
export async function requeueUnansweredCommands(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE commands c
        SET status = 'queued'
       FROM command_types t
      WHERE t.command_type = c.command_type
        AND NOT t.is_physical
        AND c.status = 'sent'
        AND c.sent_at < now() - interval '3 minutes'
        AND c.expires_at > now()
        AND c.attempts < 3`,
  );

  // Beyond three attempts it is not a transient link problem. Non-physical
  // only: a physical command has no attempt count to exhaust because it is
  // never resent.
  await pool.query(
    `UPDATE commands c
        SET status = 'failed',
            last_error = 'no response from device after 3 attempts',
            failure_cause = 'no_response'
       FROM command_types t
      WHERE t.command_type = c.command_type
        AND NOT t.is_physical
        AND c.status = 'sent'
        AND c.sent_at < now() - interval '3 minutes'
        AND c.attempts >= 3`,
  );

  // The whole point of the state. Not 'failed': it may have executed.
  await pool.query(
    `UPDATE commands c
        SET status = 'uncertain',
            last_error = 'no response from device; may or may not have executed',
            failure_cause = 'no_response'
       FROM command_types t
      WHERE t.command_type = c.command_type
        AND t.is_physical
        AND c.status = 'sent'
        AND c.sent_at < now() - interval '3 minutes'`,
  );

  return rowCount ?? 0;
}

/**
 * Retire a command that will not be sent, without claiming it failed.
 *
 * 'expired' is the right shape for a command withdrawn before it reached the
 * device: nothing was attempted, so there is nothing for the device to have
 * refused, and the repeated-failure lockout must not see it.
 */
export async function expireCommand(id: number, reason: string): Promise<void> {
  await pool.query(
    `UPDATE commands
        SET status = 'expired', last_error = $2, failure_cause = 'cancelled'
      WHERE id = $1
        AND status NOT IN ('confirmed', 'failed')`,
    [id, reason],
  );
}

/**
 * Record that a command failed - but only if it has not already finished.
 *
 * Without the terminal guard this can un-confirm a confirmed command: the
 * device answers, the response resolves the row to 'confirmed', and a later
 * write failure on the same id overwrites it with 'failed'. The audit trail
 * then says an unlock that demonstrably happened did not, which is the exact
 * shape of wrong record the Ministry relies on this table not to produce.
 *
 * 'uncertain' is deliberately NOT terminal here. It means the platform does not
 * know, and a genuine transport failure discovered afterwards is real
 * information about the same exchange.
 */
export async function markCommandFailed(
  id: number,
  error: string,
  cause: FailureCause = 'unclassified',
): Promise<void> {
  await pool.query(
    `UPDATE commands
        SET status = 'failed', last_error = $2, failure_cause = $3
      WHERE id = $1
        AND status NOT IN ('confirmed', 'failed')`,
    [id, error, cause],
  );
}

/**
 * Attribute a lock event to the command that caused it — and record it as that
 * command's evidence that the lock physically moved.
 *
 * This is the only real proof the platform ever gets. The P43 response says the
 * device accepted the command word; the P45 says the motor turned. Those are
 * two different facts and the second is the one an operator actually needs.
 *
 * Deliberately conservative, in four ways:
 *
 * 1. Event source 4 means "remote static password", which covers BOTH an SMS
 *    unlock and a platform unlock - the protocol gives us no way to tell them
 *    apart. Attributing a card swipe or an SMS unlock to a platform command
 *    would put a false claim in the audit log.
 *
 * 2. Matched on when the DEVICE says the event happened, corrected onto our
 *    clock, never on delivery time. P45 reports are cached in flash and arrive
 *    minutes late - hours, after a coverage gap - so a receipt-time window
 *    would have to be hours wide, and a window that wide cannot tell two
 *    commands apart. If the device's clock offset is unknown or stale, nothing
 *    is attributed: a wrong correction gives a confident wrong attribution,
 *    which is worse than none.
 *
 * 3. If more than one open command could explain the event, none is chosen. The
 *    command stays 'uncertain', which is the honest record.
 *
 * 4. A command that already carries evidence does not collect a second piece.
 *
 * Accepts 'sent', 'uncertain' and 'confirmed'. 'uncertain' is the important
 * one: the previous version required 'confirmed' AND used a window that closed
 * a full minute before a command could even time out, so a P45 arriving after
 * the timeout was orphaned - the exact case this exists to catch.
 *
 * Returns the command id it attributed to, or null.
 */
export async function linkEventToCommand(
  deviceId: string,
  eventId: number,
  eventSourceCode: number,
  unlockAllowed: boolean,
): Promise<number | null> {
  if (!unlockAllowed) return null;

  const types =
    eventSourceCode === 4 ? ['unlock_static'] : eventSourceCode === 6 ? ['unlock_dynamic'] : [];
  if (types.length === 0) return null;

  const { rows } = await pool.query<{ id: number }>(
    `WITH ev AS (
       SELECT id, reported_at FROM lock_events WHERE id = $1
     ),
     candidates AS (
       SELECT c.id
         FROM commands c
         JOIN device_state s ON s.device_id = c.device_id
         CROSS JOIN ev
        WHERE c.device_id = $2
          AND c.command_type = ANY($3)
          AND c.status IN ('sent', 'uncertain', 'confirmed')
          AND c.sent_at IS NOT NULL
          AND c.physically_evidenced_at IS NULL
          -- No usable offset means no attribution. See point 2 above.
          AND s.clock_offset_ms IS NOT NULL
          AND s.clock_offset_at > now() - interval '24 hours'
          -- The offset is device-minus-server, so subtracting it puts the
          -- device's timestamp on our clock. The window runs past the
          -- three-minute timeout on purpose: a P45 that arrives after its
          -- command went 'uncertain' is precisely the evidence wanted.
          AND (ev.reported_at - make_interval(secs => s.clock_offset_ms / 1000.0))
                BETWEEN c.sent_at - interval '30 seconds'
                    AND c.sent_at + interval '5 minutes'
     ),
     resolved AS (
       SELECT id FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
     ),
     linked AS (
       UPDATE lock_events le SET command_id = r.id FROM resolved r WHERE le.id = $1
       RETURNING le.id
     ),
     denormalised AS (
       -- Keep the device row's copy of the newest event in step. Guarded on
       -- reported_at so attributing an older, late-arriving event does not
       -- stamp its command onto a newer one.
       UPDATE device_state s
          SET last_event_command_id = r.id
         FROM resolved r, ev
        WHERE s.device_id = $2
          AND s.last_event_at = ev.reported_at
     )
     UPDATE commands c
        SET physically_evidenced_at = now(),
            physical_evidence_kind  = 'lock_event',
            physical_evidence_id    = $1,
            -- The lock moved, so the device did receive and act on the
            -- command: the exchange succeeded after all. Nothing else is
            -- upgraded — a 'failed' command that somehow moved a lock is a
            -- contradiction worth leaving visible rather than tidying away.
            status       = CASE WHEN c.status = 'uncertain' THEN 'confirmed' ELSE c.status END,
            confirmed_at = COALESCE(c.confirmed_at, now()),
            last_error   = CASE WHEN c.status = 'uncertain' THEN NULL ELSE c.last_error END,
            failure_cause = CASE WHEN c.status = 'uncertain' THEN NULL ELSE c.failure_cause END
       FROM resolved r
      WHERE c.id = r.id
      RETURNING c.id`,
    [eventId, deviceId, types],
  );
  return rows[0]?.id ?? null;
}

export interface MatchedCommand {
  id: number;
  command_type: string;
}

export interface ResponseMatch {
  /** The one command this response certainly answers, or null. */
  matched: MatchedCommand | null;
  /** Every open command it could have answered, matched or not. */
  candidates: MatchedCommand[];
}

/**
 * Work out which command a device response answers — or establish that it
 * cannot be known.
 *
 * The old version took the most recently sent command matching the command
 * word. That is a guess, and with two unlocks outstanding it is a coin toss
 * that ends with one valve's opening recorded against the other truck's
 * command. Deliberately separated from applying the result so the answer can
 * be interpreted using the type of command it actually belongs to.
 *
 * A WLNET reply carries a serial, and the serial we sent is still sitting in
 * `payload`, so it can break a tie. It is only ever used to narrow: the manual
 * does not promise the device echoes it, so a serial matching nothing falls
 * back to refusing rather than to concluding nothing was sent.
 *
 * P-commands carry no serial at all. With two outstanding, none is resolved.
 */
export async function matchCommandForResponse(
  deviceId: string,
  commandWord: string,
  serial: string | null,
): Promise<ResponseMatch> {
  const { rows } = await pool.query<MatchedCommand & { payload_serial: string | null }>(
    `SELECT id, command_type,
            -- (deviceId,version,serial,WLNET,...) — third field, and only for
            -- a WLNET payload. NULL for a P-command, which has no serial.
            CASE WHEN payload LIKE '(%,%,%,WLNET,%'
                 THEN split_part(payload, ',', 3) END AS payload_serial
       FROM commands
      WHERE device_id = $1
        -- 'uncertain' included on purpose: a response arriving after the
        -- timeout is still the device answering, and still resolves it.
        AND status IN ('sent', 'uncertain')
        AND payload LIKE ANY($2::text[])
      ORDER BY sent_at DESC`,
    [deviceId, patternsFor(commandWord)],
  );

  const candidates = rows.map((r) => ({ id: r.id, command_type: r.command_type }));
  if (rows.length === 0) return { matched: null, candidates };
  if (rows.length === 1) return { matched: candidates[0]!, candidates };

  if (serial !== null) {
    const bySerial = rows.filter((r) => r.payload_serial === serial);
    if (bySerial.length === 1) {
      const r = bySerial[0]!;
      return { matched: { id: r.id, command_type: r.command_type }, candidates };
    }
  }
  return { matched: null, candidates };
}

/**
 * Record the device's answer against the command it answers.
 *
 * The response is the authority on whether a command was accepted: an unlock
 * answers (P43,1,0) or (P43,0,n), and a query answers with its value. Without
 * this, query commands sat at 'sent' indefinitely because only unlocks ever
 * had a completion path.
 */
export async function applyCommandResponse(
  id: number,
  ok: boolean,
  response: string,
): Promise<void> {
  await pool.query(
    `UPDATE commands
        SET status        = CASE WHEN $2 THEN 'confirmed' ELSE 'failed' END,
            confirmed_at  = CASE WHEN $2 THEN now() END,
            last_error    = CASE WHEN $2 THEN NULL ELSE $3 END,
            -- The device itself said no. This is the only cause that carries
            -- information about the password we hold, and the only one the
            -- repeated-failure lockout may count.
            failure_cause = CASE WHEN $2 THEN NULL ELSE 'device_rejected' END,
            response      = $3
      WHERE id = $1
        AND status IN ('sent', 'uncertain')`,
    [id, ok, response.slice(0, 500)],
  );
}

/**
 * A response arrived that could have answered any of these, and nothing
 * distinguishes them. Say so rather than picking one.
 *
 * They stay eligible for physical evidence: a P45 arriving later can still
 * name one of them, and that is real proof where this was only an inference.
 */
export async function markCommandsUnresolvable(ids: number[], response: string): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE commands
        SET status = 'uncertain',
            last_error = 'a device response matched this and ' || ($3::int - 1) ||
                         ' other open command(s); which one it answered is not knowable',
            response = COALESCE(response, $2)
      WHERE id = ANY($1::bigint[])
        AND status = 'sent'`,
    [ids, response.slice(0, 500), ids.length],
  );
}

/**
 * How a command's payload can be recognised from the response's command word.
 *
 * P-commands lead with the word: `(P43,123456)`. WLNET commands bury it after
 * the device id and a serial: `(8055430364,1,123,WLNET,8,1,1,5,E03B60000A)`,
 * so a leading-anchor match never fires and the command hangs at 'sent'.
 *
 * Both WLNET shapes are matched explicitly rather than with a bare wildcard,
 * because `%WLNET,1%` would also match WLNET,15 and WLNET,18.
 */
function patternsFor(commandWord: string): string[] {
  return commandWord.startsWith('WLNET')
    ? [`%,${commandWord},%`, `%,${commandWord})`]
    : [`(${commandWord}%`];
}

/**
 * Record what a master says it has bound, from a WLNET,1 reply.
 *
 * Creates a row for any peripheral we have never heard from, so a freshly
 * fitted valve lock is visible immediately rather than only once somebody
 * presses its wake button. Type is left NULL until it reports and tells us.
 *
 * Peripherals the master no longer lists have their confirmation cleared
 * rather than being deleted: binding is destructive - it replaces the whole
 * list - so a rebind that silently dropped a valve lock is exactly the thing
 * an operator needs to see, not have quietly tidied away.
 */
export async function recordBoundPeripherals(masterId: string, ids: string[]): Promise<void> {
  const normalised = ids.map((id) => id.toUpperCase());

  for (const id of normalised) {
    await pool.query(
      `INSERT INTO sub_devices (peripheral_id, master_id, bound_confirmed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (peripheral_id) DO UPDATE SET
         master_id = EXCLUDED.master_id,
         bound_confirmed_at = now()`,
      [id, masterId],
    );
  }

  await pool.query(
    `UPDATE sub_devices SET bound_confirmed_at = NULL
      WHERE master_id = $1 AND NOT (peripheral_id = ANY($2::text[]))`,
    [masterId, normalised],
  );
}

/**
 * Confirm a sub-lock unlock from the sub-lock's own report, and record that
 * report as the command's physical evidence.
 *
 * The WLNET,8 response is only an echo — it carries no success flag, and means
 * the master accepted the command for relay, not that the valve opened. The
 * sub-lock reporting itself unlocked is the first real evidence, and it
 * arrives later over LoRa.
 *
 * Matched on the sub-lock id inside the payload, which is where it already is.
 * `readingId` is the sub_device_readings row that carries the claim, so the
 * evidence points at something a person can go and look at.
 *
 * Returns the command id it confirmed, or null.
 */
export async function confirmSubLockUnlock(
  masterId: string,
  peripheralId: string,
  readingId: number,
): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    `WITH candidates AS (
       SELECT id FROM commands
        WHERE device_id = $1
          AND status IN ('sent', 'uncertain')
          AND command_type = 'unlock_sublock'
          AND payload LIKE '%' || $2 || '%'
          AND physically_evidenced_at IS NULL
          -- The command's own effective window is at most 5 minutes; allow for
          -- LoRa relay and the master's reporting lag on top.
          AND sent_at > now() - interval '30 minutes'
     ),
     resolved AS (
       -- Two open unlocks for the same valve inside half an hour cannot be
       -- told apart by a report that only says "this sub-lock is open". The
       -- previous version took the most recent, which is a guess. Both stay
       -- uncertain instead.
       SELECT id FROM candidates WHERE (SELECT count(*) FROM candidates) = 1
     )
     UPDATE commands c
        SET status = 'confirmed',
            confirmed_at = now(),
            physically_evidenced_at = now(),
            physical_evidence_kind  = 'peripheral_report',
            physical_evidence_id    = $3,
            last_error = NULL,
            failure_cause = NULL
       FROM resolved r
      WHERE c.id = r.id
      RETURNING c.id`,
    [masterId, peripheralId, readingId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Adopt a new password only after the device has confirmed it — and only the
 * password from the command the device was actually answering.
 *
 * Updating the database first and then failing to reach the device would
 * leave the platform holding a password the lock does not have - locked out
 * of our own hardware, with no way back except a physical visit.
 *
 * Takes the command id rather than finding one itself. The previous version
 * took the most recent sent `set_password` for the device, which is a
 * different command from the one that was answered whenever two rotations are
 * in flight — and adopting the wrong new password locks us out just as
 * thoroughly as adopting none. The caller has already established which
 * command this response belongs to, or established that it cannot tell.
 */
export async function promotePendingPassword(
  deviceId: string,
  commandId: number,
): Promise<string | null> {
  const { rows } = await pool.query<{ new_password: string }>(
    `SELECT metadata->>'newPassword' AS new_password
       FROM commands
      WHERE id = $2
        AND device_id = $1
        AND command_type = 'set_password'
        AND metadata ? 'newPassword'`,
    [deviceId, commandId],
  );
  const next = rows[0]?.new_password;
  if (!next) return null;

  await pool.query('UPDATE devices SET static_password = $2 WHERE device_id = $1', [deviceId, next]);
  return next;
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

/**
 * Publish the gateway's own state so /api/health can report it.
 *
 * The API runs in a different process and cannot see the session map, the
 * listener, or how long the last sweep took. This is the only channel between
 * them. Failures are swallowed by the caller: health reporting must never be
 * the thing that takes the gateway down.
 */
export async function reportGatewayHealth(health: {
  instance: string;
  startedAt: Date;
  sessions: number;
  listenerConnected: boolean;
  lastSweepMs: number | null;
  lastSweepAt: Date | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO gateway_health
       (instance, started_at, sessions, listener_connected, last_sweep_ms, last_sweep_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (instance) DO UPDATE SET
       started_at         = EXCLUDED.started_at,
       sessions           = EXCLUDED.sessions,
       listener_connected = EXCLUDED.listener_connected,
       last_sweep_ms      = EXCLUDED.last_sweep_ms,
       last_sweep_at      = EXCLUDED.last_sweep_at,
       updated_at         = now()`,
    [
      health.instance,
      health.startedAt,
      health.sessions,
      health.listenerConnected,
      health.lastSweepMs,
      health.lastSweepAt,
    ],
  );
}

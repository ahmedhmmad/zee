import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.ts';
import { apiConfig } from './config.ts';
import { tileRoutes } from './tiles.ts';
import { fetchDevices } from './devices-query.ts';
import { encode } from '../protocol/index.ts';

const DEVICE_ID = /^\d{10}$/;

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // --- Auth ---------------------------------------------------------------

  app.post('/api/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !apiConfig.checkPassword(password)) {
      await audit(req, 'login_failed', null, {});
      return reply.code(401).send({ error: 'invalid_password' });
    }
    reply.setCookie(apiConfig.cookieName, 'ok', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      // Follow the scheme the request actually arrived on, read from
      // X-Forwarded-Proto. A Secure cookie is silently discarded by the
      // browser over plain HTTP, so login returns 200 and then every
      // subsequent request is unauthenticated - the operator is locked out of
      // their own console with no error to go on. Behind TLS this stays true.
      secure: req.protocol === 'https',
      signed: true,
      maxAge: 60 * 60 * 12,
    });
    await audit(req, 'login', null, {});
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(apiConfig.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/session', async (req) => ({ authenticated: apiConfig.isAuthenticated(req) }));

  // --- Everything below requires a session --------------------------------

  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || isPublic(req.url)) return;
    if (!apiConfig.isAuthenticated(req)) {
      // Distinguish the two failure modes: no cookie means the browser never
      // stored or sent one, a bad signature means COOKIE_SECRET changed under
      // a live session. They need different fixes, so say which it is.
      const reason = req.cookies[apiConfig.cookieName] ? 'cookie_rejected' : 'no_cookie';
      req.log.warn({ url: req.url, reason, ip: req.ip }, 'unauthenticated request');
      return reply.code(401).send({ error: 'unauthorised', reason });
    }
  });

  // Registered inside this scope so it inherits the auth hook above: map
  // tiles should not be an open proxy for anyone who finds the URL.
  await app.register(tileRoutes);

  /** Front-end configuration. Behind the session check, like everything else. */
  app.get('/api/config', async () => ({
    googleMapsApiKey: apiConfig.googleMapsApiKey || null,
    arcgisApiKey: apiConfig.arcgisApiKey || null,
    arcgisVersion: apiConfig.arcgisVersion,
  }));

  app.get('/api/devices', async () => fetchDevices());

  /**
   * Track points, either over a trailing window (`hours`) or between two
   * explicit instants (`from`/`to`).
   *
   * An explicit range matters for investigating a specific journey: "what did
   * this truck do between 14:00 and 16:00 last Tuesday" is the question asked
   * after the fact, and a trailing window cannot express it.
   */
  app.get('/api/devices/:id/track', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const q = req.query as { hours?: string; from?: string; to?: string };
    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;

    if ((q.from && Number.isNaN(from!.getTime())) || (q.to && Number.isNaN(to!.getTime()))) {
      return reply.code(400).send({ error: 'invalid_range' });
    }
    if (from && to && from >= to) {
      return reply.code(400).send({ error: 'range_inverted' });
    }

    const select = `SELECT reported_at,
              ST_Y(location::geometry) AS latitude,
              ST_X(location::geometry) AS longitude,
              speed_kph, motor_locked
         FROM positions
        WHERE device_id = $1 AND positioned`;

    // 5000 points is roughly 3.5 days at one per minute. Ordering by time
    // DESC under the limit then re-sorting keeps the MOST RECENT points when a
    // long range overflows, rather than silently truncating the recent end.
    const { rows } = from || to
      ? await pool.query(
          `WITH capped AS (
             ${select}
               AND ($2::timestamptz IS NULL OR reported_at >= $2)
               AND ($3::timestamptz IS NULL OR reported_at <= $3)
             ORDER BY reported_at DESC
             LIMIT 5000
           )
           SELECT * FROM capped ORDER BY reported_at ASC`,
          [id, from, to],
        )
      : await pool.query(
          `WITH capped AS (
             ${select}
               AND reported_at > now() - ($2 || ' hours')::interval
             ORDER BY reported_at DESC
             LIMIT 5000
           )
           SELECT * FROM capped ORDER BY reported_at ASC`,
          [id, Math.min(Math.max(Number(q.hours ?? 6), 1), 24 * 30)],
        );

    return rows;
  });

  app.get('/api/devices/:id/events', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query(
      // Join the causing command so the log can say who authorised an unlock
      // and why, rather than only that one happened.
      `SELECT le.id, le.reported_at, le.received_at, le.event_source_name,
              le.unlock_allowed, le.refused_outside_fence, le.rfid_card,
              le.wrong_password_count, le.command_id,
              c.requested_by, c.reason
         FROM lock_events le
         LEFT JOIN commands c ON c.id = le.command_id
        WHERE le.device_id = $1
        ORDER BY le.reported_at DESC
        LIMIT 100`,
      [id],
    );
    return rows;
  });

  app.get('/api/devices/:id/commands', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query(
      `SELECT id, command_type, status, requested_by, reason,
              requested_at, sent_at, confirmed_at, expires_at, last_error
         FROM commands
        WHERE device_id = $1
        ORDER BY requested_at DESC
        LIMIT 50`,
      [id],
    );
    return rows;
  });

  /**
   * Queue a remote unlock.
   *
   * The password is read from the database and never accepted from the client.
   * A reason is mandatory: an unlock with no recorded justification is not an
   * auditable event.
   */
  app.post('/api/devices/:id/unlock', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const { reason, ttlMinutes } = (req.body ?? {}) as { reason?: string; ttlMinutes?: number };
    if (!reason || reason.trim().length < 3) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    // How long the authorisation stays live. Devices sleep for up to 30
    // minutes between RTC wakes, so a short window can expire before the truck
    // is ever reachable — but an unbounded one could fire hours later
    // somewhere else entirely. Operator chooses, within a hard ceiling.
    const ttl = Math.min(Math.max(Number(ttlMinutes) || 30, 5), 240);

    const { rows } = await pool.query<{ static_password: string; is_connected: boolean | null }>(
      `SELECT d.static_password, s.is_connected
         FROM devices d LEFT JOIN device_state s ON s.device_id = d.device_id
        WHERE d.device_id = $1 AND d.is_active`,
      [id],
    );
    const device = rows[0];
    if (!device) return reply.code(404).send({ error: 'device_not_found' });

    /*
     * Refuse to keep firing unlocks we can already predict will fail.
     *
     * A wrong stored password fails identically every time, each attempt costs
     * minutes of waiting for a sleeping device, and five in a row trips the
     * device's own wrong-password alarm. The platform knows after the first
     * failure; it should say so rather than let an operator walk into the
     * alarm one attempt at a time.
     *
     * Counted only since the password was last changed - correcting it makes
     * previous failures irrelevant and clears the block automatically.
     */
    const { rows: failureRows } = await pool.query<{ failures: number }>(
      `SELECT count(*)::int AS failures
         FROM commands c
        WHERE c.device_id = $1
          AND c.command_type IN ('unlock_static', 'unlock_dynamic')
          AND c.status = 'failed'
          AND c.requested_at > (SELECT password_updated_at FROM devices WHERE device_id = $1)
          AND c.requested_at > COALESCE((
                SELECT max(requested_at) FROM commands
                 WHERE device_id = $1
                   AND command_type IN ('unlock_static', 'unlock_dynamic')
                   AND status = 'confirmed'
              ), '-infinity'::timestamptz)`,
      [id],
    );
    const failures = failureRows[0]?.failures ?? 0;
    if (failures >= 2) {
      await audit(req, 'unlock_blocked_after_failures', id, { failures });
      return reply.code(409).send({ error: 'repeated_password_failures', failures });
    }

    const { rows: inserted } = await pool.query<{ id: number }>(
      `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at)
       VALUES ($1, 'unlock_static', $2, $3, $4, 'queued', now() + ($5 || ' minutes')::interval)
       RETURNING id`,
      [id, `(P43,${device.static_password})`, actorOf(req), reason.trim(), ttl],
    );

    const commandId = inserted[0]!.id;
    await audit(
      req,
      'unlock_requested',
      id,
      { reason: reason.trim(), online: device.is_connected, ttlMinutes: ttl },
      commandId,
    );

    // Deliberately not reporting success: the command is queued, and only the
    // device's own P45 report can confirm the lock actually opened.
    return {
      commandId,
      status: 'queued',
      deviceOnline: device.is_connected === true,
    };
  });

  // --- Device administration ----------------------------------------------

  /**
   * Device IDs that have tried to connect and been refused.
   *
   * Fitting a lock and pointing it at the gateway is enough to get it listed
   * here; the ID does not have to be read off a label and typed in.
   */
  app.get('/api/unknown-devices', async () => {
    const { rows } = await pool.query(
      `SELECT r.device_id, count(*)::int AS attempts,
              min(r.at) AS first_seen, max(r.at) AS last_seen,
              max(r.remote_ip::text) AS remote_ip
         FROM rejected_frames r
        WHERE r.device_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device_id = r.device_id)
          AND r.at > now() - interval '7 days'
        GROUP BY r.device_id
        ORDER BY max(r.at) DESC
        LIMIT 20`,
    );
    return rows;
  });

  app.post('/api/devices', async (req, reply) => {
    const b = (req.body ?? {}) as {
      deviceId?: string;
      name?: string;
      plateNumber?: string;
      model?: string;
      staticPassword?: string;
    };

    const deviceId = (b.deviceId ?? '').trim();
    const name = (b.name ?? '').trim();
    if (!DEVICE_ID.test(deviceId)) return reply.code(400).send({ error: 'invalid_device_id' });
    if (name.length < 2) return reply.code(400).send({ error: 'name_required' });

    try {
      await pool.query(
        `INSERT INTO devices (device_id, name, plate_number, model, static_password)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          deviceId,
          name,
          b.plateNumber?.trim() || null,
          b.model?.trim() || 'JT701D',
          // Factory default unless told otherwise. Rotating it is a separate,
          // device-confirmed step rather than something typed in blind here.
          (b.staticPassword ?? '').trim() || '888888',
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'device_exists' });
      }
      throw err;
    }

    await audit(req, 'device_added', deviceId, { name, plateNumber: b.plateNumber });
    return { deviceId };
  });

  app.patch('/api/devices/:id', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const b = (req.body ?? {}) as { name?: string; plateNumber?: string; isActive?: boolean };

    await pool.query(
      `UPDATE devices
          SET name = COALESCE(NULLIF($2, ''), name),
              plate_number = COALESCE(NULLIF($3, ''), plate_number),
              is_active = COALESCE($4, is_active)
        WHERE device_id = $1`,
      [id, b.name?.trim() ?? '', b.plateNumber?.trim() ?? '', b.isActive ?? null],
    );
    await audit(req, 'device_updated', id, { ...b });
    return { ok: true };
  });

  /**
   * Rotate the static password.
   *
   * The stored password is NOT changed here. The command carries the new one
   * in metadata, and the gateway adopts it only once the device confirms -
   * because updating first and failing to reach the device would leave the
   * platform holding a password the lock does not have.
   */
  app.post('/api/devices/:id/password', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const { newPassword } = (req.body ?? {}) as { newPassword?: string };
    const next = (newPassword ?? '').trim();
    // The manual specifies six characters: digits, letters or symbols.
    if (!/^[\x21-\x7e]{6}$/.test(next)) {
      return reply.code(400).send({ error: 'password_must_be_6_chars' });
    }
    // Common passwords are recorded, not refused. Which password a fleet uses
    // is an operational decision, and a tool that overrides it just gets
    // worked around - as this one was, with hand-written SQL. The audit entry
    // and the "default password" badge make the choice visible instead.
    const isWeak = ['888888', '123456', '000000', '111111'].includes(next);

    const { rows } = await pool.query<{ static_password: string }>(
      'SELECT static_password FROM devices WHERE device_id = $1',
      [id],
    );
    const current = rows[0]?.static_password;
    if (!current) return reply.code(404).send({ error: 'device_not_found' });

    const { rows: inserted } = await pool.query<{ id: number }>(
      `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at, metadata)
       VALUES ($1, 'set_password', $2, $3, 'rotate static password', 'queued',
               now() + interval '4 hours', $4)
       RETURNING id`,
      [id, `(P44,${next},${current})`, actorOf(req), JSON.stringify({ newPassword: next })],
    );

    await audit(req, 'password_rotation_requested', id, { weakPassword: isWeak }, inserted[0]!.id);
    return { commandId: inserted[0]!.id, weakPassword: isWeak };
  });

  /**
   * Ask the device for its own static password.
   *
   * `(P44,1)` is answerable only over the platform TCP channel, which is why
   * this works at all — and it is how both existing devices' passwords were
   * recovered rather than guessed.
   */
  /**
   * Results of password reads, for the devices admin page.
   *
   * Kept off the general device list on purpose: that projection is broadcast
   * to every open console over the WebSocket, and an unlock password has no
   * business travelling with it. This is fetched only by the page that asked.
   */
  app.get('/api/password-reads', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (device_id)
              device_id, status, response, requested_at, confirmed_at
         FROM commands
        WHERE command_type = 'query_password'
        ORDER BY device_id, requested_at DESC`,
    );
    return rows;
  });

  app.post('/api/devices/:id/read-password', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at)
       VALUES ($1, 'query_password', '(P44,1)', $2, 'read static password', 'queued',
               now() + interval '12 hours')
       RETURNING id`,
      [id, actorOf(req)],
    );
    await audit(req, 'password_read_requested', id, {}, rows[0]!.id);
    return { commandId: rows[0]!.id };
  });

  /** The standard commissioning sequence, queued in order. */
  app.post('/api/devices/:id/commission', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    // Deliberately excludes P59 unlock-channel lockdown: that closes the SMS
    // route people rely on as a fallback, and should be a conscious separate
    // decision once remote unlocking is proven on the unit.
    const steps: Array<[string, string, string]> = [
      ['query_firmware', '(P01)', 'firmware and battery'],
      ['set_timezone', '(P10,1,120)', 'Libya is UTC+2'],
      ['set_intervals', '(P04,1,60,30)', '60s awake, 30min RTC wake'],
      ['set_p45_fields', '(P94,1,3)', 'IMEI and fence ID in lock reports'],
      ['query_channels', '(P59,0)', 'read unlock channel settings'],
    ];

    for (const [type, payload, reason] of steps) {
      await pool.query(
        `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'queued', now() + interval '12 hours')`,
        [id, type, payload, actorOf(req), reason],
      );
    }

    await audit(req, 'commissioning_queued', id, { steps: steps.length });
    return { queued: steps.length };
  });

  app.get('/api/devices/:id/sublocks', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query(
      `SELECT peripheral_id, name, device_type, last_seen_at, voltage, bound_confirmed_at,
              battery_percent, rssi, locked, rope_pulled_out, back_cover_open,
              charging, event_code, event_name, lock_cycles, rfid_card,
              comms_lost_alarm, low_voltage_alarm, temperature_c, humidity_percent
         FROM sub_devices
        WHERE master_id = $1
        ORDER BY peripheral_id`,
      [id],
    );
    return rows;
  });

  /**
   * Ask the master which peripherals it actually has bound.
   *
   * Needed because a JT709 defaults to no LoRa heartbeat, so a newly fitted
   * valve lock stays invisible until somebody presses its wake button. This
   * makes it appear as soon as the master answers.
   */
  app.post('/api/devices/:id/sublocks/refresh', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at)
       VALUES ($1, 'query_bound_peripherals', $2, $3, 'refresh bound peripheral list', 'queued',
               now() + interval '2 hours')
       RETURNING id`,
      [id, encode.wlnetQueryBound(id).toString('latin1'), actorOf(req)],
    );
    await audit(req, 'sublocks_refresh_requested', id, { commandId: rows[0]!.id });
    return { commandId: rows[0]!.id };
  });

  /**
   * Unlock one valve sub-lock, relayed by the master over LoRa.
   *
   * Unlike a master unlock this is never fully remote. The sub-lock sleeps at
   * ~60uA to get three years from a non-rechargeable battery, so it cannot
   * listen continuously: somebody at the truck presses its wake button and the
   * master hands the command over. The platform authorises; the driver
   * actuates. The response says so plainly rather than implying it is done.
   */
  app.post('/api/devices/:id/sublocks/:subId/unlock', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const subId = String((req.params as { subId?: string }).subId ?? '').toUpperCase();
    if (!/^[0-9A-F]{10}$/.test(subId)) {
      return reply.code(400).send({ error: 'invalid_sublock_id' });
    }

    const { reason, windowMinutes } = (req.body ?? {}) as {
      reason?: string;
      windowMinutes?: number;
    };
    if (!reason || reason.trim().length < 3) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    const { rowCount } = await pool.query(
      'SELECT 1 FROM sub_devices WHERE master_id = $1 AND peripheral_id = $2',
      [id, subId],
    );
    if (rowCount !== 1) return reply.code(404).send({ error: 'sublock_not_bound' });

    // The manual caps the effective window at 5 minutes, and for good reason:
    // a longer one leaves an unlock lurking to fire on some later wake nobody
    // is expecting.
    const window = Math.min(Math.max(Math.round(Number(windowMinutes) || 5), 1), 5);
    const payload = encode.wlnetUnlockSubLock(id, subId, window).toString('latin1');

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at, metadata)
       VALUES ($1, 'unlock_sublock', $2, $3, $4, 'queued', now() + interval '30 minutes', $5)
       RETURNING id`,
      [id, payload, actorOf(req), reason.trim(), JSON.stringify({ subLockId: subId, windowMinutes: window })],
    );

    await audit(req, 'sublock_unlock_requested', id, {
      subLockId: subId,
      reason: reason.trim(),
      windowMinutes: window,
    });

    return {
      commandId: rows[0]!.id,
      subLockId: subId,
      windowMinutes: window,
      // Stated explicitly so no caller mistakes queuing for opening.
      requiresButtonPress: true,
    };
  });

  /**
   * Tracking configuration.
   *
   * Every value here is a device-side setting, so nothing takes effect until
   * the lock next connects and accepts the command. Each is queued separately
   * rather than as a batch: a device that accepts three of five should keep
   * those three, not have the lot rolled back.
   */
  app.post('/api/devices/:id/settings', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const b = (req.body ?? {}) as {
      tracking?: boolean;
      wakeMinutes?: number;
      awakeSeconds?: number;
      sleepMinutes?: number;
      motionThreshold?: number;
      cornering?: boolean;
      corneringSampleSeconds?: number;
      corneringAngle?: number;
      staticDrift?: boolean;
      gnssPowerSaving?: boolean;
      autoLockMinutes?: number;
      longUnlockMinutes?: number;
      lowBatteryPercent?: number;
    };

    const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
      Math.min(Math.max(Math.round(Number(v) || fallback), lo), hi);

    const queued: { type: string; payload: string; reason: string }[] = [];

    if (typeof b.tracking === 'boolean') {
      queued.push({
        type: 'set_tracking',
        payload: `(P54,1,${b.tracking ? 1 : 0})`,
        reason: b.tracking ? 'تتبع مستمر' : 'وضع توفير البطارية',
      });
    }

    if (b.awakeSeconds != null || b.sleepMinutes != null) {
      // P04 carries both intervals, so both are always sent. Firmware floor is
      // 5 seconds - it documents [5~3600] and rejects anything lower.
      const awake = clamp(b.awakeSeconds, 5, 3600, 30);
      const sleep = clamp(b.sleepMinutes, 5, 1440, 30);
      queued.push({
        type: 'set_intervals',
        payload: `(P04,1,${awake},${sleep})`,
        reason: `إرسال كل ${awake} ثانية، واستيقاظ كل ${sleep} دقيقة`,
      });
    }

    if (b.wakeMinutes != null) {
      /*
       * How long the device keeps working after a wake before sleeping again.
       *
       * This is the quiet cost of fast reporting. At a five-second interval a
       * ten-minute default means 120 fixes are sent every time a truck stops -
       * data and battery spent watching a parked vehicle. Three minutes is
       * enough to capture the stop and settle, and while the truck is actually
       * driving continuous vibration keeps resetting the timer anyway, so a
       * short window costs nothing in transit.
       */
      const minutes = clamp(b.wakeMinutes, 3, 10, 10);
      queued.push({
        type: 'set_wake_window',
        payload: `(P39,1,${minutes})`,
        reason: `العمل ${minutes} دقائق بعد كل استيقاظ`,
      });
    }

    if (b.motionThreshold != null) {
      // 0 disables motion detection entirely; otherwise 63-8000 mg.
      const raw = Math.round(Number(b.motionThreshold));
      const mg = raw === 0 ? 0 : Math.min(Math.max(raw, 63), 8000);
      queued.push({
        type: 'set_motion',
        payload: `(P37,1,${mg})`,
        reason: mg === 0 ? 'إيقاف كشف الحركة' : `حساسية الحركة ${mg} mg`,
      });
    }

    if (typeof b.cornering === 'boolean') {
      // Samples every N seconds and emits an extra position when the heading
      // turns more than the given angle. This is what makes a track follow the
      // road through junctions instead of cutting the corner between reports.
      const sample = clamp(b.corneringSampleSeconds, 1, 600, 1);
      const angle = clamp(b.corneringAngle, 5, 180, 20);
      queued.push({
        type: 'set_cornering',
        payload: b.cornering ? `(P99,1,1,${sample},${angle})` : '(P99,1,0)',
        reason: b.cornering ? `تقرير المنعطفات عند ${angle}°` : 'إيقاف تقرير المنعطفات',
      });
    }

    if (typeof b.staticDrift === 'boolean') {
      queued.push({
        type: 'set_drift_opt',
        payload: `(P63,1,${b.staticDrift ? 1 : 0})`,
        reason: b.staticDrift ? 'تثبيت الموقع أثناء التوقف' : 'تحديث الموقع دائماً',
      });
    }

    if (typeof b.gnssPowerSaving === 'boolean') {
      // With this on the GNSS module naps between fixes, which costs accuracy
      // and responsiveness. It must be off for real tracking.
      queued.push({
        type: 'set_gnss_power',
        payload: `(P97,1,${b.gnssPowerSaving ? 1 : 0})`,
        reason: b.gnssPowerSaving ? 'توفير طاقة GPS' : 'GPS يعمل باستمرار',
      });
    }

    if (b.autoLockMinutes != null) {
      const m = clamp(b.autoLockMinutes, 1, 10, 1);
      queued.push({
        type: 'set_autolock',
        payload: `(P83,1,${m})`,
        reason: `الإقفال التلقائي بعد ${m} دقيقة`,
      });
    }

    if (b.longUnlockMinutes != null) {
      const m = clamp(b.longUnlockMinutes, 3, 180, 120);
      queued.push({
        type: 'set_long_unlock',
        payload: `(P38,1,${m})`,
        reason: `إنذار الفتح الطويل بعد ${m} دقيقة`,
      });
    }

    if (b.lowBatteryPercent != null) {
      const pct = clamp(b.lowBatteryPercent, 0, 90, 30);
      queued.push({
        type: 'set_low_battery',
        payload: `(P61,1,${pct})`,
        reason: `إنذار البطارية عند ${pct}%`,
      });
    }

    if (queued.length === 0) return reply.code(400).send({ error: 'nothing_to_change' });

    for (const c of queued) {
      await pool.query(
        `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '6 hours')`,
        [id, c.type, c.payload, actorOf(req), c.reason],
      );
    }
    await audit(req, 'device_settings_changed', id, { queued });

    return { queued: queued.length };
  });

  /**
   * Ask the device what it is actually set to.
   *
   * Worth having because the platform only knows what it has SENT. A device
   * configured by someone else, or one that rejected a command, will disagree
   * with our assumptions and nothing would reveal it.
   */
  app.post('/api/devices/:id/settings/read', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const queries: [string, string][] = [
      ['query_tracking', '(P54,0)'],
      ['query_intervals', '(P04,0)'],
      ['query_wake_window', '(P39,0)'],
      ['query_motion', '(P37,0)'],
      ['query_cornering', '(P99,0)'],
      ['query_drift', '(P63,0)'],
      ['query_gnss_power', '(P97,0)'],
      ['query_autolock', '(P83,0)'],
    ];

    for (const [type, payload] of queries) {
      await pool.query(
        `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, expires_at)
         VALUES ($1, $2, $3, $4, 'قراءة الإعدادات الحالية', now() + interval '6 hours')`,
        [id, type, payload, actorOf(req)],
      );
    }
    await audit(req, 'device_settings_read', id, { count: queries.length });
    return { queued: queries.length };
  });

  /** The device's own answers to those queries, newest first. */
  app.get('/api/devices/:id/settings', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (command_type)
              command_type, payload, response, status, sent_at, confirmed_at
         FROM commands
        WHERE device_id = $1
          AND command_type LIKE 'query_%'
        ORDER BY command_type, requested_at DESC`,
      [id],
    );
    return rows;
  });

  // --- Locations catalogue ------------------------------------------------

  app.get('/api/locations', async () => {
    const { rows } = await pool.query(
      `SELECT id, name, kind, radius_m, address, notes, is_active, created_by, created_at,
              ST_Y(location::geometry) AS latitude,
              ST_X(location::geometry) AS longitude
         FROM locations
        WHERE is_active
        ORDER BY kind, name`,
    );
    return rows;
  });

  app.post('/api/locations', async (req, reply) => {
    const b = (req.body ?? {}) as {
      name?: string;
      kind?: string;
      latitude?: number;
      longitude?: number;
      radiusM?: number;
      address?: string;
      notes?: string;
    };

    const name = (b.name ?? '').trim();
    const lat = Number(b.latitude);
    const lon = Number(b.longitude);

    if (name.length < 2) return reply.code(400).send({ error: 'name_required' });
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      return reply.code(400).send({ error: 'invalid_coordinates' });
    }

    const kind = ['depot', 'station', 'customer', 'yard', 'other'].includes(b.kind ?? '')
      ? b.kind
      : 'other';
    const radius = Math.min(Math.max(Math.round(Number(b.radiusM) || 100), 30), 5000);

    try {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO locations (name, kind, location, radius_m, address, notes, created_by)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7, $8)
         RETURNING id`,
        [name, kind, lon, lat, radius, b.address?.trim() || null, b.notes?.trim() || null, actorOf(req)],
      );
      await audit(req, 'location_created', null, { id: rows[0]!.id, name, latitude: lat, longitude: lon });
      return { id: rows[0]!.id };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw err;
    }
  });

  /** Soft delete: arrival rules and audit entries still reference it. */
  app.delete('/api/locations/:locationId', async (req, reply) => {
    const locationId = Number((req.params as { locationId?: string }).locationId);
    if (!Number.isInteger(locationId)) return reply.code(400).send({ error: 'invalid_id' });
    await pool.query('UPDATE locations SET is_active = false WHERE id = $1', [locationId]);
    await audit(req, 'location_deleted', null, { id: locationId });
    return { ok: true };
  });

  // --- Arrival unlocks ----------------------------------------------------

  app.get('/api/devices/:id/arrivals', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.reason, a.radius_m, a.is_armed, a.created_by, a.include_sublocks,
              a.created_at, a.expires_at, a.triggered_at, a.triggered_distance_m,
              a.triggered_command_id,
              ST_Y(a.location::geometry) AS latitude,
              ST_X(a.location::geometry) AS longitude,
              -- How far the vehicle is right now, so the operator can see it
              -- approaching rather than guessing.
              --
              -- A device that has never had a GPS fix stores 0,0 - a real
              -- point in the Gulf of Guinea. Measuring to it produced "3879 km"
              -- for a truck 18 km away, which reads as a broken system rather
              -- than as "we do not know where this truck is". Report NULL and
              -- let the UI say so.
              CASE WHEN s.location IS NOT NULL
                    AND NOT (abs(ST_Y(s.location::geometry)) < 0.0001
                         AND abs(ST_X(s.location::geometry)) < 0.0001)
                   THEN round(ST_Distance(a.location, s.location)::numeric, 0)
              END AS current_distance_m
         FROM arrival_unlocks a
         LEFT JOIN device_state s ON s.device_id = a.device_id
        WHERE a.device_id = $1
        ORDER BY a.is_armed DESC, a.created_at DESC
        LIMIT 20`,
      [id],
    );
    return rows;
  });

  /**
   * Arm an automatic unlock at a point.
   *
   * This is the one place a lock opens with no human deciding in the moment,
   * so it carries the same mandatory reason as a manual unlock, a bounded
   * radius, and an expiry.
   */
  app.post('/api/devices/:id/arrivals', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    const body = (req.body ?? {}) as {
      locationId?: number;
      name?: string;
      latitude?: number;
      longitude?: number;
      radiusM?: number;
      reason?: string;
      expiresInHours?: number;
      includeSubLocks?: boolean;
    };

    if (!body.reason || body.reason.trim().length < 3) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    // Coordinates come from the catalogue by preference, read server-side:
    // the client sends an id, never a position, so a tampered or mistyped
    // request cannot move a truck's unlock point.
    let lat: number;
    let lon: number;
    let locationId: number | null = null;
    let defaultRadius = 100;
    let name = (body.name ?? '').trim();

    if (body.locationId != null) {
      const { rows } = await pool.query<{
        id: number;
        name: string;
        latitude: number;
        longitude: number;
        radius_m: number;
      }>(
        `SELECT id, name, radius_m,
                ST_Y(location::geometry) AS latitude,
                ST_X(location::geometry) AS longitude
           FROM locations WHERE id = $1 AND is_active`,
        [body.locationId],
      );
      const loc = rows[0];
      if (!loc) return reply.code(404).send({ error: 'location_not_found' });
      lat = loc.latitude;
      lon = loc.longitude;
      locationId = loc.id;
      defaultRadius = loc.radius_m;
      name = name || loc.name;
    } else {
      lat = Number(body.latitude);
      lon = Number(body.longitude);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
        return reply.code(400).send({ error: 'invalid_coordinates' });
      }
    }

    // Below ~30m the vehicle would often pass through without a position
    // landing inside; above 5km it stops meaning "arrived" at all.
    const radius = Math.min(Math.max(Math.round(Number(body.radiusM) || defaultRadius), 30), 5000);
    const hours = Math.min(Math.max(Number(body.expiresInHours) || 12, 1), 72);
    if (!name) name = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const includeSubLocks = body.includeSubLocks === true;

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO arrival_unlocks (device_id, name, location, radius_m, reason, created_by, expires_at, location_id, include_sublocks)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7,
               now() + ($8 || ' hours')::interval, $9, $10)
       RETURNING id`,
      [id, name, lon, lat, radius, body.reason.trim(), actorOf(req), hours, locationId, includeSubLocks],
    );

    await audit(req, 'arrival_unlock_armed', id, {
      arrivalId: rows[0]!.id,
      locationId,
      name,
      latitude: lat,
      longitude: lon,
      radiusM: radius,
      reason: body.reason.trim(),
      expiresInHours: hours,
      includeSubLocks,
    });

    return { id: rows[0]!.id, name, radiusM: radius, expiresInHours: hours };
  });

  /**
   * Disarm. Kept as a row so the audit trail still shows it existed.
   *
   * Also cancels the unlock this arrival already queued, if it fired while the
   * vehicle was asleep and the command is still waiting to be delivered.
   * Clearing the flag alone left that command live, so the lock opened on the
   * next wake - minutes or hours after an operator watched the rule disappear
   * and reasonably concluded nothing more would happen.
   */
  app.delete('/api/devices/:id/arrivals/:arrivalId', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const arrivalId = Number((req.params as { arrivalId?: string }).arrivalId);
    if (!Number.isInteger(arrivalId)) return reply.code(400).send({ error: 'invalid_id' });

    const { rows } = await pool.query<{ triggered_command_id: number | null }>(
      `UPDATE arrival_unlocks SET is_armed = false
        WHERE id = $1 AND device_id = $2 AND is_armed
        RETURNING triggered_command_id`,
      [arrivalId, id],
    );

    // Only commands still awaiting delivery. One already 'sent' is on the wire
    // and beyond recall, and saying otherwise would be worse than saying
    // nothing - the operator needs to know to go and physically check.
    let cancelledCommand: number | null = null;
    const commandId = rows[0]?.triggered_command_id ?? null;
    if (commandId) {
      const { rowCount } = await pool.query(
        `UPDATE commands SET status = 'expired',
                last_error = 'cancelled with the arrival rule'
          WHERE id = $1 AND status IN ('queued', 'approved')`,
        [commandId],
      );
      if (rowCount === 1) cancelledCommand = commandId;
    }

    await audit(req, 'arrival_unlock_disarmed', id, { arrivalId, cancelledCommand });
    return { disarmed: rows.length === 1, cancelledCommand };
  });

  /**
   * Cancel a queued command before it reaches the vehicle.
   *
   * These locks sleep for up to 30 minutes, so an unlock can sit waiting long
   * enough for the reason behind it to change - a delivery reassigned, a
   * wrong vehicle picked, a decision reversed. Without this the only options
   * were to let it fire or to edit the database by hand.
   */
  app.delete('/api/devices/:id/commands/:commandId', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const commandId = Number((req.params as { commandId?: string }).commandId);
    if (!Number.isInteger(commandId)) return reply.code(400).send({ error: 'invalid_id' });

    const { rows } = await pool.query<{ status: string; command_type: string }>(
      'SELECT status, command_type FROM commands WHERE id = $1 AND device_id = $2',
      [commandId, id],
    );
    const command = rows[0];
    if (!command) return reply.code(404).send({ error: 'command_not_found' });

    // 'sent' has already gone out over the socket; 'confirmed' has already
    // happened. Refusing loudly is the honest answer for both, because the
    // physical lock may now be open and somebody has to deal with that.
    if (!['queued', 'approved', 'draft', 'pending_approval'].includes(command.status)) {
      return reply.code(409).send({ error: 'not_cancellable', status: command.status });
    }

    const { rowCount } = await pool.query(
      `UPDATE commands SET status = 'expired', last_error = 'cancelled by operator'
        WHERE id = $1 AND status IN ('queued', 'approved', 'draft', 'pending_approval')`,
      [commandId],
    );
    // Lost the race against the gateway claiming it, in the moment between the
    // check above and this update.
    if (rowCount !== 1) return reply.code(409).send({ error: 'not_cancellable', status: 'sent' });

    await audit(req, 'command_cancelled', id, { commandType: command.command_type }, commandId);
    return { cancelled: commandId };
  });

  app.get('/api/audit', async () => {
    const { rows } = await pool.query(
      `SELECT at, actor, action, device_id, command_id, detail
         FROM audit_log ORDER BY at DESC LIMIT 200`,
    );
    return rows;
  });
}

function isPublic(url: string): boolean {
  return url.startsWith('/api/login') || url.startsWith('/api/session') || url.startsWith('/api/logout');
}

function deviceIdOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const { id } = req.params as { id?: string };
  if (!id || !DEVICE_ID.test(id)) {
    reply.code(400).send({ error: 'invalid_device_id' });
    return null;
  }
  return id;
}

function actorOf(req: FastifyRequest): string {
  return `operator@${req.ip}`;
}

async function audit(
  req: FastifyRequest,
  action: string,
  deviceId: string | null,
  detail: Record<string, unknown>,
  commandId?: number,
): Promise<void> {
  await pool
    .query(
      'INSERT INTO audit_log (actor, action, device_id, command_id, detail, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
      [actorOf(req), action, deviceId, commandId ?? null, JSON.stringify(detail), req.ip],
    )
    .catch(() => {});
}

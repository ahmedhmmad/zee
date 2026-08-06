import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.ts';
import { apiConfig } from './config.ts';
import { tileRoutes } from './tiles.ts';

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
      // Nginx terminates TLS, so the cookie is only ever sent over HTTPS.
      secure: true,
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
  }));

  app.get('/api/devices', async () => {
    const { rows } = await pool.query(`
      SELECT d.device_id, d.name, d.plate_number, d.model,
             d.imei, d.firmware_version, d.sim_msisdn,
             s.last_seen_at, s.last_position_at, s.is_connected, s.connected_at,
             ST_Y(s.location::geometry) AS latitude,
             ST_X(s.location::geometry) AS longitude,
             s.positioned, s.speed_kph, s.heading_deg, s.satellites,
             s.battery_percent, s.charging, s.motor_locked, s.rope_inserted,
             s.gsm_signal, s.wake_source, s.active_alarms,
             s.mileage_km, s.mcc, s.mnc,
             -- Most recent lock activity, so the panel can show it without
             -- the operator having to go hunting through the event log.
             le.reported_at    AS last_event_at,
             le.event_source_name AS last_event_source,
             le.unlock_allowed AS last_event_allowed,
             le.command_id     AS last_event_command_id
        FROM devices d
        LEFT JOIN device_state s ON s.device_id = d.device_id
        LEFT JOIN LATERAL (
          SELECT reported_at, event_source_name, unlock_allowed, command_id
            FROM lock_events
           WHERE device_id = d.device_id
           ORDER BY reported_at DESC
           LIMIT 1
        ) le ON true
       WHERE d.is_active
       ORDER BY d.name`);
    return rows;
  });

  app.get('/api/devices/:id/track', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const hours = Math.min(Number((req.query as { hours?: string }).hours ?? 6), 72);
    const { rows } = await pool.query(
      `SELECT reported_at,
              ST_Y(location::geometry) AS latitude,
              ST_X(location::geometry) AS longitude,
              speed_kph, motor_locked
         FROM positions
        WHERE device_id = $1
          AND positioned
          AND reported_at > now() - ($2 || ' hours')::interval
        ORDER BY reported_at ASC
        LIMIT 5000`,
      [id, hours],
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

  // --- Arrival unlocks ----------------------------------------------------

  app.get('/api/devices/:id/arrivals', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.reason, a.radius_m, a.is_armed, a.created_by,
              a.created_at, a.expires_at, a.triggered_at, a.triggered_distance_m,
              a.triggered_command_id,
              ST_Y(a.location::geometry) AS latitude,
              ST_X(a.location::geometry) AS longitude,
              -- How far the vehicle is right now, so the operator can see it
              -- approaching rather than guessing.
              CASE WHEN s.location IS NOT NULL
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
      name?: string;
      latitude?: number;
      longitude?: number;
      radiusM?: number;
      reason?: string;
      expiresInHours?: number;
    };

    const lat = Number(body.latitude);
    const lon = Number(body.longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      return reply.code(400).send({ error: 'invalid_coordinates' });
    }
    if (!body.reason || body.reason.trim().length < 3) {
      return reply.code(400).send({ error: 'reason_required' });
    }

    // Below ~30m the vehicle would often pass through without a position
    // landing inside; above 5km it stops meaning "arrived" at all.
    const radius = Math.min(Math.max(Math.round(Number(body.radiusM) || 100), 30), 5000);
    const hours = Math.min(Math.max(Number(body.expiresInHours) || 12, 1), 72);
    const name = (body.name ?? '').trim() || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO arrival_unlocks (device_id, name, location, radius_m, reason, created_by, expires_at)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7,
               now() + ($8 || ' hours')::interval)
       RETURNING id`,
      [id, name, lon, lat, radius, body.reason.trim(), actorOf(req), hours],
    );

    await audit(req, 'arrival_unlock_armed', id, {
      arrivalId: rows[0]!.id,
      name,
      latitude: lat,
      longitude: lon,
      radiusM: radius,
      reason: body.reason.trim(),
      expiresInHours: hours,
    });

    return { id: rows[0]!.id, name, radiusM: radius, expiresInHours: hours };
  });

  /** Disarm. Kept as a row so the audit trail still shows it existed. */
  app.delete('/api/devices/:id/arrivals/:arrivalId', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const arrivalId = Number((req.params as { arrivalId?: string }).arrivalId);
    if (!Number.isInteger(arrivalId)) return reply.code(400).send({ error: 'invalid_id' });

    const { rowCount } = await pool.query(
      `UPDATE arrival_unlocks SET is_armed = false WHERE id = $1 AND device_id = $2 AND is_armed`,
      [arrivalId, id],
    );
    await audit(req, 'arrival_unlock_disarmed', id, { arrivalId });
    return { disarmed: rowCount === 1 };
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

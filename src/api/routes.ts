import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.ts';
import { apiConfig } from './config.ts';

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

  app.get('/api/devices', async () => {
    const { rows } = await pool.query(`
      SELECT d.device_id, d.name, d.plate_number, d.model,
             s.last_seen_at, s.last_position_at, s.is_connected,
             ST_Y(s.location::geometry) AS latitude,
             ST_X(s.location::geometry) AS longitude,
             s.positioned, s.speed_kph, s.heading_deg, s.satellites,
             s.battery_percent, s.charging, s.motor_locked, s.rope_inserted,
             s.gsm_signal, s.wake_source, s.active_alarms
        FROM devices d
        LEFT JOIN device_state s ON s.device_id = d.device_id
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
      `SELECT id, reported_at, event_source_name, unlock_allowed,
              refused_outside_fence, rfid_card, wrong_password_count, command_id
         FROM lock_events
        WHERE device_id = $1
        ORDER BY reported_at DESC
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

    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason || reason.trim().length < 3) {
      return reply.code(400).send({ error: 'reason_required' });
    }

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
       VALUES ($1, 'unlock_static', $2, $3, $4, 'queued', now() + interval '30 minutes')
       RETURNING id`,
      [id, `(P43,${device.static_password})`, actorOf(req), reason.trim()],
    );

    const commandId = inserted[0]!.id;
    await audit(req, 'unlock_requested', id, { reason: reason.trim(), online: device.is_connected }, commandId);

    // Deliberately not reporting success: the command is queued, and only the
    // device's own P45 report can confirm the lock actually opened.
    return {
      commandId,
      status: 'queued',
      deviceOnline: device.is_connected === true,
    };
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.ts';
import { config } from '../config.ts';
import { apiConfig, RateLimiter } from './config.ts';
import {
  findActiveById,
  findByUsername,
  hashPassword,
  recordLogin,
  verifyPassword,
  type User,
} from './users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved once per request by the auth hook. null means nobody. */
    zeeUser?: User | null;
  }
}

/*
 * Login: five attempts per account and twenty per address, per five minutes.
 *
 * Per account so one operator's password cannot be ground down; per address
 * because the account limit alone is sidestepped by working through usernames.
 */
const loginByUser = new RateLimiter(5, 5 * 60_000);
const loginByIp = new RateLimiter(20, 5 * 60_000);

/*
 * Unlocks: ten per operator and twenty per address, per minute.
 *
 * Not an anti-fraud control — a permitted operator can unlock a permitted
 * truck. It is a bound on a script or a stuck retry loop opening valves across
 * the fleet faster than anyone could notice.
 */
const unlockByUser = new RateLimiter(10, 60_000);
const unlockByIp = new RateLimiter(20, 60_000);

/**
 * Verified against when no such account exists, so a missing username and a
 * wrong password cost the same time. Computed once at startup; the password it
 * hashes is random and is never anybody's.
 */
const DUMMY_HASH = await hashPassword(crypto.randomUUID());
import { tileRoutes } from './tiles.ts';
import { fetchDevices, fetchSubLocks } from './devices-query.ts';
import { fetchIntegrationVehicles } from './integration.ts';
import { toFeatureCollection } from './integration-shape.ts';
import { encode } from '../protocol/index.ts';

const DEVICE_ID = /^\d{10}$/;

/**
 * What a queued unlock stores instead of the password.
 *
 * `commands.payload` lives for thirty days and is readable by anyone with
 * database access; it was carrying every truck's unlock password in clear. The
 * gateway fills the placeholder in at the moment it dispatches. See
 * `substitutePlaceholders` in src/gateway/store.ts, which is the one place that
 * knows what these expand to.
 */
const STATIC_PASSWORD_PLACEHOLDER_PAYLOAD = '(P43,{{static_password}})';

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // --- Auth ---------------------------------------------------------------

  app.post('/api/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const name = (username ?? '').trim();

    /*
     * Rate limited per account AND per address before anything else happens.
     * Either check alone is trivially sidestepped: one account from a botnet,
     * or one address working through a list of usernames.
     *
     * The refusal is deliberately identical to a wrong password, so the limiter
     * does not become a way to find out which usernames exist.
     */
    const withinLimits =
      loginByIp.allow(req.ip) && (name === '' || loginByUser.allow(name.toLowerCase()));
    if (!withinLimits) {
      await audit(req, 'login_rate_limited', null, { username: name });
      return reply.code(429).send({ error: 'too_many_attempts' });
    }

    const user = name ? await findByUsername(name) : null;

    // Ordering matters: verify even when the user does not exist, against a
    // dummy hash, so a missing account and a wrong password take the same time.
    // Without that, the response time alone enumerates valid usernames.
    const ok = user
      ? user.is_active && (await verifyPassword(password ?? '', user.password_hash))
      : (await verifyPassword(password ?? '', DUMMY_HASH), false);

    if (!ok || !user) {
      await audit(req, 'login_failed', null, { username: name });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    loginByIp.clear(req.ip);
    loginByUser.clear(name.toLowerCase());
    await recordLogin(user.id);

    // The cookie carries WHO, not merely that somebody once knew a password.
    reply.setCookie(apiConfig.cookieName, String(user.id), {
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
    req.zeeUser = user;
    await audit(req, 'login', null, { username: user.username });
    return { ok: true, username: user.username, mayUnlock: user.may_unlock };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(apiConfig.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/session', async (req) => {
    const user = await currentUser(req);
    return {
      authenticated: apiConfig.isAuthenticated(req),
      username: user?.username ?? null,
      // The console hides the unlock controls on this. The routes enforce it
      // regardless — hiding a button is a courtesy, never the gate.
      mayUnlock: user ? user.may_unlock : apiConfig.authDisabled,
    };
  });

  /**
   * Operational health, for the fleet ramp and for whatever watches this box.
   *
   * Unauthenticated from loopback only — a monitoring agent on the same host
   * should not need a session cookie, but pool depths and fleet counts are not
   * for the open internet. From anywhere else it falls through to the normal
   * auth hook below.
   *
   * The gateway's numbers come from gateway_health, written by that process
   * once per sweep. `staleSeconds` is the load-bearing field: if it climbs, the
   * gateway has stopped reporting and everything else in that block is history,
   * not status.
   */
  app.get('/api/health', async (req, reply) => {
    if (!isLoopback(req.ip) && !apiConfig.isAuthenticated(req)) {
      return reply.code(401).send({ error: 'unauthorised' });
    }
    return healthReport();
  });

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

    /*
     * Resolve the account behind the cookie on every request, not just at
     * login. A deactivated operator's session would otherwise keep working —
     * and keep opening valves — for the twelve hours until their cookie
     * expired. Deactivation has to take effect now.
     */
    if (!apiConfig.authDisabled) {
      const user = await currentUser(req);
      if (!user) {
        reply.clearCookie(apiConfig.cookieName, { path: '/' });
        return reply.code(401).send({ error: 'unauthorised', reason: 'account_inactive' });
      }
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
    // The console hides the sub-lock unlock controls when this is false. The
    // routes refuse regardless — hiding a control is a courtesy, never the
    // gate itself.
    subLockUnlockEnabled: config.subLockUnlockEnabled,
  }));

  app.get('/api/devices', async () => fetchDevices());

  /**
   * What a partner receives, shown to the operator.
   *
   * The same call the token-authenticated feed makes, through the same shaping
   * functions — not a description of it. Anyone handing a partner a token can
   * see the exact bytes that partner will get, and a field that stops being
   * published stops appearing here in the same deploy.
   *
   * Behind the session cookie like everything else in this scope. It publishes
   * nothing new: an operator already sees all of this, and rather less of it
   * than /api/devices carries.
   */
  app.get('/api/integration-preview', async (req) => {
    const vehicles = await fetchIntegrationVehicles();
    if ((req.query as { format?: string }).format === 'geojson') {
      return toFeatureCollection(vehicles);
    }
    return { generatedAt: new Date().toISOString(), count: vehicles.length, vehicles };
  });

  /**
   * Who holds a token, and whether they are actually using it.
   *
   * Only the SHA-256 of a token is stored, so no token can be shown here — by
   * design, and it is why this lists rather than reveals. `last_used_at` is the
   * field that matters during a rollout: it separates "the partner cannot reach
   * us" from "the partner has not tried yet", which otherwise look identical
   * from this side.
   *
   * Issuing stays on the CLI (scripts/create-api-token.ts): a token is printed
   * once and never recoverable, which is a poor fit for a page that can be
   * reloaded, and granting fleet-wide visibility deserves shell access.
   */
  app.get('/api/integration-tokens', async () => {
    const { rows } = await pool.query(
      `SELECT id, name, is_active, created_at, created_by, last_used_at, last_used_ip, request_count
         FROM api_tokens
        ORDER BY is_active DESC, created_at DESC`,
    );
    return rows;
  });

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
      // is_physical and the evidence columns travel together on purpose. The
      // console has to be able to say "the device accepted this, and no
      // movement has been evidenced" — which is only meaningful, and only
      // alarming, for a command that can actually move a valve.
      `SELECT c.id, c.command_type, c.status, c.requested_by, c.reason,
              c.requested_at, c.sent_at, c.confirmed_at, c.expires_at,
              c.last_error, c.failure_cause,
              c.physically_evidenced_at, c.physical_evidence_kind,
              COALESCE(t.is_physical, true) AS is_physical
         FROM commands c
         LEFT JOIN command_types t ON t.command_type = c.command_type
        WHERE c.device_id = $1
        ORDER BY c.requested_at DESC
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

    if (!(await requireUnlockRole(req, reply))) return reply;
    if (!(await allowUnlockAttempt(req, reply, id))) return reply;

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
     *
     * Only the DEVICE rejecting us counts. A socket that broke says nothing
     * about the password, and an 'uncertain' command says nothing about
     * anything - counting either was how a link problem locked an operator out
     * of a truck whose password was fine all along.
     */
    const { rows: failureRows } = await pool.query<{ failures: number }>(
      `SELECT count(*)::int AS failures
         FROM commands c
        WHERE c.device_id = $1
          AND c.command_type IN ('unlock_static', 'unlock_dynamic')
          AND c.status = 'failed'
          AND c.failure_cause = 'device_rejected'
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

    /*
     * The password is NOT written into the queue.
     *
     * `commands.payload` is kept for 30 days, read by anyone with database
     * access, and was carrying the unlock password of every truck in clear.
     * The gateway substitutes the placeholder from `devices.static_password` at
     * the moment it dispatches — see claimPendingCommands.
     *
     * A side benefit: a command queued before a password rotation goes out with
     * the password the device actually holds, rather than the one it held when
     * an operator pressed the button.
     */
    const { rows: inserted } = await pool.query<{ id: number }>(
      `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at)
       VALUES ($1, 'unlock_static', $2, $3, $4, 'queued', now() + ($5 || ' minutes')::interval)
       RETURNING id`,
      [id, STATIC_PASSWORD_PLACEHOLDER_PAYLOAD, actorOf(req), reason.trim(), ttl],
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
      // Neither password goes in the payload. The new one is in metadata,
      // because the rotation cannot be adopted without it, and the current one
      // the gateway reads from `devices` at dispatch — so the credential lives
      // in one place instead of three. `current` is read above only to prove
      // the device exists.
      [
        id,
        `(P44,{{new_password}},{{static_password}})`,
        actorOf(req),
        JSON.stringify({ newPassword: next }),
      ],
    );
    void current;

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
    // Shaped like the sub-locks the partner feed publishes, plus the fields
    // only the panel shows. See devices-query.ts for why one vocabulary.
    return fetchSubLocks(id);
  });

  /**
   * Ask the master which peripherals it actually has bound.
   *
   * Needed because a JT709 defaults to no LoRa heartbeat, so a newly fitted
   * valve lock stays invisible until somebody presses its wake button. This
   * makes it appear as soon as the master answers.
   *
   * Not gated by SUBLOCK_UNLOCK_ENABLED: reading which peripherals a master
   * has bound opens nothing.
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
   *
   * Gated off by default — see `config.subLockUnlockEnabled`. The refusal
   * carries a reason a dispatcher can act on, because a bare 403 on a button
   * that used to work reads as a malfunction and produces a phone call.
   */
  app.post('/api/devices/:id/sublocks/:subId/unlock', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;

    if (!config.subLockUnlockEnabled) return reply.code(409).send(subLockGateRefusal());
    if (!(await requireUnlockRole(req, reply))) return reply;
    if (!(await allowUnlockAttempt(req, reply, id))) return reply;

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

    // Arming an arrival rule IS authorising an unlock — one that fires with
    // nobody deciding in the moment. It needs the same permission as pressing
    // the button, not less.
    if (!(await requireUnlockRole(req, reply))) return reply;

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

    // Refused rather than silently downgraded. An operator who ticked the box
    // and got a rule back without it would find the valves shut on arrival and
    // have no idea why.
    if (includeSubLocks && !config.subLockUnlockEnabled) {
      return reply.code(409).send(subLockGateRefusal());
    }

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
   * Also cancels every unlock this arrival already queued, if it fired while
   * the vehicle was asleep and the commands are still waiting to be delivered.
   * Clearing the flag alone left them live, so the lock opened on the next wake
   * - minutes or hours after an operator watched the rule disappear and
   * reasonably concluded nothing more would happen.
   *
   * "Every" is load-bearing. `arrival_unlocks.triggered_command_id` records
   * only the master unlock; a rule with sub-locks spawns N more relays whose
   * ids it never held, so cancelling by that column left them armed and
   * invisible. Commands now carry the rule that spawned them.
   */
  app.delete('/api/devices/:id/arrivals/:arrivalId', async (req, reply) => {
    const id = deviceIdOf(req, reply);
    if (!id) return reply;
    const arrivalId = Number((req.params as { arrivalId?: string }).arrivalId);
    if (!Number.isInteger(arrivalId)) return reply.code(400).send({ error: 'invalid_id' });

    const { rowCount: disarmedCount } = await pool.query(
      `UPDATE arrival_unlocks SET is_armed = false
        WHERE id = $1 AND device_id = $2 AND is_armed`,
      [arrivalId, id],
    );

    /*
     * Only commands still awaiting delivery can be cancelled. One already
     * 'sent' is on the wire and beyond recall, and one that is 'uncertain' may
     * have opened a valve already. Both are reported back rather than glossed
     * over: the operator needs to know to go and physically check.
     */
    const { rows: outcome } = await pool.query<{
      id: number;
      command_type: string;
      cancelled: boolean;
      status: string;
    }>(
      `WITH spawned AS (
         SELECT id, command_type, status FROM commands
          WHERE triggered_by_arrival_id = $1 AND device_id = $2
       ),
       cancelled AS (
         UPDATE commands c
            SET status = 'expired',
                last_error = 'cancelled with the arrival rule',
                failure_cause = 'cancelled'
           FROM spawned s
          WHERE c.id = s.id
            AND c.status IN ('queued', 'approved', 'draft', 'pending_approval')
          RETURNING c.id
       )
       SELECT s.id, s.command_type, s.status,
              (s.id IN (SELECT id FROM cancelled)) AS cancelled
         FROM spawned s
        ORDER BY s.id`,
      [arrivalId, id],
    );

    const cancelled = outcome.filter((c) => c.cancelled).map((c) => c.id);
    const beyondRecall = outcome
      .filter((c) => !c.cancelled)
      .map((c) => ({ id: c.id, type: c.command_type, status: c.status }));

    await audit(req, 'arrival_unlock_disarmed', id, { arrivalId, cancelled, beyondRecall });
    return {
      disarmed: disarmedCount === 1,
      cancelled,
      // Named so a caller cannot read an empty `cancelled` as "nothing was
      // queued" when it actually means "everything had already gone out".
      beyondRecall,
    };
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
      `UPDATE commands
          SET status = 'expired',
              last_error = 'cancelled by operator',
              failure_cause = 'cancelled'
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

/**
 * Why a sub-lock unlock was refused, in words a dispatcher can act on.
 *
 * A capability that used to work and now returns a bare error reads as a
 * broken system, and the next move is a phone call rather than a decision.
 * Say what is switched off, and that the master lock still works.
 */
function subLockGateRefusal(): Record<string, unknown> {
  return {
    error: 'sublock_unlock_disabled',
    reason:
      'فتح الأقفال الفرعية (صمامات JT709) معطَّل حالياً: لا توجد وسيلة للتأكد من أن الصمام قد فُتح فعلاً. ' +
      'فتح القفل الرئيسي يعمل كالمعتاد.',
  };
}

function isPublic(url: string): boolean {
  return (
    url.startsWith('/api/login') ||
    url.startsWith('/api/session') ||
    url.startsWith('/api/logout') ||
    // Exempt from the blanket hook because it does its own check: open from
    // loopback, authenticated from anywhere else. See the route.
    url.startsWith('/api/health')
  );
}

/**
 * Hooks apply to every route in the scope regardless of registration order, so
 * /api/health has to opt out of the auth hook above and then gate itself.
 */
function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Everything the fleet ramp needs to see in one request.
 *
 * Deliberately one round trip per fact rather than one clever query: this runs
 * on demand, not on the hot path, and each number should be readable on its own
 * when one of them looks wrong.
 */
async function healthReport(): Promise<Record<string, unknown>> {
  const [gateway, commands, partitions, connected] = await Promise.all([
    pool.query<{
      instance: string;
      sessions: number;
      listener_connected: boolean;
      last_sweep_ms: number | null;
      last_sweep_at: Date | null;
      stale_seconds: number;
      started_at: Date;
    }>(
      `SELECT instance, sessions, listener_connected, last_sweep_ms, last_sweep_at, started_at,
              EXTRACT(epoch FROM now() - updated_at)::int AS stale_seconds
         FROM gateway_health
        ORDER BY updated_at DESC`,
    ),
    pool.query<{ queued: number; oldest_seconds: number | null }>(
      `SELECT count(*)::int AS queued,
              EXTRACT(epoch FROM now() - min(requested_at))::int AS oldest_seconds
         FROM commands
        WHERE status IN ('queued', 'approved')
          AND expires_at > now()`,
    ),
    // Rows in the default partition mean the monthly partitions ran out — the
    // data is still there, but it is in the wrong place and retention cannot
    // drop it by partition. Headroom is how many months of partitions remain.
    pool.query<{ default_rows: number; headroom_months: number }>(
      `SELECT (SELECT count(*)::int FROM ONLY positions_default) AS default_rows,
              (SELECT count(*)::int FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relname ~ '^positions_[0-9]{4}_[0-9]{2}$'
                 AND n.nspname = current_schema()
                 AND c.relname >= 'positions_' || to_char(now(), 'YYYY_MM')) AS headroom_months`,
    ),
    pool.query<{ connected: number }>(
      'SELECT count(*)::int AS connected FROM device_state WHERE is_connected',
    ),
  ]);

  const g = gateway.rows[0];
  return {
    ok: true,
    api: {
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        // Non-zero means requests are queueing for a connection — the silent
        // pool queue, and the first thing to look at under load.
        waiting: pool.waitingCount,
      },
    },
    gateway: g
      ? {
          instance: g.instance,
          startedAt: g.started_at,
          sessions: g.sessions,
          listenerConnected: g.listener_connected,
          lastSweepMs: g.last_sweep_ms,
          lastSweepAt: g.last_sweep_at,
          staleSeconds: g.stale_seconds,
        }
      : null,
    devices: { connected: connected.rows[0]?.connected ?? 0 },
    commands: {
      queued: commands.rows[0]?.queued ?? 0,
      oldestQueuedSeconds: commands.rows[0]?.oldest_seconds ?? null,
    },
    partitions: {
      defaultRows: partitions.rows[0]?.default_rows ?? 0,
      headroomMonths: partitions.rows[0]?.headroom_months ?? 0,
    },
  };
}

function deviceIdOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const { id } = req.params as { id?: string };
  if (!id || !DEVICE_ID.test(id)) {
    reply.code(400).send({ error: 'invalid_device_id' });
    return null;
  }
  return id;
}

/**
 * Who did this, for the audit trail.
 *
 * Used to be `operator@${req.ip}` — an address wearing an identity's clothes.
 * It answered "which machine" and was recorded in the field that is supposed to
 * answer "which person", on the trail the Ministry relies on to say who opened
 * a tanker. The address is still recorded, in audit_log.ip_address, where it
 * belongs and where it is not mistaken for attribution.
 *
 * Resolved from the request, which the auth hook has already populated. With
 * auth disabled there is genuinely nobody, and it says so rather than inventing
 * a name.
 */
function actorOf(req: FastifyRequest): string {
  const user = req.zeeUser;
  if (user) return String(user.id);
  return apiConfig.authDisabled ? 'auth-disabled' : 'unknown';
}

/**
 * The account behind this request, cached on it.
 *
 * The auth hook resolves it once per request; everything after reads the cache.
 * Without that, every route that audits would go back to the database for the
 * same row.
 */
async function currentUser(req: FastifyRequest): Promise<User | null> {
  if (req.zeeUser !== undefined) return req.zeeUser;
  const id = apiConfig.sessionUserId(req);
  const user = id === null ? null : await findActiveById(id);
  req.zeeUser = user;
  return user;
}

/**
 * Refuse anything that opens a lock to an account that may only watch.
 *
 * Viewing where the fleet is and opening a valve on a tanker full of petrol are
 * different kinds of act. This is the only role distinction there is, and it is
 * the one worth having before a pilot.
 */
/**
 * Bound how fast one operator, or one machine, can open valves.
 *
 * Not a fraud control — a permitted operator unlocking a permitted truck is the
 * point of the platform. It is a ceiling on a script or a stuck retry loop
 * working through the fleet faster than anyone could notice, on a system where
 * each call opens a valve on a tanker.
 */
async function allowUnlockAttempt(
  req: FastifyRequest,
  reply: FastifyReply,
  deviceId: string,
): Promise<boolean> {
  const actor = actorOf(req);
  if (unlockByUser.allow(actor) && unlockByIp.allow(req.ip)) return true;

  await audit(req, 'unlock_rate_limited', deviceId, {});
  reply.code(429).send({
    error: 'too_many_unlocks',
    reason: 'عدد كبير من طلبات الفتح خلال وقت قصير. انتظر قليلاً ثم أعد المحاولة.',
  });
  return false;
}

async function requireUnlockRole(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (apiConfig.authDisabled) return true;
  const user = await currentUser(req);
  if (user?.may_unlock) return true;

  await audit(req, 'unlock_forbidden', null, { url: req.url });
  reply.code(403).send({
    error: 'unlock_not_permitted',
    reason: 'هذا الحساب مخوَّل بالمتابعة فقط ولا يملك صلاحية فتح الأقفال.',
  });
  return false;
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

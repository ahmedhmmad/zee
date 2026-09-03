/**
 * Read-only JSON API for other systems to pull from.
 *
 * Built so a partner platform - the Ministry's fuel committee system, which
 * already runs an Esri map - can fetch vehicle positions and draw them
 * alongside its own data, without anyone being given a console login.
 *
 * Three deliberate constraints:
 *
 *   1. READ ONLY. There is no unlock, no configuration, no write of any kind
 *      reachable from here. A token that leaks costs visibility, never
 *      control of a lock on a fuel tanker.
 *   2. An explicit field allowlist, not the console's projection. That one
 *      carries SIM numbers and a flag saying whether a lock still has its
 *      factory password - fine for the operator, not for a third party.
 *   3. Bearer tokens, separate from the operator password, so a partner's
 *      access can be revoked without changing the password drivers use.
 *
 * Registered as a sibling of apiRoutes rather than inside it, so the session
 * cookie hook there does not apply: these callers are machines and have no
 * cookie to present.
 */

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db.ts';
import {
  toVehicle,
  toSubLock,
  toFeatureCollection,
  type VehicleRow,
  type SubLockRow,
  type SubLock,
  type Vehicle,
} from './integration-shape.ts';

/**
 * Vehicle projection for external consumers.
 *
 * Every column here is a deliberate choice to publish. Anything not listed is
 * not exposed - which is why this is written out rather than reusing
 * fetchDevices().
 *
 * A device that has never had a GPS fix stores 0,0 - a real point in the Gulf
 * of Guinea. Reported as no position at all rather than as a location, because
 * a partner plotting our JSON would otherwise show a fuel tanker in the
 * Atlantic and reasonably conclude the whole feed is wrong.
 */
const VEHICLES_SQL = `
  SELECT d.device_id,
         d.name,
         d.plate_number,
         s.last_seen_at,
         s.last_position_at,
         COALESCE(s.is_connected, false) AS is_connected,
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
         s.speed_kph,
         s.heading_deg,
         s.battery_percent,
         s.motor_locked,
         s.rope_inserted,
         s.active_alarms,
         s.mileage_km,
         -- Denormalised onto device_state by store.insertLockEvent (019), so
         -- this costs nothing here. It used to be a LATERAL over lock_events.
         s.last_event_at,
         s.last_event_source,
         s.last_event_allowed,
         s.last_event_command_id
    FROM devices d
    LEFT JOIN device_state s ON s.device_id = d.device_id
   WHERE d.is_active
   ORDER BY d.device_id`;

/**
 * Every sub-lock bound to an active master, in one query.
 *
 * One query for the whole fleet, grouped by master in JS, rather than a
 * subquery per vehicle. Migration 019 already paid for that lesson: a
 * per-device LATERAL on a list that gets polled is what made the console's
 * device list unservable at fleet scale, and this list is polled by definition.
 *
 * `rfid_card` is not selected. A driver's card id is not map data.
 */
const SUBLOCKS_SQL = `
  SELECT p.peripheral_id,
         p.master_id,
         p.name,
         p.device_type,
         p.locked,
         p.rope_pulled_out,
         p.back_cover_open,
         p.battery_percent,
         p.voltage,
         p.last_seen_at,
         p.comms_lost_alarm,
         p.low_voltage_alarm
    FROM sub_devices p
    JOIN devices d ON d.device_id = p.master_id AND d.is_active
   ORDER BY p.master_id, p.peripheral_id`;

/**
 * The feed, assembled.
 *
 * Exported because the console's preview page renders the same call. Two
 * callers, one implementation — otherwise the preview drifts from the feed and
 * the thing an operator checks before handing a token over stops describing
 * what the partner actually receives.
 */
export async function fetchIntegrationVehicles(): Promise<Vehicle[]> {
  const [vehicles, subLocks] = await Promise.all([
    pool.query<VehicleRow>(VEHICLES_SQL),
    pool.query<SubLockRow>(SUBLOCKS_SQL),
  ]);

  const byMaster = new Map<string, SubLock[]>();
  for (const row of subLocks.rows) {
    // char(10), so the join key is space-padded on both sides of this map.
    const master = row.master_id.trim();
    const list = byMaster.get(master);
    if (list) list.push(toSubLock(row));
    else byMaster.set(master, [toSubLock(row)]);
  }

  return vehicles.rows.map((r) => toVehicle(r, byMaster.get(r.device_id.trim()) ?? []));
}

/**
 * Resolve a bearer token to the row that issued it.
 *
 * The presented token is hashed and looked up by hash, so the comparison is an
 * indexed equality on a fixed-length digest rather than a string compare
 * against a secret.
 */
async function authenticate(req: FastifyRequest): Promise<{ id: number; name: string } | null> {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  const digest = crypto.createHash('sha256').update(match[1]!.trim()).digest('hex');
  const { rows } = await pool.query<{ id: number; name: string }>(
    'SELECT id, name FROM api_tokens WHERE token_sha256 = $1 AND is_active',
    [digest],
  );
  return rows[0] ?? null;
}

/**
 * Record that a token was used. Deliberately not awaited by the request: usage
 * accounting must never be the reason a partner's poll fails or slows down.
 */
function recordUse(tokenId: number, ip: string): void {
  void pool
    .query(
      `UPDATE api_tokens
          SET last_used_at = now(), last_used_ip = $2, request_count = request_count + 1
        WHERE id = $1`,
      [tokenId, ip],
    )
    .catch(() => {});
}

/**
 * Origins allowed to call this API from a browser. Empty by default, which
 * means no CORS headers at all and only server-to-server callers can use it.
 *
 * Exact origins, never `*`: these responses are token-gated, and a wildcard on
 * a credentialed feed is how live tanker positions end up readable from any
 * page on the internet.
 */
const corsOrigins = new Set(
  (process.env.INTEGRATION_CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),
);

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  /*
   * CORS, hand-written and scoped to this plugin.
   *
   * Twenty lines against a fourth Fastify plugin, on a codebase that is
   * dependency-light on purpose. Scoped here so the console, the unlock
   * endpoint and the WebSocket are untouched by it: a mistake in this block
   * must not be able to open anything that actuates hardware.
   *
   * Preflight is answered before authentication, because a browser sends
   * OPTIONS without the Authorization header — answering 401 there means the
   * real request is never sent and the partner sees an opaque CORS failure
   * rather than an auth one.
   */
  if (corsOrigins.size > 0) {
    app.log.info(`integration api: CORS enabled for ${[...corsOrigins].join(', ')}`);

    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && corsOrigins.has(origin.replace(/\/$/, ''))) {
        reply.header('Access-Control-Allow-Origin', origin);
        // The response varies by request origin, so a shared cache must not
        // hand one partner's copy to another.
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Headers', 'Authorization');
        reply.header('Access-Control-Max-Age', '86400');
      }
      if (req.method === 'OPTIONS') {
        return reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS').code(204).send();
      }
    });

    /*
     * A route for the preflight to match.
     *
     * Fastify runs a plugin's hooks only after routing has found a handler in
     * that plugin, and OPTIONS is routed separately from GET. Without this the
     * preflight falls through to the server's 404 handler, the hook above
     * never runs, and the partner sees a CORS failure with no explanation.
     * The hook answers first in practice; this exists so it gets the chance.
     */
    app.options('/api/v1/*', async (_req, reply) => reply.code(204).send());
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = await authenticate(req);
    if (!token) {
      req.log.warn({ url: req.url, ip: req.ip }, 'integration api: rejected');
      // WWW-Authenticate so a partner's HTTP client reports "unauthorised"
      // rather than an opaque 401 with no hint of what is expected.
      return reply
        .header('WWW-Authenticate', 'Bearer realm="zee-integration"')
        .code(401)
        .send({ error: 'unauthorised', hint: 'send: Authorization: Bearer <token>' });
    }
    (req as FastifyRequest & { tokenName?: string }).tokenName = token.name;
    recordUse(token.id, req.ip);
  });

  /** Current state of every active vehicle. */
  app.get('/api/v1/vehicles', async () => {
    const vehicles = await fetchIntegrationVehicles();
    return { generatedAt: new Date().toISOString(), count: vehicles.length, vehicles };
  });

  /** The same data as GeoJSON, for map clients that consume it directly. */
  app.get('/api/v1/vehicles.geojson', async () => {
    return toFeatureCollection(await fetchIntegrationVehicles());
  });

  /**
   * Cheap endpoint for a partner to confirm their token works before wiring
   * up anything else. Saves a round of "is it us or is it you".
   */
  app.get('/api/v1/ping', async (req) => ({
    ok: true,
    token: (req as FastifyRequest & { tokenName?: string }).tokenName ?? null,
    serverTime: new Date().toISOString(),
  }));
}

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
import { toVehicle, toFeatureCollection, type VehicleRow } from './integration-shape.ts';

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
         s.mileage_km
    FROM devices d
    LEFT JOIN device_state s ON s.device_id = d.device_id
   WHERE d.is_active
   ORDER BY d.device_id`;

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

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
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
    const { rows } = await pool.query<VehicleRow>(VEHICLES_SQL);
    const vehicles = rows.map(toVehicle);
    return { generatedAt: new Date().toISOString(), count: vehicles.length, vehicles };
  });

  /** The same data as GeoJSON, for map clients that consume it directly. */
  app.get('/api/v1/vehicles.geojson', async () => {
    const { rows } = await pool.query<VehicleRow>(VEHICLES_SQL);
    return toFeatureCollection(rows.map(toVehicle));
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

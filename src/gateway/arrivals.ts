/**
 * Arrival-triggered unlocking.
 *
 * When a position falls inside an armed rule's radius, queue an unlock. The
 * checks below are deliberately strict, because this is the one path in the
 * system where a lock opens with nobody deciding in the moment.
 */

import { pool } from '../db.ts';
import type { PositionFrame } from '../protocol/index.ts';

export interface TriggeredArrival {
  id: number;
  name: string;
  reason: string;
  distanceM: number;
  commandId: number | null;
}

export async function checkArrivalUnlocks(p: PositionFrame): Promise<TriggeredArrival[]> {
  // A cell-tower fix is accurate to hundreds of metres or worse - nowhere near
  // good enough to decide whether a tanker has arrived somewhere.
  if (!p.positioned) return [];

  // Blind-area replays deliver positions from hours ago. One of those could
  // sit inside the radius and fire an unlock long after the truck left.
  if (p.isHistorical) return [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Claim and disarm in one statement, so two positions arriving together
    // cannot both trigger the same rule.
    const { rows } = await client.query<{
      id: number;
      name: string;
      reason: string;
      distance_m: string;
    }>(
      `UPDATE arrival_unlocks a
          SET is_armed = false,
              triggered_at = now(),
              triggered_distance_m = ST_Distance(a.location, $2::geography)
        WHERE a.device_id = $1
          AND a.is_armed
          AND a.expires_at > now()
          AND ST_DWithin(a.location, $2::geography, a.radius_m)
        RETURNING a.id, a.name, a.reason,
                  ST_Distance(a.location, $2::geography) AS distance_m`,
      [p.deviceId, `SRID=4326;POINT(${p.longitude} ${p.latitude})`],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    const { rows: deviceRows } = await client.query<{ static_password: string }>(
      'SELECT static_password FROM devices WHERE device_id = $1',
      [p.deviceId],
    );
    const password = deviceRows[0]?.static_password;
    if (!password) {
      await client.query('ROLLBACK');
      return [];
    }

    const triggered: TriggeredArrival[] = [];
    for (const rule of rows) {
      const distanceM = Math.round(Number(rule.distance_m) * 10) / 10;

      const { rows: cmd } = await client.query<{ id: number }>(
        `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at)
         VALUES ($1, 'unlock_static', $2, $3, $4, 'queued', now() + interval '15 minutes')
         RETURNING id`,
        [
          p.deviceId,
          `(P43,${password})`,
          `arrival:${rule.name}`,
          `${rule.reason} — وصول تلقائي (${distanceM} م)`,
        ],
      );
      const commandId = cmd[0]?.id ?? null;

      await client.query('UPDATE arrival_unlocks SET triggered_command_id = $2 WHERE id = $1', [
        rule.id,
        commandId,
      ]);

      await client.query(
        `INSERT INTO audit_log (actor, action, device_id, command_id, detail)
         VALUES ('system', 'arrival_unlock_triggered', $1, $2, $3)`,
        [
          p.deviceId,
          commandId,
          JSON.stringify({
            arrivalId: rule.id,
            name: rule.name,
            reason: rule.reason,
            distanceM,
            latitude: p.latitude,
            longitude: p.longitude,
            satellites: p.satellites,
            reportedAt: p.reportedAt,
          }),
        ],
      );

      triggered.push({ id: rule.id, name: rule.name, reason: rule.reason, distanceM, commandId });
    }

    await client.query('COMMIT');
    return triggered;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Arrival-triggered unlocking.
 *
 * When a position falls inside an armed rule's radius, queue an unlock. The
 * checks below are deliberately strict, because this is the one path in the
 * system where a lock opens with nobody deciding in the moment.
 */

import { pool } from '../db.ts';
import { config } from '../config.ts';
import { encode, type PositionFrame } from '../protocol/index.ts';

export interface TriggeredArrival {
  id: number;
  name: string;
  reason: string;
  distanceM: number;
  commandId: number | null;
  /** Valve locks also queued, if the rule asked for them. */
  subLocks: number;
}

export async function checkArrivalUnlocks(p: PositionFrame): Promise<TriggeredArrival[]> {
  // A cell-tower fix is accurate to hundreds of metres or worse - nowhere near
  // good enough to decide whether a tanker has arrived somewhere.
  if (!p.positioned) return [];

  /*
   * Act only on a position that still describes where the truck is.
   *
   * Guarding on age rather than on data type: blind-area replays are hours
   * old, but the device's recent backlog (type 4) can also arrive minutes
   * late, and at motorway speed a two-minute-old fix is several kilometres
   * behind. Either could sit inside the radius and open a lock the vehicle has
   * already left.
   *
   * Arrivals happen at walking pace anyway - the truck is slowing to stop - so
   * a tight window costs nothing real.
   */
  const ageSeconds = (Date.now() - p.reportedAt.getTime()) / 1000;
  if (ageSeconds > 120) return [];

  /*
   * Cheap pooled question before the expensive one.
   *
   * Below this line every positioned frame took a dedicated client out of the
   * pool and ran BEGIN / UPDATE / COMMIT — three round trips and a held
   * connection — even when the truck had no arrival rule armed at all, which is
   * almost always. And it is awaited on the position path, so at fleet scale it
   * was the pool contention that everything else queued behind.
   *
   * Served by the existing partial index arrival_unlocks_armed_idx. The
   * transactional claim below remains the authority: this only decides whether
   * it is worth asking, so no correctness property depends on it.
   */
  const { rowCount: armed } = await pool.query(
    `SELECT 1 FROM arrival_unlocks
      WHERE device_id = $1 AND is_armed AND expires_at > now()
      LIMIT 1`,
    [p.deviceId],
  );
  if (!armed) return [];

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
      include_sublocks: boolean;
    }>(
      `UPDATE arrival_unlocks a
          SET is_armed = false,
              triggered_at = now(),
              triggered_distance_m = ST_Distance(a.location, $2::geography)
        WHERE a.device_id = $1
          AND a.is_armed
          AND a.expires_at > now()
          AND ST_DWithin(a.location, $2::geography, a.radius_m)
        RETURNING a.id, a.name, a.reason, a.include_sublocks,
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
    // Read only to establish that the platform HOLDS a password for this truck.
    // Queuing an unlock we could never fill in would leave an armed rule that
    // fires and fails, which reads to an operator like the truck ignoring it.
    const password = deviceRows[0]?.static_password;
    if (!password) {
      await client.query('ROLLBACK');
      return [];
    }

    const triggered: TriggeredArrival[] = [];
    for (const rule of rows) {
      const distanceM = Math.round(Number(rule.distance_m) * 10) / 10;

      // triggered_by_arrival_id is what makes disarming honest: the rule can
      // spawn N+1 commands and arrival_unlocks only ever held the id of one of
      // them, so cancelling by that column left the sub-lock relays armed with
      // nothing recording that they existed.
      const { rows: cmd } = await client.query<{ id: number }>(
        `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at, triggered_by_arrival_id)
         VALUES ($1, 'unlock_static', $2, $3, $4, 'queued', now() + interval '15 minutes', $5)
         RETURNING id`,
        [
          p.deviceId,
          // Not the password itself: the queue keeps this row for the life of
          // the rule and it is readable by anyone with database access. The
          // gateway substitutes it at dispatch.
          '(P43,{{static_password}})',
          `arrival:${rule.name}`,
          `${rule.reason} — وصول تلقائي (${distanceM} م)`,
          rule.id,
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

      // Optionally release the valve locks as well. The platform can only
      // place the command with the master; the sub-lock still has to be woken
      // at the truck, so this queues intent rather than guaranteeing an open
      // valve.
      //
      // The gate is checked here as well as at the API. A rule armed before
      // sub-lock unlocking was switched off is still sitting in the table, and
      // it must not fire valve relays now that there is no way to evidence
      // them. The audit row says the rule was downgraded rather than leaving a
      // silent difference between what was armed and what happened.
      let subLocks = 0;
      if (rule.include_sublocks && !config.subLockUnlockEnabled) {
        await client.query(
          `INSERT INTO audit_log (actor, action, device_id, command_id, detail)
           VALUES ('system', 'arrival_sublocks_suppressed', $1, $2, $3)`,
          [
            p.deviceId,
            commandId,
            JSON.stringify({
              arrivalId: rule.id,
              name: rule.name,
              why: 'sub-lock unlocking is disabled: no confirmation path exists for it',
            }),
          ],
        );
      } else if (rule.include_sublocks) {
        const { rows: subs } = await client.query<{ peripheral_id: string }>(
          `SELECT peripheral_id FROM sub_devices
            WHERE master_id = $1
              AND bound_confirmed_at IS NOT NULL
              AND (device_type IS NULL OR device_type IN ('jt709_sub_lock', 'jt802_valve_lock'))`,
          [p.deviceId],
        );

        for (const sub of subs) {
          await client.query(
            `INSERT INTO commands (device_id, command_type, payload, requested_by, reason, status, expires_at, metadata, triggered_by_arrival_id)
             VALUES ($1, 'unlock_sublock', $2, $3, $4, 'queued', now() + interval '15 minutes', $5, $6)`,
            [
              p.deviceId,
              encode.wlnetUnlockSubLock(p.deviceId, sub.peripheral_id).toString('latin1'),
              `arrival:${rule.name}`,
              `${rule.reason} — وصول تلقائي (قفل فرعي)`,
              JSON.stringify({ subLockId: sub.peripheral_id, arrivalId: rule.id }),
              rule.id,
            ],
          );
          subLocks++;
        }
      }

      triggered.push({
        id: rule.id,
        name: rule.name,
        reason: rule.reason,
        distanceM,
        commandId,
        subLocks,
      });
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

-- Take the two LATERAL subqueries off the device list, which runs on every
-- position frame.
--
-- 002_live_updates.sql fires notify_device_change on every device_state INSERT
-- *or* UPDATE — so on every position frame. The API forwards that to
-- pushDeviceUpdate, which calls the device projection. That projection contains
-- a seven-day per-device mileage LATERAL over `positions`. At 3,000 trucks
-- reporting every 30 seconds it therefore scans roughly four thousand position
-- rows per device, dozens of times a second, to compute two integers that
-- barely change.
--
-- positions_device_time_idx can serve the range, but mileage_km is not in it,
-- so every heap row is read anyway. The fix is not a better index — it is not
-- asking the question. The rollup below is maintained on write, at the cost of
-- one upsert folded into the position path's existing statement.
--
-- local_day is MATERIALISED rather than computed. `AT TIME ZONE '<name>'` is
-- STABLE, not IMMUTABLE — the zone database can change under it — so Postgres
-- will not index an expression using it. Storing the day is the only way this
-- can be looked up by day at all.
--
-- It also settles an inconsistency nobody had noticed: today_km was computed
-- over Africa/Tripoli calendar days and week_km over a rolling 168-hour UTC
-- window, so the two numbers on screen were measured against different clocks.
-- Both are Tripoli days now.
--
-- Idempotent; adds tables and columns, drops nothing.

BEGIN;

-- ---------------------------------------------------------------------------
-- Daily odometer span, per device.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS device_mileage_daily (
  device_id     char(10) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  local_day     date     NOT NULL,

  first_km      integer  NOT NULL,
  last_km       integer  NOT NULL,

  -- The reading with the newest DEVICE timestamp for this day, and the
  -- odometer on it. Kept separately from last_km because they disagree in
  -- exactly the case worth catching.
  latest_reported_at timestamptz NOT NULL,
  km_at_latest       integer     NOT NULL,

  /*
   * The odometer only ever counts up, so a later reading showing a LOWER
   * value means something happened that max - min cannot describe: a reset, a
   * rollover, or a replaced unit. One reset in a day yields about 99,994 km
   * for that truck.
   *
   * Generated rather than set by the writer, so it cannot drift from the data
   * it describes.
   *
   * Deliberately only a flag. What to do about it — segmenting the day around
   * the reset — is a Ministry reporting decision and belongs with the
   * reporting it feeds. Nothing may put an unguarded max - min in front of
   * anyone in the meantime.
   *
   * Note this is NOT tripped by blind-area replay: a replayed frame carries an
   * older device timestamp, so it widens first_km and leaves km_at_latest
   * alone.
   */
  has_anomaly   boolean GENERATED ALWAYS AS (km_at_latest < last_km) STORED,

  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (device_id, local_day)
);

COMMENT ON TABLE device_mileage_daily IS
  'Odometer span per device per Africa/Tripoli day, maintained on write. '
  'Replaces a seven-day LATERAL over positions that ran on every position '
  'frame. Nothing reportable may consume a row with has_anomaly set.';

CREATE INDEX IF NOT EXISTS device_mileage_daily_day_idx
  ON device_mileage_daily (local_day DESC);

-- Thirty days of history, which is trivial at the current volume and means the
-- console shows the same numbers the moment this lands rather than filling in
-- over a week.
INSERT INTO device_mileage_daily
  (device_id, local_day, first_km, last_km, latest_reported_at, km_at_latest, updated_at)
SELECT p.device_id,
       (p.reported_at AT TIME ZONE 'Africa/Tripoli')::date AS local_day,
       min(p.mileage_km),
       max(p.mileage_km),
       max(p.reported_at),
       -- The odometer on the newest reading of that day.
       (array_agg(p.mileage_km ORDER BY p.reported_at DESC))[1],
       now()
  FROM positions p
 WHERE p.reported_at >= now() - interval '30 days'
   AND p.mileage_km IS NOT NULL
 GROUP BY p.device_id, (p.reported_at AT TIME ZONE 'Africa/Tripoli')::date
ON CONFLICT (device_id, local_day) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The last lock event, on the device row.
-- ---------------------------------------------------------------------------

-- The other LATERAL. Lock events are a handful per device per day, so
-- maintaining this on write costs nothing measurable and removes a per-device
-- subquery from a list that is read constantly.
ALTER TABLE device_state
  ADD COLUMN IF NOT EXISTS last_event_at         timestamptz,
  ADD COLUMN IF NOT EXISTS last_event_source     text,
  ADD COLUMN IF NOT EXISTS last_event_allowed    boolean,
  ADD COLUMN IF NOT EXISTS last_event_command_id bigint;

COMMENT ON COLUMN device_state.last_event_at IS
  'Denormalised from lock_events, maintained by store.insertLockEvent. The '
  'lock_events row remains the record; this is a cache of its newest entry.';

UPDATE device_state s
   SET last_event_at         = le.reported_at,
       last_event_source     = le.event_source_name,
       last_event_allowed    = le.unlock_allowed,
       last_event_command_id = le.command_id
  FROM (
    SELECT DISTINCT ON (device_id)
           device_id, reported_at, event_source_name, unlock_allowed, command_id
      FROM lock_events
     ORDER BY device_id, reported_at DESC
  ) le
 WHERE le.device_id = s.device_id
   AND s.last_event_at IS NULL;

COMMIT;

-- Repair state damaged by null-island positions being stored as real fixes.
BEGIN;

-- Positions that were never really at 0,0 - the device simply had no fix.
UPDATE positions
   SET location = NULL
 WHERE location IS NOT NULL
   AND abs(ST_Y(location::geometry)) < 0.0001
   AND abs(ST_X(location::geometry)) < 0.0001;

-- Restore each device's last genuinely known position, which the 0,0 reports
-- had overwritten.
UPDATE device_state s
   SET location = last_good.location
  FROM (
    SELECT DISTINCT ON (device_id) device_id, location
      FROM positions
     WHERE location IS NOT NULL AND positioned
     ORDER BY device_id, reported_at DESC
  ) last_good
 WHERE s.device_id = last_good.device_id
   AND (s.location IS NULL
        OR (abs(ST_Y(s.location::geometry)) < 0.0001
        AND abs(ST_X(s.location::geometry)) < 0.0001));

-- Anything still sitting on the null island had no good fix to fall back to.
UPDATE device_state
   SET location = NULL
 WHERE location IS NOT NULL
   AND abs(ST_Y(location::geometry)) < 0.0001
   AND abs(ST_X(location::geometry)) < 0.0001;

COMMIT;

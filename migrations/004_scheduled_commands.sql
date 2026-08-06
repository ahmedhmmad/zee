-- Allow a command to be held back until a given time.
--
-- Needed so the platform can re-check lock state a couple of minutes after an
-- unlock: the device auto-locks about a minute later (P83) and is usually
-- asleep by then, so the state we hold goes stale showing "open" for a lock
-- that has since closed.

BEGIN;

ALTER TABLE commands ADD COLUMN IF NOT EXISTS not_before timestamptz;

COMMENT ON COLUMN commands.not_before IS
  'Earliest dispatch time. NULL means send as soon as the device connects.';

-- The dispatch index has to account for it, or held commands still get picked.
DROP INDEX IF EXISTS commands_dispatch_idx;
CREATE INDEX commands_dispatch_idx ON commands (device_id, not_before, requested_at)
  WHERE status IN ('queued', 'approved');

COMMIT;

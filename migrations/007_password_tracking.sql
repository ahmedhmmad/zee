-- Track when a device's password was last changed.
--
-- Used to decide whether a run of failed unlocks is still relevant: once
-- someone corrects the stored password, previous failures say nothing about
-- the next attempt and must stop blocking it.

BEGIN;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS password_updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION touch_password_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.static_password IS DISTINCT FROM OLD.static_password THEN
    NEW.password_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger rather than application code, so a password corrected straight in
-- psql - which is how it is actually done today - clears the block too.
DROP TRIGGER IF EXISTS devices_password_touch ON devices;
CREATE TRIGGER devices_password_touch
  BEFORE UPDATE OF static_password ON devices
  FOR EACH ROW EXECUTE FUNCTION touch_password_updated_at();

COMMIT;

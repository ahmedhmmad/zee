-- Know which peripherals are BOUND, not just which have spoken.
--
-- Until now a sub-lock only existed to us once it transmitted. But a JT709
-- defaults to no LoRa heartbeat at all - it stays silent while asleep to
-- protect a battery that must last three years - so a freshly bound valve lock
-- is invisible until somebody presses its wake button. An operator who has
-- just fitted one sees nothing and reasonably concludes it failed.
--
-- WLNET,1 asks the master what it actually holds, which answers that directly.

BEGIN;

-- Set when the master last listed this peripheral in a WLNET,1 reply.
ALTER TABLE sub_devices ADD COLUMN IF NOT EXISTS bound_confirmed_at timestamptz;

-- A peripheral we know is bound but which has never reported has no type yet,
-- so these can no longer be NOT NULL.
ALTER TABLE sub_devices ALTER COLUMN device_type DROP NOT NULL;
ALTER TABLE sub_devices ALTER COLUMN device_type_code DROP NOT NULL;

COMMENT ON COLUMN sub_devices.bound_confirmed_at IS
  'Last WLNET,1 reply that listed this peripheral. NULL after a rebind that '
  'dropped it - binding is destructive and replaces the whole list.';

COMMIT;

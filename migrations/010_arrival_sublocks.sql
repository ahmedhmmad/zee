-- Let an arrival rule open the valve locks too, not just the master.
--
-- Opt-in rather than automatic. Opening the dome cover on arrival is one
-- decision; releasing every discharge valve is a considerably larger one, and
-- an operator should have to say so.

BEGIN;

ALTER TABLE arrival_unlocks
  ADD COLUMN IF NOT EXISTS include_sublocks boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN arrival_unlocks.include_sublocks IS
  'Also queue a WLNET,8 unlock for every bound sub-lock on arrival. Note the '
  'sub-lock still has to be woken at the truck - the platform can only place '
  'the command with the master.';

COMMIT;

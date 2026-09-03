-- Record which arrival rule spawned each command, and retract the sub-lock
-- capability that is already armed out in the field.
--
-- Two problems, one migration, because they are the same problem seen twice.
--
-- 1. Disarming an arrival rule cancelled one command. A rule with sub-locks
--    spawns the master unlock plus one relay per valve, and
--    arrival_unlocks.triggered_command_id holds a single id - the master's. The
--    relays' ids were recorded nowhere at all. So an operator who disarmed a
--    fired rule was told the unlock was cancelled while N valve relays stayed
--    queued, ready to fire on the next wake. triggered_by_arrival_id fixes that
--    at the source: the rule is on every command it spawns.
--
-- 2. Sub-lock unlocking is being gated off, because it has no confirmation
--    path: the WLNET,8 reply is a bare echo and a sleeping JT709 reports
--    nothing, so the platform cannot say whether a valve opened. A config flag
--    stops new ones. It does nothing about the rules already armed with
--    include_sublocks, or the relays already queued - and those are exactly the
--    commands that fire hours later with nobody watching.
--
-- Armed rules are downgraded rather than disarmed: the master unlock is what
-- the operator is waiting for at the depot gate and it is unaffected, so
-- cancelling it outright would break a live operation to fix a different
-- problem. The downgrade is written to the audit log, because an operator who
-- ticked a box has to be able to find out why it stopped being true.
--
-- Nothing is deleted and no rule is removed. Idempotent.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The rule that spawned each command.
-- ---------------------------------------------------------------------------

ALTER TABLE commands
  ADD COLUMN IF NOT EXISTS triggered_by_arrival_id bigint REFERENCES arrival_unlocks(id);

COMMENT ON COLUMN commands.triggered_by_arrival_id IS
  'The arrival rule that queued this command, if any. Disarming a rule must be '
  'able to find EVERY command it spawned - a rule with sub-locks queues one '
  'master unlock and N relays, and arrival_unlocks.triggered_command_id holds '
  'only the first of them.';

CREATE INDEX IF NOT EXISTS commands_arrival_idx
  ON commands (triggered_by_arrival_id)
  WHERE triggered_by_arrival_id IS NOT NULL;

-- Backfill the master unlocks, which are the ones that were recorded.
UPDATE commands c
   SET triggered_by_arrival_id = a.id
  FROM arrival_unlocks a
 WHERE a.triggered_command_id = c.id
   AND c.triggered_by_arrival_id IS NULL;

-- And the sub-lock relays, whose rule was only ever written into the command's
-- own metadata - the one place nothing ever looked.
UPDATE commands c
   SET triggered_by_arrival_id = (c.metadata->>'arrivalId')::bigint
 WHERE c.triggered_by_arrival_id IS NULL
   AND c.command_type = 'unlock_sublock'
   AND c.metadata ? 'arrivalId'
   AND EXISTS (
     SELECT 1 FROM arrival_unlocks a WHERE a.id = (c.metadata->>'arrivalId')::bigint
   );

-- ---------------------------------------------------------------------------
-- 2. Retract the capability that is already out there.
-- ---------------------------------------------------------------------------

-- Relays that have not gone out yet. A 'sent' one is on the wire and beyond
-- recall; saying otherwise would be a lie an operator might act on.
INSERT INTO audit_log (actor, action, device_id, command_id, detail)
SELECT 'migration', 'sublock_unlock_suppressed', c.device_id, c.id,
       jsonb_build_object(
         'why', 'sub-lock unlocking disabled: no confirmation path exists for it',
         'previousStatus', c.status,
         'arrivalId', c.triggered_by_arrival_id
       )
  FROM commands c
 WHERE c.command_type = 'unlock_sublock'
   AND c.status IN ('queued', 'approved', 'draft', 'pending_approval');

UPDATE commands
   SET status = 'expired',
       last_error = 'sub-lock unlocking disabled before this command was delivered',
       failure_cause = 'cancelled'
 WHERE command_type = 'unlock_sublock'
   AND status IN ('queued', 'approved', 'draft', 'pending_approval');

-- Armed rules that would spawn more of them. Downgraded, and said so.
INSERT INTO audit_log (actor, action, device_id, command_id, detail)
SELECT 'migration', 'arrival_sublocks_suppressed', a.device_id, NULL,
       jsonb_build_object(
         'arrivalId', a.id,
         'name', a.name,
         'why', 'sub-lock unlocking disabled: the master unlock still applies'
       )
  FROM arrival_unlocks a
 WHERE a.include_sublocks
   AND a.is_armed
   AND a.expires_at > now();

UPDATE arrival_unlocks
   SET include_sublocks = false
 WHERE include_sublocks
   AND is_armed
   AND expires_at > now();

COMMIT;

-- migrate: no-transaction
--
-- Indexes for the two fleet-wide command queries that had none.
--
-- BREAKS THE REPO CONVENTION, deliberately. Every other migration wraps itself
-- in BEGIN/COMMIT; this one must not, because CREATE INDEX CONCURRENTLY cannot
-- run inside a transaction block. Removing BEGIN/COMMIT is not sufficient on
-- its own either: Postgres wraps a multi-statement simple query in an IMPLICIT
-- transaction, so the marker above tells the runner to send each statement as
-- its own round trip.
--
-- CONCURRENTLY because commands is the table the unlock path writes to. A plain
-- CREATE INDEX takes a lock that blocks writes for the duration, and blocking
-- writes on that table means an operator's unlock does not get queued.
--
-- The trade is that a CONCURRENTLY build can fail and leave an INVALID index
-- behind, which is why each is dropped first: re-running this file after a
-- failure is then the fix rather than a second problem. Check for leftovers
-- with:
--
--   SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--    WHERE NOT i.indisvalid AND c.relname LIKE 'commands_%';
--
-- Idempotent, and safe to re-run.

-- The sweep asks "which devices have work waiting?" across the whole fleet,
-- with no device_id predicate. commands_dispatch_idx is device-LEADING
-- (device_id, not_before, requested_at), so a fleet query degrades to a scan of
-- the whole partial index, which grows with total command history rather than
-- with the amount of work outstanding.
DROP INDEX CONCURRENTLY IF EXISTS commands_due_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS commands_due_idx
  ON commands (not_before NULLS FIRST, requested_at)
  WHERE status IN ('queued', 'approved');

-- requeueUnansweredCommands scans for commands sent and not answered. It runs
-- every sweep and has had no supporting index at all.
DROP INDEX CONCURRENTLY IF EXISTS commands_sent_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS commands_sent_idx
  ON commands (sent_at)
  WHERE status = 'sent';

COMMENT ON INDEX commands_due_idx IS
  'Fleet-wide "what is due", for the gateway sweep. Not device-leading, unlike '
  'commands_dispatch_idx, because the sweep has no device predicate.';

COMMENT ON INDEX commands_sent_idx IS
  'Commands awaiting an answer, for the timeout pass. Deliberately excludes '
  'uncertain: that state is terminal for dispatch and must never be swept back '
  'into the queue.';

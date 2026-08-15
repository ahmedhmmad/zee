-- Small key/value table for facts about this deployment itself, as opposed to
-- the fleet it manages.
--
-- Its first use is the evaluation-period anchor: the instant the platform was
-- first installed here. The installer computes the expiry as anchor + agreed
-- length rather than now + agreed length, so re-running it cannot restart the
-- clock. Without the anchor, the same install command run a second time simply
-- issues a fresh period, and the limit never actually arrives.
--
-- Deliberately in the database rather than in a file: resetting it means
-- destroying the positions, lock events and audit trail stored alongside it,
-- so the cost of a reset falls on whoever resets it. This is a deterrent, not
-- a protection - anyone with database access can edit the row. See README
-- "Evaluation period" for what this does and does not defend against.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_meta (
  key        text PRIMARY KEY,
  value      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_meta IS
  'Facts about this deployment. Currently the evaluation-period anchor.';

COMMENT ON COLUMN platform_meta.value IS
  'For key=evaluation_started_at: ISO instant of the first install here. '
  'Written once, never updated by the installer.';

COMMIT;

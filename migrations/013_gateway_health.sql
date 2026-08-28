-- Somewhere for the gateway to publish how it is doing, so the API can answer
-- for it.
--
-- The gateway and the API are separate processes - the devices speak a binary
-- TCP protocol, so there is no HTTP in the device path and Nginx cannot carry
-- it. That means /api/health, which runs in the API process, cannot read the
-- gateway's session count, sweep timing or listener state directly. The
-- gateway writes them here once per sweep and the API reads them back.
--
-- Keyed by instance because Phase 5 runs more than one gateway. Until then
-- there is exactly one row.
--
-- updated_at is what makes the row trustworthy: a stale row means the gateway
-- died without saying so, which is the failure this table exists to expose.
-- Read it as "these numbers were true as of", never as "these numbers are
-- true".

BEGIN;

CREATE TABLE IF NOT EXISTS gateway_health (
  instance           text PRIMARY KEY,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz NOT NULL,
  sessions           integer     NOT NULL,
  listener_connected boolean     NOT NULL,
  last_sweep_ms      integer,
  last_sweep_at      timestamptz
);

COMMENT ON TABLE gateway_health IS
  'Gateway self-report, one row per gateway process. Written once per sweep.';

COMMENT ON COLUMN gateway_health.updated_at IS
  'When this row was last written. Staleness is the signal: an old row means '
  'the gateway stopped reporting, not that it has nothing to report.';

COMMENT ON COLUMN gateway_health.last_sweep_ms IS
  'Duration of the last command sweep. Growing toward the 60s interval means '
  'the sweep is about to overlap itself.';

COMMIT;

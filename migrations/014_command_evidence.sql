-- Separate what happened in the exchange with the device from whether the lock
-- physically moved.
--
-- These are two facts and the platform routinely knows one without the other: a
-- device can answer (P43,1,0) and the valve still not open, and a P45 lock event
-- can arrive minutes after the command that caused it has already timed out.
-- One status column cannot hold both, and the version that tried conflated
-- "the device accepted this" with "the valve is open" - which on a tanker full
-- of petrol is the wrong thing to be wrong about.
--
-- So: commands.status keeps one meaning, identical for every command type -
-- what happened in the exchange - and gains 'uncertain' for the case the schema
-- previously had no way to write at all, where nothing came back and the
-- command may or may not have executed. Physical movement becomes evidence
-- recorded alongside, pointing at the row that proves it.
--
-- command_types exists so the retry policy has exactly one source of truth. A
-- physical command is never auto-retried, because the device auto-locks about a
-- minute after opening and a helpful retry opens the valve again, possibly in
-- transit. The foreign key is the point of the table: a new command type cannot
-- be queued without someone first declaring whether it actuates hardware.
--
-- Idempotent, and reversible: nothing is dropped and no row is deleted.

BEGIN;

-- ---------------------------------------------------------------------------
-- The exchange vocabulary.
-- ---------------------------------------------------------------------------

-- 'uncertain' cannot be written at all until this lands, so every later part of
-- this work depends on it.
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_status_check;
ALTER TABLE commands ADD CONSTRAINT commands_status_check
  CHECK (status IN ('draft','pending_approval','approved','queued','sent',
                    'confirmed','failed','uncertain','expired','rejected'));

COMMENT ON COLUMN commands.status IS
  'What happened in the exchange with the device, and nothing else: '
  'queued -> sent -> confirmed (the device answered the command word, ok) '
  '| failed (the device refused, or the write genuinely failed) '
  '| uncertain (nothing came back in the window; it may still have executed) '
  '| expired. Whether the lock physically moved is physically_evidenced_at.';

-- ---------------------------------------------------------------------------
-- Physical movement, recorded as evidence rather than as a state.
-- ---------------------------------------------------------------------------

ALTER TABLE commands
  ADD COLUMN IF NOT EXISTS physically_evidenced_at timestamptz,
  ADD COLUMN IF NOT EXISTS physical_evidence_kind  text,
  ADD COLUMN IF NOT EXISTS physical_evidence_id    bigint;

ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_physical_evidence_check;
-- Evidence is a claim about a specific row. A timestamp with nothing to point
-- at is exactly the confident-but-unsupported record this work exists to stop.
ALTER TABLE commands ADD CONSTRAINT commands_physical_evidence_check
  CHECK (
    (physically_evidenced_at IS NULL
      AND physical_evidence_kind IS NULL
      AND physical_evidence_id IS NULL)
    OR
    (physically_evidenced_at IS NOT NULL
      AND physical_evidence_kind IN ('lock_event','peripheral_report')
      AND physical_evidence_id IS NOT NULL)
  );

COMMENT ON COLUMN commands.physically_evidenced_at IS
  'When movement was evidenced - NOT when it happened, and NULL is not proof '
  'that nothing moved. It means the platform has no evidence either way.';
COMMENT ON COLUMN commands.physical_evidence_kind IS
  'lock_event (a P45 from the master) or peripheral_report (a sub-lock '
  'reporting itself open over LoRa).';
COMMENT ON COLUMN commands.physical_evidence_id IS
  'lock_events.id or sub_device_readings.id. Deliberately not a foreign key: '
  'it points into two different tables, and Phase 4 partitions one of them.';

-- ---------------------------------------------------------------------------
-- Why a command failed - transport, or the device saying no.
-- ---------------------------------------------------------------------------

-- last_error is a free-text message for a human. The lockout counter at
-- /unlock needs to count only the device rejecting our password, never a
-- socket that broke, so it needs a field it can qualify on.
ALTER TABLE commands ADD COLUMN IF NOT EXISTS failure_cause text;

ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_failure_cause_check;
ALTER TABLE commands ADD CONSTRAINT commands_failure_cause_check
  CHECK (failure_cause IS NULL OR failure_cause IN
    ('device_rejected','transport','no_response','cancelled','unclassified'));

COMMENT ON COLUMN commands.failure_cause IS
  'device_rejected: the device answered no - the only cause that says anything '
  'about our password. transport: the write failed. no_response: nothing came '
  'back. cancelled: an operator or an arrival rule withdrew it. unclassified: '
  'written before this column existed.';

-- ---------------------------------------------------------------------------
-- The one place that says which command types actuate hardware.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS command_types (
  command_type text PRIMARY KEY,
  -- Physical means sending it can move a valve. Physical commands are never
  -- auto-retried and never returned to 'queued' by a timeout.
  is_physical  boolean NOT NULL,
  description  text    NOT NULL
);

COMMENT ON TABLE command_types IS
  'Every command type the platform can queue, and whether it actuates '
  'hardware. Referenced by commands.command_type so a new type cannot be used '
  'before it is classified.';

INSERT INTO command_types (command_type, is_physical, description) VALUES
  -- Physical. These open a valve on a tanker.
  ('unlock_static',           true,  'Remote unlock with the stored static password (P43)'),
  ('unlock_dynamic',          true,  'Remote unlock with a dynamic password (P52)'),
  ('unlock_sublock',          true,  'Relay an unlock to a JT709 valve sub-lock (WLNET,8)'),

  -- Queries. Read-only, and safe to retry.
  ('query_position',          false, 'Ask for a position and lock-state report (P02)'),
  ('query_firmware',          false, 'Firmware string and battery percentage (P01)'),
  ('query_password',          false, 'Read back the static password the device holds (P44,1)'),
  ('query_channels',          false, 'Read which unlock channels are enabled (P59,0)'),
  ('query_bound_peripherals', false, 'Ask the master which peripherals it has bound (WLNET,1)'),
  ('query_tracking',          false, 'Read continuous-tracking setting (P54,0)'),
  ('query_intervals',         false, 'Read reporting and wake intervals (P04,0)'),
  ('query_wake_window',       false, 'Read how long the device stays awake (P39,0)'),
  ('query_motion',            false, 'Read motion-detection sensitivity (P37,0)'),
  ('query_cornering',         false, 'Read cornering-report setting (P99,0)'),
  ('query_drift',             false, 'Read static-drift optimisation setting (P63,0)'),
  ('query_gnss_power',        false, 'Read GNSS power-saving setting (P97,0)'),
  ('query_autolock',          false, 'Read the auto-lock delay (P83,0)'),

  -- Settings. They change how the device behaves, but none of them move a
  -- lock: set_autolock and set_long_unlock are a delay and an alarm threshold.
  ('set_password',            false, 'Rotate the static password (P44)'),
  ('set_timezone',            false, 'Set the device timezone (P10)'),
  ('set_intervals',           false, 'Set reporting and wake intervals (P04)'),
  ('set_p45_fields',          false, 'Choose which fields lock reports carry (P94)'),
  ('set_tracking',            false, 'Continuous tracking on or off (P54)'),
  ('set_wake_window',         false, 'How long to stay awake after a wake (P39)'),
  ('set_motion',              false, 'Motion-detection sensitivity (P37)'),
  ('set_cornering',           false, 'Cornering reports and their angle (P99)'),
  ('set_drift_opt',           false, 'Static-drift optimisation (P63)'),
  ('set_gnss_power',          false, 'GNSS power saving (P97)'),
  ('set_autolock',            false, 'Auto-lock delay after an unlock (P83)'),
  ('set_long_unlock',         false, 'Long-unlock alarm threshold (P38)'),
  ('set_low_battery',         false, 'Low-battery alarm threshold (P61)')
ON CONFLICT (command_type) DO UPDATE SET
  description = EXCLUDED.description;

-- Anything already in the table that this seed does not know about is
-- classified physical - not because it is, but because that is the direction
-- that cannot cause a second unlock. It reads as an unreviewed row.
INSERT INTO command_types (command_type, is_physical, description)
SELECT DISTINCT c.command_type, true,
       'UNREVIEWED: found in existing command history. Classified physical so '
       'it is never auto-retried. Reclassify once someone confirms what it does.'
  FROM commands c
 WHERE NOT EXISTS (
   SELECT 1 FROM command_types t WHERE t.command_type = c.command_type
 )
ON CONFLICT (command_type) DO NOTHING;

ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_command_type_fkey;
ALTER TABLE commands ADD CONSTRAINT commands_command_type_fkey
  FOREIGN KEY (command_type) REFERENCES command_types (command_type);

COMMIT;

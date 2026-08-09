-- Replace the provisional sub-device status columns with the real field set.
--
-- Migration 007 was written against a reconstruction of the WLNET,5 layout
-- that had a single status byte. The actual Integration Manual V1.7.1 defines
-- Event (2 bytes) and Device Status (2 bytes) as separate fields, with the
-- motor state in Device Status bit 1. The old single byte was reading the high
-- half of Event, which reported our bench sub-lock as unlocked when it was
-- locked with its back cover off.

BEGIN;

ALTER TABLE sub_devices
  DROP COLUMN IF EXISTS status_code,
  DROP COLUMN IF EXISTS rope_cut_alarm,
  ADD COLUMN IF NOT EXISTS event_code        integer,
  ADD COLUMN IF NOT EXISTS event_name        text,
  ADD COLUMN IF NOT EXISTS rope_pulled_out   boolean,
  ADD COLUMN IF NOT EXISTS back_cover_open   boolean,
  ADD COLUMN IF NOT EXISTS charging          boolean,
  ADD COLUMN IF NOT EXISTS lock_cycles       integer,
  ADD COLUMN IF NOT EXISTS rfid_card         char(10),
  -- Master reports it can no longer hear this sub-lock over LoRa. On a tanker
  -- that is either a flat battery or a valve lock that is no longer attached.
  ADD COLUMN IF NOT EXISTS comms_lost_alarm  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS low_voltage_alarm boolean NOT NULL DEFAULT false;

ALTER TABLE sub_device_readings
  DROP COLUMN IF EXISTS status_code,
  DROP COLUMN IF EXISTS rope_cut_alarm,
  ADD COLUMN IF NOT EXISTS event_code        integer,
  ADD COLUMN IF NOT EXISTS event_name        text,
  ADD COLUMN IF NOT EXISTS rope_pulled_out   boolean,
  ADD COLUMN IF NOT EXISTS back_cover_open   boolean,
  ADD COLUMN IF NOT EXISTS charging          boolean,
  ADD COLUMN IF NOT EXISTS lock_cycles       integer,
  ADD COLUMN IF NOT EXISTS rfid_card         char(10),
  ADD COLUMN IF NOT EXISTS comms_lost_alarm  boolean,
  ADD COLUMN IF NOT EXISTS low_voltage_alarm boolean,
  -- Cached data replayed later, not a live reading. Flagged rather than
  -- dropped: it is still a true record, just delivered late.
  ADD COLUMN IF NOT EXISTS reupload          boolean NOT NULL DEFAULT false,
  -- The sensor's own transmission counter. Two readings can share a timestamp
  -- when a sub-lock reports twice in a second, so this completes the key.
  ADD COLUMN IF NOT EXISTS sensor_serial     smallint;

-- The old uniqueness rule keyed on a column that no longer exists.
ALTER TABLE sub_device_readings DROP CONSTRAINT IF EXISTS sub_device_readings_peripheral_id_reported_at_status_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS sub_device_readings_unique
  ON sub_device_readings (peripheral_id, reported_at, sensor_serial);

COMMIT;

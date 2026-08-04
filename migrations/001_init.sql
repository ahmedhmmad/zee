-- Zee lock platform, initial schema.
--
-- All timestamps are timestamptz and stored UTC: the protocol reports UTC
-- exclusively. Conversion to Africa/Tripoli (UTC+2, no DST) happens in the UI,
-- never in the database or the gateway.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

CREATE TABLE devices (
  device_id       char(10) PRIMARY KEY,          -- the 10-digit ID in every frame
  name            text        NOT NULL,
  plate_number    text,
  model           text        NOT NULL DEFAULT 'JT701D',
  imei            char(15),
  sim_msisdn      text,

  -- Unlock credentials. TODO(hardening): move to a secrets store or encrypt at
  -- rest with pgcrypto. Factory default is 888888 and must be rotated on
  -- commissioning with P44.
  static_password text        NOT NULL DEFAULT '888888',
  dynamic_password        text,
  dynamic_password_at     timestamptz,

  is_active       boolean     NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE devices IS
  'Allowlist of known master locks. The protocol has no authentication, so a '
  'frame whose device_id is absent here is treated as forged.';

-- ---------------------------------------------------------------------------
-- Live state: one row per device, overwritten on every report.
--
-- The map reads only from here. Doing "latest position per device" against the
-- partitioned positions table would get slow the moment there is real history.
-- ---------------------------------------------------------------------------

CREATE TABLE device_state (
  device_id        char(10) PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,

  last_seen_at     timestamptz,          -- any frame at all, including heartbeats
  last_position_at timestamptz,
  location         geography(Point, 4326),
  positioned       boolean,              -- false => coordinates are stale/base-station
  speed_kph        numeric(6,1),
  heading_deg      smallint,
  satellites       smallint,

  battery_percent  smallint,
  charging         boolean,

  motor_locked     boolean,
  rope_inserted    boolean,

  gsm_signal       smallint,
  wake_source      text,
  active_alarms    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  is_connected     boolean     NOT NULL DEFAULT false,  -- socket currently open
  connected_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_state_connected_idx ON device_state (is_connected) WHERE is_connected;

-- ---------------------------------------------------------------------------
-- Positions: high volume, append only, partitioned monthly.
--
-- Partitioning is cheap now and very painful to retrofit, so it goes in from
-- the start even though the test fleet is tiny.
-- ---------------------------------------------------------------------------

CREATE TABLE positions (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  device_id     char(10)    NOT NULL,
  reported_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),

  location      geography(Point, 4326),
  positioned    boolean     NOT NULL,
  speed_kph     numeric(6,1) NOT NULL,
  heading_deg   smallint    NOT NULL,
  mileage_km    integer     NOT NULL,
  satellites    smallint    NOT NULL,

  battery_percent smallint,
  charging      boolean     NOT NULL,

  motor_locked  boolean     NOT NULL,
  rope_inserted boolean     NOT NULL,
  status_flags  jsonb       NOT NULL,

  data_type     smallint    NOT NULL,   -- 1 realtime, 2 alarm, 3 blind area, 4 sub-new
  is_alarm      boolean     NOT NULL,
  is_historical boolean     NOT NULL,   -- replayed from device flash, not live

  gsm_signal    smallint,
  wake_source   text,
  mcc           integer,
  mnc           integer,
  cell_id       bigint,
  lac           integer,

  -- One byte, wraps at 255, resets on device restart. Kept only so duplicate
  -- blind-area replays can be recognised; never a stable identifier.
  serial        smallint    NOT NULL,

  PRIMARY KEY (device_id, reported_at, serial)
) PARTITION BY RANGE (reported_at);

-- BRIN rather than B-tree: the data is append-only and time-ordered, so BRIN
-- gives comparable pruning at a fraction of the size. Disk is the constraint
-- on this box, not RAM.
CREATE INDEX positions_reported_at_brin ON positions USING brin (reported_at);
CREATE INDEX positions_device_time_idx ON positions (device_id, reported_at DESC);

-- Catch-all so ingestion never fails on a timestamp outside the pre-created
-- range: devices with no GPS fix and no time sync can report wild dates.
CREATE TABLE positions_default PARTITION OF positions DEFAULT;

CREATE OR REPLACE FUNCTION ensure_position_partition(for_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  start_date date := date_trunc('month', for_month)::date;
  end_date   date := (date_trunc('month', for_month) + interval '1 month')::date;
  part_name  text := format('positions_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF positions FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date
    );
  END IF;
END;
$$;

-- Current month plus twelve ahead, so nothing lands in the default partition
-- during normal operation.
DO $$
DECLARE i integer;
BEGIN
  FOR i IN 0..12 LOOP
    PERFORM ensure_position_partition((date_trunc('month', now()) + (i || ' month')::interval)::date);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Lock events (P45): the audit spine. Every unlock and lock the device itself
-- reports, which is the only trustworthy record of what physically happened.
-- ---------------------------------------------------------------------------

CREATE TABLE lock_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id      char(10)    NOT NULL REFERENCES devices(device_id),
  reported_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),

  location       geography(Point, 4326),
  positioned     boolean     NOT NULL,
  speed_kph      numeric(6,1) NOT NULL,

  event_source      smallint NOT NULL,   -- 1 rfid, 4 static pw, 5 auto-lock, 6 dynamic pw, 8 rope out
  event_source_name text     NOT NULL,
  verification_code smallint NOT NULL,
  unlock_allowed    boolean  NOT NULL,
  -- Device refused because it was outside its authorised geofence. The single
  -- most operationally interesting failure mode for fuel deliveries.
  refused_outside_fence boolean NOT NULL DEFAULT false,

  rfid_card      char(10),
  password_correct boolean  NOT NULL DEFAULT false,
  wrong_password_count smallint NOT NULL DEFAULT 0,

  mileage_km     integer,
  fence_id       smallint,
  imei           char(15),

  event_serial   smallint    NOT NULL,
  raw            text        NOT NULL,

  -- Set when this event confirms a command we issued.
  command_id     bigint,

  UNIQUE (device_id, reported_at, event_serial)
);

CREATE INDEX lock_events_device_time_idx ON lock_events (device_id, reported_at DESC);
CREATE INDEX lock_events_unlocks_idx ON lock_events (reported_at DESC)
  WHERE event_source <> 5;

-- ---------------------------------------------------------------------------
-- Command queue.
--
-- Durable in Postgres rather than Redis: an approved unlock authorisation must
-- survive a gateway restart. Devices sleep, so a command may wait a long time
-- between queued and sent.
-- ---------------------------------------------------------------------------

CREATE TABLE commands (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id     char(10)    NOT NULL REFERENCES devices(device_id),

  command_type  text        NOT NULL,   -- 'unlock_static', 'query_position', ...
  payload       text        NOT NULL,   -- exact ASCII sent on the wire

  -- draft -> pending_approval -> approved -> queued -> sent -> confirmed
  --                                                        \-> failed / expired
  -- sent is NOT success: only the device's own P45 moves us to confirmed.
  status        text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('draft','pending_approval','approved','queued','sent','confirmed','failed','expired','rejected')),

  requested_by  text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  approved_by   text,
  approved_at   timestamptz,
  sent_at       timestamptz,
  confirmed_at  timestamptz,

  -- An unlock authorised at 09:00 must not fire when the truck wakes at 14:00
  -- somewhere else entirely.
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '30 minutes',

  attempts      smallint    NOT NULL DEFAULT 0,
  last_error    text,
  response      text,
  reason        text                    -- why this unlock was requested
);

CREATE INDEX commands_dispatch_idx ON commands (device_id, requested_at)
  WHERE status IN ('queued', 'approved');
CREATE INDEX commands_device_time_idx ON commands (device_id, requested_at DESC);

-- Wake the gateway the instant a command becomes dispatchable, rather than
-- polling. Removes the need for Redis pub/sub at single-instance scale.
CREATE OR REPLACE FUNCTION notify_command_queued()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'queued' THEN
    PERFORM pg_notify('command_queued', NEW.device_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commands_notify
  AFTER INSERT OR UPDATE OF status ON commands
  FOR EACH ROW EXECUTE FUNCTION notify_command_queued();

-- ---------------------------------------------------------------------------
-- Audit log: who asked for what, and what the hardware actually did.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text,
  action     text        NOT NULL,
  device_id  char(10),
  command_id bigint,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_device_idx ON audit_log (device_id, at DESC);

-- ---------------------------------------------------------------------------
-- Frames we could not attribute to a known device. Quarantine rather than
-- discard: a spike here is the signal that someone is probing the port.
-- ---------------------------------------------------------------------------

CREATE TABLE rejected_frames (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  device_id  text,
  reason     text        NOT NULL,
  remote_ip  inet,
  raw_hex    text
);

CREATE INDEX rejected_frames_at_idx ON rejected_frames (at DESC);

COMMIT;

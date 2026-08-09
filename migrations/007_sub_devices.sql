-- JT709 sub-locks and JT126 sensors bound to a master.
--
-- The WLNET,5 layout this relies on is reconstructed and verified against real
-- frames, not taken from the vendor's integration manual, which we still do
-- not have. The lock STATUS byte in particular is provisional - hence
-- locked being nullable rather than a plain boolean.

BEGIN;

CREATE TABLE sub_devices (
  peripheral_id  char(10) PRIMARY KEY,          -- e.g. E03B60000A
  master_id      char(10) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  name           text,
  device_type    text     NOT NULL,             -- jt709_sub_lock, jt126_temp_humidity, ...
  device_type_code smallint NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),

  last_seen_at   timestamptz,
  voltage        numeric(5,2),
  battery_percent smallint,
  rssi           smallint,
  status_code    smallint,
  -- NULL means "we do not know", which is the honest answer for any status
  -- code we have not confirmed. Never default this to a confident value.
  locked         boolean,
  rope_cut_alarm boolean NOT NULL DEFAULT false,
  temperature_c  numeric(5,1),
  humidity_percent smallint
);

CREATE INDEX sub_devices_master_idx ON sub_devices (master_id);

-- Every reading, so a status byte can be correlated with a known physical
-- state later. This is what will confirm the provisional lock decoding.
CREATE TABLE sub_device_readings (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  peripheral_id char(10) NOT NULL,
  master_id     char(10) NOT NULL,
  reported_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  voltage       numeric(5,2),
  battery_percent smallint,
  rssi          smallint,
  status_code   smallint,
  locked        boolean,
  rope_cut_alarm boolean,
  temperature_c numeric(5,1),
  humidity_percent smallint,
  raw_hex       text,
  UNIQUE (peripheral_id, reported_at, status_code)
);

CREATE INDEX sub_device_readings_idx ON sub_device_readings (peripheral_id, reported_at DESC);

COMMIT;

-- Unlock automatically when a vehicle reaches a given point.
--
-- Note this is enforced by the PLATFORM, not the device: we watch incoming
-- positions and queue an unlock when one falls inside the radius. It therefore
-- requires the device to be awake and reporting, which a moving truck is.
--
-- Device-side geofencing (P24/P29/P31 + P52,1) is a different and stronger
-- mechanism - it makes the lock REFUSE to open outside a fence, offline, in
-- firmware. The two are complementary: this one opens doors, that one closes
-- them.

BEGIN;

CREATE TABLE arrival_unlocks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id    char(10)    NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,

  name         text        NOT NULL,
  location     geography(Point, 4326) NOT NULL,
  -- GPS is good to roughly 10-15m in the open, so anything under ~30m would
  -- be missed as often as hit. Bounded in the API too.
  radius_m     integer     NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 30 AND 5000),

  -- One-shot. Disarmed the moment it fires, so a truck parked inside the
  -- radius cannot re-open itself every time it reports.
  is_armed     boolean     NOT NULL DEFAULT true,

  reason       text        NOT NULL,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- A standing authorisation with no end date is a liability; every arrival
  -- rule dies on its own.
  expires_at   timestamptz NOT NULL,

  triggered_at         timestamptz,
  triggered_command_id bigint,
  triggered_distance_m numeric(8,1)
);

CREATE INDEX arrival_unlocks_armed_idx ON arrival_unlocks (device_id)
  WHERE is_armed;
CREATE INDEX arrival_unlocks_location_idx ON arrival_unlocks USING gist (location);

COMMIT;

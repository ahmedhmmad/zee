-- Named locations: depots, filling stations, customer sites.
--
-- Arrival unlocks previously took raw coordinates typed in each time, which
-- is both laborious and a real hazard: one mistyped digit puts the unlock
-- point in the wrong place, and nothing downstream would notice. A catalogue
-- means a coordinate is entered once, by someone who checked it, and every
-- later use is a choice from a list.

BEGIN;

CREATE TABLE locations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  kind       text        NOT NULL DEFAULT 'other'
    CHECK (kind IN ('depot', 'station', 'customer', 'yard', 'other')),
  location   geography(Point, 4326) NOT NULL,
  -- Default arrival radius for this site; overridable per arming.
  radius_m   integer     NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 30 AND 5000),
  address    text,
  notes      text,
  is_active  boolean     NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE INDEX locations_geo_idx ON locations USING gist (location);

-- Which catalogue entry an arrival rule came from. Nullable: ad-hoc
-- coordinates remain possible, and a location can be deleted without
-- destroying the audit record of an unlock that already happened.
ALTER TABLE arrival_unlocks
  ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES locations(id) ON DELETE SET NULL;

COMMIT;

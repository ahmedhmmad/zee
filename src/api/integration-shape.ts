/**
 * The wire format of the integration API, kept free of any database import.
 *
 * Separate from integration.ts so the shape other systems depend on can be
 * exercised without a live PostgreSQL: these are pure functions over a row,
 * and needing a database to test them would mean, in practice, not testing
 * them. Every mistake available here - coordinate order, a dropped vehicle, a
 * numeric arriving as a string - is silent on both sides of the wire.
 */

export interface VehicleRow {
  device_id: string;
  name: string;
  plate_number: string | null;
  last_seen_at: Date | null;
  last_position_at: Date | null;
  is_connected: boolean;
  latitude: number | null;
  longitude: number | null;
  speed_kph: string | null;
  heading_deg: number | null;
  battery_percent: number | null;
  motor_locked: boolean | null;
  mileage_km: number | null;
}

/**
 * Shape sent to partners. Stable: other systems parse this.
 *
 * Field names are an explicit allowlist. The console's projection carries SIM
 * numbers and a flag for whether a lock still holds its factory password -
 * appropriate for the operator, not for a third party - which is why this is
 * written out by hand rather than spreading a row.
 */
export function toVehicle(r: VehicleRow) {
  return {
    // device_id is char(10) in Postgres, so shorter ids arrive space-padded
    // and would not compare equal on the partner's side.
    deviceId: r.device_id.trim(),
    name: r.name,
    plateNumber: r.plate_number,
    latitude: r.latitude,
    longitude: r.longitude,
    // Explicit rather than inferred from a null latitude, so a consumer does
    // not have to guess whether a missing position means "no fix" or "this
    // version of the feed does not send the field".
    positioned: r.latitude !== null && r.longitude !== null,
    // pg returns numeric as a string. Left as one, a partner's `speed > 80`
    // compares lexically and quietly misbehaves.
    speedKph: r.speed_kph === null ? null : Number(r.speed_kph),
    headingDeg: r.heading_deg,
    batteryPercent: r.battery_percent,
    locked: r.motor_locked,
    mileageKm: r.mileage_km,
    online: r.is_connected,
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    lastPositionAt: r.last_position_at?.toISOString() ?? null,
  };
}

export type Vehicle = ReturnType<typeof toVehicle>;

/**
 * GeoJSON FeatureCollection of the same data.
 *
 * Offered because the partner runs an Esri map, where a FeatureCollection is
 * loaded directly with no transformation on their side.
 *
 * Vehicles without a fix keep a null geometry rather than being dropped: the
 * RFC allows it, and a truck that is present but unlocatable is information
 * the other system wants. Omitting it silently would read as the vehicle
 * having left the fleet.
 */
export function toFeatureCollection(vehicles: Vehicle[]) {
  return {
    type: 'FeatureCollection' as const,
    features: vehicles.map((v) => ({
      type: 'Feature' as const,
      // GeoJSON is longitude-first. Reversed, Tripoli plots off Somalia -
      // the most common mistake with this format, and it looks like a
      // working system right up until someone recognises the coastline.
      geometry: v.positioned
        ? { type: 'Point' as const, coordinates: [v.longitude, v.latitude] }
        : null,
      properties: v,
    })),
  };
}

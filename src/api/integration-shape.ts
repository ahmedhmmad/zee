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
  rope_inserted: boolean | null;
  /** jsonb: the alarm names that are currently true, as an object of flags. */
  active_alarms: Record<string, boolean> | null;
  last_event_at: Date | null;
  last_event_source: string | null;
  last_event_allowed: boolean | null;
  last_event_command_id: number | null;
}

/** One JT709 valve sub-lock or JT126 sensor bound to a master. */
export interface SubLockRow {
  peripheral_id: string;
  master_id: string;
  name: string | null;
  device_type: string;
  locked: boolean | null;
  rope_pulled_out: boolean | null;
  back_cover_open: boolean | null;
  battery_percent: number | null;
  voltage: string | null;
  last_seen_at: Date | null;
  comms_lost_alarm: boolean;
  low_voltage_alarm: boolean;
}

/**
 * One sub-lock, as published.
 *
 * `locked` is deliberately nullable and is passed through untouched. The JT709
 * status decoding is reconstructed from real frames rather than documented, so
 * null means "we cannot tell" — and a partner map drawing a valve as
 * confidently locked when we do not know is precisely the failure this
 * platform exists to refuse. Defaulting it to false here would be one
 * character and would put a wrong answer on a Ministry screen.
 *
 * `rfid_card` is not published. It identifies a driver's card and nothing on a
 * map needs it.
 */
export function toSubLock(r: SubLockRow) {
  return {
    peripheralId: r.peripheral_id.trim(),
    name: r.name,
    type: r.device_type,
    locked: r.locked,
    ropePulledOut: r.rope_pulled_out,
    backCoverOpen: r.back_cover_open,
    batteryPercent: r.battery_percent,
    // numeric(5,2), which pg hands over as a string. See speedKph below.
    voltage: r.voltage === null ? null : Number(r.voltage),
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    // The master can no longer hear this sub-lock over LoRa: a flat battery,
    // or a valve lock that is no longer attached to the tanker.
    commsLost: r.comms_lost_alarm,
    lowVoltage: r.low_voltage_alarm,
  };
}

export type SubLock = ReturnType<typeof toSubLock>;

/**
 * Shape sent to partners. Stable: other systems parse this.
 *
 * Field names are an explicit allowlist. The console's projection carries SIM
 * numbers and a flag for whether a lock still holds its factory password -
 * appropriate for the operator, not for a third party - which is why this is
 * written out by hand rather than spreading a row.
 */
export function toVehicle(r: VehicleRow, subLocks: SubLock[] = []) {
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
    // A cut rope and a locked motor look identical on `locked` alone: the lock
    // reports itself locked because its motor is, while the rope it was
    // securing is no longer through anything.
    ropeInserted: r.rope_inserted,
    mileageKm: r.mileage_km,
    online: r.is_connected,
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    lastPositionAt: r.last_position_at?.toISOString() ?? null,
    // The names of the alarms currently raised, as an array — always present,
    // empty when there are none, so a consumer can iterate without a guard.
    // Stored as an object of flags; only the true ones are ever written.
    alarms: Object.keys(r.active_alarms ?? {}),
    /*
     * The newest lock event of ANY kind, not only an unlock.
     *
     * Named `lastEvent` rather than `lastUnlock` on purpose: `auto_locked` and
     * `rope_pulled_out` arrive here too, and a partner reading an auto-lock as
     * an opening would have the Ministry looking at a valve that never moved.
     * `source` is the raw event name, left in English for a consumer to
     * translate as their own interface requires.
     */
    lastEvent: r.last_event_at
      ? {
          at: r.last_event_at.toISOString(),
          source: r.last_event_source,
          allowed: r.last_event_allowed,
          commandId: r.last_event_command_id,
        }
      : null,
    subLocks,
    /*
     * Flat counts alongside the array, for styling a marker.
     *
     * Nested objects inside GeoJSON `properties` are legal but handled
     * inconsistently by map clients, so the numbers a symbol renderer needs
     * are scalars and the detail stays in the array.
     *
     * Three counts, not two: a sub-lock whose state we cannot read is neither
     * locked nor unlocked, and folding it into either would be the same lie
     * that `locked: null` exists to avoid.
     */
    subLockCount: subLocks.length,
    subLocksLocked: subLocks.filter((s) => s.locked === true).length,
    subLocksUnknown: subLocks.filter((s) => s.locked === null).length,
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

/**
 * Outbound command encoding.
 *
 * Everything the platform sends is ASCII `(Pxx,args)`. Acknowledgements are
 * not optional: an unacknowledged frame is retransmitted by the device
 * indefinitely — the dynamic-password report retries every 60 seconds forever.
 */

/**
 * General acknowledgement for position data, alarms, P45 reports and WLNET,5
 * peripheral data. `serial` is the frame's own serial/event number echoed back.
 */
export function ackData(serial: number): Buffer {
  return cmd(`P69,0,${serial}`);
}

/**
 * Acknowledge a dynamic-password report. Until this is sent the device keeps
 * re-reporting the same password every minute.
 */
export function ackDynamicPassword(password: string): Buffer {
  return cmd(`P52,2,${password}`);
}

/**
 * Answer a device's time-sync request with server UTC, formatted DDMMYYhhmmss.
 *
 * Only takes effect while the device has no GPS fix; once positioned it
 * prefers satellite time and will reject this.
 */
export function timeSync(now: Date = new Date()): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s =
    p(now.getUTCDate()) +
    p(now.getUTCMonth() + 1) +
    p(now.getUTCFullYear() % 100) +
    p(now.getUTCHours()) +
    p(now.getUTCMinutes()) +
    p(now.getUTCSeconds());
  return cmd(`P22,${s}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Remote unlock with the device's static password (factory default 888888). */
export function unlockStatic(password: string): Buffer {
  return cmd(`P43,${password}`);
}

/**
 * Remote unlock with the current dynamic password. Requires P52,1 to be
 * enabled and the platform to hold the latest password reported by the device.
 */
export function unlockDynamic(password: string): Buffer {
  return cmd(`P52,3,${password}`);
}

/** Change the static password. Both new and current are required. */
export function setStaticPassword(newPassword: string, currentPassword: string): Buffer {
  return cmd(`P44,${newPassword},${currentPassword}`);
}

/** Ask for an immediate position + status report. */
export function queryPosition(): Buffer {
  return cmd('P02');
}

/** Firmware version and battery level. */
export function queryFirmware(): Buffer {
  return cmd('P01');
}

/**
 * Continuous tracking: the device stops sleeping and reports constantly.
 * Costs a great deal of battery — enable on dispatch, disable on trip close.
 */
export function setTrackingMode(enabled: boolean): Buffer {
  return cmd(`P54,1,${enabled ? 1 : 0}`);
}

/**
 * Reporting intervals: `awakeSeconds` between reports while awake (5-3600),
 * `sleepMinutes` between RTC wake-ups while asleep (5-1440).
 */
export function setIntervals(awakeSeconds: number, sleepMinutes: number): Buffer {
  return cmd(`P04,1,${awakeSeconds},${sleepMinutes}`);
}

/**
 * Per-channel unlock control. Disabling everything except GPRS forces all
 * unlocks through the platform, where they are authorised and audited — the
 * single most valuable hardening step available for fuel tankers.
 */
export function setUnlockChannels(ch: {
  sms: boolean;
  gprs: boolean;
  rfid: boolean;
  serial: boolean;
  bluetooth: boolean;
}): Buffer {
  const b = (v: boolean) => (v ? 1 : 0);
  return cmd(`P59,1,${b(ch.sms)},${b(ch.gprs)},${b(ch.rfid)},${b(ch.serial)},${b(ch.bluetooth)}`);
}

/** Enable the extended P45 fields (IMEI, fence ID, base-station info). */
export function setP45ExtendedFields(bits: number): Buffer {
  return cmd(`P94,1,${bits}`);
}

/** Remote restart. Takes roughly 30 seconds. */
export function restart(): Buffer {
  return cmd('P15');
}

/**
 * Escape hatch for commands we haven't wrapped. Accepts the body without
 * parentheses, e.g. `raw('P83,1,5')`.
 */
export function raw(body: string): Buffer {
  return cmd(body);
}

function cmd(body: string): Buffer {
  return Buffer.from(`(${body})`, 'latin1');
}

/** Decoded shapes for everything a JT701D/E can send us. */

/** Low nibble of the type byte in a binary frame. */
export const DataType = {
  RealtimePosition: 1,
  Alarm: 2,
  BlindArea: 3,
  SubNewPosition: 4,
} as const;
export type DataTypeValue = (typeof DataType)[keyof typeof DataType];

/**
 * Extended device status bits 0-3. Tells us *why* the device woke up, which is
 * forensically valuable: a truck reporting because its back cover opened is a
 * very different event from an RTC timer tick.
 */
export const WakeSource = {
  0: 'device_restart',
  1: 'rtc_timer',
  2: 'vibration',
  3: 'back_cover_opened',
  4: 'lock_rope_changed',
  5: 'charging',
  6: 'rfid_card',
  7: 'lora',
  8: 'vip_sms',
  9: 'non_vip_sms',
  10: 'bluetooth',
} as const;
export type WakeSourceName = (typeof WakeSource)[keyof typeof WakeSource] | 'unknown';

/** The 2-byte device status field: the entire security state of the lock. */
export interface DeviceStatus {
  // Byte1
  baseStationPositioning: boolean;
  enterFenceAlarm: boolean;
  exitFenceAlarm: boolean;
  ropeCutAlarm: boolean;
  vibrationAlarm: boolean;
  ackRequired: boolean;
  ropeInserted: boolean;
  motorLocked: boolean;
  // Byte2
  longUnlockAlarm: boolean;
  wrongPasswordAlarm: boolean;
  illegalCardAlarm: boolean;
  lowBatteryAlarm: boolean;
  backCoverOpenedAlarm: boolean;
  backCoverClosed: boolean;
  motorStuckAlarm: boolean;
}

/** Extended status 2 — charging plus the JT701E-only compartment covers. */
export interface ExtendedStatus2 {
  charging: boolean;
  upCoverAlarm: boolean;
  upCoverClosed: boolean;
  downCoverAlarm: boolean;
  downCoverClosed: boolean;
}

export interface PositionFrame {
  kind: 'position';
  deviceId: string;
  protocolVersion: string;
  deviceType: number;
  dataType: number;
  /** Blind-area data (type 3): recorded with no coverage, hours old. */
  isHistorical: boolean;
  /**
   * Sub-new data (type 4): the device's recent backlog, delivered LIFO just
   * behind the real-time frames. Seconds old, not history.
   */
  isBacklog: boolean;
  isAlarm: boolean;
  reportedAt: Date;
  latitude: number;
  longitude: number;
  /** GPS fix. When false, lat/lon are stale or base-station derived. */
  positioned: boolean;
  speedKph: number;
  headingDeg: number;
  mileageKm: number;
  satellites: number;
  status: DeviceStatus;
  /**
   * 1-100, or null when the device reports 0xFF meaning "charging".
   * Units with a coulomb counter (PCB >= 2.7.1) report 1-100 even while
   * charging and signal it via extended2.charging instead.
   */
  batteryPercent: number | null;
  charging: boolean;
  cellId: number;
  lac: number;
  gsmSignal: number;
  /** 99 means the device could not see any cellular signal at all. */
  gsmSignalValid: boolean;
  fenceAlarmId: number;
  wakeSource: WakeSourceName;
  extended2: ExtendedStatus2;
  imei: string | null;
  mcc: number | null;
  mnc: number | null;
  /**
   * One byte, wraps at 0xFF, resets on device restart. This is the value to
   * echo in the P69 ack and nothing more — never treat it as a unique key.
   */
  serial: number;
  raw: Buffer;
}

/** P45 event source type. */
export const EventSource = {
  1: 'rfid_authorized',
  2: 'rfid_illegal',
  3: 'vehicle_id_card_bind',
  4: 'remote_static_password',
  5: 'auto_locked',
  6: 'remote_dynamic_password',
  7: 'bluetooth_unlock',
  8: 'rope_pulled_out',
} as const;
export type EventSourceName = (typeof EventSource)[keyof typeof EventSource] | 'unknown';

export interface LockEventFrame {
  kind: 'lock_event';
  deviceId: string;
  reportedAt: Date;
  latitude: number;
  longitude: number;
  positioned: boolean;
  speedKph: number;
  headingDeg: number;
  eventSource: EventSourceName;
  eventSourceCode: number;
  /**
   * Raw verification code. For RFID and dynamic-password unlocks this doubles
   * as a fence result: 1-10 = unlocked inside that fence, 98 = fence check
   * disabled, 99 = REFUSED because the device was outside its fence.
   */
  verificationCode: number;
  unlockAllowed: boolean;
  refusedOutsideFence: boolean;
  rfidCard: string | null;
  passwordCorrect: boolean;
  wrongPasswordCount: number;
  /** Echo this in the P69 ack. */
  eventSerial: number;
  mileageKm: number;
  imei: string | null;
  fenceId: number | null;
  raw: string;
}

export interface HeartbeatFrame {
  kind: 'heartbeat';
  deviceId: string;
  raw: string;
}

export interface TimeSyncRequestFrame {
  kind: 'time_sync_request';
  deviceId: string;
  raw: string;
}

export interface DynamicPasswordFrame {
  kind: 'dynamic_password';
  deviceId: string;
  password: string;
  raw: string;
}

export interface PeripheralFrame {
  kind: 'peripheral';
  deviceId: string;
  /** Protocol version field: JT701D is fixed at 1, JT701T uses 23. */
  protocolVersion: string;
  /**
   * Data serial number, 0-255. Must be echoed in the P69 acknowledgement or
   * the device keeps re-sending the same peripheral data.
   */
  serial: number;
  /** Un-escaped payload, starting at the data-type marker. */
  payload: Buffer;
  raw: string;
}

export interface CommandResponseFrame {
  kind: 'command_response';
  deviceId: string;
  command: string;
  params: string[];
  raw: string;
}

/** A frame we recognised structurally but cannot interpret. */
export interface UnknownFrame {
  kind: 'unknown';
  deviceId: string | null;
  reason: string;
  raw: Buffer;
}

export type DecodedFrame =
  | PositionFrame
  | LockEventFrame
  | HeartbeatFrame
  | TimeSyncRequestFrame
  | DynamicPasswordFrame
  | PeripheralFrame
  | CommandResponseFrame
  | UnknownFrame;

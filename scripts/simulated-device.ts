/**
 * One fake JT701D, as a reusable object.
 *
 * This is the behaviour that used to live directly in simulate-device.ts, moved
 * out so the fleet simulator can run three thousand of them in one process
 * without duplicating any of it. simulate-device.ts is now a thin CLI over this
 * class and behaves exactly as before.
 *
 * Everything a real lock does that matters to the platform is here: position
 * reports on an interval, heartbeats, P43 unlock handling with the P45 report
 * that actually confirms it, and the auto-lock that follows about a minute
 * later. Blind-area buffering is modelled too, because that is what produces
 * the replay bursts the fleet has to survive.
 */

import net from 'node:net';
import { Framer } from '../src/protocol/framer.ts';
import { buildPositionFrame, buildLockEvent } from './build-frames.ts';

/** A rough loop through Tripoli: port area -> city centre -> airport road. */
export const ROUTE: Array<[lat: number, lon: number]> = [
  [32.8925, 13.1802],
  [32.8872, 13.1913],
  [32.879, 13.2035],
  [32.8654, 13.221],
  [32.8412, 13.2388],
  [32.819, 13.2455],
  [32.8412, 13.2388],
  [32.8654, 13.221],
  [32.879, 13.2035],
];

export type SimEventKind =
  | 'connected'
  | 'disconnected'
  | 'position'
  | 'replayed'
  | 'unlock-accepted'
  | 'unlock-rejected'
  | 'auto-locked'
  | 'error';

export interface SimEvent {
  kind: SimEventKind;
  deviceId: string;
  detail?: string;
  /** Frames flushed, for a `replayed` event. */
  count?: number;
}

export interface SimulatedDeviceOptions {
  deviceId: string;
  host: string;
  port: number;
  /** Reporting interval while awake. */
  intervalMs?: number;
  /** The static unlock password this device will accept. */
  password?: string;
  /**
   * Start this device partway around the route, so a fleet does not drive in
   * one stack.
   */
  routeOffset?: number;
  /** Per-frame console output. Off for a fleet; on for a single device. */
  verbose?: boolean;
  onEvent?: (e: SimEvent) => void;
}

export class SimulatedDevice {
  readonly deviceId: string;
  #opts: Required<Omit<SimulatedDeviceOptions, 'onEvent'>> & { onEvent?: (e: SimEvent) => void };
  #socket: net.Socket | null = null;
  #framer = new Framer();

  #step: number;
  #serial = 0;
  #mileage = 1200;
  #battery = 87;
  #motorLocked = true;
  #ropeInserted = true;
  #autoLockTimer: NodeJS.Timeout | null = null;
  #reportTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  /**
   * Frames generated while out of coverage. A real lock stores these and
   * delivers them on reconnect; replaying them is the burst the platform has to
   * absorb.
   */
  #blindArea = false;
  #buffered: Buffer[] = [];

  constructor(options: SimulatedDeviceOptions) {
    this.deviceId = options.deviceId;
    this.#opts = {
      deviceId: options.deviceId,
      host: options.host,
      port: options.port,
      intervalMs: options.intervalMs ?? 10_000,
      password: options.password ?? '888888',
      routeOffset: options.routeOffset ?? 0,
      verbose: options.verbose ?? false,
      onEvent: options.onEvent,
    };
    this.#step = this.#opts.routeOffset;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  get bufferedFrames(): number {
    return this.#buffered.length;
  }

  connect(): void {
    if (this.#stopped) return;

    const socket = net.createConnection({ host: this.#opts.host, port: this.#opts.port }, () => {
      this.#emit('connected');
      this.#log(`connected to ${this.#opts.host}:${this.#opts.port}`);

      // Anything buffered while out of coverage goes first, all at once. This
      // is deliberately not paced: the point is to reproduce the burst.
      this.#flushBuffered();
      this.#startReporting();

      // As the device does when its reporting interval exceeds 80s.
      this.#heartbeatTimer ??= setInterval(() => {
        this.#send(Buffer.from(`(${this.deviceId},@JT)`, 'latin1'), { bufferable: false });
      }, 60_000);
    });

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => {
      this.#emit('error', err.message);
      this.#log(`error ${err.message}`, true);
    });
    socket.on('close', () => {
      // Only the heartbeat stops. Position reporting deliberately continues
      // while the socket is down: a lock out of coverage keeps taking fixes and
      // stores them, and those stored frames are the replay burst. Clearing the
      // report timer here would mean a blind area generated nothing to replay,
      // which is the opposite of what a blind area does.
      if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
      this.#emit('disconnected');
      this.#log('disconnected');
    });

    this.#socket = socket;
  }

  /** Simulate driving out of coverage: frames are generated but held. */
  enterBlindArea(): void {
    this.#blindArea = true;
    this.#socket?.destroy();
  }

  /** Back in coverage: reconnect and dump everything buffered. */
  leaveBlindArea(): void {
    this.#blindArea = false;
    this.connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#socket?.destroy();
  }

  report(): void {
    const [lat, lon] = this.#here();
    const [nextLat, nextLon] = ROUTE[(this.#step + 1) % ROUTE.length]!;
    const heading = (Math.atan2(nextLon - lon, nextLat - lat) * 180) / Math.PI;
    const speedKph = this.#motorLocked ? 42 + Math.round(Math.random() * 18) : 0;

    this.#send(
      buildPositionFrame({
        deviceId: this.deviceId,
        lat,
        lon,
        speedKph,
        headingDeg: (heading + 360) % 360,
        mileageKm: this.#mileage,
        batteryPercent: this.#battery,
        motorLocked: this.#motorLocked,
        ropeInserted: this.#ropeInserted,
        serial: this.#nextSerial(),
        // Buffered frames are reported as blind-area data, which is what a real
        // device does and what the gateway's replay handling keys on.
        dataType: this.#blindArea ? 3 : 1,
      }),
    );

    this.#emit('position');
    this.#log(
      `position ${lat.toFixed(5)},${lon.toFixed(5)} ${speedKph}km/h ` +
        `battery ${this.#battery}% ${this.#motorLocked ? 'locked' : 'UNLOCKED'}`,
    );

    this.#step++;
    this.#mileage += 1;
    if (this.#step % 20 === 0 && this.#battery > 5) this.#battery--;
  }

  // --- internals ----------------------------------------------------------

  #nextSerial(): number {
    return (this.#serial = (this.#serial + 1) & 0xff);
  }

  #here(): [number, number] {
    return ROUTE[this.#step % ROUTE.length]!;
  }

  /**
   * Write, or hold the frame if we are out of coverage. Heartbeats are not
   * bufferable — a real device has nothing to say about a heartbeat it missed.
   */
  #send(frame: Buffer, opts: { bufferable?: boolean } = {}): void {
    if (this.#blindArea || !this.connected) {
      if (opts.bufferable !== false) this.#buffered.push(frame);
      return;
    }
    this.#socket!.write(frame);
  }

  #flushBuffered(): void {
    if (this.#buffered.length === 0) return;
    const count = this.#buffered.length;
    for (const frame of this.#buffered) this.#socket!.write(frame);
    this.#buffered = [];
    this.#emit('replayed', undefined, count);
    this.#log(`replayed ${count} buffered frame(s)`);
  }

  /**
   * Platform -> device frames carry NO device id: `(P43,888888)`, not
   * `(8000620011,P43,...)`. The protocol decoder is built for the device ->
   * platform direction and rejects them, so parse the raw text here instead.
   */
  #onData(chunk: Buffer): void {
    for (const raw of this.#framer.push(chunk)) {
      if (raw.type !== 'ascii') continue;
      const text = raw.bytes.toString('latin1');
      const body = text.slice(1, -1);
      const [command, ...args] = body.split(',');

      if (command === 'P69') continue; // data acknowledgement, nothing to do
      this.#log(`<- ${text}`);

      switch (command) {
        case 'P43': {
          const ok = args[0] === this.#opts.password;
          this.#emit(ok ? 'unlock-accepted' : 'unlock-rejected');
          this.#log(`unlock ${ok ? 'ACCEPTED' : 'REJECTED'} (password ${args[0]})`);
          if (ok) {
            this.#motorLocked = false;
            this.#ropeInserted = false;
          }
          // Real firmware reports the outcome immediately after acting. That
          // report, not the socket write, is what confirms the command.
          setTimeout(() => this.#sendLockEvent(4, ok), 800);
          if (ok) this.#scheduleAutoLock();
          break;
        }

        case 'P02':
          this.report();
          break;

        case 'P22':
          this.#log(`time synced to ${args[0]}`);
          break;

        default:
          this.#log(`(no handler for ${command})`);
      }
    }
  }

  #sendLockEvent(sourceCode: number, allowed: boolean): void {
    if (this.#stopped) return;
    const [lat, lon] = this.#here();
    this.#send(
      buildLockEvent({
        deviceId: this.deviceId,
        lat,
        lon,
        sourceCode,
        allowed,
        serial: this.#nextSerial(),
        mileageKm: this.#mileage,
      }),
    );
  }

  /** The device auto-locks if the rope is not pulled within the configured time. */
  #scheduleAutoLock(): void {
    if (this.#autoLockTimer) clearTimeout(this.#autoLockTimer);
    this.#autoLockTimer = setTimeout(() => {
      this.#motorLocked = true;
      this.#ropeInserted = true;
      this.#sendLockEvent(5, false);
      this.#emit('auto-locked');
      this.#log('auto-locked');
    }, 60_000);
  }

  /** Runs from the first connect until stop(), across disconnections. */
  #startReporting(): void {
    if (this.#reportTimer) return;
    this.report();
    this.#reportTimer = setInterval(() => this.report(), this.#opts.intervalMs);
  }

  #clearTimers(): void {
    for (const t of [this.#reportTimer, this.#heartbeatTimer, this.#autoLockTimer]) {
      if (t) clearInterval(t as NodeJS.Timeout);
    }
    this.#reportTimer = this.#heartbeatTimer = this.#autoLockTimer = null;
  }

  #emit(kind: SimEventKind, detail?: string, count?: number): void {
    this.#opts.onEvent?.({ kind, deviceId: this.deviceId, detail, count });
  }

  #log(message: string, isError = false): void {
    if (!this.#opts.verbose) return;
    const line = `[sim ${this.deviceId}] ${message}`;
    if (isError) console.error(line);
    else console.log(line);
  }
}

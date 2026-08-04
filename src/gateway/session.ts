/**
 * One DeviceSession per open socket.
 *
 * A session starts anonymous: the socket carries no identity until the first
 * frame arrives with a device ID in it. Until then we cannot dispatch commands
 * to it, which is why the registry is keyed on device ID rather than socket.
 */

import type { Socket } from 'node:net';
import { Framer, decodeFrame, encode, type DecodedFrame } from '../protocol/index.ts';
import { config } from '../config.ts';
import * as store from './store.ts';

export interface SessionEvents {
  onIdentified(deviceId: string, session: DeviceSession): void;
  onClosed(deviceId: string | null, session: DeviceSession): void;
}

export class DeviceSession {
  readonly socket: Socket;
  readonly remoteIp: string;
  #framer = new Framer();
  #deviceId: string | null = null;
  #known = false;
  #events: SessionEvents;

  constructor(socket: Socket, events: SessionEvents) {
    this.socket = socket;
    this.remoteIp = socket.remoteAddress ?? 'unknown';
    this.#events = events;

    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(config.gateway.idleTimeoutMs);

    socket.on('data', (chunk: Buffer) => void this.#onData(chunk));
    socket.on('timeout', () => {
      this.log('idle timeout, closing');
      socket.destroy();
    });
    socket.on('error', (err) => this.log(`socket error: ${err.message}`));
    socket.on('close', () => void this.#onClose());
  }

  get deviceId(): string | null {
    return this.#deviceId;
  }

  get isIdentified(): boolean {
    return this.#deviceId !== null && this.#known;
  }

  send(payload: Buffer | string): boolean {
    if (this.socket.destroyed) return false;
    const buf = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
    return this.socket.write(buf);
  }

  async #onData(chunk: Buffer): Promise<void> {
    let frames;
    try {
      frames = this.#framer.push(chunk);
    } catch (err) {
      this.log(`framing error: ${(err as Error).message}`);
      return;
    }

    for (const raw of frames) {
      let decoded: DecodedFrame;
      try {
        decoded = decodeFrame(raw);
      } catch (err) {
        this.log(`decode error: ${(err as Error).message}`);
        await store.recordRejectedFrame(this.#deviceId, `decode error: ${(err as Error).message}`, this.remoteIp, raw.bytes);
        continue;
      }

      try {
        await this.#handle(decoded, raw.bytes);
      } catch (err) {
        console.error(`[gateway] handler failed for ${this.#deviceId ?? '?'}:`, err);
      }
    }
  }

  async #handle(frame: DecodedFrame, rawBytes: Buffer): Promise<void> {
    if (frame.kind === 'unknown') {
      await store.recordRejectedFrame(frame.deviceId, frame.reason, this.remoteIp, rawBytes);
      return;
    }

    // Bind the socket to a device on first sight, and check the allowlist.
    if (this.#deviceId === null) {
      this.#deviceId = frame.deviceId;
      this.#known = config.requireKnownDevice ? await store.isKnownDevice(frame.deviceId) : true;

      if (!this.#known) {
        // No authentication exists in this protocol, so an unrecognised device
        // ID is the only signal we get that something is wrong. Log and drop.
        this.log('unknown device id, refusing session');
        await store.recordRejectedFrame(frame.deviceId, 'device not in allowlist', this.remoteIp, rawBytes);
        this.socket.destroy();
        return;
      }

      await store.setConnected(frame.deviceId, true);
      this.log('identified');
      this.#events.onIdentified(frame.deviceId, this);
    } else if (frame.deviceId !== this.#deviceId) {
      // One socket must carry one device. A change mid-stream means either a
      // corrupt frame or someone splicing traffic.
      await store.recordRejectedFrame(
        frame.deviceId,
        `device id changed mid-session (was ${this.#deviceId})`,
        this.remoteIp,
        rawBytes,
      );
      return;
    }

    if (!this.#known) return;

    switch (frame.kind) {
      case 'position': {
        const isNew = await store.insertPosition(frame);
        // Historical replays must not clobber the live snapshot.
        if (!frame.isHistorical) await store.updateDeviceState(frame);
        // Ack regardless: the device re-sends until acknowledged, and a
        // duplicate we already hold is still a frame it wants cleared.
        this.send(encode.ackData(frame.serial));
        if (isNew && frame.isAlarm) {
          await store.audit('alarm_received', frame.deviceId, {
            alarms: Object.entries(frame.status).filter(([k, v]) => v && k.endsWith('Alarm')).map(([k]) => k),
            at: frame.reportedAt,
          });
        }
        break;
      }

      case 'lock_event': {
        const id = await store.insertLockEvent(frame);
        this.send(encode.ackData(frame.eventSerial));
        if (id !== null) {
          await store.confirmCommandFromEvent(frame.deviceId, id, frame.eventSourceCode);
          await store.audit('lock_event', frame.deviceId, {
            source: frame.eventSource,
            unlockAllowed: frame.unlockAllowed,
            refusedOutsideFence: frame.refusedOutsideFence,
            rfidCard: frame.rfidCard,
            at: frame.reportedAt,
          });
        }
        break;
      }

      case 'dynamic_password':
        await store.recordDynamicPassword(frame.deviceId, frame.password);
        // Without this ack the device re-reports every 60 seconds forever.
        this.send(encode.ackDynamicPassword(frame.password));
        break;

      case 'time_sync_request':
        this.send(encode.timeSync());
        break;

      case 'heartbeat':
        await store.touchLastSeen(frame.deviceId);
        break;

      case 'peripheral':
        // Sub-lock and sensor payloads. Acknowledge so the device stops
        // retrying; decoding awaits the JT709/JT126 integration manual.
        await store.audit('peripheral_data', frame.deviceId, {
          bytes: frame.payload.length,
          hex: frame.payload.toString('hex').slice(0, 512),
        });
        break;

      case 'command_response':
        this.log(`response ${frame.command}: ${frame.params.join(',')}`);
        await store.audit('command_response', frame.deviceId, {
          command: frame.command,
          params: frame.params,
        });
        break;
    }
  }

  /** Send anything queued for this device. Called on connect and on NOTIFY. */
  async drainCommands(): Promise<void> {
    if (!this.isIdentified || this.socket.destroyed) return;
    const pending = await store.claimPendingCommands(this.#deviceId!);

    for (const cmd of pending) {
      const ok = this.send(cmd.payload);
      if (ok) {
        await store.markCommandSent(cmd.id);
        // 'sent' is not 'confirmed' — only the device's own P45 closes an unlock.
        await store.audit('command_sent', cmd.device_id, { type: cmd.command_type, payload: cmd.payload }, cmd.id);
        this.log(`sent ${cmd.command_type}: ${cmd.payload}`);
      } else {
        await store.markCommandFailed(cmd.id, 'socket write failed');
      }
    }
  }

  async #onClose(): Promise<void> {
    if (this.#deviceId && this.#known) {
      await store.setConnected(this.#deviceId, false).catch(() => {});
    }
    this.log('closed');
    this.#events.onClosed(this.#deviceId, this);
  }

  log(msg: string): void {
    console.log(`[gateway] ${this.#deviceId ?? this.remoteIp} ${msg}`);
  }
}

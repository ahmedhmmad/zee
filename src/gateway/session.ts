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
import { checkArrivalUnlocks } from './arrivals.ts';
import { decodePeripheralPayload } from '../protocol/decode-peripheral.ts';

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
  #handshakeTimer: NodeJS.Timeout | null = null;

  constructor(socket: Socket, events: SessionEvents) {
    this.socket = socket;
    this.remoteIp = socket.remoteAddress ?? 'unknown';
    this.#events = events;

    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(config.gateway.idleTimeoutMs);

    // Drop connections that never send a frame. Scanners hit an open port
    // constantly; without this every one of them lingers and logs.
    this.#handshakeTimer = setTimeout(() => {
      if (this.#deviceId === null) socket.destroy();
    }, config.gateway.handshakeTimeoutMs);

    socket.on('data', (chunk: Buffer) => void this.#onData(chunk));
    socket.on('timeout', () => {
      this.log('idle timeout, closing');
      socket.destroy();
    });
    socket.on('error', (err) => this.log(`socket error: ${err.message}`, true));
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
      if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
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
        // Only act on positions we have not seen before, so a duplicate
        // delivery cannot re-trigger an arrival.
        if (isNew) {
          for (const hit of await checkArrivalUnlocks(frame)) {
            this.log(`ARRIVAL "${hit.name}" — ${hit.distanceM}m — unlock queued (cmd ${hit.commandId})`);
          }
        }
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
          await store.linkEventToCommand(
            frame.deviceId,
            id,
            frame.eventSourceCode,
            frame.unlockAllowed,
          );
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

      case 'peripheral': {
        // Peripheral data is acknowledged exactly like position data. Without
        // this the device re-sends the same payload every 35 seconds forever,
        // burning its battery and the sub-lock's.
        this.send(encode.ackData(frame.serial));

        const decoded = decodePeripheralPayload(frame.payload);
        if (!decoded) {
          // Keep the bytes: an undecodable payload is the raw material for
          // working out what changed in a firmware or a new peripheral type.
          await store.audit('peripheral_undecodable', frame.deviceId, {
            bytes: frame.payload.length,
            hex: frame.payload.toString('hex').slice(0, 512),
          });
          break;
        }
        await store.recordPeripheralReading(frame.deviceId, decoded);
        this.log(
          `peripheral ${decoded.peripheralId} (${decoded.deviceType}) ` +
            `battery ${decoded.batteryPercent}% ${decoded.voltage}V rssi ${decoded.rssi} ` +
            `status 0x${decoded.statusCode.toString(16).padStart(2, '0')}`,
        );
        if (decoded.ropeCutAlarm) {
          this.log(`SUB-LOCK ROPE CUT ALARM — ${decoded.peripheralId}`);
          await store.audit('sub_lock_rope_cut', frame.deviceId, {
            peripheralId: decoded.peripheralId,
          });
        }
        break;
      }

      case 'command_response': {
        this.log(`response ${frame.command}: ${frame.params.join(',')}`);
        await store.audit('command_response', frame.deviceId, {
          command: frame.command,
          params: frame.params,
        });

        // The response is the authority on whether a command was accepted.
        //   P43   -> success, wrongCount
        //   P52,3 -> commandId, success, wrongCount
        // Everything else is a query, and answering at all means it worked.
        const isStatic = frame.command === 'P43';
        const isDynamic = frame.command === 'P52' && frame.params[0] === '3';

        // P01 answers "<firmware string>,<battery>%" — worth keeping on the
        // device record: it determines which commands the unit supports.
        if (frame.command === 'P01' && frame.params[0]) {
          await store.recordFirmware(frame.deviceId, frame.params[0]);
        }

        // A P44 that answers "1" is the device confirming it accepted a new
        // password; "0" means it refused, almost always because the current
        // password we hold is wrong. (A P44 QUERY answers with the password
        // itself, six characters, so the three cannot be confused.)
        let ok = true;
        if (frame.command === 'P44' && frame.params[0] === '1') {
          const adopted = await store.promotePendingPassword(frame.deviceId);
          if (adopted) {
            this.log('password rotated and adopted');
            await store.audit('password_rotated', frame.deviceId, {});
          }
        } else if (frame.command === 'P44' && frame.params[0] === '0') {
          // Was previously recorded as success, because only unlocks had their
          // response inspected. A failed rotation showing as confirmed is
          // worse than useless: it says the password changed when it did not.
          ok = false;
          this.log('PASSWORD CHANGE REFUSED — the current password we hold is wrong');
          await store.audit('password_rotation_refused', frame.deviceId, {});
        }

        if (isStatic || isDynamic) {
          const success = isStatic ? frame.params[0] : frame.params[1];
          const wrongCount = isStatic ? frame.params[1] : frame.params[2];
          ok = success === '1';
          if (ok) {
            // The device auto-locks about a minute from now, while asleep, and
            // would never report it. Schedule a state refresh so the console
            // does not sit showing "open" for a lock that has closed.
            await store.queueLockStateRefresh(frame.deviceId);
          }
          if (!ok) {
            // Five consecutive failures trips an alarm on the device itself.
            this.log(`UNLOCK REFUSED — ${wrongCount ?? '?'} consecutive wrong passwords`);
            await store.audit('unlock_refused', frame.deviceId, { wrongCount });
          }
        }

        await store.resolveCommandFromResponse(
          frame.deviceId,
          frame.command,
          ok,
          frame.params.join(','),
        );
        break;
      }
    }
  }

  /** Send anything queued for this device. Called on connect and on NOTIFY. */
  async drainCommands(): Promise<void> {
    if (!this.isIdentified || this.socket.destroyed) return;
    const pending = await store.claimPendingCommands(this.#deviceId!);

    // Already marked 'sent' by the claim, so a concurrent drain cannot pick
    // them up again. Only the failure path needs correcting here.
    for (const cmd of pending) {
      if (this.send(cmd.payload)) {
        // 'sent' is not 'confirmed' — only the device's own response closes it.
        await store.audit('command_sent', cmd.device_id, { type: cmd.command_type, payload: cmd.payload }, cmd.id);
        this.log(`sent ${cmd.command_type}: ${cmd.payload}`);
      } else {
        await store.markCommandFailed(cmd.id, 'socket write failed');
      }
    }
  }

  async #onClose(): Promise<void> {
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    if (this.#deviceId && this.#known) {
      await store.setConnected(this.#deviceId, false).catch(() => {});
    }
    this.log('closed', true);
    this.#events.onClosed(this.#deviceId, this);
  }

  /**
   * `quietIfAnonymous` suppresses the message for sockets that never sent a
   * frame. Those are almost always port scanners, and logging both an error
   * and a close for each one buries the device you are trying to watch.
   */
  log(msg: string, quietIfAnonymous = false): void {
    if (quietIfAnonymous && this.#deviceId === null) return;
    console.log(`[gateway] ${this.#deviceId ?? this.remoteIp} ${msg}`);
  }
}

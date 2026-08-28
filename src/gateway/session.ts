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

/**
 * What became of a write. See `DeviceSession.send`.
 *
 * `backpressured` exists so that "the socket asked us to slow down" can never
 * again be recorded as "the command failed".
 */
export type WriteOutcome = 'sent' | 'backpressured' | 'failed';

/**
 * Command types whose payload carries credential material on the wire.
 *
 * The payload has to contain the password to work — that is the protocol — but
 * nothing that keeps a copy of it needs to. The queue stores placeholders and
 * the audit log stores this redaction.
 */
const CREDENTIAL_BEARING = new Set(['unlock_static', 'unlock_dynamic', 'set_password']);

/**
 * What to record about a payload, rather than the payload.
 *
 * Keeps the command word, which is what makes an audit row useful when reading
 * back what happened, and drops everything after it.
 */
export function redactPayload(commandType: string, payload: string): string {
  if (!CREDENTIAL_BEARING.has(commandType)) return payload;
  const word = /^\((P\d+)/.exec(payload)?.[1];
  return word ? `(${word},<redacted>)` : '<redacted>';
}

/**
 * The registry's side of the session's lifecycle.
 *
 * `onIdentified` both admits and registers, and it is asynchronous, because
 * admission is a database round trip that also records the device as connected
 * — one statement instead of two, and it keeps every write to is_connected
 * inside the registry where the ownership rule can be enforced.
 */
export interface SessionEvents {
  /** False means the device is not on the allowlist; the session drops it. */
  onIdentified(deviceId: string, session: DeviceSession): Promise<boolean>;
  onClosed(deviceId: string | null, session: DeviceSession): void;
}

/**
 * Everything the session reaches the database through.
 *
 * Injected rather than imported directly so the session can be driven in a test
 * without a database. `test/` covers the protocol codec and nothing else today;
 * the concurrency and command-lifecycle work needs to assert on what the
 * session *does* — how many times it identifies, in what order it persists,
 * whether it marks a command failed — and none of that is reachable while the
 * store is a module-level import.
 *
 * Defaults to the real modules, so production construction is unchanged.
 */
export interface SessionDeps {
  store: typeof store;
  checkArrivalUnlocks: typeof checkArrivalUnlocks;
}

const defaultDeps: SessionDeps = { store, checkArrivalUnlocks };

export class DeviceSession {
  readonly socket: Socket;
  readonly remoteIp: string;
  #framer = new Framer();
  #deviceId: string | null = null;
  #known = false;
  #events: SessionEvents;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #lastInboundAt = Date.now();
  #inboundWatchdog: NodeJS.Timeout | null = null;
  #store: SessionDeps['store'];
  #checkArrivals: SessionDeps['checkArrivalUnlocks'];
  /** Serialises inbound chunks. See the 'data' handler in the constructor. */
  #processing: Promise<void> = Promise.resolve();
  #inFlight = 0;
  /** Replay admission window. See `#admitReplay`. */
  #replayWindowStart = 0;
  #replayInWindow = 0;

  constructor(socket: Socket, events: SessionEvents, deps: SessionDeps = defaultDeps) {
    this.socket = socket;
    this.remoteIp = socket.remoteAddress ?? 'unknown';
    this.#events = events;
    this.#store = deps.store;
    this.#checkArrivals = deps.checkArrivalUnlocks;

    socket.setKeepAlive(true, 60_000);

    /*
     * Watch INBOUND silence, not socket idleness.
     *
     * Node resets socket.setTimeout on any activity, writes included. So a
     * device that has gone away is kept "alive" by our own retries: a command
     * re-sent every minute against a three-minute timeout means the timeout can
     * never fire, and the console shows a truck as connected indefinitely
     * while it is actually asleep or out of coverage.
     *
     * Only the device saying something proves the device is there.
     */
    socket.setTimeout(config.gateway.idleTimeoutMs);
    this.#inboundWatchdog = setInterval(() => {
      if (Date.now() - this.#lastInboundAt > config.gateway.idleTimeoutMs) {
        this.log('no inbound data, closing stale connection');
        socket.destroy();
      }
    }, 15_000);
    this.#inboundWatchdog.unref();

    // Drop connections that never send a frame. Scanners hit an open port
    // constantly; without this every one of them lingers and logs.
    this.#handshakeTimer = setTimeout(() => {
      if (this.#deviceId === null) socket.destroy();
    }, config.gateway.handshakeTimeoutMs);

    /*
     * One chunk at a time, in arrival order, with the socket paused while a
     * chunk is in flight.
     *
     * This used to be `void this.#onData(chunk)` — fired and not awaited. Under
     * any database latency two chunks from the same socket then ran
     * concurrently: both could observe `#deviceId === null` and identify the
     * same device twice, and frames persisted in whatever order their queries
     * happened to finish. At two devices that is invisible. At three thousand,
     * with a pool of ten, it is the normal case.
     *
     * Pausing also gives the socket real TCP backpressure, which is what makes
     * a slow database slow the devices down instead of queueing frames in this
     * process's memory.
     */
    socket.on('data', (chunk: Buffer) => {
      this.#inFlight++;
      socket.pause();
      this.#processing = this.#processing
        .then(() => this.#onData(chunk))
        .catch((err) => {
          console.error(`[gateway] data handler failed for ${this.#deviceId ?? '?'}:`, err);
        })
        // The resume MUST happen even when the parse threw. An unguarded
        // resume left a socket paused forever on any error: the device stays
        // connected, keeps sending, and nothing is ever read — it looks alive
        // while being deaf, which nothing detects. Worse than a disconnect.
        .finally(() => {
          if (--this.#inFlight === 0 && !socket.destroyed) socket.resume();
        });
    });
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

  /**
   * Put bytes on the socket, and say honestly what happened to them.
   *
   * Three outcomes, not two, because the boolean this used to return collapsed
   * a distinction that matters on a fuel tanker:
   *
   * - `sent` — accepted by the kernel.
   * - `backpressured` — `write()` returned false. The bytes ARE queued and will
   *   go out; false is the socket asking us to slow down, not a failure. Under
   *   load this is the common case, and recording it as a failure is how an
   *   unlock that reached the truck ended up in the database as one that did
   *   not — and then fed the repeated-failure lockout.
   * - `failed` — the socket is gone, or the write threw. Nothing went out.
   *
   * A pre-write `destroyed` check is not enough on its own: the socket can be
   * torn down around the write, so the throw is caught here too. An error
   * surfaced asynchronously is handled at the call site.
   */
  send(payload: Buffer | string, onLateError?: (err: Error) => void): WriteOutcome {
    if (this.socket.destroyed) return 'failed';
    const buf = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
    try {
      const written = this.socket.write(buf, (err) => {
        if (err) onLateError?.(err);
      });
      return written ? 'sent' : 'backpressured';
    } catch (err) {
      this.log(`write failed: ${(err as Error).message}`, true);
      return 'failed';
    }
  }

  /**
   * Wait for the socket to drain before writing again.
   *
   * Bounded, because this is awaited inside the fleet sweep: a socket that
   * never drains — a truck that has driven out of coverage without the TCP
   * connection noticing — would otherwise stall every device behind it. On
   * timeout the rest of this device's queue waits for the next pass, which is
   * the right outcome: it is not reachable anyway.
   */
  async #awaitDrain(timeoutMs = 5_000): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.socket.off('drain', done);
        this.socket.off('close', done);
        this.socket.off('error', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.socket.once('drain', done);
      this.socket.once('close', done);
      this.socket.once('error', done);
    });
  }

  /**
   * Hold one device's replayed backlog to a bounded rate.
   *
   * The JT701D buffers positions while out of coverage and dumps them on
   * reconnect: four hours of gap is 480 frames, and a regional outage returning
   * two hundred trucks at once is ninety-six thousand. Without a limit, one
   * truck's backlog occupies the connection pool and the trucks reporting live
   * — the ones somebody is actually watching — wait behind it.
   *
   * Per session, so it throttles the device doing the dumping and nobody else.
   * Waits out the rest of the window rather than dropping anything: replayed
   * positions are real history and are not discarded, only slowed.
   */
  async #admitReplay(): Promise<void> {
    const limit = config.gateway.replayFramesPerSecond;
    if (limit <= 0) return;

    const now = Date.now();
    if (now - this.#replayWindowStart >= 1000) {
      this.#replayWindowStart = now;
      this.#replayInWindow = 0;
    }

    if (++this.#replayInWindow > limit) {
      const wait = 1000 - (now - this.#replayWindowStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#replayWindowStart = Date.now();
      this.#replayInWindow = 1;
    }
  }

  async #onData(chunk: Buffer): Promise<void> {
    // Proof of life, recorded before any parsing: even a frame we cannot decode
    // means the device is still on the other end.
    this.#lastInboundAt = Date.now();

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
        await this.#store.recordRejectedFrame(this.#deviceId, `decode error: ${(err as Error).message}`, this.remoteIp, raw.bytes);
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
      await this.#store.recordRejectedFrame(frame.deviceId, frame.reason, this.remoteIp, rawBytes);
      return;
    }

    // Bind the socket to a device on first sight, and check the allowlist.
    if (this.#deviceId === null) {
      if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
      this.#deviceId = frame.deviceId;

      // Admission is the registry's call, and one round trip: it checks the
      // allowlist and records the device as connected in the same statement.
      // The session does not write is_connected itself — see the ownership
      // invariant in index.ts. A session writing its own connection state is
      // how a superseded socket's close handler came to mark a live truck
      // offline.
      const allowlisted = await this.#events.onIdentified(frame.deviceId, this);
      // With the allowlist disabled the gateway accepts anything, which is what
      // makes the simulator usable in development. It is the only
      // authentication the protocol has, so it stays on everywhere else.
      this.#known = config.requireKnownDevice ? allowlisted : true;

      if (!this.#known) {
        // No authentication exists in this protocol, so an unrecognised device
        // ID is the only signal we get that something is wrong. Log and drop.
        this.log('unknown device id, refusing session');
        await this.#store.recordRejectedFrame(frame.deviceId, 'device not in allowlist', this.remoteIp, rawBytes);
        this.socket.destroy();
        return;
      }

      this.log('identified');
      // Devices sleep, so this is usually the only moment we can reach them.
      // Not awaited: the queued commands go out alongside the handling of this
      // frame rather than delaying its ack behind them.
      void this.drainCommands();
    } else if (frame.deviceId !== this.#deviceId) {
      // One socket must carry one device. A change mid-stream means either a
      // corrupt frame or someone splicing traffic.
      await this.#store.recordRejectedFrame(
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
        /*
         * Ack FIRST, before either write.
         *
         * The device re-sends until acknowledged. With the ack behind two
         * awaited round trips against a pool of ten, database latency produced
         * retransmits, retransmits produced more database load, and that
         * produced more latency — a feedback loop that engages exactly when
         * the pool is already saturated. A statement timeout does not help: it
         * bounds one query, and does nothing about a loop whose output is more
         * inbound frames.
         *
         * Safe on this codebase's own terms. insertPosition is idempotent on
         * (device_id, reported_at, serial), so a frame acked and then lost to a
         * crash is re-delivered by blind-area replay and inserted once. The
         * durability being traded away is a few seconds of positions on a hard
         * crash; what is bought is the gateway not amplifying its own overload.
         *
         * A duplicate we already hold is still a frame the device wants
         * cleared, so this is unconditional.
         */
        this.send(encode.ackData(frame.serial));

        // One truck returning from a four-hour coverage gap has 480 buffered
        // frames to dump. Held to a rate here so it cannot take the whole pool
        // and stall the trucks that are reporting live. The socket is paused
        // while this waits, so the throttle reaches the device as real TCP
        // backpressure rather than piling frames up in this process.
        if (frame.isHistorical || frame.isBacklog) await this.#admitReplay();

        const isNew = await this.#store.insertPosition(frame);
        // Blind-area data counts too. It arrives late, but it is still the
        // truck's real position at the time it was taken - and a vehicle that
        // drives through a coverage gap would otherwise sit frozen on the map
        // even after its positions reach us.
        //
        // Ordering is safe: updateDeviceState only accepts a report newer than
        // the one it holds, so a replay of old data cannot rewind the present.
        await this.#store.updateDeviceState(frame);
        // Only act on positions we have not seen before, so a duplicate
        // delivery cannot re-trigger an arrival.
        if (isNew) {
          for (const hit of await this.#checkArrivals(frame)) {
            this.log(
              `ARRIVAL "${hit.name}" — ${hit.distanceM}m — unlock queued (cmd ${hit.commandId})` +
                (hit.subLocks ? ` + ${hit.subLocks} sub-lock(s)` : ''),
            );
          }
        }
        if (isNew && frame.isAlarm) {
          await this.#store.audit('alarm_received', frame.deviceId, {
            alarms: Object.entries(frame.status).filter(([k, v]) => v && k.endsWith('Alarm')).map(([k]) => k),
            at: frame.reportedAt,
          });
        }
        break;
      }

      case 'lock_event': {
        // Deliberately NOT acked first, unlike a position. A lock event is the
        // only physical evidence that a valve moved, and it now carries a
        // command's proof of execution. It is a handful of rows per device per
        // day, so persisting before acking costs nothing worth counting and the
        // durability is worth having.
        const id = await this.#store.insertLockEvent(frame);
        this.send(encode.ackData(frame.eventSerial));
        if (id !== null) {
          const evidenced = await this.#store.linkEventToCommand(
            frame.deviceId,
            id,
            frame.eventSourceCode,
            frame.unlockAllowed,
          );
          if (evidenced !== null) this.log(`lock event ${id} evidences command ${evidenced}`);
          await this.#store.audit('lock_event', frame.deviceId, {
            source: frame.eventSource,
            unlockAllowed: frame.unlockAllowed,
            refusedOutsideFence: frame.refusedOutsideFence,
            rfidCard: frame.rfidCard,
            at: frame.reportedAt,
            // null here means the platform could not tell which command this
            // belongs to — not that no command caused it.
            commandId: evidenced,
          });
        }
        break;
      }

      case 'dynamic_password':
        await this.#store.recordDynamicPassword(frame.deviceId, frame.password);
        // Without this ack the device re-reports every 60 seconds forever.
        this.send(encode.ackDynamicPassword(frame.password));
        break;

      case 'time_sync_request':
        this.send(encode.timeSync());
        break;

      case 'heartbeat':
        await this.#store.touchLastSeen(frame.deviceId);
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
          await this.#store.audit('peripheral_undecodable', frame.deviceId, {
            bytes: frame.payload.length,
            hex: frame.payload.toString('hex').slice(0, 512),
          });
          break;
        }
        const readingId = await this.#store.recordPeripheralReading(frame.deviceId, decoded);

        // The sub-lock reporting itself open is the only real evidence a
        // valve unlock worked: the WLNET,8 response is a bare echo from the
        // master with no success flag in it.
        //
        // Only a reading we have not seen before counts. A duplicate carries
        // no new evidence, and confirming from one would stamp today's time on
        // a report the device made an hour ago.
        if (decoded.locked === false && readingId !== null) {
          const confirmed = await this.#store.confirmSubLockUnlock(
            frame.deviceId,
            decoded.peripheralId,
            readingId,
          );
          if (confirmed !== null) {
            this.log(`sub-lock ${decoded.peripheralId} reports open — command ${confirmed} evidenced`);
          }
        }

        const lockState =
          decoded.locked === null ? '' : decoded.locked ? ' LOCKED' : ' UNLOCKED';
        this.log(
          `peripheral ${decoded.peripheralId} (${decoded.deviceType})${lockState} ` +
            `battery ${decoded.batteryPercent}% ${decoded.voltage}V rssi ${decoded.rssi}` +
            (decoded.eventName ? ` event ${decoded.eventName}` : ''),
        );

        // Alarms worth surfacing rather than leaving in a table: a cut rope or
        // a sub-lock the master can no longer hear are both theft signals.
        if (decoded.commsLostAlarm) {
          this.log(`SUB-LOCK LOST — ${decoded.peripheralId} out of LoRa contact`);
          await this.#store.audit('sub_lock_lost', frame.deviceId, { peripheralId: decoded.peripheralId });
        }
        if (decoded.status?.backCoverOpen) {
          await this.#store.audit('sub_lock_cover_open', frame.deviceId, {
            peripheralId: decoded.peripheralId,
          });
        }
        break;
      }

      case 'command_response': {
        this.log(`response ${frame.command}: ${frame.params.join(',')}`);
        await this.#store.audit('command_response', frame.deviceId, {
          command: frame.command,
          params: frame.params,
        });

        // Establish WHICH command this answers before interpreting it. A P44
        // reading "1" means "password accepted" if it answers a set_password
        // and is part of a password if it answers a query, so the same bytes
        // mean different things depending on the command they belong to —
        // there is no reading them safely without knowing that first.
        const { matched, candidates } = await this.#store.matchCommandForResponse(
          frame.deviceId,
          frame.command,
          frame.serial,
        );

        // The response is the authority on whether a command was accepted.
        //   P43   -> success, wrongCount
        //   P52,3 -> commandId, success, wrongCount
        // Everything else is a query, and answering at all means it worked.
        const isStatic = frame.command === 'P43';
        const isDynamic = frame.command === 'P52' && frame.params[0] === '3';

        // WLNET,1 lists what the master has bound. The reply shape varies -
        // sometimes with a leading function digit, sometimes without - so pick
        // out anything that looks like a peripheral id rather than counting
        // fields.
        if (frame.command === 'WLNET,1') {
          const ids = frame.params.filter((p) => /^[0-9A-Fa-f]{10}$/.test(p) && /[A-Fa-f]/.test(p));
          await this.#store.recordBoundPeripherals(frame.deviceId, ids);
          this.log(`bound peripherals: ${ids.length ? ids.join(', ') : 'none'}`);
        }

        // P01 answers "<firmware string>,<battery>%" — worth keeping on the
        // device record: it determines which commands the unit supports.
        if (frame.command === 'P01' && frame.params[0]) {
          await this.#store.recordFirmware(frame.deviceId, frame.params[0]);
        }

        // A P44 that answers "1" is the device confirming it accepted a new
        // password; "0" means it refused, almost always because the current
        // password we hold is wrong. (A P44 QUERY answers with the password
        // itself, six characters, so the three cannot be confused.)
        //
        // Adoption is gated on the matched command being the rotation itself.
        // Without that, a P44 answering a query_password while a set_password
        // happened to be outstanding would adopt a password the device never
        // took — and lock the platform out of its own hardware.
        let ok = true;
        if (frame.command === 'P44' && frame.params[0] === '1') {
          if (matched?.command_type === 'set_password') {
            const adopted = await this.#store.promotePendingPassword(frame.deviceId, matched.id);
            if (adopted) {
              this.log('password rotated and adopted');
              await this.#store.audit('password_rotated', frame.deviceId, {}, matched.id);
            }
          } else if (candidates.some((c) => c.command_type === 'set_password')) {
            this.log('P44 accepted but could not be tied to one rotation — NOT adopting', true);
            await this.#store.audit('password_rotation_unresolved', frame.deviceId, {
              candidates: candidates.map((c) => c.id),
            });
          }
        } else if (frame.command === 'P44' && frame.params[0] === '0') {
          // Was previously recorded as success, because only unlocks had their
          // response inspected. A failed rotation showing as confirmed is
          // worse than useless: it says the password changed when it did not.
          ok = false;
          this.log('PASSWORD CHANGE REFUSED — the current password we hold is wrong');
          await this.#store.audit('password_rotation_refused', frame.deviceId, {});
        }

        if (isStatic || isDynamic) {
          const success = isStatic ? frame.params[0] : frame.params[1];
          const wrongCount = isStatic ? frame.params[1] : frame.params[2];
          ok = success === '1';
          if (ok) {
            // The device auto-locks about a minute from now, while asleep, and
            // would never report it. Schedule a state refresh so the console
            // does not sit showing "open" for a lock that has closed.
            await this.#store.queueLockStateRefresh(frame.deviceId);
          }
          if (!ok) {
            // Five consecutive failures trips an alarm on the device itself.
            this.log(`UNLOCK REFUSED — ${wrongCount ?? '?'} consecutive wrong passwords`);
            await this.#store.audit('unlock_refused', frame.deviceId, { wrongCount });
          }
        }

        const response = frame.params.join(',');
        if (matched) {
          await this.#store.applyCommandResponse(matched.id, ok, response);
        } else if (candidates.length > 1) {
          // Several open commands could have produced this and nothing
          // separates them. Recording it against the newest — which is what
          // this used to do — puts one truck's valve movement in another
          // truck's audit trail.
          this.log(`response ${frame.command} matches ${candidates.length} open commands — resolving none`, true);
          await this.#store.markCommandsUnresolvable(candidates.map((c) => c.id), response);
        }
        break;
      }
    }
  }

  /** Send anything queued for this device. Called on connect and on NOTIFY. */
  async drainCommands(): Promise<void> {
    if (!this.isIdentified || this.socket.destroyed) return;
    const pending = await this.#store.claimPendingCommands(this.#deviceId!);

    // Already marked 'sent' by the claim, so a concurrent drain cannot pick
    // them up again. Only the failure path needs correcting here.
    for (const cmd of pending) {
      /*
       * The last place a gated sub-lock unlock can be stopped.
       *
       * The API refuses to queue one and arrivals refuse to spawn one, but a
       * command queued before the gate went up is still sitting in the table
       * with status 'queued', and the claim above has just marked it sent. If
       * the flag is ever flipped back on, an unlock authorised weeks ago must
       * not quietly go out with it — so it is expired here rather than left in
       * the queue.
       */
      /*
       * The queue stores placeholders where credentials would be, and the
       * claim fills them in. A null payload means it could not — the device
       * has no password on record — and sending a half-built frame to a lock
       * is worse than sending nothing.
       */
      if (cmd.payload === null) {
        this.log(`command ${cmd.id} has no password on record for this device`, true);
        await this.#store.markCommandFailed(
          cmd.id,
          'no password on record for this device; nothing was sent',
          'transport',
        );
        continue;
      }

      if (cmd.command_type === 'unlock_sublock' && !config.subLockUnlockEnabled) {
        this.log(`refusing queued ${cmd.command_type} ${cmd.id}: sub-lock unlocking is disabled`, true);
        await this.#store.expireCommand(
          cmd.id,
          'sub-lock unlocking was disabled before this command could be delivered',
        );
        await this.#store.audit('sublock_unlock_suppressed', cmd.device_id, {
          payload: cmd.payload,
        }, cmd.id);
        continue;
      }

      /*
       * An error that surfaces after write() returned means the bytes were
       * accepted and then the connection broke. The status is deliberately
       * NOT rewritten here.
       *
       * The plan called for routing this to 'failed'. That would be a claim
       * this code cannot support: TCP can have delivered some or all of the
       * frame before the error, so for an unlock the honest answer is that we
       * do not know. Leaving the command at 'sent' produces exactly the right
       * outcome from the timeout policy — a query retries, an unlock becomes
       * 'uncertain' — without anyone having to guess. The audit row records
       * that the link broke around the write.
       */
      const outcome = this.send(cmd.payload, (err) => {
        this.log(`command ${cmd.id} errored after the write: ${err.message}`, true);
        void this.#store
          .audit('command_write_error', cmd.device_id, { error: err.message }, cmd.id)
          .catch(() => {});
      });

      if (outcome === 'failed') {
        // Transport, not the device: this says nothing about whether the
        // password we hold is right, so it must never reach the lockout.
        await this.#store.markCommandFailed(cmd.id, 'socket write failed', 'transport');
        continue;
      }

      // Backpressure counts as sent. The bytes are queued in the socket and
      // will go out; recording them as a failure is how an unlock that reached
      // the truck came to be filed as one that did not.
      //
      // 'sent' is not 'confirmed' — only the device's own response closes it.
      // The audit detail records WHAT was sent, never the credential inside it.
      // audit_log is long-lived, exported, and read through the API; a payload
      // embedded here put every truck's unlock password in it in clear.
      await this.#store.audit(
        'command_sent',
        cmd.device_id,
        { type: cmd.command_type, payload: redactPayload(cmd.command_type, cmd.payload) },
        cmd.id,
      );
      this.log(`sent ${cmd.command_type}: ${cmd.payload}${outcome === 'backpressured' ? ' (buffered)' : ''}`);

      if (outcome === 'backpressured') await this.#awaitDrain();
    }
  }

  async #onClose(): Promise<void> {
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    if (this.#inboundWatchdog) clearInterval(this.#inboundWatchdog);
    // is_connected is not written here. This handler runs for a socket that
    // may already have been superseded by a newer one for the same device, and
    // it has no way to know: only the registry does.
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

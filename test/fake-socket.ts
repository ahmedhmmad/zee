/**
 * Just enough of net.Socket to drive a DeviceSession without a network.
 *
 * Shared rather than copied into each test file: the session's contract with
 * its socket is now load-bearing — it pauses while a chunk is in flight and
 * resumes afterwards, and a write can be accepted, backpressured or thrown —
 * and four slightly different fakes would each test a slightly different
 * socket.
 */

import { EventEmitter } from 'node:events';

/** How the socket behaves on write. */
export type WriteBehaviour = 'accept' | 'backpressure' | 'throw';

export class FakeSocket extends EventEmitter {
  written: Buffer[] = [];
  destroyed = false;
  remoteAddress = '127.0.0.1';
  behaviour: WriteBehaviour = 'accept';

  /** True while the session has the socket paused. */
  paused = false;
  /** Every pause/resume in order, so a test can assert one followed the other. */
  flow: ('pause' | 'resume')[] = [];

  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  setTimeout(): this { return this; }

  pause(): this {
    this.paused = true;
    this.flow.push('pause');
    return this;
  }

  resume(): this {
    this.paused = false;
    this.flow.push('resume');
    return this;
  }

  write(buf: Buffer | string): boolean {
    if (this.behaviour === 'throw') throw new Error('EPIPE, broken pipe');
    this.written.push(typeof buf === 'string' ? Buffer.from(buf, 'latin1') : buf);
    return this.behaviour !== 'backpressure';
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  end(): this { return this.destroy(); }
}

/** Let the session's chunk queue settle. */
export const settle = (ms = 20): Promise<unknown> =>
  new Promise((r) => setTimeout(r, ms));

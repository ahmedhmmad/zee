/**
 * TCP stream framer.
 *
 * TCP is a byte stream with no message boundaries: one read can deliver half a
 * frame, or three frames plus a fragment. Everything upstream of this class
 * assumes whole frames, so all the resynchronisation lives here.
 *
 * Two frame shapes arrive on the same socket:
 *
 *   Binary  0x24 '$' ... length-prefixed, 10-byte header + N-byte payload
 *   ASCII   0x28 '(' ... terminated by 0x29 ')'
 *
 * Binary payloads can contain 0x28/0x29 bytes, which is exactly why they are
 * length-prefixed rather than delimited. ASCII frames are safe to scan for the
 * closing paren because the one payload that could contain a literal ')' —
 * WLNET,5 peripheral data — is escaped by the device firmware.
 */

export const BINARY_START = 0x24; // '$'
export const ASCII_START = 0x28; // '('
export const ASCII_END = 0x29; // ')'

/** Header is start(1) + terminalId(5) + version(1) + type(1) + length(2). */
export const BINARY_HEADER_LEN = 10;

/**
 * Guard against a corrupt length field pinning memory. A standard position
 * frame is 52 bytes of payload; anything near 1 KB is certainly garbage.
 */
const MAX_BINARY_PAYLOAD = 1024;
const MAX_ASCII_FRAME = 4096;

export interface RawFrame {
  type: 'binary' | 'ascii';
  bytes: Buffer;
}

/**
 * Outcomes of one parse attempt. The distinction matters: NEED_MORE means stop
 * and wait for the socket, while RETRY means we discarded a byte during
 * resynchronisation and should look again immediately. Collapsing the two
 * would strand a valid frame sitting behind a corrupt one until the next read.
 */
const NEED_MORE = Symbol('need-more');
const RETRY = Symbol('retry');
type ParseResult = RawFrame | typeof NEED_MORE | typeof RETRY;

export class Framer {
  #buf: Buffer = Buffer.alloc(0);

  /** Bytes discarded during resynchronisation. Non-zero means trouble. */
  #discarded = 0;

  get discardedBytes(): number {
    return this.#discarded;
  }

  /** Bytes currently held waiting for the rest of a frame. */
  get pendingBytes(): number {
    return this.#buf.length;
  }

  /** Feed a chunk from the socket, get back whatever complete frames it yields. */
  push(chunk: Buffer): RawFrame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);

    const frames: RawFrame[] = [];
    for (;;) {
      const result = this.#next();
      if (result === NEED_MORE) break;
      if (result === RETRY) continue; // always consumed >=1 byte, so this terminates
      frames.push(result);
    }
    return frames;
  }

  #next(): ParseResult {
    // Resynchronise: drop anything before the next plausible frame start.
    const start = this.#findStart();
    if (start === -1) {
      // Nothing usable in the buffer at all.
      this.#discarded += this.#buf.length;
      this.#buf = Buffer.alloc(0);
      return NEED_MORE;
    }
    if (start > 0) {
      this.#discarded += start;
      this.#buf = this.#buf.subarray(start);
    }

    return this.#buf[0] === BINARY_START ? this.#nextBinary() : this.#nextAscii();
  }

  #findStart(): number {
    for (let i = 0; i < this.#buf.length; i++) {
      const b = this.#buf[i];
      if (b === BINARY_START || b === ASCII_START) return i;
    }
    return -1;
  }

  #nextBinary(): ParseResult {
    if (this.#buf.length < BINARY_HEADER_LEN) return NEED_MORE; // header incomplete

    const payloadLen = this.#buf.readUInt16BE(8);
    if (payloadLen === 0 || payloadLen > MAX_BINARY_PAYLOAD) {
      // Bogus length — this '$' wasn't a real frame start. Skip it and retry,
      // so a genuine frame queued behind it is still recovered.
      this.#skipByte();
      return RETRY;
    }

    const total = BINARY_HEADER_LEN + payloadLen;
    if (this.#buf.length < total) return NEED_MORE; // still arriving

    const bytes = Buffer.from(this.#buf.subarray(0, total));
    this.#buf = this.#buf.subarray(total);
    return { type: 'binary', bytes };
  }

  #nextAscii(): ParseResult {
    const end = this.#buf.indexOf(ASCII_END);
    if (end === -1) {
      if (this.#buf.length > MAX_ASCII_FRAME) {
        // No terminator in a suspiciously long run — treat as garbage.
        this.#skipByte();
        return RETRY;
      }
      return NEED_MORE;
    }

    const bytes = Buffer.from(this.#buf.subarray(0, end + 1));
    this.#buf = this.#buf.subarray(end + 1);
    return { type: 'ascii', bytes };
  }

  /** Drop one byte during resynchronisation. Guarantees forward progress. */
  #skipByte(): void {
    this.#discarded += 1;
    this.#buf = this.#buf.subarray(1);
  }
}

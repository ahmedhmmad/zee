/**
 * BCD helpers.
 *
 * Jointech packs most numeric fields as binary-coded decimal: each nibble is
 * one decimal digit. The terminal ID `80 00 62 00 11` is the string
 * "8000620011", not the integer 0x8000620011.
 */

/** Read `len` bytes at `offset` as a BCD digit string (2 digits per byte). */
export function bcdToString(buf: Buffer, offset: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    const byte = buf[offset + i];
    if (byte === undefined) throw new RangeError(`BCD read past end of buffer at ${offset + i}`);
    out += (byte >> 4).toString(16) + (byte & 0x0f).toString(16);
  }
  return out;
}

/**
 * Read `count` nibbles at `offset`, starting from the high nibble of the
 * first byte. Longitude is 9 nibbles (4.5 bytes) with the direction
 * indicator packed into the trailing nibble, so byte alignment doesn't hold.
 */
export function nibblesToString(buf: Buffer, offset: number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const byte = buf[offset + (i >> 1)];
    if (byte === undefined) throw new RangeError(`nibble read past end of buffer`);
    out += (i % 2 === 0 ? byte >> 4 : byte & 0x0f).toString(16);
  }
  return out;
}

/** Single nibble at a byte offset. */
export function nibbleAt(buf: Buffer, offset: number, high: boolean): number {
  const byte = buf[offset];
  if (byte === undefined) throw new RangeError(`nibble read past end of buffer at ${offset}`);
  return high ? byte >> 4 : byte & 0x0f;
}

/**
 * Convert a packed DDMM.MMMM / DDDMM.MMMM coordinate string to decimal degrees.
 *
 * `degreeDigits` is 2 for latitude, 3 for longitude. The remainder is minutes
 * with four implied decimal places:
 *   "22348310" -> 22 deg + 34.8310 min -> 22.580517
 */
export function packedCoordToDegrees(digits: string, degreeDigits: number): number {
  const degrees = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits)) / 10000;
  return degrees + minutes / 60;
}

/**
 * Build a UTC Date from the protocol's DDMMYY + hhmmss BCD pair.
 *
 * Every timestamp in this protocol is UTC — the manual is explicit about it.
 * Local-time conversion happens at the UI edge, never here.
 */
export function bcdDateTimeToUtc(ddmmyy: string, hhmmss: string): Date {
  const day = Number(ddmmyy.slice(0, 2));
  const month = Number(ddmmyy.slice(2, 4));
  const year = 2000 + Number(ddmmyy.slice(4, 6));
  const hour = Number(hhmmss.slice(0, 2));
  const minute = Number(hhmmss.slice(2, 4));
  const second = Number(hhmmss.slice(4, 6));
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

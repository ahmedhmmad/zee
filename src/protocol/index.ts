import { Framer, type RawFrame } from './framer.ts';
import { decodeBinaryFrame } from './decode-binary.ts';
import { decodeAsciiFrame } from './decode-ascii.ts';
import type { DecodedFrame } from './types.ts';

export * from './types.ts';
export * as encode from './encode.ts';
export { Framer } from './framer.ts';
export { decodeBinaryFrame } from './decode-binary.ts';
export { decodeAsciiFrame, unescapePeripheral, parseP45Coord } from './decode-ascii.ts';
export { decodePeripheralPayload, PeripheralType } from './decode-peripheral.ts';
export type { DecodedPeripheral } from './decode-peripheral.ts';

export function decodeFrame(frame: RawFrame): DecodedFrame {
  return frame.type === 'binary' ? decodeBinaryFrame(frame.bytes) : decodeAsciiFrame(frame.bytes);
}

/** Convenience: bytes in, decoded frames out. */
export function createDecoder(): (chunk: Buffer) => DecodedFrame[] {
  const framer = new Framer();
  return (chunk: Buffer) => framer.push(chunk).map(decodeFrame);
}

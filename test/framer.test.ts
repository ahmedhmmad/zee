import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Framer } from '../src/protocol/framer.ts';
import * as encode from '../src/protocol/encode.ts';

const POSITION_HEX =
  '2480006200111911003418042116225922348310113550543F12980000002D060000000020E0' +
  '28109228661F000100000F0F0F0F0F0F0F0F000001CC0156';

const position = () => Buffer.from(POSITION_HEX, 'hex');
const heartbeat = () => Buffer.from('(8000620011,@JT)', 'latin1');

test('single binary frame in a single chunk', () => {
  const frames = new Framer().push(position());
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'binary');
  assert.equal(frames[0]!.bytes.length, 62);
});

test('single ascii frame in a single chunk', () => {
  const frames = new Framer().push(heartbeat());
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'ascii');
  assert.equal(frames[0]!.bytes.toString(), '(8000620011,@JT)');
});

test('several frames arriving in one chunk are all returned', () => {
  const frames = new Framer().push(Buffer.concat([position(), heartbeat(), position()]));
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((f) => f.type),
    ['binary', 'ascii', 'binary'],
  );
});

test('a frame split across two chunks is reassembled', () => {
  const framer = new Framer();
  const buf = position();
  assert.equal(framer.push(buf.subarray(0, 20)).length, 0, 'partial frame yields nothing yet');
  const frames = framer.push(buf.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.bytes.length, 62);
});

test('a frame split byte by byte is reassembled', () => {
  const framer = new Framer();
  const buf = position();
  let out: number = 0;
  for (const byte of buf) {
    out += framer.push(Buffer.from([byte])).length;
  }
  assert.equal(out, 1);
  assert.equal(framer.pendingBytes, 0);
});

test('a chunk boundary inside the length prefix is handled', () => {
  const framer = new Framer();
  const buf = position();
  // Split at byte 9, mid-way through the 2-byte length field.
  assert.equal(framer.push(buf.subarray(0, 9)).length, 0);
  assert.equal(framer.push(buf.subarray(9)).length, 1);
});

test('leading garbage is discarded and the following frame still parses', () => {
  const framer = new Framer();
  const frames = framer.push(Buffer.concat([Buffer.from([0x00, 0xff, 0xaa]), position()]));
  assert.equal(frames.length, 1);
  assert.equal(framer.discardedBytes, 3);
});

test('a bogus length prefix does not swallow the real frame behind it', () => {
  const framer = new Framer();
  // A stray '$' with an absurd length field, then a genuine frame.
  const decoy = Buffer.from([0x24, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
  const frames = framer.push(Buffer.concat([decoy, position()]));
  assert.equal(frames.length, 1, 'the real frame is recovered');
  assert.equal(frames[0]!.bytes.length, 62);
});

test('an ascii frame with no terminator is held, not emitted', () => {
  const framer = new Framer();
  assert.equal(framer.push(Buffer.from('(8000620011,@JT', 'latin1')).length, 0);
  assert.equal(framer.push(Buffer.from(')', 'latin1')).length, 1);
});

test('interleaved binary and ascii across ragged chunk boundaries', () => {
  const framer = new Framer();
  const stream = Buffer.concat([position(), heartbeat(), position(), heartbeat()]);
  let total = 0;
  // Deliberately awkward chunk size, unrelated to any frame length.
  for (let i = 0; i < stream.length; i += 7) {
    total += framer.push(stream.subarray(i, i + 7)).length;
  }
  assert.equal(total, 4);
  assert.equal(framer.pendingBytes, 0);
});

// --- Encoding --------------------------------------------------------------

test('P69 acknowledgements match the manual for both example frames', () => {
  // Position example: serial 0x56 = 86.
  assert.equal(encode.ackData(86).toString(), '(P69,0,86)');
  // P45 example: event serial 24.
  assert.equal(encode.ackData(24).toString(), '(P69,0,24)');
});

test('dynamic password acknowledgement echoes the password back', () => {
  assert.equal(encode.ackDynamicPassword('113271').toString(), '(P52,2,113271)');
});

test('time sync formats server UTC as DDMMYYhhmmss', () => {
  const at = new Date('2020-07-15T16:43:28Z');
  assert.equal(encode.timeSync(at).toString(), '(P22,150720164328)');
});

test('time sync zero-pads single-digit components', () => {
  const at = new Date('2026-01-05T04:07:09Z');
  assert.equal(encode.timeSync(at).toString(), '(P22,050126040709)');
});

test('unlock commands', () => {
  assert.equal(encode.unlockStatic('888888').toString(), '(P43,888888)');
  assert.equal(encode.unlockDynamic('223457').toString(), '(P52,3,223457)');
});

test('unlock channel control can restrict every route except the platform', () => {
  const cmd = encode.setUnlockChannels({
    sms: false,
    gprs: true,
    rfid: true,
    serial: false,
    bluetooth: false,
  });
  assert.equal(cmd.toString(), '(P59,1,0,1,1,0,0)');
});

test('tracking mode and reporting intervals', () => {
  assert.equal(encode.setTrackingMode(true).toString(), '(P54,1,1)');
  assert.equal(encode.setTrackingMode(false).toString(), '(P54,1,0)');
  assert.equal(encode.setIntervals(60, 30).toString(), '(P04,1,60,30)');
});

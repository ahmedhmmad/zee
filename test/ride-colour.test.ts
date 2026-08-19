/**
 * Per-ride route colours.
 *
 * Worth pinning down because both map libraries parse this as a CSS colour
 * string: a malformed value is not an error, it is a line that silently fails
 * to draw. And the colour has to be stable, or a route appears to change
 * identity every time the console refreshes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rideColour } from '../public/map.js';

test('the same ride always gets the same colour', () => {
  // Stability is the point: a route that changed colour on every redraw would
  // suggest to an operator that something about the ride had changed.
  assert.equal(rideColour(42), rideColour(42));
  assert.equal(rideColour('arrival-7'), rideColour('arrival-7'));
  // Numeric and string ids for the same ride must not diverge - arrival ids
  // arrive as numbers from the API and as strings from dataset attributes.
  assert.equal(rideColour(42), rideColour('42'));
});

test('different rides get different colours', () => {
  const seen = new Set(Array.from({ length: 20 }, (_, i) => rideColour(i + 1)));
  // Not demanding 20 distinct hues from a 360-degree space, but a hash that
  // collapsed everything onto one or two colours would defeat the purpose.
  assert.ok(seen.size >= 15, `expected mostly distinct colours, got ${seen.size}/20`);
});

test('the value is a CSS colour both map libraries can parse', () => {
  for (const seed of [0, 1, 999, 'x', 'arrival-12345', '']) {
    const colour = rideColour(seed);
    const m = /^hsl\((\d{1,3}), 70%, 55%\)$/.exec(colour);
    assert.ok(m, `not a parseable hsl() string: ${colour}`);
    // Out-of-range hue is accepted by some parsers and dropped by others,
    // which would show as a missing line on one basemap only.
    assert.ok(Number(m[1]) >= 0 && Number(m[1]) < 360, `hue out of range: ${colour}`);
  }
});

test('saturation and lightness are fixed, so no ride is illegible', () => {
  // Random RGB would eventually produce near-black or near-white lines that
  // vanish against satellite imagery or a pale street map respectively.
  for (let i = 0; i < 100; i++) {
    assert.match(rideColour(`ride-${i}`), /, 70%, 55%\)$/);
  }
});

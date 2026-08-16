/**
 * Tile upstream URL construction.
 *
 * The failure this guards against is silent: a transposed tile URL returns a
 * perfectly valid PNG of the wrong part of the world, so the map renders
 * beautifully and shows somewhere else entirely.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upstreamUrl, PROVIDERS, imageType } from '../src/api/tiles.ts';

test('OpenStreetMap is {z}/{x}/{y}.png', () => {
  assert.equal(
    upstreamUrl('osm', 12, 2345, 1567),
    'https://tile.openstreetmap.org/12/2345/1567.png',
  );
});

test('Esri reverses the axes to {z}/{y}/{x}', () => {
  const url = upstreamUrl('esri', 12, 2345, 1567);
  // y before x, and no .png - the two ways a naive host swap goes wrong.
  assert.ok(url!.endsWith('/12/1567/2345'), `axes not reversed: ${url}`);
  assert.equal(url!.includes('.png'), false, 'Esri takes no extension');
});

test('the two providers disagree, which is the whole point', () => {
  assert.notEqual(
    upstreamUrl('osm', 8, 100, 200)?.split('/').slice(-3).join('/'),
    upstreamUrl('esri', 8, 100, 200)?.split('/').slice(-3).join('/'),
  );
});

test('an unknown provider is refused rather than fetched', () => {
  // Guards against the proxy being steered at an arbitrary host.
  assert.equal(upstreamUrl('http://evil.example.com', 1, 0, 0), null);
  assert.equal(upstreamUrl('../../etc/passwd', 1, 0, 0), null);
  assert.equal(upstreamUrl('', 1, 0, 0), null);
});

test('every provider template carries all three placeholders', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    for (const token of ['{z}', '{x}', '{y}']) {
      assert.ok(p.url.includes(token), `${id} is missing ${token}`);
    }
    assert.ok(p.attribution.length > 0, `${id} has no attribution`);
  }
});

test('content type is read from the bytes, since Esri serves JPEG', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(jpeg), 'image/jpeg');
});

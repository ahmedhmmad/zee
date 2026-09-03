/**
 * The push path, from the trigger to the rendered row.
 *
 * `migrations/002_live_updates.sql` fires notify_device_change on every
 * device_state INSERT *or* UPDATE, which means every position frame. At 3,000
 * trucks that is ~36 notifications a second, and each one used to become its
 * own execution of the device projection — two LATERAL subqueries apiece —
 * against a pool of 15, and then a full teardown and rebuild of a 3,000-row
 * list in every open console.
 *
 * Neither end has a database or a DOM in these tests, so what is asserted is
 * the shape of the code that produces those two behaviours. The properties are
 * invisible in normal use and each one would look like a harmless tidy-up to
 * remove, which is exactly why they are pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(root + p, 'utf8');

const server = read('src/api/server.ts');
const devicesQuery = read('src/api/devices-query.ts');
const app = read('public/app.js');

// --- Server side -------------------------------------------------------------

test('several changed devices are read in one query, not one each', () => {
  assert.match(devicesQuery, /export async function fetchDevicesByIds/);
  assert.match(devicesQuery, /d\.device_id = ANY\(\$1::char\(10\)\[\]\)/);
  // Reuses the one projection rather than forking a second copy that will
  // drift from it.
  assert.match(devicesQuery, /\$\{SELECT\} AND d\.device_id = ANY/);
  assert.match(devicesQuery, /if \(deviceIds\.length === 0\) return \[\]/);
});

test('coalescing is fleet-wide, not per device', () => {
  // A timer per device coalesces nothing across 3,000 distinct trucks — which
  // is the entire fleet, all the time.
  assert.doesNotMatch(server, /pendingPushes/);
  assert.match(server, /const dirty = new Map<string, string>\(\)/);
  assert.match(server, /let flushTimer: NodeJS\.Timeout \| null = null/);

  const push = /function pushDeviceUpdate[\s\S]*?\n\}/.exec(server);
  assert.ok(push, 'pushDeviceUpdate not found');
  assert.match(push[0]!, /if \(flushTimer\) return/, 'one timer for the whole flush');
});

test('nothing watching means nothing is queried', () => {
  const push = /function pushDeviceUpdate[\s\S]*?\n\}/.exec(server)![0]!;
  assert.match(push, /if \(sockets\.size === 0\) return/);
});

test('a batch over the cap is deferred, never dropped', () => {
  const flush = /async function flushDeviceUpdates[\s\S]*?\n\}/.exec(server);
  assert.ok(flush, 'flushDeviceUpdates not found');
  assert.match(flush[0]!, /slice\(0, PUSH_BATCH_MAX\)/);
  assert.match(flush[0]!, /if \(dirty\.size > 0 && !flushTimer\)/, 'the remainder must be rescheduled');
});

test('a device that vanished still produces a nudge', () => {
  // The browser has to be told to drop it from the list; silence would leave a
  // deactivated truck on screen indefinitely.
  const flush = /async function flushDeviceUpdates[\s\S]*?\n\}/.exec(server)![0]!;
  assert.match(flush, /if \(!returned\.has\(id\)\)/);
  // And a failed query degrades to nudges rather than to nothing.
  assert.match(flush, /catch \(err\)[\s\S]*?broadcast\(JSON\.stringify\(\{ kind: kinds\.get\(id\)/);
});

// --- Console side ------------------------------------------------------------

test('the console accepts both the single and the batch frame', () => {
  const apply = /function applyUpdate\(raw\)[\s\S]*?\n\}/.exec(app);
  assert.ok(apply, 'applyUpdate not found');
  // Old consoles and new servers have to interoperate in both directions
  // while a rollout is in progress.
  assert.match(apply[0]!, /Array\.isArray\(msg\?\.devices\)/);
  assert.match(apply[0]!, /msg\?\.deviceId && msg\.device/);
  // A payload with nothing usable in it still refetches, so a malformed
  // message cannot leave the console silently out of date.
  assert.match(apply[0]!, /if \(!incoming\) return void refresh\(\)/);
});

test('an unknown device is added rather than triggering a full-fleet refetch', () => {
  // The refetch amplifier: an unknown id made every open console pull all
  // 3,000 rows, and it fired hardest exactly when the database was already
  // struggling.
  const apply = /function applyUpdate\(raw\)[\s\S]*?\n\}/.exec(app)![0]!;
  assert.match(apply, /state\.devices\.push\(device\)/);
  const refetches = apply.match(/refresh\(\)/g) ?? [];
  assert.equal(refetches.length, 2, 'refresh should survive only on the two malformed-payload paths');
});

test('the device list is patched, not rebuilt', () => {
  const render = /function renderDeviceList\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(render, 'renderDeviceList not found');
  // `innerHTML = ''` plus 3,000 createElement calls ran on every pushed
  // message. The empty-state assignment is a different thing and is allowed.
  assert.doesNotMatch(render[0]!, /list\.innerHTML = ''/);
  assert.match(app, /const deviceRows = new Map\(\)/);
  assert.match(render[0]!, /if \(html !== row\.html\)/, 'rows should only be rewritten when they change');
});

test('one click listener serves the whole list', () => {
  // 3,000 addEventListener calls were being created and discarded on every
  // render.
  const render = /function renderDeviceList\(\)[\s\S]*?\n\}/.exec(app)![0]!;
  assert.doesNotMatch(render, /addEventListener/);
  assert.match(app, /\$\('device-list'\)\.addEventListener\('click'/);
  assert.match(app, /li\.dataset\.deviceId/);
});

test('only markers somebody can see are animated', () => {
  const sync = /function syncMarkers\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(sync, 'syncMarkers not found');
  assert.match(sync[0]!, /const box = viewportBox\(\)/);
  assert.match(sync[0]!, /!onScreen \? 0/);

  // When the map cannot say, everything counts as visible — degrading to the
  // old behaviour is the safe direction.
  const inBox = /function inBox\(box, lat, lon\)[\s\S]*?\n\}/.exec(app)![0]!;
  assert.match(inBox, /if \(!box\) return true/);
});

test('the animation loop skips markers that are not moving', () => {
  const run = /function runAnimation\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(run, 'runAnimation not found');
  // Redrawing all 3,000 markers on every frame was most of the loop's cost.
  assert.match(run[0]!, /if \(!a\.dur\) continue/);
  assert.match(run[0]!, /a\.settled = true/);
});

test('the map adapter reports its own viewport', () => {
  /*
   * On the adapter rather than reached past it: the culling in syncMarkers asks
   * the map what is visible and must not learn which library it is talking to.
   *
   * There was one adapter per provider when this was written — Google, ArcGIS
   * and MapLibre — and it counted all three. There is one now, and the rule it
   * protects is unchanged: whatever the map is built on, the console asks it
   * through this interface.
   */
  const src = read('public/map.js');
  assert.equal(
    (src.match(/getBounds\(\) \{/g) ?? []).length,
    1,
    'public/map.js must expose getBounds on its adapter',
  );
  assert.equal(
    src.includes('map-arcgis.js'),
    false,
    'the ArcGIS adapter is gone; nothing should still import it',
  );
});

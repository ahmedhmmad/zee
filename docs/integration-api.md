# Integration API — for the system consuming this feed

Read-only JSON feed of vehicle and lock state, for another system to draw on its own map
alongside its own data. Hand this document to whoever is building that side.

Everything here is `GET`, authenticated with a bearer token, and returns current state. There
is no write path of any kind — see [What this API will never do](#what-this-api-will-never-do).

## The division of work

| | This platform | Your system |
|---|---|---|
| Owns | the locks, the device gateway, the database, every command | your map, your stations, your shipments |
| Does | publishes lock and vehicle state as JSON | reads it, draws it, styles it |
| Holds | issues you a token, revocable at any time | one token |

You never touch our database and never need a console login. We never touch your map. The
contract between the two is the JSON below.

## Getting a token

Issued on the server, once, by whoever operates this platform:

```bash
sudo -u zee node --env-file=.env scripts/create-api-token.ts "<who it is for>"
```

The token is printed **once** and is not recoverable — only its SHA-256 is stored. If it is
lost, that row is revoked and a new one issued. Each consumer gets its own, so any one can be
cut off without disturbing the others.

Send it on every request:

```
Authorization: Bearer <token>
```

Confirm it works before wiring anything else up:

```bash
curl -H "Authorization: Bearer <token>" https://locks.ahmedhammad.page/api/v1/ping
```

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/v1/vehicles` | `{ generatedAt, count, vehicles: [...] }` |
| `GET /api/v1/vehicles.geojson` | The same vehicles as a GeoJSON `FeatureCollection` |
| `GET /api/v1/ping` | `{ ok, token, serverTime }` — a token check |

Poll `/api/v1/vehicles` every 10–30 seconds. Devices report every few seconds when moving and
sleep when parked, so anything faster mostly re-reads unchanged rows.

## Vehicle fields

| Field | Type | Meaning |
|---|---|---|
| `deviceId` | string | The lock's device id. Stable; use it as your key |
| `name`, `plateNumber` | string, string \| null | As entered by the operator |
| `latitude`, `longitude` | number \| null | WGS84. Null when there is no usable fix |
| `positioned` | boolean | Whether the coordinates above are present |
| `speedKph` | number \| null | |
| `headingDeg` | number \| null | 0–359, degrees from north |
| `batteryPercent` | number \| null | The master lock's battery |
| `locked` | boolean \| null | The master lock's motor |
| `ropeInserted` | boolean \| null | Whether the rope is through the seal |
| `mileageKm` | number \| null | The device's own odometer |
| `online` | boolean | A TCP session is open right now |
| `lastSeenAt`, `lastPositionAt` | ISO 8601 \| null | |
| `alarms` | string[] | Names of the alarms currently raised. `[]` when none |
| `lastEvent` | object \| null | The newest lock event — see below |
| `subLocks` | array | Bound JT709 valve locks. `[]` when none |
| `subLockCount`, `subLocksLocked`, `subLocksUnknown` | number | Counts, for styling a marker |

### `lastEvent`

```json
{ "at": "2026-08-19T18:31:34.000Z", "source": "remote_static_password", "allowed": true, "commandId": 185 }
```

The newest lock event of **any** kind, not only an unlock. `source` is one of
`remote_static_password`, `rfid_card`, `rope_pulled_out`, `auto_locked`, and similar. Read
`auto_locked` as an opening and you will report a valve movement that never happened.

### `subLocks[]`

```json
{
  "peripheralId": "E03B60000A", "name": "صمام 1", "type": "jt709_sub_lock",
  "locked": null, "ropePulledOut": false, "backCoverOpen": false,
  "batteryPercent": 96, "voltage": 3.6, "lastSeenAt": "2026-08-19T18:30:00.000Z",
  "commsLost": false, "lowVoltage": false
}
```

**`locked` has three states, and the third one matters.** `true` locked, `false` unlocked,
`null` **we do not know**. The JT709 status decoding is reconstructed from real device frames
rather than from a vendor specification, so the platform reports uncertainty instead of
guessing.

Do not draw `null` as locked. A valve on a tanker full of petrol shown as confidently secured
when nothing establishes that is the one failure this feed is built to avoid. Draw it as a
distinct third state — grey, hatched, a question mark, whatever suits your map — and let the
operator see that it is unknown. `subLocksUnknown` is there so you can style it without
walking the array.

## Two ways to consume it

**Your server fetches, your page reads from your server.** Recommended. The token stays in
your backend, our JSON is re-served from your own origin, and nothing crosses a browser:

```js
// your server
const res = await fetch('https://locks.ahmedhammad.page/api/v1/vehicles', {
  headers: { Authorization: `Bearer ${process.env.ZEE_TOKEN}` },
});
res.ok && reply.send(await res.json());   // to your own page, from your own origin
```

**Your page fetches us directly.** Requires your origin to be added to
`INTEGRATION_CORS_ORIGINS` on our side, and it means **the token is public** — it sits in
your page's JavaScript, where anyone who views source can read it and, with it, the live
position of every tanker in the fleet. The token is read-only, so what leaks is visibility,
never control of a lock. Ask for this only if the first option is genuinely not available.

## Drawing it on a plain OSM map

Leaflet, from `/api/v1/vehicles` (via your own proxy endpoint):

```js
const markers = new Map();

async function refresh() {
  const { vehicles } = await (await fetch('/your-proxy/vehicles')).json();

  for (const v of vehicles) {
    if (!v.positioned) continue;                    // no fix: leave the last marker alone

    const colour = v.locked === false ? '#e5484d'   // open
                 : v.subLocksUnknown > 0 ? '#8b8b8b' // a valve we cannot read
                 : '#30a46c';                       // locked

    const marker = markers.get(v.deviceId) ?? L.circleMarker([0, 0], { radius: 7 }).addTo(map);
    marker.setLatLng([v.latitude, v.longitude]);
    marker.setStyle({ color: colour, fillColor: colour, fillOpacity: 0.9 });
    marker.bindPopup(
      `${v.name} — ${v.plateNumber ?? ''}<br>` +
      `${v.locked === false ? 'مفتوح' : 'مقفول'} · ${v.online ? 'متصل' : 'غير متصل'}<br>` +
      `صمامات: ${v.subLocksLocked}/${v.subLockCount}` +
      (v.subLocksUnknown ? ` (${v.subLocksUnknown} غير معروف)` : ''),
    );
    markers.set(v.deviceId, marker);
  }
}

refresh();
setInterval(refresh, 15000);
```

For a map library that loads GeoJSON directly, `/api/v1/vehicles.geojson` is the same data;
coordinates are `[longitude, latitude]`, per the GeoJSON RFC. A vehicle with no fix keeps a
`null` geometry rather than disappearing from the collection — it is still in the fleet.

## What this API will never do

Unlocking a lock opens a valve on a tanker full of petrol. Unlock stays on this platform,
behind a named operator account, with the reason recorded and the operator's name against it,
because the Ministry relies on those records.

So there is no unlock, no configuration write, no command queue and no database access
reachable from this token, and there will not be. A token that leaks costs visibility, never
control. If your system needs to *request* an unlock, that is a separate, audited path and a
separate conversation — not an extension of this feed.

## Checking it from our side

The console has a **الربط الخارجي** page showing the exact JSON a token returns, rendered
through the same code that serves it, plus the list of issued tokens with `last_used_at` and
a request count. If something is not arriving, that page distinguishes "you cannot reach us"
from "you have not called yet".

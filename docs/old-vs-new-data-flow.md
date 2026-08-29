# Old deployment vs current: how data is sent, read and written

Two deployments of this platform are live at once. They are far enough apart that
"the system" is now an ambiguous phrase, and the differences are concentrated in
exactly the places that decide whether a record can be trusted.

| | Old | Current |
|---|---|---|
| Address | `http://160.19.100.218/` | `https://locks.ahmedhammad.page/` |
| Vintage | installer build, 15–16 August 2026 | `657e1ea`, 29 August 2026 |
| Transport | plain HTTP, bare IP | HTTPS, certbot, hostname |
| Machine-readable output | **none** | `/api/v1/*`, token-authenticated |
| Accounts | one shared password | named accounts with roles |

## How the old one was identified

Nobody has shell access to it in this account, so its version was established
from outside — four unauthenticated requests, and the repository history:

| Probe | Result | What it establishes |
|---|---|---|
| `GET /` | 200, the Arabic console | It is this platform |
| `GET /api/v1/ping` | **404** | Predates `311b352`, 16 Aug — the integration API |
| `GET /api/health` | **404** | Predates Phase 1 |
| `GET /api/session` | `{"authenticated":false}` | No `username`/`mayUnlock` — predates named users |
| `GET /basemap/libya.pmtiles` | 200 | Has `05f60b7`, 6 Aug — the self-hosted basemap |

That brackets it to the week of 15–16 August, after the single-command installer
(`9e7d3d4`) and the bare-IP support (`605cf75`), before the integration API. Read
everything below as "the old build behaves as that commit range behaves" — it is
inference from a version, not observation of that machine.

---

## 1. Writing: device → database

Unchanged in both: the lock is a **TCP client speaking a binary protocol**. It
opens a socket to port 10001, and `devices.is_active` is the only authentication
the protocol has. No HTTP is involved anywhere on this path, which is why the
gateway binds its own port and nginx never sees it.

What changed is what happens to a frame after it arrives.

**Acknowledgement order.** Old: a position was persisted and only then
acknowledged, behind two awaited round trips. The device re-sends until it is
acknowledged, so database latency produced retransmits and retransmits produced
more latency — a loop that engages exactly when the pool is already saturated.
Current: the ack goes out **first**. Safe because `insertPosition` is idempotent
on `(device_id, reported_at, serial)`, so a frame acked and then lost to a crash
is re-delivered by blind-area replay and inserted once.

A lock event still persists *before* it is acked, and deliberately so: it is the
only evidence a valve moved, and evidence is worth a durability cost that a
position is not.

**Who may write `device_state.is_connected`.** Old: three writers that
disagreed, so a truck reconnecting before the old socket's FIN arrived could be
recorded as offline while it was connected. Current: only the registry in
`src/gateway/index.ts`.

**Backlog.** A truck returning from a four-hour coverage gap dumps ~480 buffered
positions. Old: unthrottled — one truck's backlog could hold the connection pool
while the trucks reporting live queued behind it. Current: a per-session rate
limit, with the socket paused so the throttle reaches the device as real TCP
backpressure. Nothing is dropped; replayed positions are real history, only
slowed.

**What a command record means.** This is the largest difference, and the one
that matters for accountability:

| | Old | Current |
|---|---|---|
| Outcome of an unresolvable command | swept back to `queued` | `uncertain`, terminal |
| Physical movement | inferred from status | recorded separately as evidence |
| Two open commands could explain one response | resolved against the newest | **neither** is resolved |
| Backpressure on the socket | recorded as a failure | recorded as `sent` |
| Password in `commands.payload` | stored in clear for 30 days | `{{static_password}}`, substituted at dispatch |
| Retry of a physical command | possible | never — `command_types.is_physical` |

The last row is a safety property, not a tidiness one. The device auto-locks
about a minute after opening, so a retry opens the valve again, possibly in
transit.

**Cost per frame.** Old: the device projection ran a seven-day mileage LATERAL
over `positions` on every position frame — roughly four thousand heap rows per
device, dozens of times a second at fleet scale. Current: a rollup maintained on
write (migration `019`), folded into the statement that was already running.

**One caveat, in the old build's favour.** The gateway crash that took the fleet
offline on 28–29 August was introduced *by* Phase 1 (a missing comma between two
CTEs) and fixed in `97572d1`. The old build never had it. It is fair to say the
current build is more careful about what it records; it is not fair to say it has
been more reliable this month.

## 2. Reading: platform → the operator console

Broadly the same design in both, because the WebSocket push predates the old
build (`df208be`, 11 Aug): Postgres `NOTIFY` on a `device_state` write → the API
holds a dedicated `LISTEN` connection → the changed vehicle's row is pushed down
`/api/ws` → the browser patches that one vehicle. Neither version polls the fleet.

Differences:

| | Old | Current |
|---|---|---|
| Flush | one timer per device, one query per device | one 500 ms batch, one `= ANY` query |
| Listener failure | silent — a dropped `LISTEN` looks like a quiet fleet | supervised, 30 s heartbeat, `resync` nudge on reconnect |
| Marker animation | every marker, every frame | off-screen markers placed directly |
| Field names | `snake_case`, console-only shape | `camelCase`, a superset of the partner feed |
| Basemaps | OSM raster + self-hosted vector | the same — see below |

The listener row is worth dwelling on. Everything that changed while a `LISTEN`
connection was down is missed: `NOTIFY` has no replay. On the old build that
leaves every open console showing a fleet frozen at the moment the connection
dropped, with nothing on screen to say so — the map keeps drawing, the timestamps
keep their values, and a truck that has since been unlocked still reads as
locked.

**The map went in a circle, deliberately.** The old build draws OpenStreetMap
through the tile proxy, because Google and Esri had not been added yet. Between
then and now the console gained a Google adapter, an ArcGIS adapter and a picker;
`657e1ea` removed all three and returned to one MapLibre map over proxied OSM —
this time as a decision, to match how the partner platform draws its own map.

## 3. Reading: platform → another system

**Old: there is no way.** No `/api/v1` of any kind. The only routes that return
vehicle data require a session cookie, so anything consuming that build is either
screen-scraping the console or reading its database directly.

**Current:** a read-only JSON feed, added in `311b352` and extended in `77cfbad`.

```
their server → GET https://locks.ahmedhammad.page/api/v1/vehicles
               Authorization: Bearer <token>
             → nginx :443 → zee-api :3333 → two queries → JSON
```

- Three endpoints: `/api/v1/vehicles`, `/api/v1/vehicles.geojson`, `/api/v1/ping`.
- Bearer tokens per consumer, stored as SHA-256 only, revocable one at a time.
- An explicit field allowlist — not the console's projection, which carries SIM
  numbers and a flag for whether a lock still holds its factory password.
- Read-only by construction: no unlock, no configuration, no write is reachable.
  A leaked token costs visibility, never control of a valve.
- Polling, not push. Every request reads fresh; 10–30 s is the right interval.

See `docs/integration-api.md` for the field table and a worked example.

## 4. Who did it

| | Old | Current |
|---|---|---|
| Login | one shared password for everyone | named accounts, scrypt |
| Session cookie says | somebody once knew the password | which user, by id |
| Revoking one person | change the password for everyone | deactivate that account |
| Deactivation takes effect | at their next login | at their next request |
| Unlock permission | anyone who can log in | `may_unlock` on the account |
| Audit row for an unlock | `operator@<ip>` | the operator's name |

On the old build the audit trail cannot say who opened a valve. The Ministry
relies on these records, so this is a substantive difference and not an
administrative one.

## 5. Transport

The old deployment is served over **plain HTTP against a bare IP**. Two
consequences, both by design rather than oversight — `ab2a9b9` deliberately
stops setting a `Secure` cookie there, because a `Secure` cookie over HTTP is
silently discarded and would lock every operator out with no error to go on:

- every login sends the operator's password across the network in clear;
- the session cookie is not `Secure`, so it travels in clear too.

The current deployment terminates TLS at nginx with a certbot certificate on a
hostname, and the cookie follows the scheme the request actually arrived on.

## The open question

**Which deployment are the two trucks configured against?** A JT701D holds one
server address, set with `P06`, so it reports to exactly one of these. Whichever
one it is not has been frozen since the changeover, and a frozen console is
harder to catch than a broken one: the map still draws, the markers still sit
somewhere plausible, and only the timestamps give it away.

Confirm with `(P07)` against a device, or by comparing `last_position_at` on both
boxes. Until that is settled, any feed built on the old deployment could be
serving positions that are weeks old and look perfectly alive.

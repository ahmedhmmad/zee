# Zee — Jointech lock platform

Monitoring and remote unlock for Jointech JT701D master locks (and JT709EX
explosion-proof valve sub-locks) on fuel tankers. 

Built against the Jointech JT701D user manual, JT709EX user manual, and
`JT701D/E Protocol Manual V1.9.5`. Those PDFs are copyright Shenzhen Joint
Technology and marked not-for-redistribution, so they are kept alongside the
working copy but excluded from version control.

## Architecture

```
[JT709EX valve locks] --LoRa 433MHz--> [JT701D master] --TCP--> [gateway :10001]
                                                                      |
                                                              Postgres + PostGIS
                                                                      |
                                                          [API + web UI :3333]
                                                                      |
                                                       Nginx (CloudPanel) :443
```

Two processes, because the devices are **TCP clients speaking a binary
protocol** — there is no HTTP anywhere in the device path, so Nginx cannot
carry it. The gateway binds its own port directly.

| Host | Port | Path |
|---|---|---|
| `locks.ahmedhammad.page` | 443 → 3333 | Web UI + API, via Nginx |
| `gw.ahmedhammad.page` | 10001 | Device gateway, raw TCP |

Devices are configured with the **hostname**, never a raw IP, so moving servers
is a DNS change rather than re-visiting every truck.

## Layout

```
src/protocol/     Frame codec — the heart. Fully unit-tested.
  framer.ts       TCP stream -> whole frames (length-prefixed + delimited)
  decode-binary.ts  Position / alarm frames
  decode-ascii.ts   P45 lock events, heartbeat, time sync, dynamic password
  encode.ts       Acks and outbound commands
src/gateway/      TCP server, per-socket sessions, persistence
src/api/          Fastify routes, WebSocket push, device projection
public/           Operator console — vanilla JS, Arabic UI, no framework
migrations/       Schema
scripts/          Device simulator, fleet simulator, migration runner, user admin
deploy/           systemd units and the install script
docs/             OpenAPI spec and the scaling roadmap
test/             244 tests: the protocol codec from the manual's worked
                  examples, plus the gateway session and command lifecycle
```

## Roadmap

The platform is field-proven on 2 trucks and being scaled to ~3,000.
[`docs/scaling-plan.md`](docs/scaling-plan.md) is the plan in force — five phases, with Phase 1
(correctness, capacity and pilot safety) specified in full.

**Phase 1 is implemented.** What remains of it is verification: a staging run against the fleet
simulator at the burst figures the plan sizes for, and the JT709 bench test that decides whether
valve sub-lock unlocking can be switched back on. `CLAUDE.md` lists the invariants Phase 1
established — read those before touching the command lifecycle, because each fixed a defect that
is invisible in normal operation and each would look like a harmless simplification to undo.

[`docs/scaling-plan-superseded.md`](docs/scaling-plan-superseded.md) is the previous revision,
kept only so the design it proposed — and the reasons it was rejected — stay on the record.

## Development

```bash
npm install
```

```bash
npm test
```

The protocol tests decode the exact hex frames printed in
`JT701D_JT701E Protocol ManualV1.9.5.pdf` and assert the field values the
manual states for each. That means the codec is verified against vendor
ground truth without any hardware.

The gateway tests drive a real `DeviceSession` over `test/fake-socket.ts` with a stubbed store,
so command dispatch, chunk serialisation, backpressure and the replay limiter are exercised as
behaviour rather than asserted as shape. Store queries themselves still have no database in the
suite; those are pinned by reading the SQL, and need a staging run behind any change.

### Running locally against the simulator

Create the schema:

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
```

Register a device (the gateway rejects IDs not on the allowlist):

```bash
psql "$DATABASE_URL" -c "INSERT INTO devices (device_id, name, plate_number) VALUES ('8000620011', 'Tanker 1', 'TRP-1234');"
```

Start the gateway:

```bash
npm run gateway
```

Then in a second terminal, a fake truck driving around Tripoli:

```bash
npm run simulate 8000620011
```

To drive the deployed gateway instead — which also proves both firewalls and
the DNS record — pass the host:

```bash
npm run simulate 8000620011 gw.ahmedhammad.page
```

Queue an unlock and watch it flow through `queued → sent → confirmed`:

```bash
psql "$DATABASE_URL" -c "INSERT INTO commands (device_id, command_type, payload, requested_by, reason) VALUES ('8000620011', 'unlock_static', '(P43,888888)', 'dev', 'testing');"
```

## Deployment

```bash
sudo cp deploy/zee-gateway.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now zee-gateway
```

```bash
journalctl -u zee-gateway -f
```

Port 10001 needs an ingress rule in **both** the Oracle Cloud VCN Security List
and CloudPanel's firewall. Opening only one silently drops all device traffic.

## Device commissioning

Per device, before it goes on a truck:

| Command | Purpose |
|---|---|
| `(P06,1,gw.ahmedhammad.page,10001,<APN>,,)` | Point it at us. APN from Libyana / Al-Madar. |
| `(P44,<new>,888888)` | Rotate off the factory-default password. |
| `(P59,1,0,1,0,0,0)` | Restrict unlocking to the platform channel only. |
| `(P04,1,60,30)` | 60s reporting while awake, 30min RTC wake interval. |
| `(P10,1,120)` | SMS alarm timezone offset: Libya is UTC+2. |
| `(P94,1,3)` | Enable IMEI + fence ID in P45 reports. |

## Integration API

Read-only JSON for other systems to pull, so a partner platform - the Ministry
fuel committee's Esri map among them - can plot the fleet alongside its own
data without anyone being issued a console login.

Issue a token on the server:

```bash
sudo -u zee node --env-file=.env scripts/create-api-token.ts "Ministry fuel committee"
```

It prints the token **once**; only its SHA-256 is stored, so a copy of the
database does not hand over working credentials.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/vehicles` | Current state of every active vehicle, as JSON |
| `GET /api/v1/vehicles.geojson` | The same, as a GeoJSON FeatureCollection |
| `GET /api/v1/ping` | Confirms a token works, before wiring anything up |

```bash
curl -H "Authorization: Bearer <token>" https://<host>/api/v1/vehicles.geojson
```

The GeoJSON form loads straight into Esri or Leaflet with no transformation.
Vehicles without a GPS fix are returned with a `null` geometry rather than
dropped, so a partner can tell "present but unlocatable" from "no longer in
the fleet".

Each vehicle carries position, speed, heading, battery, `locked`,
`ropeInserted`, `alarms`, the newest lock event (`lastEvent` — of *any* kind,
not only an unlock), and the JT709 valve sub-locks bound to it. A sub-lock's
`locked` is three-state: `true`, `false`, or `null` meaning the platform cannot
tell, which a consumer must not draw as locked. **`docs/integration-api.md` is
the document to hand to whoever builds the other side** — full field table, both
delivery routes, and a Leaflet example.

The console's **الربط الخارجي** page renders the same feed through the same
shaping code, so the exact bytes a partner receives can be read and copied
without a token, alongside the issued tokens and when each was last used.

Three properties of this API are deliberate and should stay that way:

- **Read only.** No unlock, no configuration, no write of any kind is
  reachable. A leaked token costs visibility, never control of a lock.
- **An explicit field allowlist**, not the console's projection - which carries
  SIM numbers and a flag for whether a lock still has its factory password.
- **Tokens separate from the operator password**, so a partner's access can be
  revoked without changing the password drivers use.

Revoke with `UPDATE api_tokens SET is_active = false WHERE name = '...';`, and
see `last_used_at` / `request_count` in that table for who is actually calling.

Browser callers are off by default: the feed sends no CORS headers unless
`INTEGRATION_CORS_ORIGINS` lists their exact origin. Prefer having the partner's
own server hold the token and re-serve the JSON — a token in browser JavaScript
is readable by anyone who views the page source, and with it the live position
of every tanker.

## The map

One basemap, one library: MapLibre over OpenStreetMap, with every tile proxied
through `/api/tiles/osm/{z}/{x}/{y}.png` and cached on disk, because tile hosts
are not reliably reachable from Libya. No key, no billing account, no external
dependency in the browser.

This replaced three implementations behind one adapter interface — Google, the
ArcGIS SDK and this one — with a picker to choose between them. The partner
platform this console now shares a data shape with draws its own map the same
way, so an operator moving between the two systems sees one map behaving one
way, and marker code written against one runs against the other.

What that gave up: Google's Libyan street data, which is better than OSM's, and
the Esri satellite layer. The tile proxy still carries its Esri provider and the
test that pins the axis order — OSM is `{z}/{x}/{y}.png`, Esri is `{z}/{y}/{x}`
with no extension and returns **JPEG**, and swapping only the hostname fetches
transposed tiles: a map that renders perfectly and shows the wrong part of the
world. So imagery is one entry in `RASTER_BASEMAPS` away, and nothing
server-side would have to come back with it.

`ARCGIS_API_KEY` remains, and is not a basemap key. It buys one thing: the road
route drawn to an arrival point, from Esri's routing service. Without it the
destination still appears, joined by a straight line.

## Evaluation period

The platform can run for a fixed, agreed pilot period, after which continued
use depends on approval. This is a **disclosed term of the evaluation
agreement**, implemented as ordinary, findable code — not a hidden trigger and
not obfuscated. The client's own team is expected to be able to read it.

**What it is:** a single environment variable, `EVALUATION_EXPIRES_AT` in
`.env`, holding a date (`YYYY-MM-DD`). The check lives in
[`src/evaluation.ts`](src/evaluation.ts) and is a plain local date comparison —
no remote call, no signing, no network dependency of any kind.

**Set at install time**, counted from the day the installer runs, so the period
starts when the client actually receives the platform:

```bash
sudo bash install.sh --evaluation-days 60
```

`--evaluation-days 0` means no limit; omitting the flag defaults to 60 days.
It is a command-line option rather than a prompt because the length is a term
of the agreement, not a choice for whoever runs the installer.

`--evaluation-minutes N` does the same in minutes, for demonstrating the expiry
itself inside one sitting rather than waiting out a real pilot:

```bash
sudo bash install.sh --evaluation-minutes 30
```

Minutes are written as a full ISO instant rather than a date, because a bare
`YYYY-MM-DD` means the *end of that day* and would grant the rest of the day
instead of the minutes asked for.

Re-running the installer **keeps the date already in `.env`**. It is meant to
be safe to re-run when something needs fixing, and recomputing the date there
would restart the clock every time, so the period could never end. Pass
`--evaluation-days N` explicitly to change it.

**Re-running with a flag does not renew it either.** The instant of the first
install is recorded once in `platform_meta` (see
[`migrations/011_platform_meta.sql`](migrations/011_platform_meta.sql)) and the
expiry is computed as *anchor + length*, not *now + length*. Running
`--evaluation-minutes 30` again an hour later therefore produces a date already
in the past, and the platform stays stopped.

To extend legitimately, pass a longer length — it is still measured from the
first install, so `--evaluation-days 60` means sixty days from when the client
received the platform, whenever you run it:

```bash
sudo bash install.sh --evaluation-days 60   # or 0 for no limit
```

The anchor lives in the database rather than a file so that resetting it costs
the positions, lock events and audit trail stored alongside it. That is a
deterrent, not a protection: anyone with database access can edit the row.

**Before the date:** the platform runs completely normally. There is no
countdown or banner shown to end users; the only mention is one line in the
service logs at startup (`journalctl -u zee-api`).

**On or after the date:** both the API and the device gateway stop serving.
Anyone opening the console sees an "evaluation period ended" notice; the
gateway closes its port so no positions are recorded and no unlock — manual or
arrival — can fire. Each process stays running but inert (they are
`Restart=always`, so exiting would just restart-loop).

**Nothing is ever deleted.** No data, no files, no database records. The locks
themselves are untouched and keep their physical state.

**To extend or remove the limit** (e.g. once the deal is approved), edit
`.env` and restart — the platform resumes immediately, with everything intact:

```bash
# a later date, or leave it blank for no limit at all
sudo sed -i 's/^EVALUATION_EXPIRES_AT=.*/EVALUATION_EXPIRES_AT=2027-01-31/' /home/zee/app/.env
sudo systemctl restart zee-gateway zee-api
```

**To remove the mechanism entirely from the code:** delete
[`src/evaluation.ts`](src/evaluation.ts) and the two `evaluationPeriod` gates
(one `onRequest` hook in [`src/api/server.ts`](src/api/server.ts), one
`watch()` block in [`src/gateway/index.ts`](src/gateway/index.ts)), plus
[`public/expired.html`](public/expired.html).

**Not tamper-proof, by design.** Anyone with root can edit `.env`, change the
system clock, or edit the anchor row. What the mechanism actually achieves is
narrower than it looks, and worth stating plainly:

- it stops the **passive** case — the pilot ends, nobody acts, the platform
  stops on its own;
- it makes continuing a **deliberate, documented act** rather than a default,
  which is what matters under a disclosed agreement;
- it is **not** a lock, and does not pretend to be one.

Resisting a determined administrator would require a remote licence check,
which trades a simple pilot limit for a network dependency that could strand a
working fleet the day it is unreachable — the wrong trade for locks on fuel
tankers. For a disclosed evaluation the honest local limit is sufficient; the
written agreement, not the code, is the real protection.


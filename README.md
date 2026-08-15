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
migrations/       Schema
scripts/          Device simulator
test/             59 tests built from the manual's own worked examples
```

## Development

```bash
npm install
```

```bash
npm test
```

The test suite decodes the exact hex frames printed in
`JT701D_JT701E Protocol ManualV1.9.5.pdf` and asserts the field values the
manual states for each. That means the codec is verified against vendor
ground truth without any hardware.

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


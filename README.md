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





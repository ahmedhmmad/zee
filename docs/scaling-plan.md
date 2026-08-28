# Zee lock platform — Phase 1, revised

> ## Status: Phase 1 implemented
>
> Every item below, 1.0 through 1.12, has landed. `npm test` and `npm run typecheck` are clean.
> `CLAUDE.md` carries the invariants this work established, which is what a future change needs
> to know; this document remains the record of *why* each one exists.
>
> **Two things in this document turned out to be wrong, and the code differs from it deliberately:**
>
> - **1.1 commit 2 says the clock offset comes from the time-sync handshake.** It cannot: the
>   `P22,2` frame the device sends is a bare request for the time and carries no device timestamp
>   at all. The offset is sampled from real-time position frames instead, which is a better source
>   anyway — `reportedAt` comes from the same clock that stamps a P45. Blind-area and backlog
>   frames are excluded, or a truck back from a coverage gap would be recorded as hours behind.
>
> - **1.1 commit 3 says an asynchronous write error should be routed to `failed`.** It is not.
>   TCP may have delivered some or all of the frame before the error surfaced, so for an unlock
>   the honest answer is that we do not know. The command is left at `sent` and the timeout policy
>   resolves it correctly for both classes — a query retries, an unlock becomes `uncertain` —
>   without anyone having to guess. This follows the plan's own rule that every step must be
>   monotonically safer on physical actuation.
>
> Two smaller notes: 1.5 claims viewport culling touches neither map module; no adapter exposed
> the viewport, so a `getBounds()` was added to all three rather than reaching past the adapter.
> And 1.1's `command_types` table is seeded with 29 types, not the 15 the document estimates.
>
> **Not done, and not doable from here:** the 1.0 bench test (real hardware) and the verification
> sequence at the end of this document (a staging database and a fleet run). Sub-lock unlocking
> ships gated off, which is what the plan specifies while that answer is unknown.

Supersedes [`scaling-plan-superseded.md`](scaling-plan-superseded.md). That revision survived an adversarial review well: all
twelve load-bearing `file:line` citations checked out against the code, which is unusual, and
most of its structure is carried forward unchanged. Five things did not survive, and they are
what this document changes.

## What changed, and why

**1. The command-type table was wrong, and item 1.1's design rested on it.**
The previous revision states "of the nine types in use, only three are physical" and builds a
**per-type state machine** on that list. There are at least **fifteen** types.
`src/api/routes.ts:707-714` queues eight in a single route:

```
query_tracking (P54,0)    query_motion (P37,0)     query_drift (P63,0)      query_autolock (P83,0)
query_intervals (P04,0)   query_cornering (P99,0)  query_gnss_power (P97,0) query_wake_window (P39,0)
```

A state machine that branches on a list this long — and still growing, since every new device
setting adds a type — is a standing invitation to misfile one. Misfiling a *physical* type as
non-physical means an unlock auto-retries and a valve opens twice.

**The lifecycle is no longer per type.** `commands.status` goes back to meaning one thing —
*what happened in the exchange with the device* — and physical movement becomes evidence
recorded against the command, not a state in a machine. See 1.1.

**2. Item 1.1(f)'s fix depends on undocumented hardware behaviour.**
The previous revision fixes the unconfirmable sub-lock unlock by "requir[ing] the heartbeat
enabled on that peripheral before a sub-lock unlock may be armed." But `src/protocol/encode.ts:216-219`
says, in the repo's own words:

> The manual describes this purely as loss-alarm detection. Whether a heartbeat wake also lets
> the sub-lock collect a queued unlock is **NOT stated anywhere** — plausible, since it is a wake
> like any other, but untested and not promised. Do not rely on it until it has been observed on
> hardware.

The proposed fix may not work at all. It is now gated behind a bench test (1.0).

**3. Phase 1 was not a safe stopping point for a pilot.**
Phase 2 is marked "Blocks rollout", yet Phase 1 was scheduled into a pilot on real tankers ahead
of it. What that means concretely, verified:

| Fact | Where |
|---|---|
| Authentication is one shared operator password | `src/api/config.ts:20` |
| The session cookie's entire payload is the literal string `'ok'` — it carries no identity | `src/api/config.ts:81` |
| Audit attribution is the client IP: `operator@${req.ip}` | `src/api/routes.ts:1042` |
| `AUTH_DISABLED=true` opens the UI **and the unlock endpoint** outright | `src/api/config.ts:17` |

On a system whose records are the Ministry's accountability trail, that is one shared credential
that can open any valve in the fleet, with no way to say who used it. A minimum identity slice is
now **1.11**, inside Phase 1 and blocking the pilot.

**4. ACK ordering moves into Phase 1.**
The previous revision identified the retransmit amplifier, called it "a real durability trade",
and deferred it on the grounds that a DB-side `statement_timeout` bounds the damage. It does not.
`statement_timeout` bounds one query; it does nothing about a loop that *generates more inbound
frames* precisely when the pool is saturated. The ack sits behind two awaited round trips
(`src/gateway/session.ts:160-168`) and `src/db.ts:13` sizes the pool at `max: 10`.

**5. The open scope question is resolved — but not the way it was posed.**
The question was "cut 1.9 and 1.11?". The mileage rollup is not primarily a reporting item:
`migrations/002_live_updates.sql:20` fires on every `device_state` INSERT **or UPDATE**, which
reaches `src/api/server.ts:184` and calls `fetchDevice()` — so the 7-day per-device LATERAL at
`src/api/devices-query.ts:47-63` runs on **every position frame**. It is a hot-path item and it
stays. The *odometer-reset policy* it feeds is reporting, and moves out. Partition automation
moves out (headroom to 2027-09-01).

Retained unchanged from the previous revision: the eight defects and their diagnoses, the
sequencing constraints between items, the commit-ordering safety argument in 1.1, and the
capacity guardrails.

---

## Load target — revised for burst

Steady state is unchanged and was never the problem:

| Assumption | Value |
|---|---|
| Devices | 3,000 |
| Awake reporting interval | 30s while moving |
| Duty cycle | 8h/day driving = 33% |
| Fleet rows/day | 3.07M |
| Average inserts/sec | 36 |
| Steady peak (whole fleet moving) | 100 |

**The previous revision sized Phase 1 against that peak. It is the wrong number to size against.**
The JT701D buffers positions when out of coverage and replays them on reconnect — blind-area
replay, which the plan relies on elsewhere for correctness. Two burst sources dominate:

| Burst source | Arithmetic | Frames |
|---|---|---|
| One truck, 4h coverage gap | 4h ÷ 30s | 480 buffered |
| Regional outage, 200 trucks return together | 200 × 480 | 96,000 |
| Gateway restart, fleet reconnects and replays | 3,000 × ~100 over ~60s | **~5,000/sec** |

That is **50× the stated peak**, and a gateway restart is not an exotic event — it is what
`Restart=always` does after any crash, and `src/gateway/index.ts:46-49` currently calls
`process.exit(1)` on *any* server error.

Phase 1 must therefore hold under burst, not just under 100/s. Three items carry that load:
**1.3** (ack before persistence, so a slow DB stops generating retransmits), **1.9** (bounded
concurrency in the sweep and the drain), and **1.12** (pool sizing, backlog, accept-error
handling). Add a per-device replay admission limit — a device dumping 480 frames must not be
able to monopolise the pool — and verify against the burst figure, not the steady one.

Storage figures from the previous revision are unchanged and were checked: ~490 B/row,
594 GB/yr as-is, 230 GB/yr after the Phase 4 optimisations.

---

## Phase breakdown

| Phase | Goal | Gates |
|---|---|---|
| **1. Correctness, capacity & pilot safety** | Fix the command lifecycle, hold 3,000 devices on one server, and make the audit trail defensible | — |
| **2. Full identity & roles** | Complete RBAC, session management, SSO if required | Blocks rollout past pilot |
| **3. Fleet operations** | Company grouping, bulk onboarding, pagination, alarm workflow, Ministry reporting *(now incl. odometer-reset policy)* | Blocks rollout past a pilot |
| **4. Storage economics** | `status_flags` raw bytes, drop redundant index, partition `sub_device_readings` and `audit_log`, retention *(now incl. partition automation)* | Before JT709 heartbeats go fleet-wide |
| **5. Resilience** | Multi-instance gateway, DB replica, monitoring, staging | Before full rollout |

**This plan details Phase 1 only.**

---

## Phase 1

### 1.0 Prerequisites

Nothing below is verifiable without these.

- **`scripts/simulate-fleet.ts`** — N in-process sockets, configurable ramp and interval, **and a
  replay mode** that reproduces the burst figures above. Reuse `buildPositionFrame`/`buildLockEvent`
  from `scripts/build-frames.ts` and `src/protocol/framer.ts`; extend `scripts/simulate-device.ts`
  rather than duplicating it. **Never seed fake IDs into a production `devices` table** — the
  allowlist is the only authentication this protocol has. Needs a staging database.

- **`GET /api/health`** in `src/api/routes.ts` (add to `isPublic()`, bind-restricted):
  `pool.totalCount/idleCount/waitingCount`, `sessions.size`, listener-connected, last sweep
  duration, oldest queued command age, `SELECT count(*) FROM ONLY positions_default`, partition
  headroom in months. A non-zero `waitingCount` *is* the silent pool queue.

- **Test seam** — `src/gateway/session.ts:12` does `import * as store`. Make it
  constructor-injectable (defaulting to the module) so gateway concurrency becomes testable.
  `test/` currently covers protocol decode only; there are no tests over the gateway, store,
  routes, or console.

- **Migration runner: non-transactional support and an advisory lock.**
  `scripts/migrate.ts:47-52` sends each migration file as one query string and records the
  filename in a second, unlocked statement — so a crash between them silently re-runs a migration.
  It also means `CREATE INDEX CONCURRENTLY` cannot work: Postgres wraps a multi-statement simple
  query in an **implicit** transaction, so removing `BEGIN`/`COMMIT` from the file is not
  sufficient on its own. Add `pg_advisory_lock`, and either split non-transactional migrations
  into one statement per round trip or mark them so the runner sends their statements
  individually. Document that new migrations must be idempotent. **1.7 cannot land without this.**

- **🔬 Bench test: JT709 heartbeat wake and queued unlock.** *(new — blocks 1.1 commit 5)*
  On real hardware, with one master and one sub-lock:
  1. Enable a heartbeat on the peripheral (`wlnetSetHeartbeat`).
  2. Queue a sub-lock unlock while the peripheral is asleep.
  3. Observe whether the heartbeat wake collects and executes it, and whether the peripheral
     subsequently reports `locked === false`.

  Record the result in the repo next to `encode.ts:216-219` and replace that comment with an
  observed fact. **Commit 5 of 1.1 cannot be designed until this is answered**, because its entire
  remedy assumes the answer is yes. If it is no, the sub-lock unlock has no confirmation path at
  all and the feature stays gated (see 1.1 commit 5).

---

### 1.1 — PRIORITY — Command lifecycle: transport state is not device state

Live correctness bugs, not scaling issues. Rare at 2 devices, routine at 3,000. The eight defects
(a)-(h) and their diagnoses are carried forward from the previous revision unchanged and are not
restated in full here — they were verified accurate against the code. What changes is the model
they are fixed with.

#### The model: status is the exchange, evidence is a fact

The previous revision split `confirmed` into `acknowledged` + `confirmed` and made the lifecycle
branch per command type. Replace that with:

**`commands.status` means what happened in the exchange, for every type identically.**

```
queued → sent → confirmed   (device answered the command word, ok)
              → failed      (device refused, or the write genuinely failed)
              → uncertain   (nothing came back in the window; may have executed)
              → expired
```

**Physical movement is recorded as evidence, not as a state.** New columns on `commands`:

| Column | Meaning |
|---|---|
| `physically_evidenced_at timestamptz` | when movement was evidenced |
| `physical_evidence_kind text` | `'lock_event'` (P45) or `'peripheral_report'` |
| `physical_evidence_id bigint` | the `lock_events.id` or `sub_device_readings.id` that proves it |

Why this is better than the state split, concretely:

- **It does not branch on type.** The fifteen-and-growing type list stops being a correctness
  hazard. A settings command simply never acquires evidence, which is the truth about it, and it
  still reaches `confirmed` normally — the previous revision needed a whole per-type table to
  avoid five types being stranded forever, and that table was missing seven of them.
- **It cannot un-fix the lockout.** `src/api/routes.ts:216-219` clears the password-failure
  counter on a `status='confirmed'` unlock. Under the per-type split, an unlock whose P45 was lost
  would stall at `acknowledged` and stop clearing the counter — reintroducing defect (b) through
  the fix for it. Under this model `confirmed` still means "the device answered", which is exactly
  the right proof that the password was correct.
- **It is the honest shape.** "The device accepted the command" and "the valve moved" are two
  facts, and a truck can be in the state where the first is true and the second is unknown. A
  single status column cannot hold two facts; two columns can.

**Retry policy keys off type, in one place only.** Physical types are never auto-retried. That
list lives in **one** place — a `command_types` reference table with an `is_physical` boolean,
FK'd from `commands.command_type`, so SQL and TypeScript read the same source and **a new command
type cannot be added without declaring whether it is physical.** Seed it with all fifteen current
types. A test asserts every type used in `routes.ts` and `session.ts` is registered.

**The console shows evidence, not just status.** `app.js:122` currently renders `confirmed` as
`تم التأكيد من الجهاز`, which an operator reads as *the valve opened*. Under this model the
console shows the device's acceptance and the movement evidence as two distinct lines, and says
plainly when movement is unevidenced. On a fuel tanker that distinction is the entire safety
argument.

**`uncertain` blocks retry, never evidence.** Late evidence must still upgrade it.

#### How this lands — five commits, in order

**1. Vocabulary, evidence columns, and the terminal guard.**
Migration: add `uncertain` to the `status` CHECK (`001_init.sql:219` — `uncertain` cannot be
written at all until this lands, so every later commit depends on it); add the three evidence
columns; add a `failure_cause` column so (b) can distinguish transport failure from password
rejection; create and seed `command_types`. Add the Arabic labels and severity classes to
`COMMAND_STATUS` (`app.js:118-128`, which today falls back to raw English at `app.js:699`).
Correct the state-machine comment at `001_init.sql:214-216`.

**Also in this commit: the `markCommandFailed` terminal guard** (defect (e)) —
`WHERE id = $1 AND status NOT IN ('confirmed','failed')` at `store.ts:502-506`. The previous
revision held this until commit 3. It is two lines, it is pure safety, it can un-confirm a
confirmed command today, and it has no interaction with the ordering argument below. It lands now.

Tests over every reader of `commands.status` asserting the new state renders and routes correctly.

**2. Type-aware timeout policy, and late evidence.** — defects (c) and (g).
`requeueUnansweredCommands` (`store.ts:479-487`) gains a join to `command_types`: physical types
time out to `uncertain` and are never returned to `queued`; non-physical types retry as today.
`linkEventToCommand` (`store.ts:546`) and `confirmSubLockUnlock` (`store.ts:656`) accept the open
states (`sent`, `uncertain`) instead of a single hardcoded status, and on evidence they set the
three evidence columns and upgrade `uncertain` → `confirmed`.

These cannot be separated: shipping the timeout without the upgrade path *is* the orphaning bug.

**The link window must extend past the timeout.** `store.ts:548-549` accepts a P45 only
`BETWEEN c.sent_at - 30s AND c.sent_at + 2 minutes`, while `store.ts:484` does not time a command
out for **3 minutes** — the window closes a full minute before the command can become `uncertain`,
so widening the accepted statuses alone changes nothing.

**Clock skew — decided.** Match on **corrected device time**, not `received_at`. The previous
revision left this open. `received_at` is server time and skew-free, but `store.ts:534-538`'s own
comment records that P45 reports are cached and delivered late — under blind-area replay a
receipt-time window would have to be hours wide, which makes it ambiguous exactly when several
commands are in flight. Instead: record each device's clock offset at handshake (the
`time_sync_request` handler in `session.ts` already has the exchange), store it on
`device_state`, and compare `le.reported_at + offset` to `c.sent_at` with a window of
`sent_at - 30s .. sent_at + 5 minutes`. Where the offset is unknown or the match is ambiguous,
attach nothing and leave the command `uncertain` — refusing to guess is the whole point.

**3. Write classification.** — defects (a) and (b).
`session.ts:82-86` returns a three-state result (`sent` / `backpressured` / `failed`) rather than
a boolean, so `session.ts:358-366` cannot collapse the distinction again. `socket.destroyed` is a
genuine failure; a `false` from `write()` is backpressure — audit it as **sent**, and await
`drain` before the next write. A pre-write `destroyed` check is not sufficient on its own: the
socket can be torn down around the write, and `write()` can throw or surface an error
asynchronously — route those to `failed`.

The lockout counter at `routes.ts:207-221` qualifies on `failure_cause`, counting device-reported
password rejections only, never transport failures and never `uncertain`. **Fixing (a) stops new
rows appearing; it does not clear existing ones** — the migration must reclassify historical
`last_error = 'socket write failed'` rows or the lockout survives the fix.

**4. Deterministic correlation.** — defect (d).
Correlate on the serial wherever the protocol carries one — `encode.ts:137-145` generates them
**specifically to distinguish commands** and `store.ts:602-605` throws them away. Note the
decoder also drops the WLNET response serial from `CommandResponseFrame`; that has to be carried
through first. Where no serial exists, refuse to resolve ambiguously: if more than one open
command matches the pattern, resolve none and mark all matches `uncertain`. Covers all three
cases — P43, P44 (including the `promotePendingPassword` race at `store.ts:678-688`), and WLNET.

**5. Sub-lock gate and arrival cancellation.** — defects (f) and (h). **Blocked on the 1.0 bench test.**
Both concern commands spawned in batches by an arrival rule.

- Sub-lock unlock relays are physical, so never auto-retried (already true via commit 2's
  `command_types` join).
- **The gate is a code gate.** `routes.ts:490-539` and `routes.ts:913-920` expose sub-lock unlock
  and the `include_sublocks` arrival option today. Add a config flag that refuses the route and
  hides the option. Master-only unlock is unaffected.
- **Retracting a shipped capability needs more than a flag** — three things the previous revision
  omitted: a migration or startup check for existing `arrival_unlocks` rows with
  `include_sublocks = true` (they must be disarmed or downgraded, not silently ignored); an
  operator-visible reason string on the 4xx, so a dispatcher is told *why* rather than seeing a
  malfunction; and a rollback path that cannot silently re-enable already-queued sub-lock commands
  when the flag flips back.
- **If the bench test says heartbeat wake does not collect a queued unlock**, there is no
  confirmation path for a sub-lock unlock at all. The feature then stays gated past Phase 1 and
  the open question becomes a vendor question, not a platform one. Do not ship an unlock whose
  execution cannot be evidenced.
- Arrival disarm must look up commands **by the rule that spawned them** — a
  `triggered_by_arrival_id` on `commands`, or a join table — not by the single
  `triggered_command_id` column, which records only the master and leaves the N sub-lock relays
  (`arrivals.ts:138-149`) with no ids recorded at all. Cancel every still-cancellable command from
  the rule and report honestly which were already beyond recall.

#### Why the timeout policy precedes the write classification

Carried forward from the previous revision, and it is correct. The two changes interact through
`requeueUnansweredCommands`, which only ever touches `status = 'sent'` (`store.ts:483`).

| After | A backpressured unlock is | Requeued? |
|---|---|---|
| today | `failed` — wrong record, feeds the lockout | no |
| write classification first | `sent` | **yes — the valve reopens** |
| timeout policy first | `failed` — still wrong, but inert | no |
| then write classification | `sent` — correct | no |

The general rule: **every commit in this sequence must be monotonically safer than the one before
it on physical actuation**, even at the cost of leaving a cosmetic or accounting defect in place
for one more commit. Check any future resequencing against that.

**Verify (whole item):** under the fleet sim,
`SELECT count(*) FROM commands WHERE status='failed' AND last_error='socket write failed'` stays
at zero; no unlock command in the run has more than one `command_sent` audit row; every P45
arriving after its command timed out is linked rather than orphaned; and no command row has
`physically_evidenced_at` set without a resolvable `physical_evidence_id`.

---

### 1.2 Session correctness under load

Dormant at two devices, constant at 3,000. Must precede anything that reads connection state as a
scaling signal, or the numbers cannot be trusted. Unchanged from the previous revision.

**`is_connected` has three writers, not two.** `session.ts:141` sets it true on identify;
`session.ts:372-374` sets it false on close **without checking it is still the registered
session**, while supersede at `index.ts:33` destroys the old socket; and
**`store.updateDeviceState` also asserts `is_connected = true`** (`store.ts:173`, in the
`ON CONFLICT DO UPDATE`). Moving only the two `session.ts` writes leaves the race unresolved,
because the ingest path keeps asserting `true`. **All three change in the same commit.**

Fix by ownership: `onIdentified` destroys the superseded socket **first**, then sets connected;
`onClosed` sets disconnected **inside** the existing `sessions.get(deviceId) === session` guard at
`index.ts:41`; `updateDeviceState` stops touching `is_connected` entirely.
Invariant: **only the registry writes `is_connected`.**

**`#onData` is unserialised.** `session.ts:65` is `socket.on('data', chunk => void this.#onData(chunk))`
— async, not awaited, no `socket.pause()`. Under DB latency two chunks run concurrently on one
socket, both observing `#deviceId === null` at `session.ts:126` (double identification), and
frames persist out of order. Chain chunks through a `#processing: Promise<void>` and
`socket.pause()` until it drains; this also gives real TCP backpressure, which 1.3 and the burst
target depend on.

**Wrap the resume in `try/finally`.** If anything throws mid-parse, an unguarded resume leaves the
socket **permanently paused** — the device stays connected, sends nothing that is ever read, and
looks alive while being deaf. Worse than a disconnect, because nothing detects it.

**Verify:** `test/session-concurrency.test.ts` — two frames in one `data` event, two `data` events
in the same tick, assert exactly one identification and in-order handling; force a throw inside
the parse loop and assert the socket is resumed. Then force 200 sim devices to reconnect while
connected and assert `SELECT count(*) FROM device_state WHERE is_connected` never dips below the
live socket count.

---

### 1.3 ACK ordering — break the retransmit amplifier

*Pulled into Phase 1 from the previous revision's deferred decisions.* **Depends on 1.2**, which
provides the serialisation and real backpressure this relies on.

`session.ts:160-171` acks a position frame only **after** `insertPosition` **and**
`updateDeviceState` — two awaited round trips against a pool of `max: 10` (`src/db.ts:13`).
Devices re-send until acknowledged. So DB latency causes retransmits, which cause more DB load,
which causes more latency. It is a positive feedback loop that engages exactly when the pool is
already saturated, and under the burst figures above it engages routinely.

The previous revision deferred this, reasoning that a DB-side `statement_timeout` bounds the
damage. It does not: `statement_timeout` bounds *one query*, and does nothing about a loop whose
output is *more inbound frames*.

**Change:** ack a position frame after decode and session validation, **before** persistence.
This is safe on the repo's own terms — `insertPosition` is idempotent on
`(device_id, reported_at, serial)`, and blind-area replay re-delivers anything genuinely lost.

**Keep the current ordering for lock events.** A lock event is physical evidence and now carries a
command's proof of execution (1.1); it is a handful of rows per device per day, so persisting
before acking costs nothing and the durability is worth having.

**Add a per-device replay admission limit** so one device dumping 480 buffered frames cannot
monopolise the pool.

**Verify:** under the sim's replay mode at the burst figure, `waitingCount` stays bounded, ack
latency stays flat, and the retransmit rate does not climb with DB latency. Inject 500ms of
artificial query latency and assert inbound frame rate does **not** increase.

---

### 1.4 Fleet-wide command expiry job

**Must precede 1.9's removal of the per-drain expiry UPDATE.** Unchanged.

The per-drain `UPDATE commands SET status='expired'` at `store.ts:419-423` is **not
"display-only"**: `/api/devices/:id/commands` selects `status` raw with no expiry computation, so
with that UPDATE gone and nothing replacing it an expired command **displays as `queued`
forever** — an operator sees a pending unlock that will never fire, with no way to tell.

Add a fleet-wide expiry pass to the sweep in `src/gateway/index.ts:73-82`, once per tick rather
than once per device drain. Only after it is live and verified may the per-drain UPDATE be removed.

**Verify:** queue a command with a short `expires_at`, let it lapse, confirm it reads `expired` in
`/api/devices/:id/commands` within one sweep interval.

---

### 1.5 Client-side batch-frame handling

`public/app.js:1905` hard-rejects any frame lacking `msg.deviceId` / `msg.device` and falls
through to `refresh()` — a full-fleet `/api/devices` refetch. Enable naive server batching first
and **every open console refetches all 3,000 devices on every flush**.

*(The previous revision made this a hard ordering constraint. It is now a soft one — see 1.6 —
but the client work is still a prerequisite for the rendering win and should land first anyway.)*

- Accept a batch frame (`{ kind, devices: [...] }`) alongside the current single-device shape.
- Keep a `Map<deviceId, HTMLLIElement>` and **patch changed rows** instead of `innerHTML = ''`
  (`app.js:503`).
- **One delegated listener** on `#device-list` reading `dataset.deviceId`, replacing 3,000
  individual `addEventListener` calls.
- **Remove the refetch amplifier** — an unknown device in a batch should be *added*, not trigger a
  full-fleet refetch. It is a positive feedback loop that fires exactly when the database is
  already struggling.
- `syncMarkers` (`app.js:441`): animate only markers in the viewport; place the rest directly.
  Touches neither `public/map.js` nor `public/map-arcgis.js` — both already sit behind the
  `setMarker`/`removeMarker` adapter.
- Make the existing search filter (`app.js:505-511`) the primary interaction. A dispatcher cannot
  read 3,000 rows.

**Verify:** Chrome performance profile at 3,000 devices and ~36 msg/sec — frame time interactive,
DOM node count flat rather than growing per message.

---

### 1.6 Batch the WebSocket push (server side)

`src/api/server.ts:142-165`: replace the per-device `setTimeout` map with a single dirty
`Map<deviceId, kind>` flushed every ~500 ms. On flush, one `fetchDevicesByIds(ids)` (new export in
`src/api/devices-query.ts`, reusing the existing `SELECT` constant with `WHERE d.device_id = ANY($1)`).
Cap the batch (~500 ids), spilling to the next flush.

The current 200 ms coalescing is *per device*, so across 3,000 distinct devices it collapses
nothing. This is batching, not caching — data is still read fresh on every flush.

**The DB win and the wire change are separable.** The previous revision treated 1.5-before-1.6 as
a hard constraint. It is not: the flush can broadcast **legacy single-device frames** from the one
batched query result. That captures the entire database saving — which is the part that matters
for capacity — with zero client dependency, and old consoles keep working. Ship the wire-level
batch frame only once 1.5 has landed. Sequence 1.5 first regardless, but the constraint is now a
preference rather than a safety requirement.

---

### 1.7 Fleet due-command query, and the index it needs

**Must precede 1.9. Depends on the migration-runner change in 1.0.**

`store.dueCommandDeviceIds()` **does not exist yet.** `src/gateway/store.ts` has
`claimPendingCommands()` (`store.ts:418`) and `requeueUnansweredCommands()` (`store.ts:479`) and no
fleet-wide due query. The query has to be designed first — including how it treats the `uncertain`
state 1.1 introduces (it must **not** pick those up) — and the index shape follows from that.

`commands_dispatch_idx` is `(device_id, not_before, requested_at)` — **device-leading**
(`migrations/004_scheduled_commands.sql:17`, which dropped and replaced the original at
`001_init.sql:238`). A fleet-wide due query has no `device_id` predicate, so it degrades to a scan
of the partial index, which grows with total command history.

In a migration file that **must not wrap itself in BEGIN/COMMIT** (note it in the file header —
this breaks the convention every other migration follows):

```sql
CREATE INDEX CONCURRENTLY commands_due_idx
  ON commands (not_before, requested_at)
  WHERE status IN ('queued','approved');
CREATE INDEX CONCURRENTLY commands_sent_idx
  ON commands (sent_at) WHERE status = 'sent';
```

The second serves `requeueUnansweredCommands` (`store.ts:479-500`), which today has no supporting
index at all.

**Verify:** `EXPLAIN (ANALYZE)` on both queries showing an index scan, not a seq or full
partial-index scan.

---

### 1.8 Listener supervision

**Must precede 1.9.** Optimising the sweep while the listener can die unnoticed just makes the
sweep a crutch for a broken dispatch path — and hides the outage it is compensating for.

`src/db.ts:24-36` opens one dedicated client and only `console.error`s on failure. If it drops,
**command dispatch silently degrades to the 60-second sweep forever**. The real failure mode is a
half-open TCP connection that never emits `'error'`, so the existing handler would never fire. Add
reconnect with capped backoff, re-`LISTEN`, an `onReconnect` callback, and a 30s `SELECT 1`
heartbeat. `src/gateway/index.ts:60` passes a callback that runs an immediate sweep;
`src/api/server.ts:184` one that broadcasts a resync nudge.

**Verify:** `pg_terminate_backend` the listener, queue an unlock, confirm it dispatches within
seconds rather than waiting for the sweep.

---

### 1.9 Remaining gateway hot path

`src/gateway/index.ts:73-82` — the 60s sweep sequentially awaits `drainCommands()` for every
session: ~6,000 statements/minute at 3,000 devices, no overlap guard.
- Add an overlap guard.
- Use the fleet due query from 1.7 to drain only the intersection with `sessions`, with **bounded
  concurrency** instead of sequential `await`.
- **Only now** remove the per-drain expiry UPDATE at `store.ts:419-423`, since 1.4 replaced it.

`src/gateway/arrivals.ts:42-69` takes a pool client plus `BEGIN`/`UPDATE`/`COMMIT` per positioned
frame even when nothing is armed — and it is awaited inside the position path, so it is on the
critical path to the ack. Add a pooled pre-check
`SELECT 1 FROM arrival_unlocks WHERE device_id=$1 AND is_armed AND expires_at > now() LIMIT 1`,
served by the existing partial index `arrival_unlocks_armed_idx`. The transactional claiming
UPDATE remains the authority, so no correctness property changes.

`store.isKnownDevice` (`store.ts:6-12`) and `store.setConnected` (`store.ts:363-374`) are two round
trips asking overlapping questions. **Merge, don't cache:** one
`INSERT INTO device_state ... SELECT ... FROM devices d WHERE d.device_id = $1 AND d.is_active ... RETURNING device_id`,
where `rowCount === 0` means not allowlisted. Update `session.ts:126-141`.
**Preserve the `config.requireKnownDevice === false` path** (`src/config.ts:31`, `session.ts:130`)
— with the allowlist disabled the gateway must still accept unknown devices, which is what makes
the simulator usable in development.

---

### 1.10 Device projection: mileage rollup and lock-event denormalisation

**Stays in Phase 1 — this is a hot-path item, not a reporting one.**
`migrations/002_live_updates.sql:20` fires `notify_device_change` on every `device_state` INSERT
**or UPDATE**; `src/api/server.ts:184-188` forwards that to `pushDeviceUpdate`, which calls
`fetchDevice()`. So the 7-day per-device mileage LATERAL at `src/api/devices-query.ts:47-63` runs
**on every position frame**. `positions_device_time_idx (device_id, reported_at DESC)`
(`001_init.sql:123`) can serve the range, but `mileage_km` is not covering, so the heap rows are
still read — ~4,000 per device per call.

- New migration: `device_mileage_daily (device_id, local_day date, first_km int, last_km int, updated_at)`,
  PK `(device_id, local_day)`.
- Maintain in `store.updateDeviceState` (`store.ts:138-196`) as one upsert using `least`/`greatest`,
  folded into the same query via CTE to keep round-trip count flat.
- Materialising `local_day` is **required**: `AT TIME ZONE '<name>'` is STABLE, not IMMUTABLE, so
  it can never be indexed on `positions` directly.
- Also fixes a live inconsistency: `week_km` currently uses a rolling 168h UTC window while
  `today_km` uses Tripoli calendar days.
- Backfill 30 days in the migration (trivial at current volume).

**Also denormalise the last lock event** onto `device_state` (`last_event_at`, `last_event_source`,
`last_event_allowed`, `last_event_command_id`), maintained in `store.insertLockEvent`. Lock events
are a handful per device per day, so the write is free and the second LATERAL at
`devices-query.ts:40-46` disappears. With both gone, `/api/devices` becomes a plain two-table scan.

**The odometer-reset policy moves to Phase 3.** `mileage_km` is a bare integer with no reset or
rollover metadata, and one reset in a day yields ~99,994 km for that truck. That is a Ministry
reporting concern and belongs with the reporting it feeds. **But it cannot simply be ignored
here**, because this item starts *storing* the rolled-up numbers: for Phase 1, detect a decrease
between consecutive readings within a day and **flag the row** (`has_anomaly boolean`), leaving
the segmentation policy to Phase 3. Nothing reportable consumes `device_mileage_daily` until then.
**Do not let `max - min` reach a report unguarded.**

**Verify:** `EXPLAIN (ANALYZE, BUFFERS)` on `fetchDevice` before and after — expect shared-hit
blocks down roughly three orders of magnitude. Unit-test the rollup against a synthetic day
containing an odometer reset and assert the anomaly flag is set.

---

### 1.11 Identity, attribution, and credential hygiene — PILOT GATE

*New in this revision.* This is the minimum that makes the audit trail mean anything. It is not
all of Phase 2 — no SSO, no fine-grained RBAC, no delegated administration. It is the slice
without which a pilot on real tankers produces records the Ministry cannot rely on.

**Today**, verified: authentication is one shared `AUTH_PASSWORD` (`src/api/config.ts:20`); the
session cookie's whole payload is the literal string `'ok'` (`src/api/config.ts:81`), so it
carries no identity whatsoever; and every audit row is attributed to `operator@${req.ip}`
(`src/api/routes.ts:1042`). One shared credential opens any valve in the fleet and nothing records
who used it.

- **Named users.** A `users` table (id, username, password hash via `scrypt` from `node:crypto` —
  no new dependency, per the repo's dependency-light posture), and a session cookie carrying the
  user id rather than `'ok'`. Keep the shared-password path only behind `AUTH_DISABLED` for
  development.
- **One role distinction, not a matrix:** may-unlock vs may-view. Unlock and sub-lock routes
  require the former. Everything else follows in Phase 2.
- **Real attribution.** `actorOf()` (`routes.ts:1042`) returns the authenticated user id; keep the
  IP as a separate audit field rather than as the identity. Backfill existing rows as
  `unknown-legacy` rather than leaving them ambiguous.
- **Rate limiting** on login and on unlock — per user and per IP.
- **`AUTH_DISABLED` must be impossible in production.** It currently opens the UI *and the unlock
  endpoint* on an env var (`config.ts:17`). Refuse to start when it is set together with any
  non-development marker.
- **Redact credential material.** `commands.payload` carries unlock and password material
  (`routes.ts:230`, `routes.ts:366`) and `command_sent` audit details embed the full payload
  (`session.ts:361`). Redact at write time for `set_password` / `query_password` and for unlock
  payloads. *(Schema-level redaction of historical rows stays in Phase 4; this stops new ones.)*

**Verify:** two operators unlocking the same truck produce two distinguishable audit rows; a
view-only user gets 403 on `/unlock`; the app refuses to start with `AUTH_DISABLED=true` outside
development; no `commands.payload` or audit row written after this lands contains a password in
clear.

---

### 1.12 Capacity guardrails

- `deploy/zee-gateway.service`, `deploy/zee-api.service`: `LimitNOFILE=65535`.
  **Verify the current effective value first** — Node raises `RLIMIT_NOFILE` soft to hard at
  startup and systemd ≥240 defaults to `1024:524288`, so the predicted EMFILE-at-1000 may not
  apply: `cat /proc/$(systemctl show -p MainPID --value zee-gateway)/limits | grep 'open files'`.
- `src/gateway/index.ts:46-49` calls `process.exit(1)` on *any* server error. Under
  `Restart=always` one transient accept error becomes a crash loop, each restart running a
  3,000-row `clearAllConnections` and inviting the reconnect stampede that 1.3 is sized for. Split:
  listen-time failures (EADDRINUSE) fatal; post-listen accept errors (EMFILE, ECONNABORTED) logged
  and swallowed.
- `src/gateway/index.ts:113`: pass `backlog: 1024` (Node default 511). Add
  `/etc/sysctl.d/60-zee.conf` via `deploy/install.sh`: `net.core.somaxconn=4096`,
  `net.ipv4.tcp_max_syn_backlog=8192`.
- `src/db.ts:11-15`: env-tunable `max` (gateway 25, API 15 — **sized against the burst target, not
  the steady one**), `connectionTimeoutMillis: 5000`, per-process `application_name` so
  `pg_stat_activity` is readable. Enforce statement timeouts DB-side —
  `ALTER ROLE zee_app SET statement_timeout = '15s'`, `idle_in_transaction_session_timeout = '30s'`
  — with maintenance raising it via `SET LOCAL`.
- `deploy/install.sh`: write `/etc/postgresql/<ver>/main/conf.d/60-zee.conf` — `shared_buffers`,
  `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `max_wal_size`,
  `checkpoint_timeout=15min`, `wal_compression=on`, `random_page_cost=1.1`,
  `log_min_duration_statement=1000`, `shared_preload_libraries='pg_stat_statements'`, lowered
  `autovacuum_vacuum_scale_factor` for `positions` and `commands`.

---

## Verification sequence

1. **Baseline.** Fleet sim at 3,000 devices / 30s against staging, **plus one replay-burst run**.
   Record `/api/health` (`waitingCount`, sweep duration), `pg_stat_statements` top queries, and a
   Chrome profile with a console open.
2. **1.0** — bench test answered and recorded; migration runner survives a kill between the
   migration and its `schema_migrations` insert.
3. **1.1** — verify per commit, in order.
   *Commit 1:* every reader of `commands.status` renders and routes `uncertain` correctly; no raw
   English reaches the console; a `confirmed` command cannot be moved to `failed`; every command
   type used anywhere in the codebase is registered in `command_types`.
   *Commit 2:* an unanswered unlock ends `uncertain` with exactly one `command_sent`, and a P45
   arriving afterwards upgrades it to `confirmed` **and populates the evidence columns** rather
   than being orphaned — tested at the old 2-minute boundary, at the 3-minute timeout, and with a
   device clock skewed several minutes in each direction. Assert no physical command is ever
   returned to `queued`.
   *Commit 3:* a mocked socket whose `write()` returns `false` does **not** call
   `markCommandFailed` and **does** write the `command_sent` audit row; a throwing `write()` does
   record failed; two historical `'socket write failed'` rows no longer block `/unlock`. Re-run
   commit 2's double-unlock assertion here — this is the boundary where an ordering mistake shows.
   *Commit 4:* two open P43s and one response confirm neither; a concurrent `set_password` and
   `query_password` resolve to the right rows; WLNET responses match on serial.
   *Commit 5:* a sub-lock unlock is never auto-resent; disarming a rule that has already fired
   cancels every still-cancellable command it spawned, master and sub-locks alike; an existing
   `include_sublocks` rule is handled explicitly by the migration.
4. **1.2** — concurrency tests incl. the throw-and-resume case; `is_connected` never dips below
   live socket count during a 200-device reconnect storm.
5. **1.3** — under replay burst, `waitingCount` bounded and inbound frame rate does **not** rise
   with injected query latency.
6. **1.4** — an expired command reads `expired`, not `queued`.
7. **1.5** — frame time interactive, DOM node count flat.
8. **1.6** — `fetchDevice` call rate drops from ~36/sec to ~2/sec.
9. **1.7** — `EXPLAIN (ANALYZE)` shows index scans for both new indexes.
10. **1.8** — kill the listener; queued unlock still dispatches within seconds.
11. **1.9** — sweep duration bounded and non-overlapping; `waitingCount` stays zero on the
    500 → 1500 → 3000 ramp.
12. **1.10** — buffer counts down ~3 orders of magnitude; anomaly flag set across a synthetic
    odometer reset.
13. **1.11** — two operators produce distinguishable audit rows; view-only user gets 403 on
    `/unlock`; no new clear-text credential material in `commands.payload` or `audit_log`.
14. **1.12** — `nstat -az TcpExtListenOverflows`, `/proc/PID/limits`,
    `SELECT state, count(*) FROM pg_stat_activity GROUP BY 1`.
15. `npm test` and `npm run typecheck` clean.

---

## What moved out of Phase 1

| Item | Moved to | Why |
|---|---|---|
| Odometer-reset segmentation policy | Phase 3 | Reporting semantics; belongs with the Ministry reporting it feeds. Phase 1 still flags anomalies so nothing silently wrong is stored. |
| Partition automation (was 1.11) | Phase 4 | Headroom to 2027-09-01, and it is the foundation retention needs. The migration-runner half stays in 1.0 — 1.7 depends on it. |

---

## Maintenance windows and irreversibility

Phase 1 needs **one Postgres restart** for `shared_buffers` and `shared_preload_libraries` —
seconds. With partition automation moved out there is no longer DDL to bundle it with, so schedule
it with the 1.12 deploy. Everything else is a rolling service restart; devices reconnect on their own.

**Nothing in Phase 1 is irreversible.** No data deleted, no column dropped. The destructive items
— partition retention, `DROP COLUMN status_flags`, historical `commands.payload` redaction — are
deferred to Phases 3 and 4 and need explicit sign-off.

One caveat: **1.11's credential redaction is one-way for new rows.** That is intended, but it
means a payload written after it lands cannot be recovered for debugging. Confirm nothing
operational depends on reading back an unlock payload.

---

## Deferred decisions

- **Company attribution.** Monitoring is Ministry-only, so no login boundary is needed now. Still
  add `devices.company_id` in Phase 3 rather than later — cheap now, a schema change against a live
  3,000-device database is not. Confirm whether the unit is company, depot, or region.
- **Retention.** "Keep everything, decide later." Phase 4 builds the partition-drop function but
  leaves it **warn-only** unless `POSITIONS_RETENTION_MONTHS` is explicitly set. Confirm whether
  Libyan fuel logistics carries a statutory retention floor before enabling.
- **`status_flags` storage.** The single biggest storage lever — roughly two-thirds of every row,
  already recoverable from two raw bytes via `decodeDeviceStatus` (`decode-binary.ts:87`). Measure
  before committing: `SELECT avg(pg_column_size(status_flags)) FROM positions TABLESAMPLE SYSTEM (1);`
- **JT709 heartbeat volume.** If the 1.0 bench test says heartbeat wake *does* collect a queued
  unlock, per-peripheral enablement becomes the resolution to the tension with Phase 4 — but size
  it first: 3,000 armed sub-locks at a 60s heartbeat is 4.32M rows/day into an **unpartitioned
  heap** (`007_sub_devices.sql:35-53`), and 864k/day at 300s, before multiple valves per tanker.
  A heartbeat **lease with a TTL and auto-disable** — enabled only while a sub-lock is armed for
  unlock, not permanently — is the shape that keeps this bounded. Decide with Phase 4, not separately.
- **`sub_device_readings` and `audit_log` partitioning** are Phase 4, but both are "rewrite now
  while small" items. **Do not enable JT709 heartbeats fleet-wide before Phase 4 lands.**

---

## Open questions — answer before starting

1. **Does the JT709 bench test (1.0) block the start of Phase 1, or only commit 5 of 1.1?**
   Recommendation: only commit 5. Everything else proceeds in parallel.
2. **Is the 1.11 identity slice the right size?** It is deliberately minimal — named users, one
   role split, attribution, rate limiting, redaction. If the Ministry has an existing identity
   system to integrate with, that changes the shape and should be known now rather than after
   `users` exists.
3. **Is a pilot on real tankers happening before Phase 5?** If yes, the "missing" items surfaced
   in review and *not* addressed here need their own decision: no cryptographic device
   authentication on the TCP protocol (the cleartext device allowlist is the only gate), a mutable
   `audit_log` with no tamper-evidence, no emergency fleet-wide unlock kill-switch, and no tested
   backup/restore. None are in Phase 1. At least the kill-switch and tested backups are cheap.

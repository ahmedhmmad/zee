> **SUPERSEDED — do not execute.** This is the fourth-round revision, kept for
> history because the design it proposes (a per-command-type state machine) is
> superficially attractive and was rejected for concrete reasons. The plan in force
> is [`scaling-plan.md`](scaling-plan.md); its "What changed, and why" section
> argues against this document point by point.

# Scaling the Zee lock platform from 2 devices to 3,000

## Context

The MVP is field-proven on two trucks in Tripoli. A Libyan operator now wants ~3,000
JT701D masters in service. Trucks belong to several haulage companies, but **monitoring
happens only from the Ministry dashboard** — so companies are an attribute for grouping
and reporting, not a login boundary. That removes per-tenant isolation from the critical
path.

Four rounds of review changed what this plan leads with.

- **The partition cliff is not imminent.** `migrations/001_init.sql` was first committed
  2026-08-05 and pre-creates 13 monthly partitions, so `positions` has headroom to
  **2027-09-01**. It still needs automating, but on a normal schedule.
- **The first *scaling* wall is the browser, not the database.** `public/app.js:1897-1915`
  runs `renderDeviceList()` on every WebSocket message, and that rebuilds every `<li>` and
  re-registers every listener (`app.js:503`).
- **But the first thing to fix is not a scaling issue at all.** The `commands` table conflates
  facts that are not the same fact — *bytes accepted by a socket*, *the device acknowledging a
  command*, and *the lock physically moving*. **Eight** defects fall out of that conflation and
  the lifecycle around it: a delivered
  unlock recorded as failed (`session.ts:363-365`); those false-failure rows then locking the
  truck out of unlocking altogether (`routes.ts:207-221`); one authorisation producing up to
  three physical unlocks (`store.ts:479`); a late response resolving the wrong command across
  P43, P44 and WLNET (`store.ts:571-578`); a terminal state being overwritten
  (`store.ts:502-506`); a sub-lock unlock that can never confirm and is therefore retried
  (`session.ts:244-249`); late physical evidence being discarded because it arrives after the
  command left `sent` (`store.ts:546`, `store.ts:656`); and arrival disarm silently cancelling
  nothing once the rule has fired (`routes.ts:953-975`). All are live today, rare at 2 devices
  and routine at 3,000. They ship first, as **five sequenced commits** — an earlier revision said
  one commit, which was wrong for a diff that touches the schema, both services and the console.

**Multi-instance is an availability need, not a throughput one.** 3,000 devices is ~36
frames/sec average; one Node process handles that comfortably once per-frame overhead is
removed. HA belongs last.

### Load target — assumptions stated explicitly

Fleet policy is **mixed**: fast while moving, asleep when parked. This is largely native to
the hardware — vibration holds a moving truck awake, a parked one sleeps on its 30-minute
RTC timer. It is a `P04` commissioning change, not new platform capability.

| Assumption | Value |
|---|---|
| Devices | 3,000 |
| Awake reporting interval | 30s while moving |
| **Duty cycle** | **8h/day driving = 33%** — not all 3,000 are ever active at once |
| Rows per device per day | 1,024 (960 driving + 64 idle wakes) |
| Fleet rows/day | 3.07M |
| Average inserts/sec | 36 |
| **Peak inserts/sec** (whole fleet moving) | **100** |

Row size, which the previous revision of this plan got wrong:

| | Bytes |
|---|---|
| All columns except `status_flags` | ~160 |
| `status_flags` jsonb | 250-330 — the fifteen boolean **key names**; the booleans are free |

| Annual storage | Heap | Indexes | Total |
|---|---:|---:|---:|
| As-is | 505 GB | 90 GB | **594 GB** |
| After dropping the redundant index (Phase 4) | 505 GB | 45 GB | 549 GB |
| After `status_flags` → 2 smallints (Phase 4) | 185 GB | 45 GB | **230 GB** |

The earlier figure of 336 GB/yr implied ~297 B/row — less than `status_flags` alone, and
internally inconsistent with this plan's own deferred-decisions section. Corrected above.

Phase 1 targets 30s awake comfortably and 15s with headroom. 5s fleet-wide (~1.9 TB/yr) is
a different system and is explicitly out of scope.

---

## Phase breakdown

| Phase | Goal | Gates |
|---|---|---|
| **1. Correctness & capacity** | Fix the command lifecycle, then make one server hold 3,000 devices | — |
| **2. Identity & accountability** | Named users, roles, real audit attribution, login rate limiting | Blocks rollout |
| **3. Fleet operations** | Company grouping, bulk onboarding, pagination, alarm workflow, Ministry reporting | Blocks rollout past a pilot |
| **4. Storage economics** | `status_flags` raw bytes, drop redundant index, partition `sub_device_readings` and `audit_log`, retention | Do the "while small" items before JT709 heartbeats go fleet-wide |
| **5. Resilience** | Multi-instance gateway, DB replica, monitoring, staging | Before full rollout |

**This plan details Phase 1 only.**

**Open scope decision.** Phase 1 grew this round: item 1.1 is now eight defects across five
commits. Review advice is to cut **1.9** (mileage rollup and odometer policy) and **1.11**
(partition automation) out of Phase 1 to make room — 1.9 moves to Phase 3 where the Ministry
reporting it feeds is built, and 1.11 has headroom to 2027-09-01. That would leave Phase 1 as
command safety, session correctness, the client and server batching, the due-command query,
listener supervision, the sweep, and the capacity guardrails. **Not applied — decide before
starting.** Note that the migration-runner part of 1.11 has already moved to 1.0 and stays there
either way, because 1.6 depends on it.

---

## Phase 1

Ordered by dependency, not by size. Items 1.1-1.6 have hard sequencing constraints: each
must land before the item that follows it is safe to enable.

### 1.0 Prerequisites (nothing below is verifiable without these)

- **`scripts/simulate-fleet.ts`** — N in-process sockets, configurable ramp and interval.
  Reuse `buildPositionFrame`/`buildLockEvent` from `scripts/build-frames.ts` and
  `src/protocol/framer.ts`; extend `scripts/simulate-device.ts` rather than duplicating it.
  **Never seed fake IDs into a production `devices` table** — the allowlist is the only
  authentication this protocol has. Needs a staging database.
- **`GET /api/health`** in `src/api/routes.ts` (add to `isPublic()`, bind-restricted):
  `pool.totalCount/idleCount/waitingCount`, `sessions.size`, listener-connected, last sweep
  duration, oldest queued command age, `SELECT count(*) FROM ONLY positions_default`,
  partition headroom in months. A non-zero `waitingCount` *is* the silent pool queue.
- **Test seam** — `src/gateway/session.ts:12` does `import * as store`. Make it
  constructor-injectable (defaulting to the module) so gateway concurrency becomes testable.
  `test/` currently covers protocol decode only.
- **Migration runner: non-transactional support and an advisory lock.** Moved here from 1.11
  because **1.6 cannot land without it**. `scripts/migrate.ts:51-52` sends each migration file
  as one query string and records the filename in a second, unlocked statement — so a crash
  between them silently re-runs a migration. It also means `CREATE INDEX CONCURRENTLY` cannot
  work: Postgres wraps a multi-statement simple query in an **implicit** transaction, so removing
  `BEGIN`/`COMMIT` from the file is not sufficient on its own. Add `pg_advisory_lock`, and
  either split non-transactional migrations into one statement per round trip or mark them so the
  runner sends their statements individually. Document that new migrations must be idempotent.

---

### 1.1 — PRIORITY — Command lifecycle: transport state is not device state

**Live correctness bugs, not scaling issues.** Rare at 2 devices, routine at 3,000.

The `commands` table conflates facts that are not the same fact — *bytes accepted by a socket*,
*the device acknowledging a command*, and *the lock physically moving*. **Seven** defects fall out
of that, catalogued as (a)-(g) below.

An earlier revision of this plan said they must land as one commit. **That was wrong** — the
resulting diff touches the schema, both services, and the console, and is too large to review
safely on a system that opens valves. They land as **five sequenced commits**, mapped at the end
of this item. What is true is that no commit may leave the lifecycle in a worse hybrid than it
started; each one below is chosen to be independently coherent.

#### First, settle what `confirmed` means

This is a precondition on everything else, and the current code is ambiguous about it. An unlock
is moved to `confirmed` by the **P43/P52 command response** (`session.ts:323-345`) — that is the
device acknowledging the command word. The **P45 lock event**, which is the device reporting that
the lock actually moved, is linked separately and afterwards (`store.ts:522-550`). Those are
different claims, and the console currently presents the first as
`تم التأكيد من الجهاز` (`app.js:122`), which an operator will read as *the valve opened*.

**Recommendation: split them — but only for commands that can produce physical evidence.**
`acknowledged` = the device answered the command word. `confirmed` = physical movement evidenced
(P45 for a master, peripheral `locked === false` for a sub-lock). On a fuel tanker that
distinction is the entire safety argument: it is the difference between an audit trail the
Ministry can rely on and one that merely records intent. It touches the same readers as
`uncertain`, so it belongs in the same vocabulary commit — not a later one.

**The split must not be applied to every command type.** Of the nine types in use, only three are
physical:

| Type | Physical? | Terminal success is |
|---|---|---|
| `unlock_static`, `unlock_dynamic` | yes | a P45 lock event links to the command |
| `unlock_sublock` | yes | the peripheral reports `locked === false` |
| `query_position`, `set_password`, `query_password`, `set_autolock`, `query_autolock` | no | the device's own response |

A settings or query command has no physical movement to evidence — `linkEventToCommand` is only
ever called from the `lock_event` case (`session.ts:195`). So if `confirmed` universally required
physical evidence, **five of the nine types could never reach a terminal state at all**. They
would sit at `acknowledged` indefinitely, and under the retry column be resent until attempts ran
out. An earlier revision of this plan had exactly that defect.

The lifecycle is therefore **per type**:

| | Non-physical types | Physical types |
|---|---|---|
| on the wire | `queued` → `sent` | `queued` → `sent` |
| device answers the command word | → `confirmed` *(terminal)* | → `acknowledged` |
| physical evidence arrives | n/a | → `confirmed` *(terminal)* |
| nothing arrives in the window | → retry, up to 3 attempts | → `uncertain`, **never auto-retried** |
| device refuses, or socket destroyed before the write | → `failed` *(terminal)* | → `failed` *(terminal)* |

`acknowledged` therefore exists **only** for physical types. For everything else the state machine
is exactly as it is today — which is also what keeps commit 1 inert for the majority of traffic.

**`uncertain` is not terminal for evidence, only for retry.** Late evidence must still be able to
upgrade it to `confirmed`. See (g).

---

**(a) A delivered unlock recorded as failed.**

`session.ts:82-86`:
```ts
send(payload: Buffer | string): boolean {
  if (this.socket.destroyed) return false;
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
  return this.socket.write(buf);
}
```
`session.ts:358-366`:
```ts
if (this.send(cmd.payload)) { ...audit 'command_sent'... }
else { await store.markCommandFailed(cmd.id, 'socket write failed'); }
```

`socket.write()` returns `false` when the internal buffer crosses the high-water mark (16 KB
default). **The data is still queued and still delivered.** So on a busy or slow link the unlock
reaches the device, the lock physically opens, and the platform records `command_failed` with no
`command_sent` audit row — an accountability record contradicting physical reality, and precisely
the record the Ministry would rely on.

**Fix:** return a three-state result (`sent` / `backpressured` / `failed`) rather than a boolean,
so the caller cannot collapse the distinction again. `this.socket.destroyed` (`session.ts:83`) is
a genuine failure. A `false` from `write()` is backpressure — audit it as sent, and await `drain`
before the next write so a burst does not grow the buffer unbounded. **A pre-write `destroyed`
check is not sufficient on its own:** the socket can be torn down around the write, and `write()`
can throw or surface an error asynchronously. Route a thrown or callback error to `failed`, not
to `sent`.

---

**(b) A backpressured write locks that truck out of unlocking, permanently.**

`src/api/routes.ts:207-221` refuses to queue an unlock once a device has two or more `failed`
unlock commands since its password was last changed:

```sql
AND c.command_type IN ('unlock_static', 'unlock_dynamic')
AND c.status = 'failed'
```

That guard exists to catch a wrong stored password before the device raises its own alarm. But
(a) writes exactly such a row for a command that **succeeded**. Two backpressure events on one
truck and `/unlock` returns `409 repeated_password_failures` for that truck from then on —
diagnosing a password fault that does not exist, and pointing the operator at a "fix" (correcting
the password, which resets `password_updated_at`) for a password that was always right. At 3,000
devices, where backpressure is routine, trucks lock themselves out progressively.

**Fix:** the counter must qualify on cause, not just status — count device-reported password
rejections only, never transport failures, and never `uncertain`. Fixing (a) stops new rows
appearing; **it does not clear existing ones.** The migration must reclassify or clear historical
`last_error = 'socket write failed'` rows, or the lockout survives the fix.

---

**(c) One authorisation, up to three physical unlocks.**

`store.ts:479-487` returns any command still `sent` after three minutes to `queued`, up to three
attempts, **with no filter on command type**. `claimPendingCommands` re-sends it
(`store.ts:425-440`) and the sweep drains it (`index.ts:73-81`). The device auto-locks about a
minute after opening, while asleep — `session.ts:328` says so.

So: unlock delivered, valve opens, the P45 confirmation is lost on the carrier link, the lock
re-closes on its own timer, and three minutes later the platform opens it again. Up to three
openings from one operator action — the last two unattended, and possibly in transit.

**Fix:** physical types never return to `queued`. On timeout they move to `uncertain`, the console
shows *may have executed*, and only an explicit human reissue creates a new command row.

---

**(d) A late response can resolve the wrong command — and it is not only P43.**

`resolveCommandFromResponse` (`store.ts:571-578`) matches on
`status = 'sent' AND payload LIKE ANY(...) ORDER BY sent_at DESC LIMIT 1`. Its doc comment claims
this resolves "a P44 response and nothing else" — true across *different* command words, but it
does not disambiguate two commands sharing one word. Three cases:

- **P43.** Every static unlock produces one (`session.ts:281-286`). An operator manual unlock and
  an arrival unlock can be in flight for the same truck simultaneously.
- **P44.** `promotePendingPassword` (`store.ts:678-688`) picks the latest `sent` `set_password`
  *before* `resolveCommandFromResponse` resolves the actual row (`session.ts:303-320`). A
  concurrent `query_password` and `set_password` can confirm the wrong row, or strand password
  adoption entirely — leaving the platform holding a password the lock does not have.
- **WLNET.** `encode.ts:137-145` generates serials **specifically to distinguish commands**, and
  `store.ts:602-605` matches on the command word and throws the serial away. WLNET,1 / 8 / 18
  ambiguity becomes routine at fleet scale.

**Fix:** correlate on the serial wherever the protocol carries one — that is what it is for.
Where it does not, refuse to resolve ambiguously: if more than one open command matches the
pattern, resolve none and mark all matches `uncertain`. Guessing is worse than admitting
ignorance on a valve.

---

**(e) `markCommandFailed` can un-confirm a confirmed command.**

`store.ts:502-506` updates by id with **no status guard**, so a late transport error racing a
device response can move `confirmed` back to `failed` — and, via (b), count that against the
password lockout.

**Fix:** `WHERE id = $1 AND status NOT IN ('confirmed','failed')`.

---

**(f) A sub-lock unlock can never confirm, so it is retried until attempts run out.**

`session.ts:244-249` is explicit: *"the WLNET,8 response is a bare echo from the master with no
success flag in it"*. A valve unlock is confirmed only when the peripheral independently reports
`locked === false`. But JT709 LoRa heartbeats are **default-off**
(`009_bound_peripherals.sql:3-7`) — so for a sub-lock that is not heartbeating, that evidence
never arrives. The command sits at `sent` and (c) resends it.

Arrival unlock queues one master unlock plus N sub-lock relays (`arrivals.ts:87-149`), so this is
the multiplied case — on the valve locks that are the actual petrol use case.

**Fix:** sub-lock unlock relays are a physical type, so never auto-retried. Where confirmation
depends on a heartbeat, require the heartbeat enabled on that peripheral before a sub-lock unlock
may be armed.

**Gate — and it must be a code gate.** `routes.ts:490-539` and `routes.ts:913-920` already expose
sub-lock unlock and the `include_sublocks` arrival option. Writing "do not enable it in the pilot"
gates nothing. Add an explicit config flag that refuses the route and hides the option until this
item lands. Master-only unlock is unaffected.

---

**(g) `uncertain` orphans the evidence that would resolve it — and late evidence is already
discarded today.**

Two functions match on a hardcoded status:

- `linkEventToCommand` (`store.ts:546`) requires `c.status = 'confirmed'` before attaching a P45
  lock event.
- `confirmSubLockUnlock` (`store.ts:656`) requires `status = 'sent'`.

So a command that times out to `uncertain` can never have its late P45 or peripheral report
attached — the exact physical evidence that resolves the uncertainty is discarded on arrival. A
state introduced to stop the platform guessing would instead guarantee permanent ignorance.

This is also a defect **today**, before any of the above lands: `linkEventToCommand` only links a
P45 to a command that already reached `confirmed`, so any unlock whose command response was lost
has its lock event orphaned even now.

**Fix:** both must accept the open states (`sent`, `acknowledged`, `uncertain`) and **upgrade** to
`confirmed` on evidence. `uncertain` blocks retry; it must not block truth arriving late.

**The existing windows will not carry that, and one of them is measured across two clocks.**
`linkEventToCommand` matches only
`le.reported_at BETWEEN c.sent_at - interval '30 seconds' AND c.sent_at + interval '2 minutes'`
(`store.ts:548-549`), while `requeueUnansweredCommands` does not time a command out until three
minutes (`store.ts:484`). The link window therefore closes a full minute **before** the command can
even become `uncertain` — so widening the accepted statuses alone changes nothing. The window has
to extend past the timeout, or the upgrade path is unreachable.

It is also a cross-clock comparison: `le.reported_at` is the **device's** timestamp and
`c.sent_at` is **server** time, with thirty seconds of tolerance absorbing the difference. These
devices sleep on an RTC and drift — `session.ts` carries a `time_sync_request` handler for exactly
that reason. At 3,000 devices a fraction will have skew beyond the window, and their lock events
will fail to link for reasons that have nothing to do with the unlock. Either match on
`received_at` (server time, so no skew) with a window sized for blind-area replay, or record each
device's clock offset at handshake and correct for it. **Decide which — this is a real choice, not
a detail.**

`confirmSubLockUnlock` needs only the status widening: its window is
`sent_at > now() - interval '30 minutes'` (`store.ts:661`) and compares server time to server time.

---

**(h) Arrival disarm cancels nothing once the rule has fired.**

Not part of the same conflation, but it is in the same lifecycle and is broken today.
`arrivals.ts:56` sets `is_armed = false` the moment the geofence triggers. The disarm route then
runs:

```sql
UPDATE arrival_unlocks SET is_armed = false
 WHERE id = $1 AND device_id = $2 AND is_armed
 RETURNING triggered_command_id
```

Once fired, `is_armed` is already false, so this matches **zero rows**, `triggered_command_id`
comes back undefined, and nothing is cancelled — while the route returns success and audits
`cancelledCommand: null` (`routes.ts:953-975`). The comment directly above it states the intent
is to cancel a command that is queued but not yet delivered; the guard makes that unreachable in
exactly the window it was written for.

Worse with sub-locks: `triggered_command_id` is a single column, and the N sub-lock commands
(`arrivals.ts:138-149`) have no ids recorded at all, so even a corrected version would cancel
only the master and silently leave the valve relays queued.

**Fix:** disarm must look up commands by the rule that spawned them, not by a single stored id —
a `triggered_by_arrival_id` on `commands`, or a join table. Cancel every still-cancellable
command from that rule, and report honestly which ones were already beyond recall.

---

#### How this lands — five commits, in order

1. **Vocabulary only, no behaviour change.** Migration adding `acknowledged` and `uncertain` to
   the `status` CHECK constraint (`001_init.sql:219` — **`uncertain` cannot be written at all
   until this lands**, so every later commit depends on it); a failure-cause column or
   classification so (b) can distinguish transport from password rejection; the Arabic labels and
   severity classes in `COMMAND_STATUS` (`app.js:118-128`, which today falls back to raw English
   at `app.js:699`); the corrected state-machine comment at `001_init.sql:214-216`; and tests over
   every reader of `commands.status` asserting the new states render and route correctly.
2. **Type-aware timeout policy** — (c), together with (g)'s late-evidence upgrade and the widened
   link window. These two cannot be separated: shipping the timeout without the upgrade path is
   the orphaning bug.
3. **Write classification and terminal guards** — (a) and (e), plus reclassifying historical
   `'socket write failed'` unlock rows so (b)'s lockout clears.
4. **Deterministic correlation** — (d), all three cases, serial-based where available.
5. **Sub-lock gate and arrival cancellation** — (f) and (h) together, since both concern commands
   spawned in batches by an arrival rule.

**Why the timeout policy precedes the write classification, and not the other way round.**
An earlier revision had these as 2 and 3 respectively. That order is **unsafe**, because the two
changes interact through `requeueUnansweredCommands`, which only ever touches `status = 'sent'`
(`store.ts:483`).

Today a backpressured unlock is written `failed` by (a), and `failed` is not a status the requeue
looks at — so the record is wrong and it poisons (b)'s lockout, but **the valve does not reopen**.
Fixing the write classification first changes that row to `sent` while the untyped retry is still
live, so it is picked up and resent. Commit 2 in that order would convert a false record into a
live double-unlock, on precisely the backpressure case (a) exists to fix.

Landing the timeout policy first is strictly safer at every point:

| After | A backpressured unlock is | Requeued? |
|---|---|---|
| today | `failed` — wrong record, feeds the lockout | no |
| write classification first | `sent` | **yes — the valve reopens** |
| timeout policy first | `failed` — still wrong, but inert | no |
| then write classification | `sent` — correct | no |

The general rule this is an instance of: **every commit in this sequence must be monotonically
safer than the one before it on physical actuation**, even at the cost of leaving a cosmetic or
accounting defect in place for one more commit. Check any future resequencing against that.

**Verify (whole item):** under the fleet sim,
`SELECT count(*) FROM commands WHERE status='failed' AND last_error='socket write failed'` stays
at zero; no unlock command in the run has more than one `command_sent` audit row; and every P45
arriving after its command timed out is linked rather than orphaned.

---

### 1.2 Session correctness under load

Dormant at two devices, constant at 3,000. Must precede anything that reads connection state
as a scaling signal, or the numbers cannot be trusted.

**`is_connected` has three writers, not two.**
- `session.ts:141` sets it true on identify
- `session.ts:372-374` sets it false on close, **without checking it is still the registered
  session** — while supersede at `index.ts:33` destroys the old socket
- **`store.updateDeviceState` also sets it true** — in the column list and as
  `is_connected = true` in the `ON CONFLICT DO UPDATE` (`src/gateway/store.ts:173`)

Moving only the two `session.ts` writes into `index.ts` leaves the race unresolved, because
`updateDeviceState` keeps asserting `true` from the ingest path. **All three must change in
the same commit.**

Fix by ownership: `onIdentified` destroys the superseded socket **first**, then sets
connected; `onClosed` sets disconnected **inside** the existing
`sessions.get(deviceId) === session` guard at `index.ts:41`; `updateDeviceState` stops
touching `is_connected` entirely. Invariant: **only the registry writes `is_connected`.**

**`#onData` is unserialised.** `session.ts:65` is
`socket.on('data', chunk => void this.#onData(chunk))` — async, not awaited, no
`socket.pause()`. Under DB latency two chunks run concurrently on one socket, both observing
`#deviceId === null` at `session.ts:126` (double identification), and frames persist out of
order. Chain chunks through a `#processing: Promise<void>` and `socket.pause()` until it
drains; this also gives real TCP backpressure.

**Wrap the resume in `try/finally`.** If anything throws mid-parse, an unguarded resume
leaves the socket **permanently paused** — the device stays connected, sends nothing that is
ever read, and looks alive while being deaf. Worse than a disconnect, because nothing
detects it.

**Verify:** `test/session-concurrency.test.ts` — two frames in one `data` event, two `data`
events in the same tick, assert exactly one identification and in-order handling; force a
throw inside the parse loop and assert the socket is resumed. Then force 200 sim devices to
reconnect while connected and assert `SELECT count(*) FROM device_state WHERE is_connected`
never dips below the live socket count.

---

### 1.3 Fleet-wide command expiry job

**Must precede 1.8's removal of the per-drain expiry UPDATE.**

The per-drain `UPDATE commands SET status='expired'` at `store.ts:419-423` is **not
"display-only"**. `/api/devices/:id/commands` selects `status` raw from the table with no
expiry computation, so with that UPDATE gone and nothing replacing it an expired command
**displays as `queued` forever** — an operator sees a pending unlock that will never fire,
with no way to tell.

Add a fleet-wide expiry pass to the sweep in `src/gateway/index.ts:73-82`, running once per
tick rather than once per device drain. Only after it is live and verified may the per-drain
UPDATE be removed.

**Verify:** queue a command with a short `expires_at`, let it lapse, confirm it reads
`expired` in `/api/devices/:id/commands` within one sweep interval.

---

### 1.4 Client-side batch-frame handling

**Must precede 1.5's server-side batching.**

`public/app.js:1905-1907` hard-rejects any frame lacking `msg.deviceId` / `msg.device` and
falls through to `refresh()` — a full-fleet `/api/devices` refetch. Enable server batching
first and **every open console refetches all 3,000 devices on every flush**, strictly worse
than the problem being solved.

Client work first, as a superset of the rendering fix:
- Accept a batch frame (`{ kind, devices: [...] }`) alongside the current single-device shape.
- Keep a `Map<deviceId, HTMLLIElement>` and **patch changed rows** instead of
  `innerHTML = ''` (`app.js:503`).
- **One delegated listener** on `#device-list` reading `dataset.deviceId`, replacing 3,000
  individual `addEventListener` calls.
- **Remove the refetch amplifier** — an unknown device in a batch should be *added*, not
  trigger a full-fleet refetch. It is a positive feedback loop that fires exactly when the
  database is already struggling.
- `syncMarkers` (`app.js:441`): animate only markers in the viewport; place the rest
  directly. Touches neither `public/map.js` nor `public/map-arcgis.js` — both already sit
  behind the `setMarker`/`removeMarker` adapter.
- Make the existing search filter (`app.js:505-511`) the primary interaction. A dispatcher
  cannot read 3,000 rows.

**Verify:** Chrome performance profile at 3,000 devices and ~36 msg/sec — frame time
interactive, DOM node count flat rather than growing per message.

---

### 1.5 Batch the WebSocket push (server side)

`src/api/server.ts:142-165`: replace the per-device `setTimeout` map with a single dirty
`Map<deviceId, kind>` flushed every ~500 ms. On flush, one `fetchDevicesByIds(ids)` (new
export in `src/api/devices-query.ts`, reusing the existing `SELECT` constant with
`WHERE d.device_id = ANY($1)`) and one broadcast frame. Cap the batch (~500 ids), spilling to
the next flush.

The current 200 ms coalescing is *per device*, so across 3,000 distinct devices it collapses
nothing. This is batching, not caching — data is still read fresh on every flush.

---

### 1.6 Fleet due-command query, and the index it needs

**Must precede 1.8.**

**`store.dueCommandDeviceIds()` does not exist yet.** `src/gateway/store.ts` has
`claimPendingCommands()` (`store.ts:418`) and `requeueUnansweredCommands()` (`store.ts:479`)
and no fleet-wide due-device query. So this item is not "add an index before using an existing
function" — the query has to be designed first, including how it treats the `uncertain` state
that 1.1 introduces, and the index shape follows from that. Budget for both.

`commands_dispatch_idx` is `(device_id, not_before, requested_at)` — **device-leading**
(`migrations/004_scheduled_commands.sql:17`, which dropped and replaced the original at
`001_init.sql:238`). A fleet-wide due query has no `device_id` predicate, so it cannot use that
index for lookup and degrades to a scan of the partial index — which grows with total command
history.

Add, in a migration file that **must not wrap itself in BEGIN/COMMIT** (`CONCURRENTLY` cannot
run inside a transaction block, which breaks the convention every other migration follows —
note it in the file header). **This depends on the migration-runner change in 1.0:** omitting
`BEGIN`/`COMMIT` is not enough while the runner sends the whole file as a single multi-statement
query, because Postgres wraps that in an implicit transaction anyway.

```sql
CREATE INDEX CONCURRENTLY commands_due_idx
  ON commands (not_before, requested_at)
  WHERE status IN ('queued','approved');
CREATE INDEX CONCURRENTLY commands_sent_idx
  ON commands (sent_at) WHERE status = 'sent';
```

The second serves `requeueUnansweredCommands` (`store.ts:479-500`), which today has no
supporting index at all.

**Verify:** `EXPLAIN (ANALYZE)` on both queries showing an index scan, not a seq or full
partial-index scan.

---

### 1.7 Listener supervision

**Must precede 1.8.** Optimising the sweep while the listener can die unnoticed just makes the
sweep a crutch for a broken dispatch path — and hides the outage it is compensating for.

`src/db.ts:24-36` opens one dedicated client and only `console.error`s on failure. If it
drops, **command dispatch silently degrades to the 60-second sweep forever**. The real
failure mode is a half-open TCP connection that never emits `'error'`, so the existing
handler would never fire. Add reconnect with capped backoff, re-`LISTEN`, an `onReconnect`
callback, and a 30s `SELECT 1` heartbeat. `src/gateway/index.ts:60` passes a callback that
runs an immediate sweep; `src/api/server.ts:184` one that broadcasts a resync nudge.

**Verify:** `pg_terminate_backend` the listener, queue an unlock, confirm it dispatches within
seconds rather than waiting for the sweep.

---

### 1.8 Remaining gateway hot path

`src/gateway/index.ts:73-82` — the 60s sweep sequentially awaits `drainCommands()` for every
session: ~6,000 statements/minute at 3,000 devices, no overlap guard.
- Add an overlap guard.
- Use the fleet due query built in 1.6 (and the index added with it) to drain only the intersection with
  `sessions`, with bounded concurrency instead of sequential `await`.
- **Only now** remove the per-drain expiry UPDATE at `store.ts:419-423`, since 1.3 has
  replaced it fleet-wide.

`src/gateway/arrivals.ts:42-69` takes a pool client plus `BEGIN`/`UPDATE`/`COMMIT` per
positioned frame even when nothing is armed. Add a pooled pre-check
`SELECT 1 FROM arrival_unlocks WHERE device_id=$1 AND is_armed AND expires_at > now() LIMIT 1`
— served by the existing partial index `arrival_unlocks_armed_idx`. The transactional
claiming UPDATE remains the authority, so no correctness property changes.

`store.isKnownDevice` (`store.ts:6-12`) and `store.setConnected` (`store.ts:363-374`) are two
round trips asking overlapping questions. **Merge, don't cache:** one
`INSERT INTO device_state ... SELECT ... FROM devices d WHERE d.device_id = $1 AND d.is_active
... RETURNING device_id`, where `rowCount === 0` means not allowlisted. Update
`session.ts:126-141`.
**Preserve the `config.requireKnownDevice === false` path** (`src/config.ts:31`,
`session.ts:130`) — with the allowlist disabled the gateway must still accept unknown
devices, which is what makes the simulator usable in development.

---

### 1.9 Mileage rollup — with odometer-reset handling

`src/api/devices-query.ts:47-63` scans seven days of positions **per device** (~4,000 heap
rows; `mileage_km` is not indexed) and is called per-device from the NOTIFY handler on every
position.

- New migration: `device_mileage_daily (device_id, local_day date, first_km int, last_km int,
  updated_at)`, PK `(device_id, local_day)`.
- Maintain in `store.updateDeviceState` (`store.ts:138-196`) as one upsert using
  `least`/`greatest`, folded into the same query via CTE to keep round-trip count flat.
- Materialising `local_day` is **required**: `AT TIME ZONE '<name>'` is STABLE, not IMMUTABLE,
  so it can never be indexed on `positions` directly.
- Also fixes a live inconsistency: `week_km` currently uses a rolling 168h UTC window while
  `today_km` uses Tripoli calendar days.
- Backfill 30 days in the migration (trivial at current volume).

**Odometer resets — highest-risk item in Phase 1.** `mileage_km` is a bare integer with no
reset or rollover metadata (`migrations/001_init.sql`). `max - min` correctly handles
blind-area replay, but **one odometer reset in a day yields ~99,994 km** for that truck. This
value feeds Ministry-facing reports, so the failure mode is a silently wrong official number —
far worse than a visibly broken one.

Before this calculation is trusted anywhere reportable: detect a decrease between consecutive
readings within a day, and either segment the day at the reset and sum the segments, or flag
the row and exclude it from aggregates with the anomaly surfaced rather than hidden. Decide
explicitly which; **do not let `max - min` reach a report unguarded.**

**Also denormalise the last lock event** onto `device_state` (`last_event_at`,
`last_event_source`, `last_event_allowed`, `last_event_command_id`), maintained in
`store.insertLockEvent`. Lock events are a handful per device per day, so the write is free and
the second LATERAL at `devices-query.ts:40-46` disappears. With both gone, `/api/devices`
becomes a plain two-table scan.

**Verify:** `EXPLAIN (ANALYZE, BUFFERS)` on `fetchDevice` before and after — expect shared-hit
blocks down roughly three orders of magnitude. Unit-test the rollup against a synthetic day
containing an odometer reset.

**Scope note.** This is the largest single item in Phase 1 and the only one separable from
command safety and gateway capacity. If Phase 1 needs cutting, the mileage rollup and the
odometer-reset policy move to Phase 3 — where the Ministry reporting they feed is built —
without blocking anything else here. The lock-event denormalisation is small and should stay,
since it is half of what makes `/api/devices` a plain two-table scan.

---

### 1.10 Capacity guardrails

- `deploy/zee-gateway.service`, `deploy/zee-api.service`: `LimitNOFILE=65535`.
  **Verify the current effective value first** — Node raises `RLIMIT_NOFILE` soft to hard at
  startup and systemd ≥240 defaults to `1024:524288`, so the predicted EMFILE-at-1000 may not
  apply:
  `cat /proc/$(systemctl show -p MainPID --value zee-gateway)/limits | grep 'open files'`.
- `src/gateway/index.ts:46-49` calls `process.exit(1)` on *any* server error. Under
  `Restart=always` one transient accept error becomes a crash loop, each restart running a
  3,000-row `clearAllConnections` and inviting a reconnect stampede. Split: listen-time
  failures (EADDRINUSE) fatal; post-listen accept errors (EMFILE, ECONNABORTED) logged and
  swallowed.
- `src/gateway/index.ts:113`: pass `backlog: 1024` (Node default 511). Add
  `/etc/sysctl.d/60-zee.conf` via `deploy/install.sh`: `net.core.somaxconn=4096`,
  `net.ipv4.tcp_max_syn_backlog=8192`.
- `src/db.ts:11-15`: env-tunable `max` (gateway 25, API 15), `connectionTimeoutMillis: 5000`,
  per-process `application_name` so `pg_stat_activity` is readable. Enforce statement timeouts
  DB-side — `ALTER ROLE zee_app SET statement_timeout = '15s'`,
  `idle_in_transaction_session_timeout = '30s'` — with maintenance raising it via `SET LOCAL`.
- `deploy/install.sh`: write `/etc/postgresql/<ver>/main/conf.d/60-zee.conf` —
  `shared_buffers`, `effective_cache_size`, `work_mem`, `maintenance_work_mem`, `max_wal_size`,
  `checkpoint_timeout=15min`, `wal_compression=on`, `random_page_cost=1.1`,
  `log_min_duration_statement=1000`, `shared_preload_libraries='pg_stat_statements'`, lowered
  `autovacuum_vacuum_scale_factor` for `positions` and `commands`.

---

### 1.11 Partition automation

Not urgent (headroom to 2027-09-01) but cheap, and the foundation retention needs in Phase 4.

- Migration: schema-qualify the `pg_class` lookup in `ensure_position_partition`
  (`001_init.sql:136` matches `relname` across all schemas); add
  `maintain_position_partitions(months_ahead int DEFAULT 6)` wrapping the loop from
  `001_init.sql:147-154`.
- `scripts/maintain.ts`: reuse `pool` from `src/db.ts`; take
  `pg_advisory_lock(hashtext('zee_maintenance'))`; call the function; then **assert
  `SELECT count(*) FROM ONLY positions_default = 0` and exit non-zero otherwise**, so failure
  appears in `systemctl --failed` rather than as an outage.
- `deploy/zee-maintenance.service` + `.timer`: `Type=oneshot`, `OnCalendar=daily`,
  `Persistent=true`. Install alongside the existing units at `deploy/install.sh:484`.
  A systemd timer, not `pg_cron` — no `shared_preload_libraries` restart, matches the existing
  deploy pattern, visible in `systemctl list-timers`.
- `scripts/migrate.ts`: the advisory lock and non-transactional migration support have **moved
  to 1.0**, since 1.6 needs them. Nothing further is required here.

---

## Verification sequence

1. **Baseline.** Fleet sim at 3,000 devices / 30s against staging. Record `/api/health`
   (`waitingCount`, sweep duration), `pg_stat_statements` top queries, and a Chrome profile with
   a console open.
2. **1.1** — verify per commit, in order.
   *Commit 1:* every reader of `commands.status` renders and routes `acknowledged` and
   `uncertain` correctly; no raw English reaches the console.
   *Commit 2:* an unanswered unlock ends `uncertain` with exactly one `command_sent`, and a P45
   arriving afterwards upgrades it to `confirmed` rather than being orphaned — tested at the old
   2-minute boundary, at the 3-minute timeout, and with a device clock skewed several minutes in
   each direction. Assert no physical command is ever returned to `queued`.
   *Commit 3:* mocked socket whose `write()` returns `false` does **not** call
   `markCommandFailed` and **does** write the `command_sent` audit row; a throwing `write()`
   does record failed; two historical `'socket write failed'` rows no longer block `/unlock`;
   a `confirmed` command cannot be moved to `failed`. Re-run commit 2's double-unlock assertion
   here — this is the boundary where an ordering mistake would show.
   *Commit 4:* two open P43s and one response confirm neither; a concurrent `set_password` and
   `query_password` resolve to the right rows; WLNET responses match on serial.
   *Commit 5:* a sub-lock unlock is never auto-resent; disarming a rule that has already fired
   cancels every still-cancellable command it spawned, master and sub-locks alike.
   Under load: zero `'socket write failed'` rows, and no unlock command with more than one
   `command_sent` audit row.
3. **1.2** — concurrency tests incl. the throw-and-resume case; `is_connected` never dips below
   live socket count during a 200-device reconnect storm.
4. **1.3** — an expired command reads `expired`, not `queued`.
5. **1.4** — frame time interactive, DOM node count flat.
6. **1.5** — `fetchDevice` call rate drops from ~36/sec to ~2/sec.
7. **1.6** — `EXPLAIN (ANALYZE)` shows index scans for both new indexes.
8. **1.7** — kill the listener; queued unlock still dispatches within seconds.
9. **1.8** — sweep duration bounded and non-overlapping; `waitingCount` stays zero on the
   500 → 1500 → 3000 ramp.
10. **1.9** — buffer counts down ~3 orders of magnitude; rollup correct across a synthetic
    odometer reset.
11. **1.10** — `nstat -az TcpExtListenOverflows`, `/proc/PID/limits`,
    `SELECT state, count(*) FROM pg_stat_activity GROUP BY 1`.
12. **1.11** — new partitions appear; `positions_default` empty. On a scratch DB, insert one row
    into the default partition and confirm `CREATE ... PARTITION OF` then fails, so the symptom
    is recognisable.
13. `npm test` (107 tests) and `npx tsc --noEmit` clean.

---

## Maintenance windows and irreversibility

Phase 1 needs **one Postgres restart** for `shared_buffers` and `shared_preload_libraries` —
seconds, bundled with the 1.11 DDL. Everything else is a rolling service restart; devices
reconnect on their own.

**Nothing in Phase 1 is irreversible.** No data deleted, no column dropped. The destructive
items — partition retention, `DROP COLUMN status_flags`, `commands.payload` password redaction
— are deferred to Phases 2 and 4 and need explicit sign-off.

---

## Deferred decisions

- **Company attribution.** Monitoring is Ministry-only, so no login boundary is needed now.
  Still add `devices.company_id` in Phase 3 rather than later — cheap now, a schema change
  against a live 3,000-device database is not. Confirm whether the unit is company, depot, or
  region before designing it.
- **Retention.** "Keep everything, decide later." Phase 4 builds the partition-drop function but
  leaves it **warn-only** unless `POSITIONS_RETENTION_MONTHS` is explicitly set. Confirm whether
  Libyan fuel logistics carries a statutory retention floor before enabling.
- **`status_flags` storage.** The single biggest storage lever — roughly two-thirds of every
  row, and already recoverable from two raw bytes via `decodeDeviceStatus`
  (`decode-binary.ts:87`). Measure before committing:
  `SELECT avg(pg_column_size(status_flags)) FROM positions TABLESAMPLE SYSTEM (1);`
- **ACK ordering.** `session.ts:160-171` acks only after `insertPosition` and
  `updateDeviceState`. Devices re-send until acknowledged, so DB latency causes retransmits,
  which cause more load — an amplifier on top of pool saturation. Acking after decode but before
  persistence breaks the loop and is safe (`insertPosition` is idempotent on
  `(device_id, reported_at, serial)`, and blind-area replay re-delivers anything lost) — but it
  is a real durability trade and should be a deliberate decision, not a side effect. Phase 1
  leaves it as-is; the DB-side `statement_timeout` bounds the damage meanwhile.
- **`sub_device_readings` and `audit_log` partitioning** are Phase 4, but both are "rewrite now
  while small" items. `sub_device_readings` is near-empty only because JT709 heartbeats default
  off (`009_bound_peripherals.sql:3-7`); enabling them fleet-wide makes it the fastest-growing
  table in the schema, on an unpartitioned heap. **Do not enable JT709 heartbeats fleet-wide
  before Phase 4 lands.**
  Note the tension with 1.1(f): heartbeats being off is precisely what makes a sub-lock unlock
  unconfirmable. Enabling them *per peripheral, only for sub-locks armed for unlock* is a far
  smaller volume than fleet-wide and is the likely resolution — but the two constraints pull
  against each other and must be decided together, not separately.

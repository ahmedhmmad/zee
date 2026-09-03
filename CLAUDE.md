# Zee lock platform

Monitoring and remote unlock for Jointech JT701D master locks and JT709EX explosion-proof valve
sub-locks fitted to **fuel tankers** in Libya. A TCP gateway speaks the vendor's binary protocol
to the locks; a Fastify API and web console are the operator dashboard. Currently field-proven on
2 trucks, being scaled to ~3,000.

See `README.md` for architecture and local setup, `docs/scaling-plan.md` for the roadmap in force.

## What makes this different from an ordinary CRUD app

**Unlocking a lock opens a valve on a tanker full of petrol.** Three things follow, and they
override normal convenience trade-offs:

- **Never make an unlock path "just work" by guessing.** If the platform cannot tell which command
  a device response belongs to, or whether a lock physically moved, it must record that it does
  not know. An `uncertain` record is correct; a confident wrong record is a safety and
  accountability failure. The Ministry relies on these records.
- **Distinguish three facts that look alike:** bytes accepted by a socket, the device
  acknowledging a command, and the lock physically moving. Most of the defects in the current
  codebase come from conflating them. `commands.status` is the *exchange*; physical movement is
  evidence recorded separately.
- **Never auto-retry a command that actuates hardware.** The device auto-locks about a minute
  after opening, so a "helpful" retry opens the valve again, possibly in transit.

## Gates

```bash
npm test          # node --test, 244 tests, all must pass
npm run typecheck # tsc --noEmit
```

Both must be clean before a commit. `test/` covers the protocol codec, and — since Phase 1 — the
gateway session, the command lifecycle, the sweep and the listener, driven through the injection
seam in `session.ts` with `test/fake-socket.ts`. There is still no test that touches a real
database, so store queries are asserted by shape rather than by behaviour; changes there need a
staging run behind them, not just a green suite.

## Conventions

- **Node 22 with native type stripping.** No build step, no bundler. Imports carry explicit
  **`.ts`** extensions (`import { pool } from '../db.ts'`) — this is required, not a style choice.
- **Dependency-light on purpose.** Runtime deps are Fastify (+ two plugins) and `pg`. Prefer
  `node:` built-ins over a package. **Ask before adding any dependency.**
- **Migrations** live in `migrations/`, wrap themselves in `BEGIN`/`COMMIT`, and open with a
  comment explaining *why*, not what. New migrations must be idempotent. A migration that cannot
  run in a transaction — `CREATE INDEX CONCURRENTLY` — opts out with `-- migrate: no-transaction`
  on its own line and is then sent one statement per round trip; `018` is the worked example.
  Note that several existing files share a numeric prefix (three `007_`, two `008_`), so ordering
  is alphabetical, not numeric.
- **The console is vanilla JS** in `public/`, no framework. Operator-facing strings are **Arabic**;
  match the surrounding text rather than introducing English labels.
- **Protocol facts come from the vendor manuals** (PDFs in the repo root, not redistributable).
  Where behaviour was reconstructed from real frames rather than documented — the WLNET,5 layout,
  the sub-lock STATUS byte, whether a heartbeat wake collects a queued unlock — the code says so
  in a comment. **Keep those caveats accurate and do not build on an undocumented behaviour
  without saying that is what you are doing.**
- The device allowlist (`devices.is_active`) is the *only* authentication the TCP protocol has.
  **Never seed fake device IDs into a production `devices` table.**

## Invariants Phase 1 established — check before changing these

Each of these fixed a defect that was invisible in normal operation, and each would look like a
harmless simplification to undo. Every one is pinned by a test that explains why.

- **Only `src/gateway/index.ts` writes `device_state.is_connected.`** It had three writers that
  disagreed, so a truck reconnecting before the old socket's FIN arrived could be recorded as
  offline while connected. Not the session, not the ingest path — the registry.
- **`commands.status` is the exchange; movement is evidence.** `confirmed` means the device
  answered the command word. Whether the lock moved lives in `physically_evidenced_at` and the
  two columns beside it. `uncertain` is a correct record and must never be swept back into
  `queued`.
- **A physical command is never auto-retried.** `command_types.is_physical` is the single source
  of that, FK'd from `commands.command_type`, so a new type cannot be queued without someone
  declaring what it is.
- **Ambiguity is refused, not resolved.** If more than one open command could explain a device
  response or a lock event, none is chosen and they stay `uncertain`.
- **The ack for a position goes out before persistence**, so database latency cannot generate
  more inbound frames. Lock events keep the old ordering, because they are evidence.
- **`commands.payload` holds placeholders, not passwords.** `{{static_password}}` and
  `{{new_password}}` are substituted in `claimPendingCommands` at dispatch.
- **Sub-lock unlocking is gated off** (`SUBLOCK_UNLOCK_ENABLED`) until a bench test says a
  heartbeat wake can collect a queued unlock. Until then a valve unlock cannot be evidenced.

Current phase: **Phase 1** (correctness, capacity & pilot safety) — implemented; the remaining
work is verification against a staging fleet, and the JT709 bench test. Nothing in Phase 1 is
irreversible: no data deleted, no column dropped. See `docs/scaling-plan.md` for what each item
was for, and Phases 2-5 for what is next.

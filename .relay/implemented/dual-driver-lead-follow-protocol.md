# Implemented: Dual-Driver Lead-Follow Protocol

## Summary

*Resolved: 2026-05-24*

**Problem**: Phase 22's #54 (orchestrator-core) shipped with `lead: 'human'` hardcoded in the `orchestrator_decide` RPC handler because no canonical lead state existed. Five downstream features in the dual-driver cluster (#56 observer-advisor, #57 lead-handoff-reconciliation, #59 brain-loop-replacement, #62 frame-b-chat-wire, plus broader operator UX) all need a single global "who is driving the board right now?" signal with explicit transfer mechanics and typed events. Additionally, Frame B feature #51 (`brain-halt-on-user-chat`, archived/SUPERSEDED 2026-05-23) had to be subsumed under this protocol — "user chat halts the brain" becomes a special case of "operator-takes-lead with reason: 'user-chat'."

**How it was resolved**: Shipped the canonical lead-state primitive at `src/conductor/lead.ts` (sibling of `loop.ts`/`cost_guard.ts`/`halt.ts`). Two-state model `'human' | 'llm'` with `LeadState` (current + since + reason + optional context) and 9-variant `LeadTransferReason` enum. State storage lives in `RuntimeStore` (extended interface + `InMemoryRuntime` class) with default `'human'` / `reason: 'daemon-start'` at construction — matches "brain is OFF by default" semantics. All transfers go through one mutation choke-point: `transferLead({runtime, bus, to, reason, context?})` which (a) reads current state, (b) returns `{changed: false}` no-op on same-state (idempotent), (c) on real transition, mutates runtime BEFORE publishing the `lead-handed-off` SSE event so subscribers see consistent state. Single event variant `lead-handed-off` carries `previous` + `current` LeadState payloads — sufficient for both acquisition (`previous.current !== current.current`) and reason-based transitions; no separate `lead-acquired` variant needed (analysis decision documented in spec).

RPC surface: `lead_get` (parameterless read) + `lead_set({to, reason, context?})` (transfer). The `lead_set` handler returns `{changed:false, reason:'no-bus'}` when `ctx.bus` is missing (review issue 2 — aligns with `conductor_start`'s discriminated-failure pattern instead of throwing). The `orchestrator_decide` handler now reads `getLead(ctx.runtime).current` instead of the hardcoded `'human'` literal — this **retires the v1 caveat documented in #54**. Closure proved end-to-end by a new test (`tests/rpc/methods.test.ts > orchestrator_decide reads lead from runtime`) that flips lead via `lead_set` then asserts the orchestrator's prompt contains `Lead: llm`; an inverse-assertion cross-check on a fresh runtime confirms `Lead: human` flows through too.

CLI surface: new `src/cli/commands/lead.ts` provides `conductor lead` (show state) / `conductor lead human` / `conductor lead llm` (transfer with `reason: 'cli-command'`). `conductor brain start` and `conductor brain stop` now ALSO call `lead_set` with reasons `'brain-start'` / `'brain-stop'` respectively — best-effort coupling via try/catch so a lead-transfer failure does not undo the brain lifecycle action.

UI: `src/ui/events.ts`'s `DaemonEventKind` union extended with `lead-handed-off` as a contract-drift guard. Actual UI rendering (masthead pill, status indicator) is deferred to feature #62 (`dual-driver-frame-b-chat-wire`) per the spec's own Integration Points hedge.

**Frame B #51 supersession closure**: This feature fulfills the SUPERSEDED 2026-05-23 closure obligation for archived `brain-halt-on-user-chat.md`. The archived spec's per-card `userTouched` flag mechanism is now subsumed by the global `transferLead({reason:'user-chat'})` call that #62 will wire into Frame B's chat submit handler. The archived file's banner already points here; no additional archive edit needed (banner already in place).

**Pattern precedent**: protocol-extraction (separate `lead.ts` module with single mutation choke-point + dual idempotency/event-publish guarantees) follows the same shape as `cost_guard.ts` / `halt.ts`. Per operator memory note on ADR scope discipline, ADR filing remains operator-deferred; pattern advance recorded here for cross-feature visibility.

## Files Modified

**New files (3 src + 2 tests):**
- `src/conductor/lead.ts` — `Lead` / `LeadState` / `LeadTransferReason` types + `transferLead()` mutation choke-point + `getLead()` read helper. 85 lines.
- `src/cli/commands/lead.ts` — `conductor lead [human|llm]` CLI command. Handles offline (`'daemon not running'`), no-bus failure (`'event bus unavailable'`), idempotent no-op, and real-transition cases. 74 lines.
- `tests/conductor/lead.test.ts` — 6 unit tests covering default state, real transition + event publication, idempotency, context plumbing, reason-taxonomy walk, mutation-before-publish ordering invariant.
- `tests/cli/lead.test.ts` — 5 tests: 3 for the lead CLI (offline show, offline set, online happy-path) + 2 for brain CLI integration (added per review issue 3): `brainStart` calls `lead_set({reason:'brain-start'})` on success; does NOT call `lead_set` when `conductor_start` returns `started:false`.

**Modified files (7 src + 2 tests):**
- `src/daemon/runtime.ts` — `RuntimeStore` interface gets `getLead()` + `setLead()`; `InMemoryRuntime` adds private `lead: LeadState` field initialized in constructor with `{current: 'human', since: now(), reason: 'daemon-start'}`. Defensive Date copies on both read and write (Date is mutable).
- `src/daemon/event_bus.ts` — `DaemonEvent` union extended with `lead-handed-off` variant carrying `previous`, `current`, `reason`, optional `context`, and ISO `ts`.
- `src/rpc/schema.ts` — `LeadGetParams` (parameterless `.strict()`) + `LeadSetParams` (zod enum mirrors `LeadTransferReason` — comment marks both sides as "must stay in sync").
- `src/rpc/methods.ts` — `lead_get` + `lead_set` handlers added; `lead_set` returns `{changed:false, reason:'no-bus'}` on missing bus (review issue 2). `orchestrator_decide` handler swapped from `const lead: 'human' | 'llm' = 'human'` → `const lead = getLead(ctx.runtime).current`. Both new handlers registered in the `methods` map.
- `src/cli/commands/brain.ts` — `brainStart` and `brainStop` split their success-branch and add a try/catch-wrapped `rpcCall('lead_set', ...)` after the conductor RPC succeeds. Lead-transfer failure is silently swallowed (brain lifecycle is not blocked on lead transfer).
- `src/cli/index.ts` — `attachLead` imported and registered between `attachBrain` and `attachTracker`.
- `src/ui/events.ts` — `DaemonEventKind` union extended with `'lead-handed-off'` (contract-drift guard; UI rendering deferred to #62).
- `tests/daemon/runtime.test.ts` — +2 tests: lead-default at construction, `setLead` round-trip.
- `tests/rpc/methods.test.ts` — +4 tests: `lead_get` default, `lead_set` happy path, no-bus discriminated-failure shape, and the #54 caveat-closure proof (lead state from runtime flows into orchestrator's prompt — verified via `Lead: llm` / `Lead: human` inverse-assertion cross-check).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands**:
  - `npm run typecheck` → clean (`tsc --noEmit` for both `tsconfig.json` + `tsconfig.ui.json`).
  - `npx vitest run tests/conductor/lead.test.ts` → 6/6 pass.
  - `npx vitest run tests/daemon/runtime.test.ts` → 8/8 pass (6 existing + 2 new).
  - `npx vitest run tests/cli/lead.test.ts` → 5/5 pass.
  - `npx vitest run tests/rpc/methods.test.ts` → 33/33 pass (29 existing + 4 new).
  - `npx vitest run tests/orchestrator/` → 52/52 pass (no regression; `decide()` signature unchanged).
  - `npx vitest run tests/conductor/ tests/daemon/ tests/cli/ tests/rpc/` → 256/256 pass across 44 test files.
  - `npm test` → 858/858 pass across 119 test files. Baseline 841 → 858 (+17 net new tests).
- **Commit (impl)**: see Control phase 30.3 commit log for the feature SHA.

## Caveats

- **#54 v1 caveat is now RETIRED.** The `orchestrator_decide` RPC handler at `src/rpc/methods.ts` no longer carries the `// Lead state will read from feature #2's getLead(runtime) once it ships` TODO block. Downstream callers (Frame B chat via #62, future brain loop via #59) automatically benefit from runtime-sourced lead state.
- **Lead state is in-memory only (no SQLite persistence).** On daemon restart, lead resets to `'human'` / `reason: 'daemon-start'`. Per spec OQ1 lean — explicit re-acquisition is safer than silent brain takeover post-restart. Revisit if dogfood operators find re-acquisition annoying.
- **UI rendering deferred to #62.** Feature #55 ships the protocol + CLI + the UI type-union extension (contract-drift guard); the visible masthead pill / per-card lead indicator lands in `dual-driver-frame-b-chat-wire` (#62).
- **Reason enum duplication between TS and zod.** `LeadTransferReason` exists as a string-literal union in `src/conductor/lead.ts` AND as a `z.enum` in `src/rpc/schema.ts`. Comment on both sides marks them as "must stay in sync." Pattern matches existing duplications across this codebase (e.g., `Lead` type vs `z.enum(['human','llm'])`).
- **`lead_set` requires a bus.** Production daemon always supplies one (`src/daemon/index.ts:78`). Test/plugin contexts without a bus get `{changed:false, reason:'no-bus'}` — discriminated failure aligned with `conductor_start`'s pattern. Direct callers must inspect `r.changed` rather than assuming a `TransferLeadResult` shape.
- **Brain start/stop lead-transfer is best-effort.** `brainStart`'s second `rpcCall('lead_set', ...)` is wrapped in try/catch — a failure does NOT undo the brain start. In practice this only matters under transient daemon errors mid-call; the brain lifecycle is the load-bearing thing.
- **Frame B #51 supersession-closure obligation FULFILLED.** The archived `.relay/archive/features/brain-halt-on-user-chat.md` was SUPERSEDED 2026-05-23 by this feature. Its banner already points here. The behavior the archived spec described (`userTouched` per-card flag + `conductor-halt reason:'user-chat'` event + `card_resume` RPC) is now generalized: Frame B's chat submit handler (wired in #62) will call `lead_set({to:'human', reason:'user-chat', context:<chat-message>})` BEFORE invoking the `chat` op; the brain loop (#59) will gate iter-start on `getLead(runtime).current === 'llm'`. Same behavior, generalized globally instead of per-card. No further archive edit needed; closure documented here per the brief's hidden closure beat.
- **Phase 22 sibling unblocking continues.** With #54 (orchestrator-core) + #55 (lead-follow-protocol) both shipped, Cohort A Foundation features #58 (backward-transitions-and-substrate-advisory), #60 (autonomy-spectrum-config), and #61 (halt-categories) can proceed in parallel. Cohort B reasoning consumers (#56 observer-advisor, #57 lead-handoff-reconciliation) can begin once Cohort A is stable. Cohort C big-bang switch (#59 brain-loop-replacement) sequences last per the spec's Development Order.
- **No ADR filed.** Per operator memory note on ADR scope discipline (`feedback-adr-scope-discipline.md`), pattern precedent (protocol-extraction with mutation choke-point + idempotency + event publish) is recorded here rather than as a separate ADR. Operator-deferred per the memory.

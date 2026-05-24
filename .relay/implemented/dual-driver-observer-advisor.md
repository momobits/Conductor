# Implemented: Dual-Driver Observer-Advisor

## Summary

*Resolved: 2026-05-24*

**Problem**: Phase 22's dual-driver model committed to "either human or LLM is the lead." Feature #57 (lead-handoff-reconciliation) handles the gap on lead handoff, but DURING the operator's lead session the brain was silent — no in-the-moment surfacing when the operator did something that looked out-of-sequence. Without an observer, the dual-driver model degraded to "two siloed drivers" where the brain only re-engaged on lead handoff. The brainstorm's Approach C definition called for "the non-lead WATCHES state transitions via SSE + substrate. When the lead does something out-of-sequence or surprising, the observer publishes an advisory event (typed; non-blocking; surfaced in telemetry)." Brainstorm OQ #5 also flagged the cost-control concern: "every state transition triggers an LLM call to check 'is this out-of-sequence?' That's expensive."

**How it was resolved**: Shipped `src/orchestrator/observer.ts` + `src/orchestrator/observer-rules.ts` mirroring the #57 reconciliation module pair shape. `makeObserver({repo, runtime, bus, config, adapter})` returns `Observer` with `start(): () => unsubscribe` + `status()` accessors. The observer subscribes to two bus events: `cards-changed` (per-card mutation signal, watched at file-mtime granularity by the existing chokidar wrapper) and `lead-handed-off` (active/inactive flip). The dispatcher is gated on `getLead(runtime).current === 'human'` — when the brain is leading, the observer is inactive (no fs reads, no rule evaluations).

On each `cards-changed` event: derive cardId from path basename → read column from disk via `readCard()` (active first, then archive) → diff against in-memory `Map<cardId, Column>` snapshot → run heuristic pre-filter `matchOutOfSequence()` from `observer-rules.ts`. The pre-filter is the COST-CONTROL anchor: if no rule fires, no LLM call. If a rule fires AND the per-card rate-limit + global per-minute ceiling allow, the observer calls `decide()` from feature #54 with `lead: 'human'` and a synthetic `userMessage` describing the rule + observation. If `decide()` returns `action === 'advise'`, the observer publishes a `conductor-observer-advisory` SSE event (BrainLogWriter persists automatically via `conductor-` prefix). Any other decision action is SUPPRESSED per spec invariant — the observer is read-only + advisory-emit-only.

Three v1 rules ship (each a pure function over `ObservedColumnTransition`):
- **`transition-forward-substrate-check`** (warn): forward move into a substrate-required column (planned/approved/building/verifying/shipped). Over-permissive by design — `decide()` reasons about whether substrate is actually present + can return `no-op` (suppressed).
- **`backward-transition-with-orphans`** (warn): backward move where `findOrphanedSubstrate()` (from #58) returns non-empty.
- **`archived-touched`** (info): card lives in `.conductor/archive/cards/` and was just observed (either moved-to-archive or edited-while-archived).

Wired into `src/daemon/index.ts` boot: `makeObserver(...).start()` runs alongside the #57 reconciliation subscriber. Unsubscribe lifecycle matches #57 — runs BEFORE `brainLog.close()` to preserve in-flight publishes. Adapter is a `RoutingAdapter` (same lazy-construct pattern as reconcile).

Schema: `AutonomyBudgetSchema` extended with `observer_advisory_rate_limit_ms: 5000` (per-card cooldown). The global per-minute ceiling reuses `observer_calls_per_minute` shipped by #60 (default 20/min). EventBus `DaemonEvent` union extended with `conductor-observer-advisory` carrying `{cardId, rationale, severity, ruleId, decisionConfidence, ts}`. BrainLogWriter `toRecord` adds the new kind, persists to `.conductor/brain.log.jsonl`. `DaemonEventKind` in `src/ui/events.ts` extended for contract-drift safety.

**Pattern precedent**: protocol-extraction module pair (`observer.ts` + `observer-rules.ts`) reaches **n=21** (after `lead.ts` n=18, `autonomy.ts` n=19, `reconciliation.ts` + `reconciliation-diff.ts` n=20). Producer-only ship pattern (no in-tree consumer for the SSE event yet) reaches **n=2** after #57's precedent. ADR filing remains operator-deferred per `feedback-adr-scope-discipline.md` memory.

## Files Modified

**New files (2 src + 2 tests):**
- `src/orchestrator/observer-rules.ts` (~150 lines) — `ObservedColumnTransition` type + `RuleMatch` type + 3 pure rule functions (`transitionForwardSubstrateCheckRule`, `backwardTransitionWithOrphansRule`, `archivedTouchedRule`) + `OBSERVER_RULES` registry + `matchOutOfSequence()` aggregator + `computeOrphans()` async helper (calls `findOrphanedSubstrate` from #58). Rule bodies are pure — async I/O happens in `computeOrphans()` which the dispatcher calls before passing the precomputed orphan list into the observation shape.
- `src/orchestrator/observer.ts` (~270 lines) — `makeObserver({repo, runtime, bus, config, adapter, rateLimitMs?, maxCallsPerMinute?, now?})` factory returning `Observer` with `start()` + `status()`. Internally: per-card column snapshot `Map<string, Column>`, per-card last-advisory `Map<string, number>` for rate-limit, rolling `recentCallTimestamps[]` for global ceiling, `active` flag flipped by `lead-handed-off` events. Reads card via `readCard()` (active path then archive path). Fires `decide()` with `lead: 'human'` + synthetic userMessage; publishes `conductor-observer-advisory` for advise-actions only; suppresses non-advise decisions per spec invariant.
- `tests/orchestrator/observer-rules.test.ts` (~22 tests) — per-rule pure-function tests (forward/backward/noop/null-before paths for each rule), `matchOutOfSequence` registry + determinism tests, `computeOrphans` integration (forward returns [], backward + orphans returns list).
- `tests/orchestrator/observer.test.ts` (~9 tests) — observer dispatch end-to-end: advisory publish on rule-fire + advise decision, no-publish when lead is llm, non-advise suppression, per-card rate-limit, global per-minute ceiling, lead-state-aware active flip, malformed-path drop, unsubscribe-stops-processing, deleted-card snapshot prune.

**Modified files (6 src):**
- `src/config/schema.ts` — `AutonomyBudgetSchema` extended with `observer_advisory_rate_limit_ms: z.number().int().nonnegative().default(5000)`. Per-mode budget alongside `orchestrator_calls_per_card` / `observer_calls_per_minute` / `max_reconciliation_calls_per_handoff`.
- `src/daemon/event_bus.ts` — `DaemonEvent` union extended with `conductor-observer-advisory` carrying `{cardId, rationale, severity: 'info'|'warn', ruleId, decisionConfidence, ts}`. Brain-log filter (`startsWith('conductor-')`) catches automatically.
- `src/daemon/brain_log.ts` — `toRecord` switch adds the new kind, persists `{cardId, payload: {rationale, severity, ruleId, decisionConfidence}}` to `.conductor/brain.log.jsonl`.
- `src/daemon/index.ts` — imports `makeObserver`. Instantiates with `RoutingAdapter` after the reconciliation subscriber. Stores `observerUnsubscribe` thunk. Shutdown unsubs observer + reconciliation BEFORE `brainLog.close()` (same lifecycle invariant as #57).
- `src/orchestrator/index.ts` — barrel re-exports `makeObserver`, `Observer`, `ObserverArgs`, `ObserverStatus`, `OBSERVER_RULES`, `matchOutOfSequence`, `computeOrphans`, rules, types.
- `src/ui/events.ts` — `DaemonEventKind` union extended with `'conductor-observer-advisory'` (contract-drift guard; UI render deferred).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands**:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run tests/orchestrator/observer-rules.test.ts tests/orchestrator/observer.test.ts` → 31/31 pass in 1.5s.
  - `npm test` → **1025/1025 pass** across 127 test files. Baseline 994 → 1025 (+31 net new tests: 22 in `observer-rules.test.ts` + 9 in `observer.test.ts`).
- **Commit (impl)**: `ac7e37c feat(30.9): dual-driver observer-advisor (#56)` (Control phase 30.9).
- **Known flake watch**: `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` did NOT fire on this run (consistent with Phase 29's runs).

## Caveats

- **Producer-only ship — no in-tree advisory consumer yet.** UI render in card_detail (advisor section) + Monitor view (advisory log line) deferred per spec § Integration Points. The persistent record (brain.log.jsonl) and the live SSE forward to the browser are the v1 surfaces; the `DaemonEventKind` extension at the SSE forwarder is a contract-drift guard for the future UI consumer.

- **Rule set trimmed from 6 → 3 in v1.** The spec listed 6 rules; we ship 3. Dropped rules require event sources the EventBus doesn't currently expose:
  - `body-edit-after-plan`: needs granular body-edit events; only file-mtime `cards-changed` is exposed.
  - `manual-substrate-bypass`: needs per-op substrate-written events; the chokidar watcher only watches `.conductor/cards/`, not `.conductor/runs/`.
  - `idle-discovered`: needs a timer + per-card last-touched-at index; out of scope for v1 producer ship.
  These rules can be added in v2 when (a) the watcher is widened to `.conductor/runs/` or (b) the cards-changed handler emits granular body-edit events. The `OBSERVER_RULES` registry is OPEN — new pure rules append without touching dispatch.

- **`transition-forward-substrate-check` is over-permissive by design.** The rule fires on EVERY forward transition into a substrate-required column, without checking whether the substrate is actually present. The cost is one LLM call per forward transition (gated by ceiling + per-card rate-limit). `decide()` reads `buildSnapshot()` which sees all substrate — if substrate IS present, decide() returns `no-op` and the observer suppresses the publish. False-positives are cheap (one ceiling-bounded LLM call); false-negatives would miss important advisories. Per spec OQ4 lean: "err toward firing."

- **Event name `conductor-observer-advisory` deviates from spec `observer-advisory`.** Reason matches #57's `conductor-reconciliation-summary` rename: BrainLogWriter persists `startsWith('conductor-')` events automatically. The prefix change is the cheapest way to get brain.log persistence parity. Taxonomy aligns with `conductor-iteration` / `conductor-decision` / `conductor-halt` / `conductor-status` / `conductor-reconciliation-summary`.

- **Per-card advisory suppression UI deferred.** Spec OQ5 leaned defer ("operator clicks 'suppress for now'; reset on daemon restart"); v1 ships no suppression mechanism. If dogfood reveals operators want to silence advisories per-card, the runtime store can be extended with a `Map<cardId, Set<ruleId>>` like the deferredReconciliations map shipped by #57.

- **Advisory substrate persistence deferred.** Spec OQ3 leaned conditional persistence ("persist if the decision is non-trivial — i.e. an LLM call fired"); v1 relies on brain.log.jsonl for the audit trail. Future polish: write `<runId>/observer-advisory.md` artifact when an advisory is published.

- **Observer is over-permissive on first-touch.** When the observer sees a card for the first time (no in-memory snapshot entry), `before === null` and most rules don't fire (intentional — we have no transition signal yet). The observer still does the disk read + snapshot prime, so the NEXT event for that card has a baseline. This is a one-event grace period per card per observer-active session. Snapshot resets on lead-handed-off → `current.current === 'human'` so re-takeover re-baselines.

- **Snapshot stays in-memory only.** On daemon restart, the in-memory column snapshot resets. The first event for each card post-restart is the prime; advisories fire from the second event onward. Acceptable for v1; persistent snapshot is a heavier feature (sqlite + boot-time read) deferred.

- **Watcher `cards-changed` is path-fragment broad.** Chokidar emits one event per file mtime change in `.conductor/cards/`. Our `cardIdFromPath()` strips the basename + `.md` suffix. Paths that don't end in `.md` (directory-level events) are dropped silently. Body-only edits would also trigger cards-changed events but currently no rule fires on them (the no-column-change early-exit silently suppresses — counted as `noChangeShortCircuits` for telemetry).

- **`decide()` failure does not crash the observer.** A try/catch around the decide() call increments `decideCallFailures` + logs; the observer continues processing subsequent events. Same pattern as #57's reconcile() per-card error handling.

- **Lead-flip clears snapshot + rate-limit state.** When lead flips to human (re-activation), the observer's column snapshot and per-card rate-limit map are cleared. Avoids stale `before` values if the operator made changes during the LLM's turn. The next event re-baselines from disk.

- **Phase 22 sibling unblocking COMPLETE.** With #54 (orchestrator-core) + #55 (lead-follow-protocol) + #58 (backward-transitions-substrate-advisory) + #60 (autonomy-spectrum-config) + #57 (lead-handoff-reconciliation) + this feature shipped, the dual-driver foundation + reasoning consumers cohort is closed. Remaining Phase 22 work: #61 (halt-categories, S) + #59 (brain-loop-replacement, big-bang switch) + #62 (frame-b-chat-wire, depends on Frame B's chat surface). No further coordination needed for #59 / #62 — they consume the producer surface shipped here directly.

- **No ADR filed.** Per `feedback-adr-scope-discipline.md` memory, pattern precedent (protocol-extraction module pair n=21; producer-only ship n=2) is recorded here rather than as a separate ADR. Operator-deferred.

## Related

- **Brainstorm**: `.relay/features/dual-driver-orchestration_brainstorm.md` (Approach C, decision #8)
- **Producer dependency**: `.relay/implemented/dual-driver-orchestrator-core.md` (#54) — `decide()` engine called in advisory mode.
- **Lead-state dependency**: `.relay/implemented/dual-driver-lead-follow-protocol.md` (#55) — `getLead()` + `lead-handed-off` subscription.
- **Substrate dependency**: `.relay/implemented/dual-driver-backward-transitions-and-substrate-advisory.md` (#58) — `findOrphanedSubstrate()` consumed by `computeOrphans()`.
- **Budget dependency**: `.relay/implemented/dual-driver-autonomy-spectrum-config.md` (#60) — `observer_calls_per_minute` ceiling.
- **Sibling pattern**: `.relay/implemented/dual-driver-lead-handoff-reconciliation.md` (#57) — module-pair shape, event-prefix-for-brain-log-persistence pattern, daemon-shutdown-ordering pattern, producer-only ship pattern.
- **Persistence dependency**: `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` — `conductor-` prefix is the filter shape; this feature's event name choice (`conductor-observer-advisory`) aligns.

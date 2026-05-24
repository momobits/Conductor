# Implemented: Dual-Driver Lead-Handoff Reconciliation

## Summary

*Resolved: 2026-05-24*

**Problem**: Phase 22's dual-driver model commits to "either human or LLM is the lead." When lead swaps from human back to llm, the brain's stored mental model of the board (prior plans, prior decisions) is from BEFORE the operator's session. Without reconciliation, the brain's first iter post-reclaim runs against stale assumptions — e.g., a card whose body the operator edited still has its pre-edit plan substrate; a card the operator moved backward still has its forward-plan still queued; an archived card still appears in the brain's prior queue. The brainstorm (decision #8) called for the brain to "diff the changes the user made to any card and when it starts up again, re-evaluate based on that whether its plan is still correct or needs amendment." Without this, the dual-driver model degrades to "two siloed drivers" where lead handoff is destructive.

**How it was resolved**: New module pair under `src/orchestrator/` — `reconciliation-diff.ts` (pure snapshot-capture / persist / load / diff functions) + `reconciliation.ts` (the entry-point `reconcile()` that orchestrates the per-card decide() loop with budget + deferred-flag handling + summary publish). New lightweight shared-types module `src/conductor/reconciliation_types.ts` houses the `CardDiff` type so `RuntimeStore` (daemon layer) can store deferred diffs without creating a daemon → orchestrator circular import. `RuntimeStore` extended with `getDeferredReconciliation` / `setDeferredReconciliation` / `clearDeferredReconciliation` / `listDeferredReconciliations` accessors matching the `getLead/setLead` pattern shipped by #55. The daemon-level subscriber in `src/daemon/index.ts` listens for `lead-handed-off` events and routes by direction: `human-takes-lead` → `captureAndPersistHandoff(repo)`; `llm-takes-lead` → `reconcile({...})`. Shutdown ordering unsubscribes the reconciliation listener BEFORE `brainLog.close()` so any in-flight `reconcile.publish()` reaches the brain log.

The new `conductor-reconciliation-summary` SSE event is added to the `DaemonEvent` discriminated union and to `BrainLogWriter.toRecord` so the summary is persisted to `.conductor/brain.log.jsonl` automatically (taxonomy matches `conductor-iteration` / `conductor-decision` / `conductor-halt` / `conductor-status`). `src/ui/events.ts` `DaemonEventKind` is extended with the new variant for contract-drift safety; UI render is deferred to a future polish ticket (per spec). Config schema adds `max_reconciliation_calls_per_handoff: 10` under `autonomy.budgets.<mode>` (per-mode scaling aligns with #60's framing) and top-level `handoffs.keep_last_n: 50` (snapshot retention, symmetric with `run_log` / `brain_log` precedent).

**Pattern precedent**: pure-helper module pair (`reconciliation.ts` orchestrator + `reconciliation-diff.ts` pure-functions) reaches **n=20** for the protocol-extraction pattern (after `lead.ts` n=18, `autonomy.ts` n=19). Producer-only ship (consumer in future #59 brain-loop-replacement) is a new pattern variant — tests directly exercise the producer surface (runtime accessors + summary event payload). ADR filing remains operator-deferred per `feedback-adr-scope-discipline.md` memory.

## Files Modified

**New files (3 src + 2 tests):**
- `src/conductor/reconciliation_types.ts` (~35 lines) — `CardChangeKind` union + `CardDiff` interface. Pure type module placed under `src/conductor/` so `RuntimeStore` (daemon) and `reconciliation-diff.ts` (orchestrator) can both depend without cycles. Mirrors the `src/conductor/lead.ts` lightweight-shared-types pattern.
- `src/orchestrator/reconciliation-diff.ts` (~270 lines) — `captureSnapshot(repo)`, `diffSnapshots(before, after)`, `persistHandoffSnapshot(repo, snap)`, `loadLatestHandoffSnapshot(repo)`, `pruneHandoffSnapshots(repo, keepLastN)`. Does its OWN `readdir + stat` walk of `.conductor/runs/<runId>/<op>.md` files (does NOT reuse `findLatestArtifactRunId` — returns no mtime — or `listRuns` — returns events.jsonl mtime, not per-op-artifact mtime).
- `src/orchestrator/reconciliation.ts` (~210 lines) — `reconcile(args)` entry, `captureAndPersistHandoff(repo)` daemon helper, `pruneHandoffsAtBoot(repo, n)` boot helper, `isReconciliationInFlight()` accessor for the in-flight guard. Priority order by column (`shipped → verifying → building → approved → planned → discovered → archived`) tiebroken by `cardId.localeCompare`. Synthesizes a no-op decision for `card-archived` / `card-deleted` changes (spec OQ6: terminal, "cheap; explicit").
- `tests/orchestrator/reconciliation-diff.test.ts` (~225 lines, 19 tests) — full coverage of `captureSnapshot` (empty board + active+archive + substrate listing), each `CardChangeKind` (`card-created` / `card-deleted` / `card-archived` / `column-changed` / `body-edited` / `frontmatter-edited` / `substrate-added` / `substrate-modified`), substrate attribution by runId suffix, `persistHandoffSnapshot` + `loadLatestHandoffSnapshot` round-trip, lexicographic-latest selection, `pruneHandoffSnapshots` keep-last-N + no-op cases + missing-dir.
- `tests/orchestrator/reconciliation.test.ts` (~190 lines, 5 tests) — no-prior-snapshot sentinel (-1) + summary publish, decide()-per-card happy path, budget-exhaustion → deferred map population, decide() failure → defer-with-error path, archived-card synthesized no-op without LLM call.

**Modified files (7 src + 1 tests):**
- `src/daemon/runtime.ts` — `RuntimeStore` interface extended with the four `deferredReconciliations` accessors. `InMemoryRuntime` impl adds a private `Map<string, CardDiff>`; accessors do JSON-roundtrip defensive copies on read/write (CardDiff is pure JSON — no Dates / Maps / class instances).
- `src/daemon/event_bus.ts` — `DaemonEvent` union extended with `conductor-reconciliation-summary` variant carrying `totalCardsOnBoard` / `cardsAffected` / `cardsEvaluated` / `cardsDeferred` / `perCard[]` / `durationMs` / `ts`. Imports `CardDiff` from `src/conductor/reconciliation_types.ts`.
- `src/daemon/brain_log.ts` — `toRecord` switch adds the new kind, persists the full summary payload to `.conductor/brain.log.jsonl`. Filter `startsWith('conductor-')` (line 50) catches the new kind automatically — no filter change needed.
- `src/daemon/index.ts` — boot-time prune via `pruneHandoffsAtBoot(repo, config.handoffs.keep_last_n)` (best-effort, same pattern as runlog / brainlog prune). Subscribes to `lead-handed-off` events: `human → llm` triggers `reconcile()`; `llm → human` triggers `captureAndPersistHandoff()`. Subscriber lifetime managed via stored unsubscribe thunk; shutdown unsubscribes BEFORE `brainLog.close()` to preserve the brain-log writer's lifecycle invariant.
- `src/config/schema.ts` — `AutonomyBudgetSchema` extended with `max_reconciliation_calls_per_handoff: z.number().int().positive().default(10)` so the budget scales per autonomy mode alongside `orchestrator_calls_per_card` / `observer_calls_per_minute`. Top-level `handoffs.keep_last_n: z.number().int().positive().default(50)` added for snapshot retention.
- `src/orchestrator/index.ts` — barrel re-exports the reconciliation surface (`reconcile` / `captureAndPersistHandoff` / `pruneHandoffsAtBoot` / `isReconciliationInFlight` + types) and the diff-module surface (`captureSnapshot` / `diffSnapshots` / `persistHandoffSnapshot` / `loadLatestHandoffSnapshot` / `pruneHandoffSnapshots` + types).
- `src/ui/events.ts` — `DaemonEventKind` union extended with `'conductor-reconciliation-summary'` so the SSE forwarder doesn't drop unknown variants at the browser. UI render deferred to a future polish ticket per spec.
- `.gitignore` — added `.conductor/handoffs/` in the Conductor section.
- `tests/daemon/runtime.test.ts` — 4 new tests for the deferred-reconciliation accessors (empty default + round-trip, defensive copy on read, clear, list).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands**:
  - `npx tsc --noEmit` → clean.
  - `npx vitest run tests/orchestrator/reconciliation-diff.test.ts` → 19/19 pass.
  - `npx vitest run tests/orchestrator/reconciliation.test.ts` → 5/5 pass.
  - `npx vitest run tests/daemon/runtime.test.ts` → 12/12 pass (was 8; +4 deferred-reconciliation tests).
  - `npm test` → **994/994 pass** across 125 test files. Baseline 966 → 994 (+28 net new tests: 19 in `reconciliation-diff.test.ts` + 5 in `reconciliation.test.ts` + 4 in `runtime.test.ts`).
- **Commit (impl)**: `55f6872 feat(30.8): dual-driver lead-handoff reconciliation (#57)` (Control phase 30.8).

## Caveats

- **Producer-only ship — no in-tree consumer yet.** Feature #59 brain-loop-replacement is the planned consumer; its `runOneCard` will call `runtime.getDeferredReconciliation(cardId)` on first touch and run `decide()` with the deferred diff BEFORE the normal action. This PR ships the producer; tests exercise the producer surface directly. The Map MUST exist on `RuntimeStore` whether or not anything reads it yet, per #59's spec assumption.

- **Body diff sample is placeholder text, not unified diff.** `diffSnapshots` produces `details.bodyDiffSample: '(body content changed — re-read card for sample, cap N chars)'` instead of an actual unified-diff sample. Reason: the snapshot stores body hashes, not body bytes, so the pure diff function can't compute a real sample without re-reading the card. The executor (`reconcile()`) does NOT augment with a re-read either; the LLM gets the hash-difference signal + the change-kind list + the column/frontmatter/substrate deltas. Sufficient for v1; richer diff samples deferred to a future polish ticket if dogfood reveals the LLM needs more.

- **`buildSnapshot` (called by `decide()`) reads from `.conductor/cards/<id>.md` only.** Archived cards live in `.conductor/archive/cards/<id>.md` and would produce a `CardNotFoundError`. Reconciliation special-cases `card-archived` and `card-deleted` change kinds: synthesizes an explicit `no-op` decision WITHOUT calling the adapter (per spec OQ6: "Cheap; explicit"). This avoids dead-letter decide() calls and keeps the budget intact.

- **In-flight guard is module-local, not per-repo.** If two daemons hypothetically ran against different repos in the same process they'd contend; in practice the daemon is one process per repo (pidfile-enforced) so the guard suffices. Spec OQ5 lean preserved: let in-flight finish, queue next handoff.

- **Snapshot filename collision possible at sub-second handoff.** Filenames are `YYYYMMDDTHHMMSS.json` (per spec, matching runId timestamp shape). If two handoffs occur within the same second, the second overwrites the first. Acceptable for v1 — rapid back-to-back handoffs are unusual and the OVERWRITTEN snapshot would have captured nearly-identical state.

- **No UI render for the reconciliation banner yet.** SSE event flows to the browser (via `ui/events.ts` `DaemonEventKind` extension) but `card_detail.ts` / `monitor.ts` don't render a banner. Deferred to a future UI polish ticket per the spec's "Could defer to a separate UI polish ticket" framing.

## Related

- **Brainstorm:** `.relay/features/dual-driver-orchestration_brainstorm.md` (decision #8: "the brain should be able to diff the changes the user made…")
- **Producer dependency:** `.relay/implemented/dual-driver-orchestrator-core.md` (#54) — calls `decide()` AS-IS.
- **Event dependency:** `.relay/implemented/dual-driver-lead-follow-protocol.md` (#55) — subscribes to `lead-handed-off`.
- **Consumer (future):** `.relay/features/dual-driver-brain-loop-replacement.md` (#59) — reads `runtime.deferredReconciliations` per `runOneCard`.
- **Config sibling:** `.relay/implemented/dual-driver-autonomy-spectrum-config.md` (#60) — per-mode budget framing.
- **Substrate-decision dispatch (consumer):** `.relay/implemented/dual-driver-backward-transitions-and-substrate-advisory.md` (#58) — `wipe-substrate` / `branch-substrate` decisions from reconciliation are dispatched by the future executor (#59) via #58's RPCs.
- **Persistence dependency:** `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` — `conductor-` prefix is the filter shape; this feature's event name choice (`conductor-reconciliation-summary`) deliberately aligns.

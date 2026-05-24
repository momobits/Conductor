# Implemented: Dual-Driver Halt Categories

*Resolved: 2026-05-24*
*Phase: 22 (Relay) / Control 30.10*
*Feature spec: archived to [.relay/archive/features/dual-driver-halt-categories.md](../archive/features/dual-driver-halt-categories.md)*
*Brainstorm: [.relay/features/dual-driver-orchestration_brainstorm.md](../features/dual-driver-orchestration_brainstorm.md) (decision #5)*
*Commit: `ed1b974` feat(30.10): typed HaltCategory taxonomy + classification record (#61)*

## Summary

Replaced the spec § 9 narrow 8-reason halt catalog in `src/conductor/halt.ts` with a 15-category `HaltCategory` zod enum and a `HaltClassification` record return shape. `classifyHalt()` now returns `{category, rawReason, context}` so the typed category drives dispatch while the verbatim halt message persists for telemetry and audit. The wider taxonomy is the single source of truth: orchestrator's `HaltWithHandoffParams.category` imports `HaltCategorySchema` directly, and the orchestrator system prompt generates its category list from the same schema at module init so prompt + schema can never drift.

## What shipped

### `src/conductor/halt.ts` (rewrite)

- `HaltCategorySchema` (zod enum, 15 values clustered as op-level / transition-gate / orchestrator-level / hard-fail / catch-all).
- `HaltClassification` interface with `category`, `rawReason`, `context: Record<string, string>` fields.
- `PATTERNS` array of `{category, match: RegExp, extractContext?}` entries; first match wins. `missing-step-arg`'s `'<column>' requires --step <id>` extractor surfaces the column name in `context.column`.
- `HaltReason` retained as a back-compat type alias for `HaltCategory` (only consumers were the halt test files; no external imports).

### `src/conductor/loop.ts`

- `runOneCard` consumes the typed classification. The legacy event `reason` string is preserved as `"<category>: <rawReason>"` so existing `loop_redteam` tests and `monitor.ts` string-matchers keep working. New typed `category`/`rawReason`/`context` fields ride alongside on the `conductor-halt` event for downstream consumers that want typed dispatch.

### `src/daemon/event_bus.ts`

- `conductor-halt` event widened with optional `category`, `rawReason`, and `context` fields. Optional because the wedge detector, conduct() halt path, and cost-ceiling breach path still publish without classification — that's a deliberate narrow-window scope cut; those sites can adopt categorization in a follow-up if the typed surface proves useful.

### `src/orchestrator/types.ts`

- `HaltWithHandoffParams.category` now imports `HaltCategorySchema` from `src/conductor/halt.ts` directly (replaces the inline 6-value v1 subset). Single source of truth for the taxonomy shared by brain loop publishes, orchestrator decisions, observer rules.

### `src/orchestrator/prompt.ts`

- System prompt's halt-category list is generated from `HaltCategorySchema.options` at module init via `HALT_CATEGORY_LIST = options.map(c => `"${c}"`).join('|')` interpolated into the JSON schema doc. Prompt and schema can never drift.

### Tests (1025 → 1036 pass / 0 fail)

- `tests/conductor/halt.test.ts`: full rewrite. 17 tests — 3 for taxonomy/return-shape invariants (enum options pinned, classification shape pinned, rawReason preserved on unknown), 14 for per-category patterns including a first-match-wins ordering test.
- `tests/adversarial/halt_redteam.test.ts`: migrated all assertions from string-equality on the result to `.category` reads; renamed `unrecognized-error` → `unknown` (the catch-all category).
- `tests/orchestrator/types.test.ts`: `narrows halt-with-handoff with each category` updated to iterate all 15 widened categories.
- `tests/orchestrator/prompt.test.ts`: `system prompt mentions every HaltCategory option` updated to assert against all 15 widened categories (spot-checks one per cluster).

## Design decisions during implementation

1. **`HaltReason` kept as back-compat type alias** rather than removed. The spec said "rewrite"; the cost of preserving the alias is zero and removing it would require updating the halt test file's imports. The alias points at `HaltCategory`, so callers see the wider taxonomy through the old name.

2. **Legacy `reason` string preserved on the `conductor-halt` event** (formatted as `"<category>: <rawReason>"`) instead of replacing with the bare category. Three regression-test sites depend on this string shape:
   - `tests/adversarial/loop_redteam.test.ts` regex-matches `/destructive-action/` and `/auth-needed/` against `e.reason`.
   - `src/ui/views/monitor.ts` line 150 interpolates `e.reason` directly into the brain-log line.
   - `tests/conductor/loop.test.ts` regex-matches `/unrecognized-error|wedged/i` against `e.reason`.
   Adding the typed fields alongside (`category`, `rawReason`, `context`) gives downstream consumers the typed surface without breaking the legacy string-matchers. Saves a multi-site UI/test rewrite in this scope.

3. **`out-of-sequence-human-action` category dropped** from the original spec's 13-category list. After surveying shipped #56 (observer-advisor), the out-of-sequence concept is the observer's `RuleMatch.ruleId` surface (`transition-forward-substrate-check`, `backward-transition-with-orphans`, `archived-touched`), not a halt category. Halts don't fire for out-of-sequence detections — advisories do. Removing the category from the halt taxonomy keeps the two surfaces distinct.

4. **`cost-ceiling` not `cost-ceiling-reached`**. The spec listed `cost-ceiling-reached`; the existing pattern in halt.ts matched on the word "cost ceiling" and emitted `cost-ceiling` (spec § 9 narrow name). Keep the shorter name to avoid a multi-site rename across `lead.ts` `LeadTransferReason` (which has its own `cost-ceiling-reached` value — different enum, unrelated) and `rpc/schema.ts`.

5. **Optional `category`/`rawReason`/`context` on the `conductor-halt` event** (not required). The loop's `classifyHalt` path always sets them, but three other publishers (wedge detector, conduct() halt, cost-ceiling breach) don't classify. Making the fields required would force a multi-site rewrite for no immediate benefit; making them optional matches the producer-only pattern used by shipped #57 and #56.

6. **Prompt-list generation at module init, not at `assemblePrompt` call time**. `HALT_CATEGORY_LIST` is a module-level const so the join cost is paid once. The SYSTEM_PROMPT template literal interpolates it the same way it interpolates `RATIONALE_CAP`.

## Files touched

- `src/conductor/halt.ts` (rewrite — 50 → ~170 lines)
- `src/conductor/loop.ts` (one block edited; ~12 lines added)
- `src/daemon/event_bus.ts` (one import + one event shape widened)
- `src/orchestrator/types.ts` (one import + inline enum replaced with schema ref)
- `src/orchestrator/prompt.ts` (one import + one const + one template interpolation)
- `tests/conductor/halt.test.ts` (rewrite — 51 → ~125 lines, 8 → 17 tests)
- `tests/adversarial/halt_redteam.test.ts` (migrated to `.category`; 11 tests, same count)
- `tests/orchestrator/types.test.ts` (one test's category list widened)
- `tests/orchestrator/prompt.test.ts` (one test's category list widened)

## Test impact

Baseline: 1025/1025 across 126 test files.
After: 1036/1036 across 127 test files (halt.test.ts gained 9 tests for new per-category patterns + return-shape invariants).
Typecheck: clean.

## Follow-ups (out of scope for #61)

- **Categorize the other three `conductor-halt` publishers** (wedge detector, conduct() halt path, cost-ceiling breach). Mechanically simple — just thread `classifyHalt` results through. Skipped here to keep #61 narrow.
- **UI category-badge rendering** in `monitor.ts` / `dialog.ts` brain-log lines (per spec § "Migration of existing consumers"). Spec mentions both; the typed fields ride alongside on the event now, so the UI can pick them up in a follow-up without a back-and-forth.
- **Per-category dialog content** in `dialog.ts` (e.g., "This card needs the next implementation step. Pick one." for `missing-step-arg`). Useful for assist mode; deferred until dialog surface is touched for another feature.
- **Tightening `context` field shape** per category (typed records instead of `Record<string, string>`). Per spec Open Question 4 lean: defer; loose record is sufficient for v1.

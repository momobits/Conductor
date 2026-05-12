# `conductor work` no longer creates a phantom run directory for nonexistent cards

## Summary

*Resolved: 2026-05-12*

**Problem:** `conductor work <nonexistent-card>` created a phantom run directory at `.conductor/runs/<ts>-<id>/` containing a single `error`-kind event before failing. Phantoms accumulated in `conductor run list`, mixed with legitimate runs, and inflated the retention store (potentially pushing real runs out of `keep_last_n`).

**Resolution:** Changed `TaskAgent.run()`'s pre-run validation catch (`src/agent/task_agent.ts:74-77`) from `yield await this.emit({kind:'error', ...}); return;` to `throw new Error(message)`. The catch still composes its message via 9.1's `messageForReadCardError` helper, but bypasses the `RunLogWriter` write entirely — preventing the lazy `mkdir` in `RunLogWriter.open()` from firing. The constructor's eager `RunLogWriter` instantiation was left unchanged; it doesn't trigger mkdir on its own (writer's `open()` only fires on first `write()`).

The adversarial review caught a hidden consumer-side regression: the autonomy loop's `runOneCard` (`src/conductor/loop.ts:130-188`) had no try/catch around its `for await (const ev of this.agentFactory(cardId))`. Before 9.3, missing-card errors yielded an `error`-kind event and flowed through the existing `ev.kind === 'error'` branch into `classifyHalt` + a `conductor-halt` event. After 9.3's source-only change, a thrown error from a real autonomy-loop race (card deleted mid-run) would silently kill the loop with no diagnostic. Step 4 wraps the for-await in try/catch and routes thrown errors through the same halt-classifier branch — preserving the diagnostic invariant.

A new redteam test (`tests/adversarial/loop_redteam.test.ts`) uses a synthetic throw-factory to pin Step 4's contract: thrown errors from the agent factory must surface as `conductor-halt` events with the message preserved.

## Files Modified

- `src/agent/task_agent.ts` — replaced the yield-emit-return shape with `throw new Error(message)` inside the readCard catch. One-line semantic change; constructor untouched.
- `src/conductor/loop.ts` — wrapped `runOneCard`'s for-await in try/catch. The catch maps `e.message` into the existing `halt = true; haltReason = ...` shape so both yielded errors (mid-run) and thrown errors (pre-run) converge on the same `classifyHalt + publish conductor-halt` branch. Preserves pre-9.3 diagnostic visibility for autonomy loop missing-card races.
- `tests/agent/task_agent.test.ts` — rewrote the two existing yielded-error tests (`emits error event when card does not exist`, `emits parse-aware error event when card YAML is malformed`) to assert thrown error + no `.conductor/runs/` dir, using a single-capture try/catch pattern. Added `existsSync` to the `node:fs` import. Net test count unchanged (5).
- `tests/cli/work.test.ts` — extended `throws if the card does not exist` to assert `readdirSync('.conductor/runs') === []` (the dir is pre-created by `runInit` as scaffold; the test asserts no run subdirectory was created by the failed work invocation). Added `readdirSync` to imports. Net test count unchanged (3).
- `tests/adversarial/loop_redteam.test.ts` — added 1 new case `publishes conductor-halt when agent factory throws (9.3 pre-run validation contract)` using a synthetic factory that throws. Asserts the autonomy loop catches and publishes the expected `conductor-halt`. Net test count +1 (3).

## Verification

- `npm run typecheck` — clean.
- Targeted: `npx vitest run tests/agent/ tests/cli/work.test.ts tests/adversarial/ tests/conductor/` → **72/72 pass** across 13 test files in 2.57s.
- Full: `npm test` → **497/497 pass** across 96 test files in 15.56s (496 baseline + 1 new). Zero regressions.

## Caveats

- **RPC SSE consumers no longer receive a `task-event{kind:'error'}` for missing-card.** Pre-9.3 sequence was `session-start` → `task-event{error}` → `session-end`. After 9.3, it's `session-start` → `session-end` (no `task-event`), with the RPC response carrying the JSON-RPC error. UI clients that previously listened for the error-kind task-event to render a "card not found" toast should look at the RPC error response. Filed as a deferable UI-polish companion in the Analysis (weak unfiled candidate).
- **The `kind: 'error'` TaskEvent variant remains in the schema** — it's still used for mid-run errors (the adversarial redteam test exercises this path with a synthetic yielded-error factory). Only the **pre-run validation path** changed from yield to throw.
- **Phantom run dirs from prior unfixed runs** in a user's `.conductor/runs/` persist after this fix. Cleanup via `conductor run prune` or manual `rm -rf`. Not a regression — just a non-cleanup.
- **Verification Fix 1 noted in the Verification Report**: Step 3's planned assertion `expect(existsSync(...)).toBe(false)` had to be reshaped to `expect(readdirSync(...)).toEqual([])` because `runInit` (the `conductor init` command at `src/cli/commands/init.ts:30, 166-168`) creates `.conductor/runs/` as one of the standard scaffold subdirectories. The corrected assertion is strictly stronger — checks the actual phantom-prevention contract.
- **Phase 9 is now complete** — all three steps (9.1, 9.2, 9.3) closed. Next: `/phase-close` to tag `phase-9-malformed-yaml-error-surface-closed`.

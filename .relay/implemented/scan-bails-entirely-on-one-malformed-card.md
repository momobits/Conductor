# `conductor scan` continues past malformed cards (lenient listCards)

## Summary

*Resolved: 2026-05-12*

**Problem:** A single card with malformed YAML frontmatter caused `conductor scan` to exit non-zero and hide every healthy card. The same crash propagated through the RPC `conductor.scan` handler, blanking the UI Board.

**Resolution:** Added a parallel `listCardsLenient(cardsDir)` in `src/engine/state/card.ts` that returns `{ cards, errors }` — catching `CardParseError` per file (relying on the typed-error discriminator landed in step 9.1) and rethrowing every other error class (`CardNotFoundError` race, `EACCES`, `EISDIR`, unknown). The strict `listCards` is unchanged; snapshot consumers (`card_list`, `work_next`, `getPhaseClosure`, conductor loop) still fail-fast. Observability surfaces (engine `scan` op + RPC `scan` handler) route through the lenient variant; the engine op and RPC handler are intentionally **not unified** (they have a pre-existing response-shape divergence — flat `CardSummary[]` vs raw `Card[]` — that the UI Board relies on; filed as a companion candidate for post-9.2 cleanup).

The CLI renders the warnings to `stderr` before the column listing and uses `process.exitCode = 1` only when zero cards parsed AND at least one error was seen. The `exitCode` path (rather than `process.exit(1)`) lets Node flush stdio buffers cleanly — Windows-safe.

## Files Modified

- `src/engine/state/card.ts` — added `listCardsLenient(cardsDir)`. Stores `{ path, message: "${reason}: ${innerCause}" }` where `reason` is `'yaml'` or `'schema'` from `CardParseError.reason` (Deviation 1 from review: the lenient warning shape is data, not display — `messageForReadCardError` is for typed-error catch sites, not aggregate iteration). The `instanceof CardParseError` check is load-bearing — non-parse errors still propagate raw.
- `src/engine/types.ts` — extended `Status` with optional `errors?: Array<{ path: string; message: string }>`. Additive; existing producers unchanged.
- `src/engine/ops/scan.ts` — switched import to `listCardsLenient`; passes `errors` through to the returned `Status`.
- `src/rpc/methods.ts` — same swap in the duplicate `scan` handler; includes `errors` in the response object. (Pre-existing engine/RPC divergence preserved; unifying is out of scope.)
- `src/cli/commands/scan.ts` — renders `status.errors` to stderr before the column listing; sets `process.exitCode = 1` only when `cards.length === 0 && errs.length > 0`.
- `tests/engine/state/card.test.ts` — new `describe('listCardsLenient', ...)` block: 6 cases covering all-good, one-bad-YAML, schema failures, missing-dir, all-bad, EISDIR rethrow regression guard.
- `tests/engine/ops/scan.test.ts` — new case: malformed-card → `Status` carries healthy cards plus errors; column tally unaffected.
- `tests/cli/scan.test.ts` — new case: `runScan` returns `Status` with `errors` populated when one card is broken.

## Verification

- `npm run typecheck` — clean.
- Targeted: `npx vitest run tests/engine/state/ tests/engine/ops/scan.test.ts tests/cli/scan.test.ts tests/rpc/` → **76/76 pass** across 10 test files in 5.06s.
- Full: `npm test` → **496/496 pass** across 96 test files in 15.84s (488 baseline + 8 new). Zero regressions.

## Caveats

- **Pre-existing engine/RPC response-shape divergence** (`src/engine/ops/scan.ts:scan` returns flat `CardSummary[]`; `src/rpc/methods.ts:scan` returns raw `Card[]`). The UI Board (`src/ui/views/board.ts:22-23`) consumes the raw shape. The `order` RPC handler's comment at `src/rpc/methods.ts:126-128` incorrectly claims no callers of the RPC handler are affected — the UI is one. 9.2 keeps this divergence intact; lenient handling was paralleled at both sites. Unifying is a future companion candidate (would require a UI rewrite).
- **UI Board does not yet render warnings.** The new `errors?` field on `Status` is structurally ignored by the local `ScanResult` interface in `src/ui/views/board.ts`. The Board now shows healthy cards (good — better than blank), but users see warnings only via stderr / terminal. UI-polish-grade companion, deferred.
- **Sequential dependency for 9.3** (`work-creates-run-dir-before-validating-card`): still uses the typed errors landed in 9.1; not affected by 9.2's additive `listCardsLenient`.
- After 9.3 closes, `/phase-close` will tag `phase-9-malformed-yaml-error-surface-closed`.

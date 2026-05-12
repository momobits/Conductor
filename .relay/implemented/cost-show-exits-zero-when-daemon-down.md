# Implemented: `conductor cost show` exits 1 (with stderr-routed diagnostic) when daemon is down

## Summary

*Resolved: 2026-05-12*

- **Problem.** `conductor cost show` printed the friendly "(daemon not running)" hint and exited **0** when the daemon was offline. A shell script using `if conductor cost show; then ...` would enter the success branch despite the missing data — silent monitoring failures, ambiguous CI exit semantics, and cross-command inconsistency (every other CLI command in the repo exits non-zero on "couldn't fulfill request").
- **Resolution.** Function-level: added an optional `logErr` sink to `CostShowArgs` (with `??`-fallback to `log` for backward compatibility); routed both failure-diagnostic branches (daemon-down at the gate, no-result after RPC) via `logErr ?? log`; changed the daemon-down return value from `0` to `1`. Action-level: captured the returned exit code, plumbed `logErr` → `process.stderr.write`, and propagated the code to `process.exitCode` (conditionally, only when non-zero, mirroring `scan.ts:44-46`'s 9.2 pattern).

## Files Modified

- `src/cli/commands/cost.ts`:
  - Lines 11-15 — `CostShowArgs` interface: added optional `logErr?: (s: string) => void`.
  - Lines 24-27 — daemon-down branch: `args.log(...)` → `(args.logErr ?? args.log)(...)`; `return 0` → `return 1`.
  - Lines 37-40 — no-result branch: `args.log('(no result)')` → `(args.logErr ?? args.log)('(no result)')` for consistency (it already returned 1; this just upgrades the routing).
  - Lines 62-68 — `attachCost` action: capture `const code = await costShowCommand(...)`; plumb `logErr: (s) => process.stderr.write(s + '\n')`; `if (code !== 0) process.exitCode = code` (Windows-safe pattern from 9.2; conditional to match `scan.ts:44-46`'s "only set when failing" convention).
- `tests/cli/cost-cli.test.ts`:
  - First test (`reports "(daemon not running)" when no endpoint file exists`) — renamed to `exits 1 with a "(daemon not running)" diagnostic when no endpoint file exists`; assertion flipped from `expect(code).toBe(0)` to `expect(code).toBe(1)`. Existing message-capture assertion stays green because Step 1's `??`-fallback routes to `log` when `logErr` is absent.
  - New second test (`routes the daemon-down diagnostic to logErr when both sinks are supplied`) — pins the stderr-routing contract at the function-contract level: when both sinks are plumbed, the diagnostic lands on `logErr` exclusively (positive `err` assertion + negative `out` regression guard).

## Verification

- `npm run typecheck` — clean (engine `tsconfig.json` + UI `tsconfig.ui.json` both pass).
- `npx vitest run tests/cli/cost-cli.test.ts` — 2/2 pass (was 1).
- `npm test` — **499/499 pass across 96 test files in 14.84s**; baseline 498 + 1 new test = expected 499. Zero regressions.

## Caveats

- **Issue scope was implicitly broader than its stated lines.** The issue cited `cost.ts:22-27` (the daemon-down branch). Source verification surfaced that `cost.ts:61-65` (the `attachCost` Commander action handler) discards the function's returned exit code — without fixing the action wiring, the function-level `return 1` would change the test's expectation but **not** the actual CLI exit code that shell scripts see. The same defect silently neutered the existing `return 1` on RPC failure (`cost.ts:38`) too. Both are fixed by this commit. Documented in the analysis Validation block and the adversarial review.
- **Phase-6 brain CLI design doc carries the same pre-fix pattern.** `docs/superpowers/plans/2026-05-08-phase-6-conductor-brain.md:2572` shows `process.exitCode = 0` on daemon-down — the same misdesign cost is correcting. When phase-6 lands, its brain CLI should adopt the unconditional-exit-1 + stderr-routing convention (and the conditional `process.exitCode = code` wiring shape). Flagged in the archived issue's Related Work; out of scope for 10.2.
- **No `docs/operations.md` update in this PR.** The issue's "Affected files" listed it for documenting the exit-code convention. Per `.relay/relay-ordering.md § Phase 7`, docs ship as one bundle after code stabilizes; deferred there. The phase-10 step description was unchanged on this point.
- **No `attachCost` integration test.** The plan exercises the function contract (return value + sink routing) but the Commander action handler itself has no direct test — the test would require Commander-wrapping infrastructure not currently set up in `tests/cli/`. The function-level test plumbs both sinks exactly like the production wiring, which catches the routing regression that would matter most. A future regression in the action-handler wiring (e.g., dropping the `process.exitCode = code` line) would only manifest as an exit-code mismatch in shell scripts, observable via dogfooding.
- **No regression risk to phase-9 or 10.1 work.** Phase-9 touched card-read error handling in `task_agent.ts` and `card.ts`; 10.1 touched the H1→H2 convention in `discover.ts` and `card.ts`. No file overlap with cost.

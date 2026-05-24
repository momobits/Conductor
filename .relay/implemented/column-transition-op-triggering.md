# Implemented: Column-transition op triggering

## Summary

*Resolved: 2026-05-24 (Control phase 30.11; Relay Phase 20 Frame B Cohort C item #50)*

- **Goal**: When a card moves columns (drag-drop, keyboard move-chord), automatically invoke the corresponding engine op per the autonomy policy, so the user doesn't have to separately click a per-op button after every column move. Reuses `op_invoke` from #48 + the existing `confirmTransition` flow + the shared `moveWithAdvisory` helper from 30.6.
- **How it was resolved**: New shared mapping helper `src/ui/lib/column_ops.ts` exposes `COLUMN_OPS_MAP` (forward-only bindings) + `opsForTransition(from, to)` lookup. Extended `moveWithAdvisory` so that after the `transition` RPC succeeds, IF the policy is `'auto'` or `'assist'` AND the direction is `'forward'`, it iterates the resolved ops and awaits `rpc.call('op_invoke', { cardId, op })` for each in order. Chain stops on first failure (logged warn; user can manually invoke remaining via per-op buttons from #48). The substrate-advisory branch from 30.6 is unchanged — backward moves still flow through that path with no op-trigger.
- **Mapping decision** (Decision 7 per brainstorm): `discovered→planned`=[analyze]; `planned→approved`=[] (user approval gate); `approved→building`=[plan, implement]; `building→verifying`=[verify]; `verifying→shipped`=[resolve]; `shipped→archived`=[] (resolve already advanced). Documented inline as IMPLEMENTATION DEVIATION from the spec markdown's TaskAgent-derived table (the brainstorm decision is the more conservative authoritative mapping per the orchestrator brief).

## Files Modified

**New files (2):**
- `src/ui/lib/column_ops.ts` (~65 lines) — `COLUMN_OPS_MAP` const-array of 6 forward-only bindings + `opsForTransition(from, to)` pure lookup. Returns `[]` for any non-canonical edge (backward, lateral, skip, no-op, terminal-out). Header docblock explains the deviation from the spec table.
- `tests/ui/column_ops.test.ts` (12 tests) — Decision 7 mapping (6 tests, one per canonical edge), non-canonical edges return [] (4 tests: backward, skip, no-op, terminal-out), table shape invariants (2 tests).

**Modified files (2):**
- `src/ui/views/move_with_advisory.ts` — imported `opsForTransition` + `ColumnOp`. Added `transitionOk` flag around the existing transition `try/catch` so the chain only fires on successful transition. Appended an op-triggering block after the transition RPC: gated by `policy !== 'manual'` AND `transitionDirection(from, to) === 'forward'`; iterates `opsForTransition(from, to)` awaiting each `op_invoke`; logs + `break` on first failure. ~26 lines added (logic + docblock).
- `tests/ui/move_with_advisory.test.ts` — extended `makeRpc` to return the `op_invoke` envelope shape (`{runId, status:'started'}`). Added 9 new tests under "forward transition op triggering (Relay #50)": auto+single-op edge, auto+multi-op edge (plan→implement order), assist+single-op, manual=no chain, planned→approved (canonical empty), shipped→archived (canonical empty), backward edge (no chain), transition rejection (no chain), first-op-failure halts chain (second op not invoked).

## Verification

- **Notebook**: SKIPPED per `.relay/relay-config.md § Notebook Setup` (TypeScript-only project; no Jupyter integration).
- **Test commands** (all green at implementation HEAD `b1a7abf`):
  - `npm run typecheck` → clean across both engine + UI tsconfigs.
  - `npx vitest run tests/ui/column_ops.test.ts tests/ui/move_with_advisory.test.ts` → 29/29 pass (12 new + 17 total in move_with_advisory).
  - `npm test` → **1057/1057 pass across 128 test files** in ~18s. Baseline 1036 → 1057 (+21 net new: 12 column_ops + 9 move_with_advisory chain tests).

## Caveats

1. **Implementation deviation from spec markdown table.** The feature spec at `.relay/features/column-transition-op-triggering.md` derives its column-to-op mapping from TaskAgent's `case '<column>'` blocks (so `discovered→planned` would chain `[analyze, plan]`, etc.). The orchestrator brief mandates the brainstorm Decision 7 mapping which is more conservative — one op per edge where that op semantically owns the edge. We followed the brief. The helper's header docblock makes this explicit so future readers don't get confused by the spec ↔ implementation gap.

2. **`verifying→shipped` triggers `resolve` which moves shipped→archived itself.** Net effect: a single move from `verifying` to `shipped` ultimately lands the card in `archived` (when policy is auto/assist and resolve succeeds). This is by-design per the brainstorm — resolve owns archival. The column-trigger does NOT separately fire on the shipped→archived transition that resolve emits internally (it doesn't run through `moveWithAdvisory`).

3. **`assist` policy = one approval covers the whole chain.** Per brainstorm Open Q3: the existing confirmTransition dialog captures intent for the entire move. We do NOT re-prompt per op. If the user wants to selectively skip mid-chain, they cancel before the dialog approves; partial-chain control via per-op approval is not in scope for v1.

4. **Op-chain failure surfaces only as a console.warn, not a user-visible toast.** When op N succeeds but op N+1 fails (e.g., cost-ceiling breach), the chain halts silently from the UI's perspective — the warn lands in browser console only. The card's column has already moved; user discovers the partial-chain state via the card-detail event stream or by noticing the op didn't run. A toast/inline-notice surface would be a polish follow-up; matches existing moveWithAdvisory warn-only failure pattern.

5. **`manual` policy means metadata-only column move, no op triggering.** Honors the autonomy spectrum's intent (manual = full operator control). User can then manually invoke ops via the per-op buttons from #48.

6. **Backward transitions bypass op triggering entirely.** `transitionDirection(from, to) === 'forward'` is the gate. Backward moves already flow through the substrate-advisory branch (30.6 / #58) for the keep/wipe/branch decision — no op fires regardless of policy. Documented in header docblock.

7. **Concurrent-move rejection NOT added in this step.** Spec Open Question 5 proposed rejecting a second move while an op_invoke for the same card is running. Not implemented here — `op_invoke`'s own concurrent-op rejection (from #48: getActiveSession check) provides the relevant guard at the RPC layer. UI doesn't pre-reject; if the user manages to fire a second move during a running op, the second op_invoke's RPC will reject and the chain halts gracefully. Acceptable for v1.

8. **`implement` step arg not specified.** Spec Open Q2 noted `implement` requires a step arg. We rely on `op_invoke`'s server-side fallback from #48 (`resolveNextStep` from Phase 29.3) which picks the first uncommitted step. UI doesn't expose a step picker for this column-trigger path; matches the per-op-button behavior from #48. Deferred to v2 per the same rationale.

9. **Pattern precedent**: pure-helper extraction reaches **n=19** with the addition of `column_ops.ts`'s `opsForTransition`. ADR filing remains operator-deferred per `feedback-adr-scope-discipline.md` memory.

10. **Frame B Cohort C progression**: #50 is the first Cohort C item. Closes the loop on Cohort A (#47 multi-surface-view + #48 op-controls) by giving column moves an actionable per-edge consequence. Remaining Cohort C work depends on which items the sweep continues with — column-trigger is now a usable end-to-end primitive for those follow-ons.

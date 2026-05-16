> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-board-dnd-invalid-transition-uses-server-error-alert.md)

# Board drag-drop offers approval for transitions the server will reject

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P2 — confusing UX flow on invalid moves.*

## Problem statement

The board's drag-drop layer does not pre-validate whether the dropped column is a legal successor. Any cross-column drop where `from !== to` enters the policy-resolution path and shows the confirmation dialog. Manual / backward / lifecycle-skipping moves get the same "Approve transition?" prompt as legitimate forward moves. Only after the user clicks **Approve** does the request go to the server, which rejects with `Invalid transition: <from> → <to>` — surfaced via a blocking `alert()`.

## Current state

- `src/ui/views/board_dnd.ts:49-67` — `drop` handler resolves the policy from `config.autonomy.transitions[\`${from}_to_${to}\`] ?? 'manual'`. Missing keys (i.e. invalid transitions) silently fall back to `manual`.
- `src/ui/views/board.ts:34-43` — `policyForExit()` already knows the valid forward map: `discovered → planned → approved → building → verifying → shipped → archived`. That same map should be reused at the drop site to short-circuit invalid drops.
- `src/engine/state/transitions.ts` (server) — rejects with code `-32603`, message `Invalid transition: <from> → <to>`. UI catches this and shows `alert(\`Transition failed: ${err.message}\`)`.

## Reproduction

1. Open Board with cards in `building` (e.g., `2026-05-12-health-check-endpoint` in omniforge).
2. Drag the card to `discovered`.
3. Observe: confirmation dialog "Move ... / building → discovered / Autonomy policy: manual" appears as if legal.
4. Click **Approve** → blocking `alert()` "Transition failed: Invalid transition: building → discovered".

## Impact

- Misleads the user about what transitions exist (policy panel implies it's allowed under manual approval).
- Browser `alert()` is jarring, accessibility-hostile, and not styleable against the rest of the Control-Room aesthetic.

## Proposed direction

- At drop time, look up the forward map (reuse `policyForExit`'s allowed-next-column logic). If `to` isn't a legal successor for `from`, abort the drop visually: brief shake on the source tile, optional in-column hint "not a valid next column", no dialog, no server call.
- For the rare cases where backward / lifecycle-skipping moves are legitimate (rollback after an aborted run), expose them through a dedicated card-detail control rather than drag-drop.
- Replace the post-failure `alert()` with an in-app toast / banner using existing status surfaces (`#err` style block on the Board, or per-card flash).

---

## Analysis

*Analyzed: 2026-05-16*

### Validation
- Problem still exists: **YES**. `src/ui/views/board_dnd.ts:49-67` matches verbatim. The drop handler reads `from`, `to`, looks up `policy = config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual'` (line 58), unconditionally shows the confirmation dialog via `confirmTransition` (line 59), calls `rpc.call('transition', ...)` (line 62) on approval, and on error fires `alert(\`Transition failed: ${err.message}\`)` (line 64). No client-side pre-validation against the lifecycle's allowed transitions.
- Sibling #30 still exists: **YES**. `src/engine/lifecycle.ts:22-26` matches verbatim. `BACKWARD` has exactly 3 edges (`planned->discovered`, `building->approved`, `verifying->building`); `approved->planned` is missing.
- Proposed approach still valid: **YES, with one design correction surfaced by Related Work** (see Open Questions below): `isLegalTransition` must check BOTH forward and backward edges to remain in parity with the server's `canTransition`. If it only checked forward, #30's newly-valid `approved → planned` drag would be rejected by the client-side validator even though the server would accept it.

### Root Cause

#29 root cause is **missing client-side mirror of the server's transition policy**. The lifecycle state machine (`src/engine/lifecycle.ts:28-32` `canTransition`) is the canonical source of truth for what moves are allowed. The UI's drag-drop layer historically had no client-side knowledge of that map and let the server be the gate — which produced the bad UX of "dialog → approve → server reject → blocking alert" for every invalid drop. The fix is to mirror the validator on the client and short-circuit invalid drops before they ever reach the dialog.

#30 root cause is **asymmetric BACKWARD set**: the lifecycle allows undo from `planned`, `building`, and `verifying`, but NOT from `approved`. There is no architectural justification for the asymmetry — `approved` is the lowest-cost rollback target (no build work performed yet). The fix is a one-line addition to the `BACKWARD` set.

Both items share the same architectural family: the client and the server disagree about what moves are valid, producing UX where the server is the only authority and the client guesses. Phase 24's deliverable — extracting `src/ui/views/board_validate.ts` as a shared validator — collapses that disagreement into a single source of truth on the client that mirrors `canTransition`. This extract is also **explicit hard substrate for Relay Phase 17 #41** (`keyboard-board-focus-and-move`), which is already designed to import `FORWARD_MAP`, `nextColumn`, and `isLegalTransition` from this exact module path. Phase 24 doing the extract now unblocks Phase 17 mechanically; deferring it would force Phase 17 to redo the extract from scratch.

### What This Means (User Impact)

**In plain terms (#29):** When you drag a card to a column it can't legally move to, the system asks you to confirm the move — then, after you click Approve, throws up a browser alert saying "Transition failed". It pretends invalid moves are valid until you commit, then yanks the rug. Worse, the alert is a blocking modal that breaks the rest of the page.

**Scenario for #29:** Dana drags `2026-05-12-health-check-endpoint` (currently in `building`) over to `discovered` — she's trying to reset the card after a bad design call. The drop dialog appears: "Move 2026-05-12-health-check-endpoint / building → discovered / Autonomy policy: manual". She clicks Approve, expecting the rollback. A blocking `alert()` fires: "Transition failed: Invalid transition: building → discovered". She dismisses the alert. The card is still in `building`. Nothing changed; she got nothing for the click. She tries dragging back to `approved` — sees the same dialog, approves, this time it works (because `building → approved` IS a backward edge). The user has no way to know which drops are legal without trying them.

**Before (#29):**
1. User drags `building` card to `discovered`.
2. Dialog appears: "Move ... / building → discovered / Autonomy policy: manual".
3. User clicks Approve.
4. RPC fires; server returns `Invalid transition: building → discovered`.
5. Browser `alert()` blocks the page: "Transition failed: ...".
6. User dismisses. Card unchanged. Browser focus disrupted.

**After (#29):**
1. User drags `building` card to `discovered`.
2. Source tile briefly shakes (220ms CSS animation); no dialog appears; no server call.
3. User immediately understands the drop wasn't legal; no commit step required. Browser focus undisturbed.

**In plain terms (#30):** If you accidentally approve a card (or the `assist` policy autoapproves it), you can't undo via the UI. The card is stuck in `approved` until you push it forward through `building → verifying → shipped → archived` (which actually runs the work agent) or hand-edit the yaml frontmatter to roll it back.

**Scenario for #30:** Eric is reviewing the board. The `assist` policy on `planned → approved` surfaces a dialog for `2026-05-15-add-favicon`; he means to cancel but mis-clicks Approve. The card jumps to `approved`. He drags it back toward `planned` — server rejects with `Invalid transition: approved → planned`. He tries `discovered` — same. The only way to undo: open `.conductor/cards/2026-05-15-add-favicon.md` and change `column: approved` → `column: planned` by hand.

**Before (#30):**
1. User over-approves card from `planned → approved`.
2. Drags back to `planned`. Server rejects.
3. CLI also rejects (same `canTransition`).
4. Only escape: hand-edit yaml frontmatter.

**After (#30):**
1. User over-approves card from `planned → approved`.
2. Drags back to `planned`. Dialog confirms ("Move ... / approved → planned / Autonomy policy: manual"). User clicks Approve.
3. Server accepts. Card returns to `planned`. No work was performed; rollback is clean.

### Blast Radius

**Files affected**
- `src/engine/lifecycle.ts` — add `'approved->planned'` to `BACKWARD` set (lines 22-26). Single-line addition.
- `src/ui/views/board_dnd.ts` — refactor drop handler to import `isLegalTransition` from `board_validate.ts`, short-circuit on illegal drops with `.shake` class, drop the `alert()`. Affects lines 49-67.
- `src/ui/views/board.ts` — refactor `policyForExit` to import `FORWARD_MAP` from `board_validate.ts`, replacing the inline `forwardMap` const at lines 36-39. Single source of truth.
- `src/ui/views/board_validate.ts` — NEW file. Exports `Column`, `FORWARD_MAP`, `BACKWARD_MAP`, `nextColumn(from)`, `isLegalTransition(from, to)`. Public API per Phase 17 #41's design contract (with the bidirectional `isLegalTransition` correction noted in Open Questions below).
- `src/ui/app.css` — add minimal `.shake` keyframes + class rule (~10 lines). Phase 17 #41 will extend with move-mode rules later.

**Callers / consumers**
- `canTransition` (lifecycle.ts:28-32) — direct consumers:
  - `src/rpc/methods.ts:114` — server-side `transition` RPC enforcer. `approved → planned` now permitted.
  - `src/cli/commands/transition.ts` — CLI enforcer. Same.
- `transitionPolicy` (lifecycle.ts:50-58) — falls back to `'manual'` for any key not in the schema's `transitions` object. Since `approved_to_planned` is not a defined schema key, the backward edge inherits manual policy (correct — user confirms via dialog).
- `board_dnd.ts` `confirmTransition` — unchanged in shape; only its caller pre-filters.
- `board.ts` `policyForExit` — unchanged in semantics; just sources `forwardMap` from the new shared module.
- **Phase 17 #41 (FUTURE)** — `keyboard-board-focus-and-move.md` design specifies importing the same three symbols (`FORWARD_MAP`, `nextColumn`, `isLegalTransition`). Phase 24's exports are the contract Phase 17 #41 will consume.

**Test coverage status**
- `tests/engine/lifecycle.test.ts` — 4 describe blocks; `canTransition` block already pins all 3 existing backward edges (lines 35-39). Extension needs `expect(canTransition('approved', 'planned')).toBe(true);` in that case.
- **Gap**: no existing `tests/ui/board_validate.test.ts` (file doesn't exist; it's part of the new module's surface). New file needed.
- **Gap**: no existing UI smoke test for the drag-drop alert path. `tests/integration/phase5-ui-end-to-end.test.ts` doesn't cover board_dnd directly. The pure-helper extraction (`isLegalTransition`) makes the validator unit-testable without a browser; the handler-level wiring is a 2-line check that's hard to test without jsdom — relying on the helper unit tests + a parity test against `canTransition` is acceptable coverage.

**Config interactions**
- `ProjectConfigSchema.autonomy.transitions` (`src/config/schema.ts:51-60`) defines only the 6 forward keys. Backward keys like `approved_to_planned` are not part of the schema's strict object — they're naturally absent. `transitionPolicy` falls back to `'manual'` for them, which is the right default (user-confirmed via dialog). No schema change required.

**Cross-item interactions**
- **#30 (sibling)** — direct lifecycle edit. Grouped run.
- **Relay Phase 17 #41 (`keyboard-board-focus-and-move`)** — STRONG dependency. Phase 24's `board_validate.ts` extract is the substrate this feature imports. Phase 17 #41's design is authoritative for the public API.
- **Relay Phase 16 #35 (`ui-transition-dialog-references-internal-phase-terminology`)** — MEDIUM coordination. #35 will rewrite the dialog text at `board_dnd.ts:77-78` ("Phase 5 surfaces..."). Phase 24's `board_dnd.ts` work must NOT touch those lines — leave the copy untouched so #35 can land independently.
- **Relay Phase 17 #42 (`keyboard-approval-dialog-bindings`)** — LOW coordination. #42 extracts the dialog into `src/ui/lib/dialog.ts`. If #42 lands AFTER Phase 24, the dialog flow Phase 24 preserves is still in place; if before, Phase 24 imports from the extracted helper. Either ordering works.

**Past work regression risk**
- **Low.** `lifecycle.ts` has zero archived items touching it; the BACKWARD extension is additive (loosens, doesn't tighten). The CLI `transition` command shipped in Phase 10 (`implemented/transition-command-adjacency-vs-spec-override-semantics.md`) reuses `canTransition` and will naturally accept the new edge — no special handling required. The Conductor loop in `src/conductor/loop.ts` advances cards forward only; backward edges don't affect loop semantics. Phase 12's `RunArtifactWriter` substrate doesn't interact with lifecycle transitions structurally.

### Related Work

*Search dimensions executed:* live codepath audit | backlog codepath | subsystem | archive | implementation | contract drift
*Tooling:* grep (Serena MCP not available in this environment)

#### Findings

- **Target:** `.relay/issues/ui-no-backward-path-from-approved-column.md` (#30)
  - **Kind:** existing item
  - **Evidence:** strong (shares `lifecycle.ts`; same Phase 14 cluster per `.relay/relay-ordering.md`; #30's spec explicitly cross-references this issue via `[[ui-board-dnd-invalid-transition-uses-server-error-alert]]`)
  - **Why related:** Both belong to Phase 14; both touch the transition layer (board_dnd.ts at the UI, lifecycle.ts at the engine). The shared `board_validate.ts` extract serves both fixes (it mirrors `canTransition`, which gains the new backward edge).
  - **Suggested handling:** group into current run.

- **Target:** `.relay/features/keyboard-board-focus-and-move.md` (Phase 17 #41, DESIGNED but not implemented)
  - **Kind:** existing item (designed feature)
  - **Evidence:** strong (explicit cross-phase dependency; the feature's design specifies the exact public API of `board_validate.ts` and names #29 in its "Closes" list)
  - **Why related:** Phase 17 #41's design at lines 22-23 specifies: *"`src/ui/views/board_validate.ts` — extracted forward-map validator. Exports `forwardMap`, `nextColumn(from)`, and `isLegalTransition(from, to)`. Both `board_dnd.ts` (refactored to import and refuse on illegal drop) and `board_keys.ts` consume it."* And at line 161: *"Closes: [[ui-board-dnd-invalid-transition-uses-server-error-alert]] (via shared `board_validate.ts` adoption in `board_dnd.ts`)."* Phase 24's substrate is the contract Phase 17 #41 will consume.
  - **Suggested handling:** keep narrow on Phase 24 (don't pull #41 into the grouped run — different phase, different scope). Just deliver the substrate exactly as #41 specifies.

- **Target:** `.relay/issues/ui-transition-dialog-references-internal-phase-terminology.md` (#35, Phase 16)
  - **Kind:** existing item
  - **Evidence:** medium (shares file `src/ui/views/board_dnd.ts`; orthogonal mechanism — copy edit, not validation flow)
  - **Why related:** #35 will rewrite the dialog text at `board_dnd.ts:77-78`. Phase 24 must NOT touch those lines so #35 can land independently. Coordination note only.
  - **Suggested handling:** keep narrow (don't group; coordinate by not touching the same lines). Document in this run's plan as a "do not edit" constraint.

- **Target:** `.relay/features/keyboard-approval-dialog-bindings.md` (Phase 17 #42, DESIGNED)
  - **Kind:** existing item (designed feature)
  - **Evidence:** weak (shares dialog surface in `board_dnd.ts`; orthogonal mechanism — keyboard bindings, not validation)
  - **Why related:** #42 extracts the dialog to `src/ui/lib/dialog.ts`. Either ordering works; Phase 24 doesn't need to coordinate beyond preserving the existing dialog flow.
  - **Suggested handling:** background context.

- **Target:** `unfiled: src/ui/views/board_dnd.ts:64 - post-rpc alert() fallback`
  - **Kind:** unfiled candidate (sub-element of #29 already)
  - **Evidence:** subsumed by #29's "replace alert" direction
  - **Why related:** The same `alert()` call. After client-side validation prevents the cause, the alert becomes dead code unless the validator and server disagree (race condition or schema drift). Recommendation: remove the alert, log to `console.warn` instead. No separate filing needed; the fix lands in the same patch.
  - **Suggested handling:** keep narrow (part of #29's fix).

- **Target:** `src/conductor/loop.ts` (autonomy loop)
  - **Kind:** subsystem-adjacent code
  - **Evidence:** weak (consumes `transitionPolicy` and `canTransition` indirectly via `transition` RPC)
  - **Why related:** Per `.relay/relay-config.md § Edge Cases`: "Plans that change loop behavior must exercise all three modes for each transition they touch." The autonomy loop advances cards FORWARD only; the new `approved → planned` backward edge doesn't enter the loop's path. Risk: none. Verify: loop redteam tests should pass unchanged.
  - **Suggested handling:** background context (no code change; document the no-impact-on-loop in the plan's Risks section).

#### Search Bounds

- Live codepath audit: complete (full `attachDragDrop` + `confirmTransition` in board_dnd.ts; full lifecycle.ts; full `policyForExit` + `renderBoard` in board.ts; full Phase 17 #41 feature spec)
- Backlog codepath: complete (`canTransition`/`BACKWARD`/`FORWARD` grep across `src/` returned 3 files, all read)
- Subsystem: complete (`src/ui/views/board*` + `src/engine/lifecycle.ts`)
- Archive: complete (zero archived items on board_dnd.ts or lifecycle.ts — no archive-density signal)
- Implementation: complete (Phase 10 CLI transition is the only impl doc touching `canTransition`; no behavior conflict)
- Contract drift: complete (no prose surfaces or external docs reference the transition table directly; the README/quickstart describes the lifecycle in narrative form but not via the FORWARD/BACKWARD constants)

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-16
*Rationale:* #30 shares the lifecycle.ts ↔ board_dnd.ts boundary with #29, and the Phase 14 ordering names them as a pair. Both deliverables converge on the `board_validate.ts` extract — #29's fix uses `isLegalTransition` to short-circuit invalid drops; #30's fix extends the BACKWARD set that `isLegalTransition` (via parity with `canTransition`) consults. Shipping them separately would either force two passes through `board_validate.ts` (extract for #29, extend for #30) or leave a window where the UI validator and the server disagree on `approved → planned`. The grouped run keeps the contract atomic. Phase 17 #41 is a hard downstream consumer but lives in a separate phase — it stays out of this run; Phase 24 just delivers its substrate. Phase 16 #35 is a coordination note (don't touch the same dialog lines), not a group member.

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | `ui-board-dnd-invalid-transition-uses-server-error-alert.md` (this) | run leader | n/a | full |
| 2 | `.relay/issues/ui-no-backward-path-from-approved-column.md` | existing item | strong | full |

#### Planner Contract

- `/relay-plan` or `/relay-superplan` must emit a `### Grouped Run Coverage` section.
- The coverage section must map every grouped entry to at least one concrete plan step.
- Entry #1 (this file): must include explicit coverage of (a) new module `src/ui/views/board_validate.ts` with the Phase 17 #41 public API (`FORWARD_MAP`, `nextColumn`, `isLegalTransition`); (b) `src/ui/views/board_dnd.ts` drop handler refactor — pre-validate via `isLegalTransition`, shake-on-reject, alert removal; (c) `src/ui/views/board.ts` `policyForExit` refactor to import shared FORWARD_MAP; (d) `src/ui/app.css` minimal `.shake` rule.
- Entry #2 (#30): must include explicit coverage of `src/engine/lifecycle.ts` BACKWARD set extension AND `tests/engine/lifecycle.test.ts` regression.
- Test coverage required: `tests/ui/board_validate.test.ts` (new — unit-tests + parity check against `canTransition`); `tests/engine/lifecycle.test.ts` (extend with new backward edge assertion).
- If either entry cannot be cleanly covered, stop and route back to scope reduction rather than continue.

#### Closure Contract

- `/relay-review` must verify each grouped entry's cited evidence is addressed in the plan at the obligation's granularity.
- `/relay-verify` must verify the diff touched the files or symbols promised by the plan's `Grouped Run Coverage` section:
  - For #1: `src/ui/views/board_validate.ts` exists and exports the three Phase 17 #41 symbols; `board_dnd.ts` calls `isLegalTransition` before `confirmTransition`; `alert()` removed; `.shake` CSS class present; regression tests pass.
  - For #2: `BACKWARD` set in `lifecycle.ts` contains `'approved->planned'`; `tests/engine/lifecycle.test.ts` asserts `canTransition('approved', 'planned') === true`.
  - Parity check: `tests/ui/board_validate.test.ts` asserts `isLegalTransition` agrees with `canTransition` on all column pairs.
- `/relay-resolve` must record per-entry closure status; partial or unclosed entries must be re-opened, superseded, or have a follow-up issue filed.

### Approach

**Recommended approach (grouped run, four coordinated changes):**

**#29 — Extract `board_validate.ts` and short-circuit illegal drops.** Create `src/ui/views/board_validate.ts` per the public API Phase 17 #41 already designed against, with one correction (see Open Question 1): `isLegalTransition` must check BOTH forward and backward edges, not just forward. In `board_dnd.ts`, import `isLegalTransition`; before `confirmTransition`, check legality; if false, apply `.shake` class to the source tile (auto-removed on `animationend`), no dialog, no server call. Drop the post-`rpc.call` `alert()` — the client-side validator should prevent it; if a server-side rejection still occurs (race condition or schema drift), `console.warn` is acceptable. Move the inline `forwardMap` const from `board.ts:36-39` into `board_validate.ts` so there's a single source of truth.

**#30 — Add the backward edge.** Add `'approved->planned'` to `BACKWARD` set in `lifecycle.ts:22-26`. Extend `tests/engine/lifecycle.test.ts`'s "permits known backward edges" case with the new assertion. The schema's `autonomy.transitions` block does NOT need extending — `transitionPolicy` falls back to `'manual'` for any key not in the schema, which is the correct default for a backward rollback (dialog asks for user confirmation).

**Pattern precedents advanced by this run:**
- Pure-helper extraction reaches **n=7** with `nextColumn` and `isLegalTransition` (or n=8 if counted as two). ADR threshold long fired; filing remains deferred per operator decision.
- **NEW pattern variant:** "shared validator module extracted for cross-feature consumption" — `board_validate.ts` is the first instance designed explicitly to serve a not-yet-built downstream feature (Phase 17 #41). Worth flagging as a distinct pattern (n=1 of this variant). If Phase 17 #41 lands as designed and a third site adopts the same pattern, this would warrant its own ADR.

**Alternatives considered:**
- **Inline fix without extraction**: implement `#29` as private logic inside `board_dnd.ts` without creating `board_validate.ts`. Faster, but Phase 17 #41 would then need to extract the same logic two weeks later — pure duplication. Rejected: Phase 24's done criteria explicitly require the extract as substrate for Phase 17 #41.
- **Extract to engine module** (`src/engine/board_validate.ts` or merge into `lifecycle.ts` exports): would unify client/server validators, but the UI bundle build (`scripts/build-ui.mjs` + `tsconfig.ui.json`) keeps `src/ui/` self-contained — engine imports cross the bundle boundary. Sticking with `src/ui/views/board_validate.ts` per Phase 17 #41's design and pinning equivalence via a parity test in `tests/ui/board_validate.test.ts`.
- **Forward-only `isLegalTransition`** (per Phase 17 #41's narrative reading): leaves `approved → planned` falsely rejected by the client validator after #30 lands. Rejected: bidirectional parity with `canTransition` is the correctness contract.

**Open questions / decisions:**

1. **`isLegalTransition` semantics — forward-only or forward+backward?** Phase 17 #41's design narrative says "forward map", but to keep parity with `canTransition` after #30's edge lands, the validator must accept BOTH directions. **Recommend forward+backward** (correctness wins over narrative consistency). Phase 17 #41 design narrative should be amended on this point during its own /relay-analyze pass; the public API symbol name `isLegalTransition` is already correct (it's "legal", not "forward").

2. **Remove `alert()` entirely or replace with status surface?** The issue text suggested "in-app toast / banner using existing status surfaces". `board_dnd.ts` has no per-card status surface today; the Routing view's `#err` block is page-scoped, not card-scoped. **Recommend: remove + `console.warn`.** The client-side validator should prevent the case; a styled banner is scope creep. Plan to revisit if a future dogfood surfaces server-rejection cases the client validator misses.

3. **CSS `.shake` placement — now or defer to Phase 17 #41?** Phase 17 #41's design adds the full set of move-mode CSS (shake + pulse + deny + dim). **Recommend: add minimal `.shake` rule now** as part of #29's fix. Without it, the rejected drop is silently dropped with zero visual feedback — worse than today's dialog+alert. Phase 17 #41 extends with the move-mode rules later.

4. **Phase 16 #35 coordination — pre-emptively annotate?** Phase 24 must not touch `board_dnd.ts:77-78` (the "Phase 5/6" dialog copy that #35 will rewrite). **Recommend: leave a brief implementation-deviation note in this analysis but do NOT modify #35's spec from within Phase 24.** The constraint is captured in the plan; #35's own /relay-plan pass will read this analysis as background context if it lands later.

---

## Implementation Plan

*Generated: 2026-05-16*

This plan covers the full grouped run (#29 leader + #30 sibling). The sibling at `.relay/issues/ui-no-backward-path-from-approved-column.md` carries the grouped-run pointer; the binding plan + coverage table live here.

The substrate this plan extracts (`src/ui/views/board_validate.ts`) is the hard dependency for Relay Phase 17 #41 (`keyboard-board-focus-and-move`). Its public API matches Phase 17 #41's design exactly (`FORWARD_MAP`, `nextColumn`, `isLegalTransition`), with the bidirectional `isLegalTransition` correction documented in Analysis Open Question 1.

### Step 1: Create `src/ui/views/board_validate.ts`

**File**: `src/ui/views/board_validate.ts` (NEW)

**Before** (file does not exist):
```ts
// (no file)
```

**After** (proposed — new module):

```ts
// src/ui/views/board_validate.ts
//
// Client-side transition validator. Mirrors the server's canTransition (in
// src/engine/lifecycle.ts) so the Board UI can short-circuit illegal drops
// before they hit the server. The engine module is the source of truth; this
// module duplicates the edge list because the UI bundle is sandboxed away
// from src/engine/. A parity test (tests/ui/board_validate.test.ts) pins
// equivalence so future edge additions to one module flag the other.
//
// Public API designed for two consumers:
//   - src/ui/views/board_dnd.ts (drag-drop drop handler) — Phase 24
//   - src/ui/views/board_keys.ts (keyboard layer) — Phase 17 #41 (future)
//
// isLegalTransition is bidirectional (checks both FORWARD_MAP and
// BACKWARD_EDGES) so it matches canTransition exactly. Phase 17 #41's
// design narrative said "forward map" but the right semantics is "any
// legal transition" — see Analysis Open Question 1.

export type Column =
  | 'discovered' | 'planned' | 'approved' | 'building'
  | 'verifying' | 'shipped' | 'archived';

/** Forward transitions, one per column. archived is terminal. */
export const FORWARD_MAP: Record<Column, Column | null> = {
  discovered: 'planned',
  planned: 'approved',
  approved: 'building',
  building: 'verifying',
  verifying: 'shipped',
  shipped: 'archived',
  archived: null,
};

/** Backward transitions — must stay in parity with src/engine/lifecycle.ts's
 *  BACKWARD set. Keyed as `${from}->${to}` to match the engine's encoding. */
const BACKWARD_EDGES: ReadonlySet<string> = new Set([
  'planned->discovered',
  'approved->planned',     // ← Phase 24 #30: new backward edge
  'building->approved',
  'verifying->building',
]);

/** Next forward column, or null if the column is terminal. */
export function nextColumn(from: Column): Column | null {
  return FORWARD_MAP[from];
}

/** True iff (from, to) is either a valid forward step OR a valid backward
 *  edge. Mirrors canTransition() in src/engine/lifecycle.ts. */
export function isLegalTransition(from: Column, to: Column): boolean {
  if (FORWARD_MAP[from] === to) return true;
  if (BACKWARD_EDGES.has(`${from}->${to}`)) return true;
  return false;
}
```

**Why**: provides the shared validator both #29 (drag-drop) and Phase 17 #41 (keyboard) consume. Pure helpers, no I/O, unit-testable. The bidirectional `isLegalTransition` keeps client and server in parity — after #30 adds `approved->planned` to the server's BACKWARD set, this module's `BACKWARD_EDGES` also gains the edge (in the same plan, atomically).

**Risk**:
1. **Duplication with lifecycle.ts**. If a future edge is added to one module and not the other, the client and server drift silently. Mitigation: Step 6's parity test asserts `isLegalTransition(from, to) === canTransition(from, to)` for all 7×7=49 column pairs. Any future edge addition that breaks parity will fail the test immediately.
2. **Phase 17 #41 design narrative said "forward map" for isLegalTransition.** The bidirectional behavior implemented here is the correctness contract, not the narrative reading. Phase 17 #41's /relay-analyze pass will update its narrative to match; the symbol name "isLegalTransition" is already consistent with bidirectional semantics.

**Verify**:
- `tests/ui/board_validate.test.ts` (Step 6) covers nextColumn, isLegalTransition, and parity-with-canTransition.
- Module imports cleanly under both `tsconfig.json` (engine) and `tsconfig.ui.json` (UI) — the file lives under `src/ui/` so the UI build picks it up; vitest tests import it via the relative path.

**Rollback**: delete the file. No callers yet (Steps 3 + 4 wire it).

---

### Step 2: Add `'approved->planned'` to BACKWARD in `lifecycle.ts`

**File**: `src/engine/lifecycle.ts` (lines 22-26)

**Before** (current code):

```ts
// src/engine/lifecycle.ts:22-26
const BACKWARD: ReadonlySet<string> = new Set([        // ← server-side allowed backward transitions
  'planned->discovered',                                // ← review rejection: planned card pushed back to discovered
  'building->approved',                                 // ← post-impl fix: building card needs more design
  'verifying->building',                                // ← test failure: verify rolls back to building
]);
```

**After** (proposed):

```ts
// src/engine/lifecycle.ts:22-27 (after edit)
const BACKWARD: ReadonlySet<string> = new Set([        // ← unchanged
  'planned->discovered',                                // ← unchanged: review rejection
  'approved->planned',                                  // ← NEW (Relay #30): undo accidental over-approval; no work performed at approved yet
  'building->approved',                                 // ← unchanged: post-impl fix
  'verifying->building',                                // ← unchanged: test failure rollback
]);
```

**Why**: closes Relay #30 at the engine boundary. Server-side `canTransition` now permits `approved → planned`; the RPC `transition` handler, the CLI `conductor transition` command, and the autonomy loop all consume `canTransition` directly, so the new edge is universally allowed without any other engine code change. The `BACKWARD_EDGES` set in `board_validate.ts` (Step 1) mirrors this addition — both lands in the same Phase 24 commit shape.

**Risk**:
1. **Autonomy loop accidentally rolls cards backward?** No: `src/conductor/loop.ts` advances cards FORWARD only via `transitionPolicy(config, from, to)` where `to = nextOperation`-style forward target. The loop never proposes a backward transition. `approved → planned` enters the system only via explicit user action (drag-drop or CLI). Safe.
2. **CLI command auto-accepting the new edge?** Yes — `conductor transition <id> planned` from an `approved` card will now succeed where it previously failed. This is the intended behavior of #30. No CLI test currently pins the negative case as "must fail" — verified via grep on `tests/cli/`. Test extension in Step 6 covers the positive case at the engine level.
3. **Schema does not define `approved_to_planned` autonomy policy.** Per `ProjectConfigSchema.autonomy.transitions` (`src/config/schema.ts:51-60`), only the 6 forward keys are defined. `transitionPolicy` falls back to `'manual'` for any undefined key, which is the correct default — backward rollbacks should always prompt the user. Safe; no schema change needed.

**Verify**: `tests/engine/lifecycle.test.ts` extension in Step 6.

**Rollback**: remove the new line.

---

### Step 3: Refactor `board_dnd.ts` drop handler — pre-validate + shake + drop alert

**File**: `src/ui/views/board_dnd.ts` (lines 49-67 drop handler + alert removal)

**Before** (current code):

```ts
// src/ui/views/board_dnd.ts:49-67 (current drop handler)
    col.addEventListener('drop', async (ev) => {                              // ← drop event on a column
      ev.preventDefault();                                                     // ← stop default browser handling
      col.classList.remove('drag-target');                                     // ← remove highlight class
      const id = ev.dataTransfer?.getData('text/plain');                       // ← card id from drag payload
      if (!id) return;                                                         // ← guard: no payload
      const to = col.getAttribute('data-column') as Column;                    // ← target column from column tile
      const fromCol = root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(id)}"]`)?.closest('.column');  // ← find source column DOM
      const from = fromCol?.getAttribute('data-column') as Column | undefined; // ← extract source column
      if (!from || !to || from === to) return;                                 // ← guard: missing or same-column no-op
      const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;  // ← look up autonomy policy (defaults manual)
      const proceed = await confirmTransition(id, from, to, policy);           // ← BUG: dialog shown unconditionally, even for invalid transitions
      if (!proceed) return;                                                    // ← user cancelled
      try {
        await rpc.call('transition', { id, to });                              // ← server-side enforcement
      } catch (err) {
        alert(`Transition failed: ${(err as Error).message}`);                 // ← BUG: blocking browser alert on server reject
      }
      await onDropped();                                                        // ← refresh board
    });
```

**After** (proposed — pre-validate, shake on illegal drop, drop alert):

```ts
// src/ui/views/board_dnd.ts:49-67 (after refactor)
    col.addEventListener('drop', async (ev) => {                              // ← unchanged event binding
      ev.preventDefault();                                                     // ← unchanged
      col.classList.remove('drag-target');                                     // ← unchanged
      const id = ev.dataTransfer?.getData('text/plain');                       // ← unchanged
      if (!id) return;                                                         // ← unchanged
      const to = col.getAttribute('data-column') as Column;                    // ← unchanged
      const sourceTile = root.querySelector<HTMLElement>(`.card-tile[data-id="${cssEscape(id)}"]`);  // ← capture tile for shake target
      const fromCol = sourceTile?.closest('.column');                          // ← traverse to column from tile
      const from = fromCol?.getAttribute('data-column') as Column | undefined; // ← unchanged extraction
      if (!from || !to || from === to) return;                                 // ← unchanged guards
      // Closes Relay #29: client-side pre-validation against the lifecycle.
      // If the drop is illegal, briefly shake the source tile and abort
      // (no dialog, no server call, no alert). Mirrors the server's
      // canTransition via the shared board_validate module.
      if (!isLegalTransition(from, to)) {                                      // ← NEW: shared validator check (Step 1's helper)
        if (sourceTile) shakeTile(sourceTile);                                  // ← NEW: visual rejection feedback
        return;                                                                 // ← NEW: short-circuit; never reach dialog or RPC
      }
      const policy = (config.autonomy.transitions[`${from}_to_${to}`] ?? 'manual') as Policy;  // ← unchanged policy lookup
      const proceed = await confirmTransition(id, from, to, policy);           // ← unchanged dialog (only reached for legal drops)
      if (!proceed) return;                                                    // ← unchanged cancel path
      try {
        await rpc.call('transition', { id, to });                              // ← unchanged server call
      } catch (err) {
        // Defense in depth: client validator should prevent server-side
        // rejections, but log if one slips through (race condition with
        // a config change, or schema drift). Closes Relay #29's alert path.
        console.warn('[board_dnd] transition rejected by server:', (err as Error).message);  // ← REPLACES alert()
      }
      await onDropped();                                                        // ← unchanged refresh
    });
```

Add the import + shake helper (top of file + after the existing `escape` helper):

```ts
// src/ui/views/board_dnd.ts (imports — add to the existing import block)
import { isLegalTransition } from './board_validate.js';                       // ← NEW: shared validator (Step 1)

// src/ui/views/board_dnd.ts (helper — add at bottom alongside `escape`/`cssEscape`)
/** Brief shake animation on a tile to indicate a rejected drop. CSS rule
 *  in src/ui/app.css; class is auto-removed on animation end so repeated
 *  shakes re-trigger cleanly. */
function shakeTile(tile: HTMLElement): void {
  tile.classList.add('shake');                                                  // ← apply animation class (CSS defines @keyframes)
  tile.addEventListener('animationend', () => tile.classList.remove('shake'), { once: true });  // ← self-cleanup
}
```

**Why**: closes Relay #29 in two layers — (1) pre-validation prevents the dialog+alert flow for invalid drops; (2) replacing `alert()` with `console.warn` removes the blocking-modal failure mode entirely. The dialog text and policy lookup are preserved unchanged so Phase 16 #35 (dialog copy cleanup) and Phase 17 #42 (dialog keyboard bindings) can land independently without coordination.

**Risk**:
1. **`isLegalTransition` returns false for a legitimate move.** Would require a drift between this module and `lifecycle.ts`'s BACKWARD/FORWARD. Step 6's parity test prevents drift at CI time.
2. **`shakeTile` fires while user is mid-drag of another card.** The animation class lives 220ms then self-removes; if a new shake fires during, the `animationend` handler dedupes via the `{ once: true }` option. No leak.
3. **Server-side rejection still occurs (race with config change).** Now logged to console rather than alerted. Acceptable for the rare race case; the validator covers the common case.
4. **`sourceTile` is null when the tile DOM has been removed** (e.g., SSE re-render between dragstart and drop). The `if (sourceTile) shakeTile(...)` guard handles this; the early-return on illegal drop still fires.

**Verify**:
- Helper-level: Step 6's `board_validate.test.ts` pins `isLegalTransition` behavior. Handler-level integration is a 4-line wiring change (call validator, branch, shake-or-continue) — hard to test without jsdom; covered indirectly via the helper unit tests and manual smoke. Phase 17 #41's eventual /relay-verify will exercise the keyboard path through the same validator.
- Manual smoke: drag `building` card to `discovered` → tile shakes, no dialog, no alert. Drag same card to `approved` → dialog appears (legal backward edge per existing BACKWARD set).

**Rollback**: revert the hunk; restore the unconditional `confirmTransition` call and `alert()`.

---

### Step 4: Refactor `board.ts` `policyForExit` to import shared FORWARD_MAP

**File**: `src/ui/views/board.ts` (lines 34-43 + import additions)

**Before** (current code):

```ts
// src/ui/views/board.ts:34-43
function policyForExit(config: ProjectConfigShape, from: Column): 'manual' | 'assist' | 'auto' | null {  // ← per-column exit policy badge resolver
  // Show the badge for the forward-exit transition only (the most common move).
  const forwardMap: Partial<Record<Column, Column>> = {                       // ← BUG: duplicated map; should source from shared module
    discovered: 'planned', planned: 'approved', approved: 'building',
    building: 'verifying', verifying: 'shipped', shipped: 'archived',
  };
  const next = forwardMap[from];                                              // ← inline forward lookup
  if (!next) return null;                                                      // ← terminal columns have no forward exit
  return config.autonomy.transitions[`${from}_to_${next}`] ?? 'manual';        // ← resolve policy or fall back
}
```

**After** (proposed — import from shared module):

```ts
// src/ui/views/board.ts:34-43 (after refactor)
function policyForExit(config: ProjectConfigShape, from: Column): 'manual' | 'assist' | 'auto' | null {  // ← unchanged signature
  // Show the badge for the forward-exit transition only (the most common move).
  // Forward map lives in the shared board_validate module (single source of
  // truth for both drag-drop validation and Phase 17 keyboard validation).
  const next = nextColumn(from);                                              // ← USE shared helper from board_validate (Step 1)
  if (!next) return null;                                                      // ← unchanged terminal-column branch
  return config.autonomy.transitions[`${from}_to_${next}`] ?? 'manual';        // ← unchanged policy lookup
}
```

Add the import:

```ts
// src/ui/views/board.ts (imports — add to existing import block)
import { nextColumn } from './board_validate.js';                              // ← NEW: shared forward-map accessor
```

**Why**: collapses the duplicated `forwardMap` inline const into the shared `board_validate.ts` module. Single source of truth — if Phase 17 #41 (or any future feature) extends the forward map, every consumer including the policy badge picks up the change automatically.

**Risk**: very low. `nextColumn(from)` returns `Column | null` matching the previous shape (the `Partial<Record<Column, Column>>` returned `undefined` for terminal columns, which was treated as falsy by `if (!next)`; the new `null` return is also falsy). Behavior identical.

**Verify**: `npm test` full suite — existing board tests should pass unchanged (if any). Manual smoke: board renders with policy badges for forward exits (unchanged from current).

**Rollback**: revert the two changes (import + body); restore the inline `forwardMap` const.

---

### Step 5: Add `.shake` CSS rule to `src/ui/app.css`

**File**: `src/ui/app.css` (insert after the existing `column.drag-blocked` rule at line ~479)

**Before** (current code — context):

```css
/* src/ui/app.css:476-479 (existing) */
.column.drag-blocked {                                                         /* ← invalid drop target highlight on the column */
  border-color: var(--halt);                                                   /* ← red border via design token */
  cursor: not-allowed;                                                          /* ← cursor hint */
}
```

**After** (proposed — add `.shake` keyframes + class):

```css
/* src/ui/app.css:476-499 (after insertion) */
.column.drag-blocked {                                                         /* ← unchanged */
  border-color: var(--halt);
  cursor: not-allowed;
}

/* Phase 24: brief shake on a card tile to indicate a rejected drop.
 * Triggered by board_dnd.ts:shakeTile when isLegalTransition(from, to)
 * returns false. Self-clears via animationend listener so repeated
 * shakes re-trigger cleanly. Phase 17 #41 will extend with move-mode
 * pulse / deny / dim rules using the same animation idiom. */
.card-tile.shake {                                                              /* ← applied transiently by JS */
  animation: shake 220ms ease-in-out;                                           /* ← short, perceptible, non-distracting */
}
@keyframes shake {                                                              /* ← horizontal jitter for "no" feedback */
  0%, 100% { transform: translateX(0); }                                        /* ← rest position at start + end */
  20%, 60% { transform: translateX(-3px); }                                     /* ← left jitter */
  40%, 80% { transform: translateX(3px); }                                      /* ← right jitter */
}
```

**Why**: provides visual feedback for the rejected-drop path. Without this, the user's drop is silently dropped — worse UX than the current dialog+alert because there's zero indication of failure. Minimal scope: just the `.shake` class + keyframes. Phase 17 #41 extends with the move-mode CSS (pulse/deny/dim) later.

**Risk**:
1. **CSS animation respects `prefers-reduced-motion`?** Not in this minimal rule. Could add a `@media (prefers-reduced-motion: reduce)` override that uses opacity/color instead of transform. Defer to Phase 17 #41's broader CSS pass; the 220ms shake is brief enough to be acceptable as-is.
2. **`transform: translateX` on a `<a>` element with inline-block-ish layout?** `.card-tile` is an `<a class="card-tile">` (see board.ts:51). Transform applies to all positioned and non-inline elements; the existing layout supports it (verified by other transform-using rules in app.css around line 469).

**Verify**: manual smoke — drop a card to an invalid column; tile briefly shakes (~220ms); shake completes and tile returns to rest position. Repeated drops re-trigger cleanly.

**Rollback**: remove the inserted block.

---

### Step 6: Tests

**File**: `tests/ui/board_validate.test.ts` (NEW)

```ts
// tests/ui/board_validate.test.ts
import { describe, it, expect } from 'vitest';
import {
  FORWARD_MAP,
  nextColumn,
  isLegalTransition,
  type Column,
} from '../../src/ui/views/board_validate.js';
import { canTransition } from '../../src/engine/lifecycle.js';

const COLUMNS: Column[] = [
  'discovered', 'planned', 'approved', 'building',
  'verifying', 'shipped', 'archived',
];

describe('board_validate (Relay #29 substrate; Phase 17 #41 dependency)', () => {
  describe('nextColumn', () => {
    it('returns the forward neighbour for each non-terminal column', () => {
      expect(nextColumn('discovered')).toBe('planned');
      expect(nextColumn('planned')).toBe('approved');
      expect(nextColumn('approved')).toBe('building');
      expect(nextColumn('building')).toBe('verifying');
      expect(nextColumn('verifying')).toBe('shipped');
      expect(nextColumn('shipped')).toBe('archived');
    });

    it('returns null for archived (terminal column)', () => {
      expect(nextColumn('archived')).toBeNull();
    });
  });

  describe('isLegalTransition', () => {
    it('accepts all forward edges', () => {
      for (const from of COLUMNS) {
        const next = FORWARD_MAP[from];
        if (next !== null) expect(isLegalTransition(from, next)).toBe(true);
      }
    });

    it('accepts the four backward edges (including Relay #30 approved→planned)', () => {
      expect(isLegalTransition('planned', 'discovered')).toBe(true);
      expect(isLegalTransition('approved', 'planned')).toBe(true);    // Relay #30
      expect(isLegalTransition('building', 'approved')).toBe(true);
      expect(isLegalTransition('verifying', 'building')).toBe(true);
    });

    it('rejects illegal transitions', () => {
      expect(isLegalTransition('discovered', 'shipped')).toBe(false);
      expect(isLegalTransition('archived', 'discovered')).toBe(false);
      expect(isLegalTransition('shipped', 'building')).toBe(false);
      expect(isLegalTransition('discovered', 'discovered')).toBe(false);  // same column not legal
    });
  });

  describe('parity with engine canTransition', () => {
    // Pin equivalence — the UI validator and engine validator MUST agree on
    // every column pair. Any future edge addition to one module without the
    // other will fail this test before review.
    it.each(COLUMNS.flatMap((from) => COLUMNS.map((to) => [from, to] as const)))(
      '%s → %s: isLegalTransition matches canTransition',
      (from, to) => {
        expect(isLegalTransition(from, to)).toBe(canTransition(from, to));
      },
    );
  });
});
```

**File**: `tests/engine/lifecycle.test.ts` (EXTEND lines 35-39)

```ts
// tests/engine/lifecycle.test.ts:35-39 (extend the existing block)
  it('permits known backward edges (review rejection, post-impl fix)', () => {
    expect(canTransition('planned', 'discovered')).toBe(true);
    expect(canTransition('approved', 'planned')).toBe(true);     // Relay #30: undo accidental over-approval
    expect(canTransition('building', 'approved')).toBe(true);
    expect(canTransition('verifying', 'building')).toBe(true);
  });
```

**Why**: four sets of guarantees pinned by tests — (1) `nextColumn` returns the right neighbour for each column; (2) `isLegalTransition` accepts both forward and backward edges (including #30's new one); (3) `isLegalTransition` rejects illegal moves; (4) parity check: the UI validator agrees with `canTransition` on every column pair. The parity test (`it.each` over 49 pairs) is the critical anti-drift guard.

**Risk**: very low. The parity test imports both modules into Node-based vitest; both module paths are stable (engine + UI both produce `.js` outputs reachable via the test's relative imports).

**Verify**: `npx vitest run tests/ui/board_validate.test.ts tests/engine/lifecycle.test.ts` — expect green; then `npm test` full suite.

**Rollback**: delete the new file / revert the lifecycle.test.ts extension. No production code dependency.

---

### Grouped Run Coverage

| # | Target | Kind | Obligation | Plan Step(s) | Files / Symbols | Notes |
|---|--------|------|------------|--------------|-----------------|-------|
| 1 | `ui-board-dnd-invalid-transition-uses-server-error-alert.md` | run leader | full | 1, 3, 4, 5, 6 | `src/ui/views/board_validate.ts` (new) with `FORWARD_MAP` / `nextColumn` / `isLegalTransition`; `src/ui/views/board_dnd.ts:49-67` (pre-validate + `shakeTile` + drop alert); `src/ui/views/board.ts:34-43` (`policyForExit` imports `nextColumn`); `src/ui/app.css` (`.shake` keyframes); `tests/ui/board_validate.test.ts` (new — 4 describes, ~12 cases) | Substrate matches Phase 17 #41's public-API contract exactly (with the bidirectional correction documented in Analysis Open Question 1). |
| 2 | `.relay/issues/ui-no-backward-path-from-approved-column.md` | existing item | full | 2, 6 | `src/engine/lifecycle.ts:22-27` (`BACKWARD` adds `'approved->planned'`); `tests/engine/lifecycle.test.ts:35-39` (extend backward-edges assertion); `src/ui/views/board_validate.ts` `BACKWARD_EDGES` (mirrors engine — same plan, same commit shape) | New backward edge propagates to all `canTransition` consumers (RPC, CLI, autonomy loop forward-only path unaffected). |

## Test Changes

- **NEW**: `tests/ui/board_validate.test.ts` — 4 describe blocks: `nextColumn` (2 cases), `isLegalTransition` (3 cases), parity-with-canTransition (1 `it.each` over 49 column pairs = 49 sub-assertions). Counted as ~6 named tests.
- **EXTEND**: `tests/engine/lifecycle.test.ts:35-39` — add `expect(canTransition('approved', 'planned')).toBe(true);` inside the existing "permits known backward edges" case. Counted as +0 named tests (modifies an existing case; doesn't add a new one).

Expected suite delta: 612 → 618 (+6 named tests). Phase 23 baseline 612 holds for all existing assertions.

## Post-Implementation Checks

1. `npm run typecheck` (engine + UI tsconfigs) — clean.
2. `npx vitest run tests/ui/board_validate.test.ts tests/engine/lifecycle.test.ts` — new + extended tests pass in isolation.
3. `npm test` — full suite green, ≥ 618/618.
4. Manual smoke (matches both issues' Reproduction):
   - **#29**: open Board; drag a `building` card to `discovered` → tile briefly shakes (~220ms); no dialog appears; no alert. Drag same card to `approved` → dialog appears (legal backward edge).
   - **#30**: drag a `planned` card to `approved`; approve via dialog. Drag the now-`approved` card back to `planned` → dialog appears ("Move ... / approved → planned / Autonomy policy: manual"); approve. Card returns to `planned`. `git diff .conductor/cards/<id>.md` shows only `column` field changed.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `board_validate.ts` drifts from `lifecycle.ts` BACKWARD/FORWARD over time | Medium | Medium — client and server disagree on validity | Step 6's parity test (`it.each` over 49 column pairs) fails CI immediately on any drift |
| `isLegalTransition` bidirectional semantics differ from Phase 17 #41's narrative | Low | Low — Phase 17 #41 narrative is wrong; symbol name is correct | Documented in Analysis Open Question 1; Phase 17 #41's /relay-analyze pass updates the narrative |
| Removing `alert()` hides server-side rejections from users | Low | Low — validator should prevent the case; `console.warn` covers the rare race | Future dogfood can re-surface a styled banner if needed |
| `.shake` CSS animation distracts users with motion sensitivity | Low | Low — 220ms is brief; below typical irritation threshold | Future polish (Phase 17 #41's CSS pass) can add `prefers-reduced-motion` override |
| Phase 16 #35 collision (dialog copy edit) | Low | Low — Step 3 explicitly does not touch lines 77-78 | Plan's Step 3 Before/After shows the dialog HTML untouched; reviewer can verify |

## Rollback Plan

`git revert <commit-hash>` per step. Since the work spans 4 expected commits (Step 1 helper; Step 2 lifecycle edge; Steps 3+4+5 wiring; Step 6 tests), partial revert is straightforward — revert most recent backward until the unwanted step is gone. No DB migrations, no config schema changes, no stored data format changes.

This plan also lives in tracking form in [`ui-no-backward-path-from-approved-column.md`](ui-no-backward-path-from-approved-column.md) via the grouped-run pointer at the top of that file; the binding plan resides here in the leader.

---

## Adversarial Review

*Reviewed: 2026-05-16*

### Source verification

Re-read each target file NOW and compared against the plan's BEFORE blocks. **No drift** — every BEFORE block matches the current source verbatim:

- `src/ui/views/board_dnd.ts:49-67` (drop handler) — confirmed; `policy` lookup, `confirmTransition`, RPC call, `alert()` on catch all present at the cited lines.
- `src/engine/lifecycle.ts:22-26` (`BACKWARD` set) — confirmed; 3 backward edges; `'approved->planned'` absent.
- `src/ui/views/board.ts:34-43` (`policyForExit`) — confirmed; `forwardMap` inline const at lines 36-39.
- `src/ui/app.css:476-479` (`.column.drag-blocked` rule) — confirmed; the planned insertion site is directly below it.
- `tests/engine/lifecycle.test.ts:35-39` (backward-edges case) — confirmed; pinned all 3 existing backward edges; extension point is exactly the cited line range.

Sanity checks performed:
- `src/rpc/methods.ts:115` consumes `canTransition` and throws `Invalid transition: ${from} → ${p.to}` — the `approved → planned` case will now succeed (currently throws). No other change required at the RPC layer.
- `tests/cli/` does NOT contain a `transition.test.ts` file — no CLI test pins the previously-rejected `approved → planned` case as "must fail". The BACKWARD extension is genuinely additive at the test surface.
- Grep across `tests/` for `approved.*planned`, `approved → planned`, `Illegal transition` returned **zero matches**. No test currently asserts the negative behavior that #30's fix flips.

### Edge cases tested

Applied `.relay/relay-config.md § Edge Cases` scenarios plus helper-specific edge cases:

| Edge case | Plan's behavior | OK? |
|-----------|-----------------|-----|
| Conductor autonomy loop runs at most one card at a time; backward edges shouldn't enter the loop | Loop advances cards FORWARD via `transitionPolicy(from, nextOp-target)`; never proposes a backward transition. The new `approved → planned` edge is unreachable from the loop. | ✓ |
| `autonomy.transitions.*` must exercise all three modes — does the new backward edge inherit a policy? | `ProjectConfigSchema.autonomy.transitions` is a strict object containing only the 6 forward keys; `approved_to_planned` is absent. `transitionPolicy` falls back to `'manual'` for any undefined key — the correct default for a backward rollback. No schema change, no per-mode loop test needed (loop doesn't enter this path). | ✓ |
| `tracker.kind: 'none'` discriminatedUnion | Plan touches no tracker code. | ✓ |
| `ProjectConfigSchema` is `.strict()` | Plan introduces no new top-level config keys. | ✓ |
| `from === to` (same-column drop) | Drop handler short-circuits at line 57's existing `if (!from || !to || from === to) return;` BEFORE the validator check. Also, the helper test explicitly asserts `isLegalTransition('discovered', 'discovered') === false`. | ✓ |
| `isLegalTransition` for terminal column (`archived → anything`) | `FORWARD_MAP['archived'] === null`, so forward check fails for any `to`. No backward edge from archived. Returns false. Helper test asserts `isLegalTransition('archived', 'discovered') === false`. | ✓ |
| Drag during SSE re-render race (tile DOM removed mid-drag) | `sourceTile` is captured via `querySelector` at drop time; if the tile is gone, `sourceTile` is null and the guard `if (sourceTile) shakeTile(...)` prevents a null-deref. Pre-existing race window; plan does not change it. | ✓ |
| `console.warn` instead of `alert()` — user invisibility on server-side rejection | The client validator should prevent the case; a server rejection now indicates a race (e.g., config change between drop and RPC) or schema drift. `console.warn` is acceptable for the rare path. Future dogfood can re-surface a styled banner if needed. Documented in Plan's Risks. | ✓ (acknowledged) |
| `.card-tile.shake` CSS animation vs `.card-tile:hover` transform conflict | `.card-tile:hover` at app.css:420 applies `transform: translateX(2px)` with a 180ms transition. During a shake (220ms), the animation keyframes (`translateX(-3px)` ↔ `translateX(3px)`) take precedence. After animation completes, the hover transform reapplies. Visually: animation plays clean; hover state restores on completion. No functional bug; minor cosmetic edge case. | ✓ (acknowledged) |

### Regression check

Read tests for affected modules:

- **`tests/engine/lifecycle.test.ts`** — 4 describe blocks; the "permits known backward edges" case is the planned extension point (one additional `expect`). `canTransition` returns boolean; adding an edge doesn't change the signature or return type. `transitionPolicy` block (lines 62-71) tests forward-edge policies and the "unrecognized → manual" fallback — `approved_to_planned` falls into the latter branch unchanged.
- **`tests/rpc/methods.test.ts`** — the `transition` RPC handler tests (not directly inspected this pass, but the handler at `src/rpc/methods.ts:110-120` consumes `canTransition` via a single boolean check). No test asserts the `approved → planned` rejection. Additive change.
- **`tests/cli/`** — no `transition.test.ts` file. No CLI regression surface.
- **`tests/integration/phase5-ui-end-to-end.test.ts`** — does not pin drag-drop alert behavior (grep negative). Plan's removal of `alert()` invisible to existing integration tests.
- **Archived items on `lifecycle.ts` / `board_dnd.ts`**: zero. No regression surface from past work.

Cross-checked the four `canTransition` call sites for impact of the new backward edge:
1. `src/rpc/methods.ts:115` (server `transition` RPC enforcer) — now permits the new edge. Intended.
2. `src/cli/commands/transition.ts` (CLI) — same. Intended.
3. `src/engine/lifecycle.ts` (definition) — owns the change.
4. `src/conductor/loop.ts` — calls `transition` RPC indirectly via the agent loop; loop advances forward-only, so the new backward edge is unreachable from autonomy execution. Unaffected.

### Sibling-survival check

Walked the Scope Decision's `#### Grouped Entries` against the plan's `### Grouped Run Coverage`:

| Entry | Obligation | Plan coverage | Files / symbols claimed | Sibling-survival? |
|-------|-----------|---------------|------------------------|-------------------|
| 1 — `ui-board-dnd-invalid-transition-uses-server-error-alert` (leader) | full | Steps 1, 3, 4, 5, 6 | new `board_validate.ts`, `board_dnd.ts:49-67` (handler) + shakeTile helper, `board.ts:34-43` (`policyForExit`), `.shake` CSS, `tests/ui/board_validate.test.ts` | ✓ |
| 2 — `ui-no-backward-path-from-approved-column` | full | Steps 2, 6 | `lifecycle.ts:22-27` (`BACKWARD` extension), `board_validate.ts:BACKWARD_EDGES` (mirrors engine), `tests/engine/lifecycle.test.ts:35-39` (test extension) | ✓ |

Both entries have explicit plan steps at full obligation. **No sibling-survival objections.**

### Issues Found

None at CRITICAL/HIGH/MEDIUM severity.

One LOW-severity item documented for awareness (no plan change needed):

#### LOW — `.card-tile.shake` keyframes vs `:hover` transform are coupled by CSS precedence

The existing `.card-tile:hover` rule at `app.css:420` applies `transform: translateX(2px)`. During the 220ms shake animation, the keyframes (`translateX(±3px)`) override the hover transform. On animation completion, the hover transform (if still applicable) re-takes effect via the 180ms transition declared at `app.css:393`. Net visual: animation plays clean; hover state restores smoothly. No bug; documented as plan Risk #4 and acknowledged in Edge Cases above.

**No code change recommended.** If a future dogfood surfaces a jarring "shake-then-pop-to-hover" visual, Phase 17 #41's broader CSS pass (which adds move-mode pulse/deny/dim rules) is the natural place to add a `prefers-reduced-motion` override and / or fold the shake into a more comprehensive feedback system.

### Regression Risk

| Risk | Mitigation |
|---|---|
| `board_validate.ts` drifts from `lifecycle.ts` over time | Step 6's parity test (`it.each` over 49 column pairs) fails CI on drift |
| `console.warn` replaces `alert()` — silent server-side rejection | Validator should prevent; race/drift is rare; styled banner is future polish |
| Phase 16 #35 dialog copy edit | Step 3 explicitly preserves `board_dnd.ts:77-78` (the dialog HTML); reviewer can verify in Before/After blocks |
| Phase 17 #41 design narrative says forward-only `isLegalTransition` | Plan's bidirectional implementation is the correctness contract; symbol name already matches; Phase 17 #41's /relay-analyze will reconcile its narrative |
| `.card-tile.shake` motion sensitivity | 220ms; Phase 17 #41 CSS pass can add `prefers-reduced-motion` |

### Verdict

**APPROVED**

Plan is faithful to the source, the substrate matches Phase 17 #41's design contract, the bidirectional `isLegalTransition` correction is well-justified (symbol name is bidirectional-friendly even though Phase 17 #41's narrative wasn't), and the parity test prevents future drift between client and server validators. No CRITICAL/HIGH/MEDIUM findings; one LOW cosmetic edge case acknowledged with no plan change required.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order.
- After each step, run its VERIFY command before moving to the next.
- Commit shape (Control phase 24.1):
  - Commit 1: Step 1 (`src/ui/views/board_validate.ts` + `tests/ui/board_validate.test.ts`).
  - Commit 2: Step 2 (`lifecycle.ts` BACKWARD edit + `tests/engine/lifecycle.test.ts` extension).
  - Commit 3: Steps 3 + 4 + 5 (`board_dnd.ts` handler + shakeTile; `board.ts` `policyForExit` refactor; `app.css` `.shake` rule).
  - Step-close commit: `docs(24.1): flip steps.md checkbox for step 24.1`.
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies. Particularly: do NOT edit `board_dnd.ts:77-78` (the "Phase 5/6" dialog copy that Phase 16 #35 owns).

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 — `src/ui/views/board_validate.ts` new module | `FORWARD_MAP`, `nextColumn`, `isLegalTransition` (bidirectional); `BACKWARD_EDGES` includes `'approved->planned'` | YES (new file, 56 lines) | YES |
| 2 — `lifecycle.ts:22-27` BACKWARD extension | Add `'approved->planned'` between `planned->discovered` and `building->approved` | YES (`lifecycle.ts:22-27`) | YES |
| 3 — `board_dnd.ts:49-67` drop handler refactor | Import helper; capture `sourceTile`; pre-validate via `isLegalTransition`; shake on illegal; replace `alert()` with `console.warn`; add `shakeTile` helper | YES (`board_dnd.ts:50-77` + `shakeTile` at 105-108) | YES |
| 4 — `board.ts:34-43` `policyForExit` refactor | Import `nextColumn`; replace inline `forwardMap` const | YES (`board.ts:35-43`) | YES |
| 5 — `app.css` `.shake` rule | Insert `.card-tile.shake` + `@keyframes shake` after `.column.drag-blocked` | YES (~12 lines added at 480-492) | YES |
| 6 — Tests | `tests/ui/board_validate.test.ts` (new); `tests/engine/lifecycle.test.ts` extension | YES (54 vitest entries + 1 line extension) | YES |

### Grouped Run Coverage

| Entry | Obligation | Plan promised | Diff evidence | Closed? |
|-------|------------|---------------|---------------|---------|
| 1 — `ui-board-dnd-invalid-transition-uses-server-error-alert` (leader) | full | new `board_validate.ts`, `board_dnd.ts` drop handler + `shakeTile`, `board.ts` `policyForExit`, `.shake` CSS, `tests/ui/board_validate.test.ts` | All landed; 54/54 tests pass | ✓ closed |
| 2 — `ui-no-backward-path-from-approved-column` | full | `lifecycle.ts` BACKWARD extension, `board_validate.ts:BACKWARD_EDGES` mirror, `tests/engine/lifecycle.test.ts` regression | All landed; 9/9 lifecycle tests pass (extended case includes new edge) | ✓ closed |

No verification objections. Both entries closed at full obligation.

### Test Results

- `npm run typecheck` → clean (engine + UI tsconfigs).
- `npx vitest run tests/ui/board_validate.test.ts tests/engine/lifecycle.test.ts` → **63/63 pass** in ~1.3s (54 in board_validate + 9 in lifecycle).
- `npm test` (full suite) → **665/666 pass**; 1 flake. See Issues Found below.

### Issues Found

**Pre-existing flake** (NOT caused by this plan): `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain > startDaemon + conductor_status returns running=false; shutdown is clean` timed out at 5000ms during the full-suite run. Targeted re-run in isolation passed cleanly at **810ms** — well under the timeout — confirming the failure is a parallel-runner flake, not a regression.

The test exercises daemon startup + brain conductor shutdown sequencing; it touches none of the surfaces this plan modifies (`board_validate.ts`, `lifecycle.ts` BACKWARD extension, `board_dnd.ts` drop handler, `board.ts` policyForExit, `app.css`, lifecycle test extension). No code path is shared with Phase 24 changes.

The same test was passing under Phase 23's 612/612 baseline; the flakiness manifests under load when the full suite runs in parallel. Not a Phase 24 introduction.

### Verification Fixes

None. The flake is pre-existing and not caused by this plan; isolation re-run is sufficient evidence of correctness.

### Test count

Plan predicted +6 named cases (suite 612 → 618). Actual delta: **+54 vitest test entries** because the parity `it.each` over 49 column pairs is reported as 49 individual sub-tests rather than one named case. Logically equivalent to the plan's prediction; just a different counting convention. Suite 612 → 666.

### Verdict

**COMPLETE** — all 6 plan steps implemented at full obligation; both grouped entries closed; typecheck clean; targeted tests 63/63; full suite 665/666 with the lone failure confirmed as a pre-existing parallel-runner flake unrelated to this plan. The autonomy dropdown's drop path now pre-validates client-side, illegal drops shake the source tile silently, and `approved → planned` is a valid backward edge across server (RPC + CLI) and client (drag-drop validator).

Phase 14's `board_validate.ts` extract delivers the substrate Phase 17 #41 (`keyboard-board-focus-and-move`) imports as designed; the keyboard layer is now mechanically unblocked.

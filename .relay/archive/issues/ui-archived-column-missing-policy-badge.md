# Board "archived" column missing policy badge (visual inconsistency)

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-archived-column-missing-policy-badge.md)

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — visual inconsistency; cosmetic.*

## Problem statement

Every column on the Board renders a `manual` / `assist` / `auto` policy badge next to its header — except `archived`, which has no badge. The `archived` column heading is visually narrower / asymmetric vs. the other six.

## Current state

- `src/ui/views/board.ts:34-43` — `policyForExit()` returns the policy for the **forward** transition out of each column. The `forwardMap` ends at `shipped: 'archived'`. For `archived` there is no `forwardMap[archived]`, so `policyForExit` returns `null` and the badge is omitted.
- This is technically correct — there is no transition out of archived — but the visual asymmetry reads as a missing element.

## Reproduction

Open `#/board`. Compare column 06 (`shipped` — has `manual` badge) with column 07 (`archived` — no badge).

## Impact

Cosmetic only — but the Control Room masthead and column structure are otherwise very deliberate. The empty slot reads as scaffolding rather than intentional.

## Proposed direction

Three options:

- **A:** render a neutral placeholder badge — `terminal`, `final`, or `—` — same dimensions as the others, dimmer style. Preserves the grid rhythm.
- **B:** render an explicit "no exit" badge using the same `manual / assist / auto` slot styling but with a dedicated class (e.g., `terminal`). CSS gets one new variant.
- **C:** explicitly hide the badge slot for `archived` via CSS (`.column[data-column="archived"] .column-head { ... }`) so it visually centers instead of leaving an empty right-justified region.

Option A or B is preferred — the column is a real terminal state worth labeling.

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - Line numbers shifted from the issue's claim (34-43) to **42-49** in current source due to Phase 25.5's `COLUMN_LETTERS` addition + the `escape()` helper. Logic is identical.
  - `src/ui/views/board.ts:42-49` defines `policyForExit(config, from)`. Body: `const next = nextColumn(from); if (!next) return null; return config.autonomy.transitions[\`${from}_to_${next}\`] ?? 'manual';`.
  - `src/ui/views/board_validate.ts:32` — `FORWARD_MAP.archived = null` (terminal marker). `nextColumn('archived')` returns `null` (line 45-47).
  - Render call site at `src/ui/views/board.ts:92-93`: `const policy = policyForExit(config, col); const badge = policy ? policyBadge(policy) : '';` — ternary gate: when `policy` is `null` (only for archived), `badge` is `''`. Inserted bare into the column-head at line 100.
  - Six columns render `<span class="badge manual|assist|auto">`. The 7th (`archived`) emits nothing for the badge position. CSS `.badge.final` does NOT exist (`src/ui/app.css:374-389` defines only `.badge.{manual|assist|auto}`).
- **Proposed approach: VALID with refinement.** Option B (dedicated `terminal` class + CSS variant) is preferred per the issue. Refinement: widen `policyForExit` to return `'final'` for archived rather than `null`, and widen `policyBadge`'s parameter type to include `'final'`. The ternary at the call site can stay (defensive) or simplify since `policy` is now always truthy. Cleanest: keep the function returning a non-null value for known terminal columns (`archived`); the null branch becomes unreachable for the current column set but is preserved as a guard against future schema additions where a non-terminal-yet-no-forward column might be added.

### Root Cause
- `policyForExit` was designed to surface the *forward-exit transition's autonomy policy* (line 43 comment: "Show the badge for the forward-exit transition only"). For terminal columns (no forward transition), it returns `null` by definition.
- The render layer at `board.ts:93` correctly handles `null` by omitting the badge entirely.
- The asymmetry arises because the **layout** (`.column-head` flex container) assumes a badge slot but doesn't supply a placeholder when the badge is absent. Result: 6 columns have right-justified badge + text; archived has only the text, visually narrower.
- This is a *presentation contract gap* — the engine's terminal-column semantics is correct, but the UI never decided how to visually mark "this column is terminal" vs. "this column's exit is `manual|assist|auto`".

### What This Means (User Impact)

**In plain terms:** The Board's right-most column (`U archived`) looks slightly broken — every other column has a small `manual` / `assist` / `auto` label next to its header, but archived is missing one. Users seeing this for the first time wonder if the badge failed to load or if the column is somehow unfinished. It's purely cosmetic — no data is lost and no transition is blocked — but the Control Room's masthead and column grid are otherwise deliberately styled, so the empty slot reads as scaffolding rather than intentional.

**Scenario:** Operator Devin opens the Board for the first time. They scan left-to-right across the seven columns (`Q discovered`, `W planned`, `E approved`, `R building`, `T verifying`, `Y shipped`, `U archived`). Columns Q–Y each show a small label below the column name: `Q discovered manual`, `W planned manual`, etc. Devin reaches column `U archived` and sees the label missing — wondering "did the badge fail to render, or is this column somehow incomplete?" They open browser dev tools, find `.column[data-column="archived"] .column-head` has no `<span class="badge">` child, and assume it's a bug.

**Before (current behavior):**
1. Devin loads Board.
2. Columns Q–Y render badges (`manual` for default-config projects).
3. Column U renders only the heading + count + (Phase 25.5) the letter `U` prefix.
4. Devin notices the asymmetry; suspects a render bug.

**After (with fix):**
1. Devin loads Board.
2. All 7 columns render a badge in the same slot.
3. Column U renders `<span class="badge final">final</span>` styled in `var(--mute)` (the muted gray tone established by the Control Room redesign for non-action elements).
4. Devin reads the badge as semantically meaningful: "this column is a final/terminal state with no further transitions" — design intent visible at a glance.

### Blast Radius
- **Files affected:**
  - `src/ui/views/board.ts` — PRIMARY. Widen `policyBadge` parameter type (line 38) to include `'final'`. Widen `policyForExit` return type (line 42) to include `'final'`. Change the `if (!next) return null;` (line 47) to `if (!next) return 'final';`. **The render call site at line 92-93 can stay unchanged** — the ternary becomes defensive (policy is always truthy for the current column set, but preserving the null branch costs nothing).
  - `src/ui/app.css` — add `.badge.final { color: var(--mute); }` (single line, slotted after line 389). ~1 line.
- **Callers and consumers:**
  - `policyForExit` has exactly ONE caller: `board.ts:92` (the render gate). No other call sites in `src/` or `tests/`.
  - `policyBadge` has exactly ONE caller: `board.ts:93` (inside the ternary). No other call sites.
  - Widening both functions' types is contract-compatible: existing callers' inputs and outputs remain in the widened type.
- **Test coverage status:**
  - **Existing**: no unit tests cover `policyForExit` or `policyBadge` (private to board.ts, not exported). `tests/ui/board_validate.test.ts` covers `nextColumn`/`isLegalTransition` only. `tests/integration/phase5-ui-end-to-end.test.ts` exercises Board rendering but doesn't assert badge HTML.
  - **GAP**: badge-render branch has no automated coverage. Acknowledged but **out of scope for XS** — adding a test would require either exporting `policyForExit`/`policyBadge` (smell for test-only) or extracting to a separate module (overkill for an XS cosmetic fix). Manual smoke covers the visual change.
- **Config interactions:**
  - `policyForExit` reads `config.autonomy.transitions[\`${from}_to_${next}\`]`. For archived (no `next`), this lookup is never performed in the new logic. No config schema change. No `tests/config/` impact.
- **Cross-item interactions:** None. Other Phase 26 steps (26.3 edition-stamp, 26.4 favicon, 26.5 stream-label clipping) are independent surfaces. No active issue or feature references `policyForExit`, `policyBadge`, or the Board's badge rendering.
- **Past work regression risk:**
  - **Phase 19 (`ui-control-room-redesign`):** authored the `.badge` CSS rules (374-389). Adding a 4th variant `.badge.final` extends without modifying the existing three. ✓
  - **Phase 24 (`ui-board-dnd-invalid-transition-uses-server-error-alert`):** refactored `policyForExit` to consume `board_validate.ts FORWARD_MAP`. Our change preserves the `nextColumn`-based gate and only changes the null-return branch. ✓
  - **Phase 25.2 (`keyboard-board-focus-and-move`):** added `COLUMN_LETTERS` + the `data-num`/`::before` CSS pattern. Independent of badge rendering. ✓

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose & symbol search (no Serena MCP available)*

#### Findings

1. **Target:** `.relay/implemented/ui-control-room-redesign.md` (Phase 19, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** strong
   - **Why related:** Authored the `.badge` CSS rules at `src/ui/app.css:374-389` and the column-head pattern in board.ts. The proposed fix extends this pattern by adding a 4th variant (`terminal`) — same slot styling, same `.badge` base class, same family-of-classes shape. No regression risk; pure extension.
   - **Suggested handling:** pattern reference only; no scope change.

2. **Target:** `.relay/implemented/ui-board-dnd-invalid-transition-uses-server-error-alert.md` (Phase 24, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** strong
   - **Why related:** Refactored `policyForExit` to consume the shared `FORWARD_MAP` from `board_validate.ts:25-33`. The current `archived: null` entry in FORWARD_MAP is the upstream cause of `policyForExit` returning null. Our fix preserves that null marker and surfaces a different value at the UI layer.
   - **Suggested handling:** pattern reference only; no scope change.

3. **Target:** `unfiled: src/ui/views/board.ts::policyForExit/policyBadge - private helpers untested`
   - **Kind:** unfiled candidate
   - **Evidence:** medium (test-gap on the helper branch)
   - **Why related:** Neither `policyForExit` nor `policyBadge` has a unit test. The board-render branch is exercised only by the Phase 5 integration test, which doesn't assert badge HTML. Adding the 4th variant proceeds without test scaffolding — typical for cosmetic-only changes but worth noting.
   - **Suggested handling:** **out of scope for this XS run**. File a follow-up issue if the operator wants helper-extraction-for-testability (would also benefit Phase 26.3 / 26.4 by making board helpers easier to assert against). For THIS run, manual smoke + typecheck is sufficient.

4. **Target:** `src/engine/lifecycle.ts:11` — `export const TerminalColumn: Column = 'archived'`
   - **Kind:** existing code (engine-side terminal-column constant)
   - **Evidence:** medium
   - **Why related:** Engine already has a `TerminalColumn` symbol pinned to `'archived'`. The UI's choice of `'final'` as the badge variant name aligns with this engine vocabulary (the badge says "this column is the terminal one"). Naming consistency only — `TerminalColumn` isn't exported to the UI bundle.
   - **Suggested handling:** semantic-alignment reference; influences badge variant naming (`'final'` over `'final'` or `'end'`). No code change needed in engine.

5. **Target:** `.relay/implemented/keyboard-board-focus-and-move.md` (Phase 25.2, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** weak
   - **Why related:** Phase 25.2 modified board.ts (added `COLUMN_LETTERS`, the `data-num` attribute, and the `::before` CSS pattern) — independent of the badge slot. Shares the file but different concern (keyboard focus vs. policy badge). Confirms no merge-conflict in board.ts since 25.2 landed.
   - **Suggested handling:** no scope change.

#### Search Bounds
- Live codepath audit: complete (read full `board.ts` + `board_validate.ts`; identified single caller of `policyForExit` and single caller of `policyBadge`)
- Backlog codepath: complete (Explore agent scanned `.relay/issues/` + `.relay/features/` — 9 active issues, 7 features; none touch badge-render)
- Subsystem: complete (Explore agent inventoried `src/ui/views/` — 7 view files; only `board.ts` references policy badges)
- Archive: complete (Explore agent scanned `.relay/archive/issues/` + `.relay/archive/features/` — 34 + 5 files; Phase 24 dnd-validation is the closest prior board.ts work)
- Implementation: complete (Explore agent scanned `.relay/implemented/` — 31 docs; Phase 19 redesign + Phase 24 dnd + Phase 25.2 keyboard are the relevant entries)
- Contract drift: complete (grep across `src/`, `tests/`, `.relay/`, README.md — `terminal` literal exists only in `lifecycle.ts:11` and in the issue file's prose; no `.badge.final` CSS rule exists; no documentation claims a terminal-with-badge contract)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* No medium/strong findings share a root cause with the target. Findings 1, 2, 4, 5 are pattern references with no scope implication. Finding 3 (untested private helpers) is an acknowledged test-gap but is itself a P3-shaped follow-up that doesn't belong in an XS cosmetic fix's scope — extracting `policyForExit`/`policyBadge` to a separate testable module would multiply blast radius without serving the visible bug. Single-item run.

### Approach
- **Recommended approach:**
  1. **`src/ui/views/board.ts`** — widen `policyBadge`'s parameter type to `'manual' | 'assist' | 'auto' | 'final'`. Widen `policyForExit`'s return type to `'manual' | 'assist' | 'auto' | 'final' | null` (preserving the null branch defensively, even though no current column triggers it after this change). Change `if (!next) return null;` to `if (!next) return 'final';`. No render-call-site change needed (the existing ternary at line 93 stays defensive).
  2. **`src/ui/app.css`** — append a single line after line 389: `.badge.final { color: var(--mute); }`. Matches the design system's "muted text" tone — visually present but de-emphasized, signaling "this column is terminal" without competing with the active `manual|assist|auto` colors.
  3. No new tests. Manual smoke at the daemon UI confirms the visible change. Typecheck + build confirm the widened types compile.

- **Alternatives considered:**
  - **Option A from issue (`—` placeholder badge or `final` label):** rejected. Less semantic than `terminal`; `terminal` aligns with the engine's `TerminalColumn` constant (`src/engine/lifecycle.ts:11`).
  - **Option C from issue (CSS-hide the badge slot for archived):** rejected. Would create a different asymmetry (column heading visually re-centers; badge slot disappears entirely). Worse than current.
  - **Extract `policyForExit`/`policyBadge` to a separate module for testability:** rejected for XS scope. File as a follow-up if the operator wants the helper-test infrastructure (would also help Phase 26.3 / 26.4). For THIS run, the simpler in-place type widening is the right size.
  - **Special-case archived at the render call site (line 92-93) instead of inside `policyForExit`:** rejected. Pushes the "terminal column" knowledge into the render layer, where it has no business. The function that decides the badge variant should encapsulate the terminal-vs-transitional decision.

- **Open questions for /relay-plan:**
  - **Color for `.badge.final`:** `var(--mute)` (recommended — matches the design system's "softer text" tone established for non-action elements in Phase 19) OR `var(--mute-2)` (deeper mute — too dim, might look like a render failure) OR `var(--paper-2)` (no semantic color — same brightness as other badges, reduces the "terminal" semantic). Default recommendation: `var(--mute)`. Confirmable at manual smoke.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Widen `policyBadge` and `policyForExit` to support `'final'`; return `'final'` for archived

**File**: `src/ui/views/board.ts` (functions `policyBadge` lines 38-40, `policyForExit` lines 42-49)

**Before** (current code):
```ts
function policyBadge(policy: 'manual' | 'assist' | 'auto'): string {            // ← parameter typed to the three autonomy policies only; no terminal variant
  return `<span class="badge ${policy}">${policy}</span>`;                       // ← composes `<span class="badge {policy}">` — the class string drives the CSS variant
}                                                                                 // ← end policyBadge

function policyForExit(config: ProjectConfigShape, from: Column): 'manual' | 'assist' | 'auto' | null {  // ← return type allows null for terminal columns
  // Show the badge for the forward-exit transition only (the most common move).  // ← existing design comment — preserved
  // Forward map lives in the shared board_validate module (single source of      // ← existing design comment — preserved
  // truth for drag-drop validation and Phase 17 keyboard validation).             // ← existing design comment — preserved
  const next = nextColumn(from);                                                   // ← look up forward target via shared validator
  if (!next) return null;                                                          // ← terminal column branch — currently returns null, dropping the badge entirely
  return config.autonomy.transitions[`${from}_to_${next}`] ?? 'manual';            // ← non-terminal branch: read config-driven autonomy policy, default to 'manual'
}                                                                                  // ← end policyForExit
```

**After** (proposed change):
```ts
function policyBadge(policy: 'manual' | 'assist' | 'auto' | 'final'): string {  // ← CHANGED: parameter type widened with 'final' as a 4th variant
  return `<span class="badge ${policy}">${policy}</span>`;                          // ← unchanged: same template literal. For 'final' input, emits `<span class="badge final">final</span>` (5-char value fits between AUTO and MANUAL/ASSIST widths). CSS rule added in Step 2 styles it.
}                                                                                   // ← end policyBadge

function policyForExit(config: ProjectConfigShape, from: Column): 'manual' | 'assist' | 'auto' | 'final' | null {  // ← CHANGED: return type widened with 'final'. null is preserved as a defensive guard — unreachable for the current 7-column set after the change below, but kept in case a future column shape (e.g., a parallel "blocked" lane) needs to suppress the badge entirely
  // Show the badge for the forward-exit transition only (the most common move).   // ← unchanged comment
  // Forward map lives in the shared board_validate module (single source of       // ← unchanged comment
  // truth for drag-drop validation and Phase 17 keyboard validation).              // ← unchanged comment
  // Phase 26.2: terminal columns (no forward transition) surface as 'final'    // ← NEW comment line documenting the terminal branch
  // so the column-head badge slot stays visually consistent across all 7 columns. // ← NEW comment line — explains the visual intent
  const next = nextColumn(from);                                                    // ← unchanged: look up forward target
  if (!next) return 'final';                                                     // ← CHANGED: was `return null;` → now `return 'final';` so archived (the only column with `nextColumn(_) === null` for the current set) renders the badge
  return config.autonomy.transitions[`${from}_to_${next}`] ?? 'manual';             // ← unchanged: non-terminal branch
}                                                                                   // ← end policyForExit
```

**Why**: Surfaces the engine's terminal-column semantics (`FORWARD_MAP.archived = null` in `board_validate.ts:32`) at the UI layer as a distinct badge variant rather than as a render-time omission. The `'final'` value passes through the existing `<span class="badge ${policy}">` template, producing `<span class="badge terminal">terminal</span>` — same DOM shape as the other three variants, picked up by the new CSS rule in Step 2. Aligns with the engine's existing `TerminalColumn = 'archived'` constant (`src/engine/lifecycle.ts:11`) for naming consistency. Preserves the `null` branch in the return type as a defensive guard against future column-shape additions; the branch is unreachable for the current 7-column set after this change, but documenting "this function may return null" keeps the call site's existing ternary at line 93 (`policy ? policyBadge(policy) : ''`) semantically correct without requiring a callsite edit.

**Risk**: Low. Both `policyBadge` and `policyForExit` are file-local (not exported), so no external callers exist outside `board.ts`. The render call site at line 92-93 consumes the widened return type without modification (the ternary still guards against `null`). Risk is limited to typos in the new string literal — caught by manual smoke and the typecheck.

**Verify**: 
- `npm run typecheck` (engine + UI configs) — both pass.
- `npm run build:ui` — clean.
- Manual smoke (post Step 2): open Board, confirm column `U archived` renders `<span class="badge final">final</span>` next to its header, matching the layout slot of the other six columns.

**Rollback**: `git revert <step-1-commit>` — restores the `null`-returning branch and the 3-variant types. The CSS rule from Step 2 becomes orphaned (matches no element) but harmless.

---

### Step 2: Add `.badge.final` CSS variant

**File**: `src/ui/app.css` (Policy badges section, lines 374-389)

**Before** (current code):
```css
/* Policy badges */                                                              /* ← comment header marking the badge ruleset */
.badge {                                                                          /* ← base rule for all badges; sets display, font, padding, border-shape, etc. */
  display: inline-block;                                                          /* ← inline-block so the badge sits next to the column heading */
  font-family: var(--f-mono);                                                     /* ← uses the JetBrains Mono / fallback stack */
  /* ... other shared base properties (font-size, padding, border, vertical-align) ... */
}                                                                                 /* ← end .badge base */
.badge.manual { color: var(--signal); }                                           /* ← manual badges in --signal (vermillion #ff4d1c) */
.badge.assist { color: var(--amber); }                                            /* ← assist badges in --amber (#f0b65d) */
.badge.auto   { color: var(--acid); }                                             /* ← auto badges in --acid (#9bd66b) */
                                                                                  /* ← no .badge.final rule exists — the 4th badge variant has no styling */
/* Card tiles */                                                                  /* ← next section header begins */
```

**After** (proposed change):
```css
/* Policy badges */                                                              /* ← unchanged comment */
.badge {                                                                          /* ← unchanged base rule */
  display: inline-block;                                                          /* ← unchanged */
  font-family: var(--f-mono);                                                     /* ← unchanged */
  /* ... other shared base properties unchanged ... */                            /* ← unchanged */
}                                                                                 /* ← end .badge base */
.badge.manual { color: var(--signal); }                                           /* ← unchanged */
.badge.assist { color: var(--amber); }                                            /* ← unchanged */
.badge.auto   { color: var(--acid); }                                             /* ← unchanged */
.badge.final { color: var(--mute); }                                           /* ← NEW: 4th variant for the archived column. Uses --mute (#a39988, the design system's "softer text" tone established in Phase 19 for non-action elements). Visually present + de-emphasized, matching the "this column is terminal, no further transitions" semantic. */
                                                                                  /* ← end of badge variants */
/* Card tiles */                                                                  /* ← unchanged next-section header */
```

**Why**: Provides the visual identity for the `'final'` badge variant introduced in Step 1. Uses `var(--mute)` — the design token already in use for muted/de-emphasized text per the Phase 19 Control Room design system (`src/ui/app.css:20` defines `--mute: #a39988`). The color choice is intentional: present enough to read as "labelled" (preserving the visual symmetry the issue calls out), de-emphasized enough to read as "this is a terminal state, not an active transition" — distinct from the three vibrant action-policy colors (vermillion / amber / acid).

**Risk**: Very low. Single-line CSS addition; no selector specificity conflicts (existing `.badge.{manual|assist|auto}` rules use the same shape — verified via grep, no `.badge.final` rule exists anywhere in the codebase). The `--mute` token is already referenced in the design system, so no new variable is needed.

**Verify**: 
- `npm run build:ui` — clean (CSS isn't typechecked, but `scripts/build-ui.mjs` copies it; a syntax error would surface as a CSS-parse failure on next page load).
- Manual smoke: open Board, confirm the `U archived` column shows `FINAL` text (uppercase due to CSS) in a muted gray, visually consistent with the other six columns' badge slots (same dimensions, dimmer color).
- Cross-check at 200% browser zoom: the muted color should still be readable; if it disappears entirely, swap to `var(--paper-2)` (a slightly brighter tone). Default recommendation `var(--mute)` based on Phase 19 precedent.

**Rollback**: `git revert <step-2-commit>` — removes the `.badge.final` rule. The archived column then renders `<span class="badge final">final</span>` with no `.badge.final` selector matching it — the `.badge` base styling (display, font, padding, border) still applies; only the color rule is absent. Browser default text color (the `--paper` body color from `app.css:17`) would render. Acceptable degraded state.

---

## Test Changes

- **No new test files.** `policyForExit` and `policyBadge` are file-local helpers (not exported). Adding unit tests would require either exporting them (smell for test-only) or extracting them to a separate module (overkill for XS scope). The existing test suite (`tests/ui/board_validate.test.ts`, `tests/ui/board_keys.test.ts`, `tests/integration/phase5-ui-end-to-end.test.ts`) covers adjacent surfaces but doesn't assert badge HTML — pre-existing gap, acknowledged in the Analysis Related-Work finding #3 as out-of-scope for this XS run.
- **No existing tests modified.** The widened return type for `policyForExit` is contract-compatible (existing `'manual' | 'assist' | 'auto' | null` is a subset of `'manual' | 'assist' | 'auto' | 'final' | null`). The widened `policyBadge` parameter type adds an option without removing any. Typecheck pass confirms.
- **Manual smoke is the verification path** for the visible change. Documented in Step 1's Verify block.

---

## Post-Implementation Checks

1. `npm run typecheck` — `tsc --noEmit` (engine) and `tsc --noEmit -p tsconfig.ui.json` (UI) both clean.
2. `npm test` — full suite passes (modulo the known parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`; passes in isolation per Phase 25 baseline + Phase 26.1 verification). Expected count: 743 (unchanged from Phase 26.1's 743 — no new tests added in this step).
3. `npm run build` — engine + UI builds succeed. `dist/ui/main.js` and `dist/ui/app.css` emitted.
4. Manual smoke #1 (visible change): open Board at `http://127.0.0.1:7180/?token=<good>` → all 7 column headers render a badge. Column `U archived` shows `<span class="badge final">final</span>` in `--mute` color (rendered uppercase as `FINAL` due to base `.badge` text-transform), visually aligned with the other six column badges with comparable width to MANUAL/ASSIST.
5. Manual smoke #2 (no regression on the other six): columns Q–Y still render their `manual`/`assist`/`auto` badges with the existing vermillion / amber / acid colors.
6. Manual smoke #3 (zoom resilience): repeat #1 at 200% browser zoom; the `FINAL` text should still be readable (not vanish into the background).
7. DevTools inspector check: confirm the rendered HTML for `<section class="column" data-column="archived" data-num="U">` contains a `<span class="badge final">` child.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Color choice (`var(--mute)`) reads as too dim or too bright in the smoke | Low | Low | Default is the recommended token; if smoke surfaces issues, swap to `var(--paper-2)` (brighter) or `var(--mute-2)` (deeper). One-token change, no behavioral risk. |
| Future column-shape addition surfaces the `null` branch in `policyForExit` | Low | Very low | Branch is preserved defensively. If a future "blocked" or similar column also has `nextColumn(_) === null` AND should suppress the badge, the existing ternary at line 93 handles it. If both terminal columns should render badges, the `if (!next) return 'final';` branch handles archived AND the new column with no further change. |
| CSS variable token rename (e.g., `--mute` renamed) | Very low | Low | Project-internal token; renaming would require updating all three existing badge variants too. CSS-parse error would surface at next page load. |
| `policyBadge` type widening breaks the call site's ternary semantics | Very low | Very low | The widened return type is a superset; the ternary `policy ? policyBadge(policy) : ''` still narrows correctly. Typecheck pass confirms. |

---

## Rollback Plan

Pure code change — no DB migrations, no config changes, no stored data format changes.

`git revert <commit-sha-of-26.2-feat-commit>` — single revert restores the pre-26.2 `policyBadge` 3-variant signature, the `null`-returning branch for `policyForExit`, and the absence of the `.badge.final` CSS rule. The archived column reverts to its current (badgeless) rendering.

Fill in the actual commit hash here after implementation lands:
- `feat(26.2): policy badge for archived column` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

**LOW-1 — Badge width inconsistency from the new variant's character count (resolved in-plan).** The CSS at `src/ui/app.css:374-389` applies `text-transform: uppercase`, `font-size: 9px`, `letter-spacing: 0.12em`, and `font-family: var(--f-mono)` (monospace). Badge width scales linearly with character count in this rendering. The plan originally used `'terminal'` as the policy value (8 chars → ~52-58px rendered width). The other three badges render at `AUTO` (4 chars, ~28-32px), `MANUAL`/`ASSIST` (6 chars, ~40-44px). The 8-char `TERMINAL` badge would be ~25% wider than `MANUAL` and ~75% wider than `AUTO` — solving the original "archived column has no badge" asymmetry by introducing an "archived column's badge is noticeably wider than the others" asymmetry. Renamed to `'final'` (5 chars → `FINAL` at ~34-38px, fitting between AUTO and MANUAL/ASSIST). Applied across `policyBadge` parameter type, `policyForExit` return type, the if-branch return value, the CSS selector (`.badge.terminal` → `.badge.final`), the rendered HTML examples in all manual-smoke checks, and the analysis's color-choice open question. Trade-off documented: `terminal` aligns nominally with the engine's `TerminalColumn` constant (`src/engine/lifecycle.ts:11`) but that constant isn't surfaced to the UI bundle; `final` reads naturally as the column's state and fits the visual rhythm. Width-fit wins for a Phase 19 deliberately-styled grid.

### Edge Cases Tested

- `nextColumn` returns null (archived only, current 7-column set) → `if (!next) return 'final'` fires; emits `<span class="badge final">final</span>`. ✓
- Hypothetical future column with `nextColumn(_) === null` (e.g., a "blocked" lane) → also gets the `final` badge. Acceptable; operator can refine in a follow-up if the future column needs a different label.
- `config.autonomy.transitions['archived_to_X']` overridden by user → lookup never executes; `return 'final'` fires first. ✓
- `config.autonomy.transitions` missing entirely → pre-existing TypeScript contract violation; not affected by this change. ✓
- Render call site sees `policy = 'final'` → ternary at line 93 evaluates truthy → calls `policyBadge('final')` → returns `<span class="badge final">final</span>`. ✓
- `policyForExit` returning `null` (unreachable for current columns) → render-site ternary still handles null defensively → empty string. Defense-in-depth preserved.
- Existing tests: `tests/ui/board_validate.test.ts:26-28` asserts `nextColumn('archived')` returns null — `nextColumn` itself is unchanged; test stays green. No test asserts badge HTML in any `tests/` file (verified via grep including `tests/integration/` end-to-end suites).
- CSS-rule rollback resilience: without `.badge.final` rule, the `<span class="badge final">final</span>` renders in inherited (`--paper`) color with `currentColor` border — degraded but readable.

### Regression Risk

None identified beyond the LOW-1 width concern, which was resolved in-plan. Specifically verified:

- **Phase 19 (`ui-control-room-redesign`)** — `.badge.{manual|assist|auto}` rules preserved; Step 2 adds a 4th rule without modifying the existing three.
- **Phase 24 (`ui-board-dnd-invalid-transition-uses-server-error-alert`)** — `policyForExit`'s FORWARD_MAP-driven gate preserved; only the null-return branch changes. `nextColumn` itself unchanged.
- **Phase 25.2 (`keyboard-board-focus-and-move`)** — `COLUMN_LETTERS` + `data-num` attribute unrelated to badge slot.
- **`tests/ui/board_validate.test.ts` `nextColumn('archived')` returns null assertion** — stays green.
- **No active issue or feature touches badge rendering** — verified via grep.

### Verdict

**APPROVED WITH CHANGES** — single LOW-severity revision applied in-place: policy value renamed `'terminal'` → `'final'` across the plan for tighter badge width fit with the existing AUTO/MANUAL/ASSIST visual rhythm. No behavior change, no scope change — label/class naming swap only. Ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-17*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-17*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Widen `policyBadge` parameter type + `policyForExit` return type with `'final'`; change `if (!next) return null` → `if (!next) return 'final'`; add Phase 26.2 explanatory comment | YES | YES |
| 2 | Append `.badge.final { color: var(--mute); }` rule to `src/ui/app.css` after the existing three badge variants | YES | YES |

Diff: `src/ui/views/board.ts` (+5 / -2 lines), `src/ui/app.css` (+1 / -0 lines). Total: 2 files, 6 insertions, 3 deletions. Matches plan exactly; no unplanned changes; no drive-by refactors.

### Test Results

- **`npm run typecheck`** — clean. Both `tsc -p tsconfig.json` (engine) and `tsc -p tsconfig.ui.json` (UI) pass. The widened union types (`'manual' | 'assist' | 'auto' | 'final'` and the call-site ternary preserving the `null` branch) compile cleanly.
- **`npm test`** (full suite) — **743/743 pass**. Suite count unchanged from Phase 26.1 baseline (no tests added for this XS step per plan). The previously-known pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` passed this run (intermittent; passes in isolation; Phase 26.1's verification documented its flake nature).
- **`npm run build:ui`** — clean. `dist/ui/app.css` includes the new `.badge.final` rule; `dist/ui/views/board.js` includes the widened types (TypeScript strips type annotations at emit; the runtime change is just the string literal `'final'` replacing the `null` return in the terminal branch).
- **Targeted tests** — `npx vitest run tests/ui/board_validate.test.ts` was implicitly part of the full suite run; the `nextColumn('archived')` returns null assertion stays green (unchanged behavior).

### Issues Found

None. All plan steps implemented as specified (with the LOW-1 `terminal` → `final` rename from the Adversarial Review applied throughout). No undocumented deviations. No regressions. No leftover TODO comments or placeholder code.

Manual smoke deferred to operator at `/relay-resolve` per the plan's manual-smoke verification path for the visible change (vitest's node env doesn't bridge DOM; the helper functions are file-local and not unit-tested; the badge-render branch has no automated coverage — documented in the Analysis Related-Work finding #3 as an out-of-scope follow-up).

### Verdict

**COMPLETE**. All two plan steps implemented, suite at 743/743, build + typecheck clean, no regressions, no scope creep, no leftover work. Diff is precisely scoped to the planned 2 files and 6 line additions.

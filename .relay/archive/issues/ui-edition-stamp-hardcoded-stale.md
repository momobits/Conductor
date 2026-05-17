# Masthead "Vol. 18 · N° 01" edition stamp is hardcoded and now stale

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-edition-stamp-hardcoded-stale.md)

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — stale UI string; cosmetic.*

## Problem statement

The Control Room masthead displays an "Edition" stamp `Vol. 18 · N° 01`. The values are hardcoded in markup; they were correct when Phase 19 shipped the redesign mid-Phase-18 but are now out of date — we just closed Phase 20 and are starting Phase 21.

## Current state

- `src/ui/index.html:24`:
  ```html
  <span class="edition-value" id="edition-stamp">
    Vol. <span data-edition-vol>18</span> · N° <span data-edition-no>01</span>
  </span>
  ```
- The `data-edition-vol` / `data-edition-no` slots suggest the original author intended these to be set dynamically, but no `main.ts` code writes to them.

## Impact

- Misleads anyone trying to correlate the UI with current Control state.
- Each new phase widens the gap silently, creating a recurring follow-up to bump.

## Proposed direction

Two options:

- **A (lightest):** rip the stamp out. It is decorative; the actual phase/step lives in STATE.md and is not surfaced anywhere else in the UI.
- **B:** populate the slots at runtime — daemon already exposes phase / step state somewhere reachable (or could via an `engine_state` RPC). On bootstrap, `main.ts` reads it and writes the values: `Vol. <currentPhase> · N° <currentStep>`. Same surface stays alive instead of drifting.

Option B preserves the masthead aesthetic without making it a maintenance burden. The decorative typography of `Vol. X · N° Y` maps naturally to phase/step ordinals.

---

## Analysis

*Analyzed: 2026-05-17*

### Validation
- **Problem still exists:** YES. Verified at current HEAD.
  - `src/ui/index.html:24` renders `Vol. <span data-edition-vol>18</span> · N° <span data-edition-no>01</span>` — hardcoded literal `18` and `01`. The current Control phase is **26** (per STATE.md), so the masthead is 8 phases stale.
  - The `data-edition-vol` / `data-edition-no` attribute slots exist (as the issue notes — original author left bootstrap hooks). Grep confirms NO `main.ts`, `bootstrap()`, or any UI-side code writes to these slots. The attributes are inert markers.
  - Visual confirmation: opening the UI shows "Edition · Vol. 18 · N° 01" in the right side of the masthead.
- **Proposed approach: NEEDS ADJUSTMENT.** The issue's Option B as written ("daemon already exposes phase / step state somewhere reachable") is **overly optimistic** — there is NO `engine_state` RPC, NO project-wide "current phase/step" exposed via any RPC, and the UI cannot read STATE.md (lives in `.control/`, not served by the daemon). Building the infrastructure for Option B as described would push this from XS to S/M scope. Three realistic variants of Option B exist (date-derived, package-version-derived, git-tag-derived); see Approach section below.

### Root Cause
- The Phase 19 Control Room redesign authored the editorial newspaper-style masthead including the `Edition · Vol. X · N° Y` stamp as a decorative element. The original author left HTML attribute hooks (`data-edition-vol`, `data-edition-no`) hinting at intended dynamic population but never wired up the JS to populate them.
- Hardcoded values land in the served HTML and never refresh; each Control phase tag silently widens the gap between the stamp and reality.
- **Deeper architectural observation**: this is the only masthead element that depends on extra-UI state. Brand name, brand mark, navigation, status indicator — all derive from the page itself or from connection state. The edition stamp is the lone outlier. Either pull it into "self-contained UI element" (Options A or B1) or surface it via a proper RPC (Option B3 — out of XS scope).

### What This Means (User Impact)

**In plain terms:** The Control Room masthead has a tiny "Edition" label that says "Vol. 18 · N° 01" — but the project is now on Phase 26. Anyone looking at the UI for the first time and trying to correlate it with documented state (e.g., comparing to STATE.md or to a phase tag in `git log`) sees the stamp lagging by 8 phases and either (a) assumes the UI is showing wrong data (eroding trust in the whole surface), (b) opens dev tools to find the hardcoded literal and files an issue (already happened — the Phase 21 Playwright dogfood surfaced this), or (c) ignores it and the editorial-aesthetic flair becomes meaningless decoration.

**Scenario:** Operator Maria opens the Conductor UI for the first time after `conductor daemon start`. She scans the masthead: `§ Conductor / Control Room` on the left, `Edition · Vol. 18 · N° 01` on the right. She knows the project is past Phase 25 (from her terminal where she's been running Control commands). She wonders: "is this UI showing stale data? Did the daemon fail to load something?" She opens dev tools, finds the literal `>18<` and `>01<` in `index.html`, and concludes: "the edition stamp is hardcoded; not a data issue, just a forgotten string." Her trust in the masthead's accuracy is dented, even though no actual data is wrong.

**Before (current behavior):**
1. Maria opens UI.
2. Masthead shows `Edition · Vol. 18 · N° 01`.
3. Maria notices the gap vs. current Phase 26.
4. She investigates, finds the hardcoded literal, files a bug (or just shrugs).

**After (with fix — Option A: rip):**
1. Maria opens UI.
2. Masthead shows `§ Conductor / Control Room` on the left, status indicator on the right (no edition stamp).
3. Maria sees a cleaner masthead with no semantically-wrong elements.

**After (with fix — Option B1: date-derived):**
1. Maria opens UI on 2026-05-17.
2. Masthead shows `Edition · Vol. 6 · N° 20` (e.g., `Vol = year - 2020`, `N° = ISO week number`).
3. Maria reads it as a self-updating decorative "today's edition" — meaningful, accurate, no maintenance burden.

**After (with fix — Option B2: package-version-derived):**
1. Maria opens UI at package version `0.1.0`.
2. Masthead shows `Edition · Vol. 0.1 · N° 00` (e.g., `Vol = major.minor`, `N° = patch zero-padded`).
3. Same staleness mode as before — only updates on release. Slightly less stale than the current literal but same shape of bug.

### Blast Radius
- **Files affected:**
  - **`src/ui/index.html:22-25`** — the `.edition` block. Option A: remove the entire `<div class="edition">…</div>` block (4 lines). Option B1/B2: leave the structure, change the hardcoded `18`/`01` to a sentinel like `<span data-edition-vol>—</span>` so it renders as a clear placeholder before JS hydrates.
  - **`src/ui/main.ts`** (Option B1/B2 only) — add a `setEditionStamp()` call inside `bootstrap()` or before `dispatch()`. ~5 lines of TypeScript reading the date/version and writing to the `data-edition-vol`/`data-edition-no` element via `document.querySelector`. Pure DOM mutation; no RPC.
  - **`src/ui/app.css:126-135`** (Option A only) — optionally remove the `.edition`, `.edition-label`, `.edition-value` rules (3 short rules, ~10 lines) since they'd be unused. Keeping them is harmless dead CSS.
- **Callers and consumers:** None. The `data-edition-vol` / `data-edition-no` attribute hooks are not referenced anywhere in `src/`, `tests/`, or `scripts/` (grep-verified). The HTML element is purely decorative.
- **Test coverage status:**
  - **Existing**: NO tests reference `edition`, `Vol.`, `N°`, `data-edition`, or `edition-stamp` anywhere in `tests/` (grep-verified).
  - **No new tests needed** for Option A (pure HTML removal). For Option B1/B2, a tiny pure-helper test could be added asserting the formatter output for a known date or version, but the helper is a 2-3 line one-liner; XS scope argues for no new tests + manual smoke.
- **Config interactions:** None for Option A. None for Option B1 (uses JS Date). For Option B2, depends on `package.json` version field — already a stable contract.
- **Cross-item interactions:** None. Other Phase 26 steps (26.4 favicon, 26.5 stream-label clipping) touch different surfaces.
- **Past work regression risk:**
  - **Phase 19 (`ui-control-room-redesign`):** authored the masthead including the edition stamp. Option A removes one of its decorative elements (small aesthetic loss); Option B1/B2 preserves it. The Phase 19 implementation doc explicitly described the edition stamp as part of the editorial flair — removing it is a minor design step-back; populating it is a design completion.
  - **No other Phase touches the masthead.** Phase 25's footer changes are independent (footer is a separate element at `index.html:47-51`).

### Related Work
*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose & symbol search (no Serena MCP available)*

#### Findings

1. **Target:** `.relay/implemented/ui-control-room-redesign.md` (Phase 19, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** strong
   - **Why related:** Authored the masthead including the edition stamp. The hardcoded `Vol. 18 · N° 01` was the values current at Phase 19 shipping. The author left `data-edition-vol`/`data-edition-no` hooks signaling future dynamic population intent. This issue is the natural follow-up to either complete or remove that intent.
   - **Suggested handling:** pattern reference only; no scope change.

2. **Target:** `unfiled: src/rpc/methods.ts - no engine_state or project_state RPC`
   - **Kind:** unfiled candidate
   - **Evidence:** medium
   - **Why related:** Issue's Option B assumes an RPC exists to surface phase/step state. None does. Building one would require: a `project_state` handler reading from `.control/progress/STATE.md` (cross-framework dependency) OR `git describe --tags --abbrev=0 --match 'phase-*-closed'` (git-tag-derived). This is a real follow-up if the operator wants a properly-data-driven Control Room masthead.
   - **Suggested handling:** **out of scope for this XS run**. File as a separate issue if Option B (proper RPC variant) is desired; for THIS run, pick between Option A, B1 (date-derived), or B2 (version-derived).

3. **Target:** `src/ui/index.html:30-32` (nav-num `01`/`02`/`03` literals)
   - **Kind:** unfiled candidate (related pattern)
   - **Evidence:** weak (shares vocabulary but different semantic)
   - **Why related:** The masthead nav also uses hardcoded numeric literals (`<span class="nav-num">01</span>` Board, `02` Monitor, `03` Routing). These are STABLE (the three views aren't reorderable), so they're correctly hardcoded. Different concern from the edition stamp's stale-by-design problem. Mentioned for awareness; no action needed.
   - **Suggested handling:** keep narrow; no scope change.

4. **Target:** `.relay/implemented/keyboard-footer-rotation-and-help-overlay.md` (Phase 25.4, archived)
   - **Kind:** existing item (implemented)
   - **Evidence:** weak
   - **Why related:** Phase 25.4 added the footer-rotation pattern (per-view dynamic footer text via `SHORTCUTS` const in `src/ui/lib/footer.ts`). If Option B1/B2 chooses to extract a tiny formatter helper to `src/ui/lib/edition.ts`, the pattern would mirror `footer.ts`'s tiny lib-style helper. Marginal precedent; mentioned for naming consistency.
   - **Suggested handling:** no scope change.

#### Search Bounds
- Live codepath audit: complete (read full `index.html` masthead block + `app.css` `.edition*` rules + verified no `data-edition` references in `main.ts`)
- Backlog codepath: complete (grep `Vol\.|edition|N°|data-edition|masthead-meta` in `src/ui/` → 2 files: `index.html` and `app.css` only; no `.relay/issues/` or `.relay/features/` reference)
- Subsystem: complete (grep across `src/ui/views/`, `src/ui/lib/` for any masthead/edition reference → none)
- Archive: complete (Phase 19's `ui-control-room-redesign` is the only relevant archived item)
- Implementation: complete (Phase 19 redesign is the origin; no subsequent implementation touched the masthead)
- Contract drift: complete (grep `engine_state|project_state` in `src/rpc/methods.ts` → no such RPC exists; symbol-existence guard fires on the issue's Option B assumption)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-17
*Rationale:* No medium/strong findings link to other open items. Finding #2 (no engine_state RPC) is an acknowledged unfiled candidate explicitly scoped OUT of this XS run (would push to S/M). Findings #1, #3, #4 are pattern references with no scope implication. Single-item run. **Implementation approach (A vs. B1 vs. B2) is a within-scope design pick — see Approach below; recommendation requires operator input.**

### Approach
- **Recommended approach** (pending operator confirmation of A vs. B1):
  - **Option A — rip**: Smallest scope. Remove the `<div class="edition">…</div>` block from `index.html:22-25` (4 lines deleted). Leave the `.edition*` CSS rules (3 short rules at `app.css:126-135`) in place as harmless dead CSS, OR remove them too as a tiny cleanup. No `main.ts` change. No new tests. Zero data-source coupling. **Cost: ~4 lines deleted; 1 file touched. Risk: very low. Trade-off: loses the editorial decorative flair from the Phase 19 masthead.**
  - **Option B1 — date-derived**: Preserves the aesthetic. Add ~5 lines of TypeScript to `main.ts bootstrap()` (or a tiny `src/ui/lib/edition.ts` helper) that computes `Vol. = year - 2020` and `N° = ISO week of year` (or `month*100 + day`, etc.), then writes the values to the `data-edition-vol` and `data-edition-no` slots via `document.querySelector`. Self-updating; no data-source dependency beyond `new Date()`. **Cost: ~5 lines of TS, 1 file touched (or 2 if extracting to lib). Risk: very low. Trade-off: vol/no semantics are arbitrary (year-2020 / week-of-year is a fake newspaper convention) — meaningful only as decorative flavor.**
  - **Option B2 — package-version-derived**: Preserves the aesthetic with semantic-version mapping. Add ~3 lines reading `import.meta.PACKAGE_VERSION` or a build-time constant (`scripts/build-ui.mjs` would need a small change to inject the version). **Cost: ~3 lines in main.ts + ~3 lines in build-ui.mjs. Risk: low (build-time injection adds one new build coupling). Trade-off: only updates on package releases — same staleness shape as the current hardcoded value, just slightly less stale; doesn't really solve the problem.**

- **Alternatives considered:**
  - **Option B (as written in issue) — read from engine_state RPC**: rejected for XS scope. No such RPC exists; building one + wiring + tests would push to S/M. File as a separate issue if proper data-backed masthead is desired (see unfiled candidate #2).
  - **Option C — hardcode bump to current values (Vol. 26 · N° 02)**: rejected. Solves nothing — would re-stale on the next Control phase tag. The issue file explicitly calls this out as a "recurring follow-up to bump" trap.
  - **Option D — pull current phase from latest git tag via small daemon RPC**: rejected for XS scope (same as Option B as written).

- **Operator-bound approach (2026-05-17): Option A — rip.** Operator chose minimum-scope cleanliness over editorial flair preservation. The masthead's other deliberate-typography elements (brand mark `§`, brand name + italic tagline, paper-grain background, deliberate font stack) carry the Control Room identity without the edition stamp. Removing one decorative element is honest about the fact that no other UI element surfaces phase/step state.

---

## Implementation Plan

*Generated: 2026-05-17*

### Step 1: Remove the `<div class="edition">` block from `src/ui/index.html`

**File**: `src/ui/index.html` (lines 22-25, inside the first `.masthead-row` flex container)

**Before** (current code):
```html
      <div class="masthead-row">                                                  <!-- ← top masthead row: brand on left, edition on right -->
        <div class="brand">                                                        <!-- ← left side: brand block -->
          <span class="brand-mark" aria-hidden="true">§</span>                     <!-- ← § glyph as the brand mark -->
          <span class="brand-name">Conductor</span>                                <!-- ← brand name -->
          <span class="brand-italic">&nbsp;/ Control Room</span>                   <!-- ← italic tagline -->
        </div>                                                                     <!-- ← end .brand -->
        <div class="edition">                                                      <!-- ← right side: edition stamp block (DELETE) -->
          <span class="edition-label">Edition</span>                                <!-- ← static "Edition" label (DELETE) -->
          <span class="edition-value" id="edition-stamp">Vol. <span data-edition-vol>18</span> · N° <span data-edition-no>01</span></span>  <!-- ← hardcoded stale Vol/N° + inert data-edition slots (DELETE) -->
        </div>                                                                     <!-- ← end .edition (DELETE) -->
      </div>                                                                       <!-- ← end .masthead-row -->
      <div class="masthead-rule"></div>                                            <!-- ← horizontal rule below the top row -->
```

**After** (proposed change):
```html
      <div class="masthead-row">                                                  <!-- ← unchanged: top masthead row container -->
        <div class="brand">                                                        <!-- ← unchanged: brand block -->
          <span class="brand-mark" aria-hidden="true">§</span>                     <!-- ← unchanged -->
          <span class="brand-name">Conductor</span>                                <!-- ← unchanged -->
          <span class="brand-italic">&nbsp;/ Control Room</span>                   <!-- ← unchanged -->
        </div>                                                                     <!-- ← unchanged: end .brand -->
                                                                                   <!-- ← REMOVED: the entire <div class="edition">…</div> block (4 lines) — was rendering hardcoded stale "Vol. 18 · N° 01" with inert data-edition-vol/no attribute hooks that no JS ever wrote to -->
      </div>                                                                       <!-- ← unchanged: end .masthead-row -->
      <div class="masthead-rule"></div>                                            <!-- ← unchanged -->
```

**Why**: Removes the only masthead element whose content depended on extra-UI state — and which was never wired up to actually read that state. The `.masthead-row` flex container at `app.css:87-92` has `display: flex; align-items: baseline; justify-content: space-between` — with only the `.brand` child remaining, the brand simply left-aligns (no longer pushed against the right-side edition stamp). Visually: the top masthead row reads as the brand alone, with the `.masthead-rule` divider underneath, then the nav + status row beneath the rule. Clean. The `.edition*` CSS rules at `app.css:126-135` become unused but are left in place per the analysis's Blast Radius note (harmless dead CSS; removing them is a separate XS cleanup if desired — out of scope here per the operator's "minimum-scope cleanliness" pick).

**Risk**: Very low. The deleted block has no JS references (grep-verified: `data-edition-vol`, `data-edition-no`, `edition-stamp`, `edition-value`, `edition-label` all return zero results outside `index.html` and `app.css`). No tests reference any of these symbols. The `.masthead-row` flex layout gracefully handles a single child (justify-content: space-between with one element behaves identically to flex-start). The mobile media query at `app.css:1287-1288` (`.masthead-row { flex-direction: column; align-items: flex-start; } .edition { text-align: left; }`) was tuning the edition's mobile layout — that rule becomes a no-op without the element but remains harmless.

**Verify**:
- `npm run typecheck` — unchanged (no TS files touched).
- `npm run build:ui` — clean. `dist/ui/index.html` no longer contains the edition block.
- Manual smoke: open Board, confirm the masthead top row shows ONLY `§ Conductor / Control Room` on the left with the right side empty (no "Edition · Vol. X · N° Y"). The `.masthead-rule` divider line still renders below. The nav + status row beneath the divider is unchanged. At 200% zoom and at mobile width (≤ 560px per the media query), confirm the masthead layout still reads cleanly.

**Rollback**: `git revert <commit-sha>` — restores the 4 lines of the edition block. The visual flair returns (along with the staleness).

---

## Test Changes

- **No new tests.** No existing test references `edition`, `Vol.`, `N°`, `data-edition`, `edition-stamp`, `edition-value`, or `edition-label` (grep-verified across all of `tests/`). The deleted HTML has zero programmatic surface area.
- **No existing tests modified.** None to modify.

---

## Post-Implementation Checks

1. `npm run typecheck` — clean (no TS changes).
2. `npm test` — full suite passes (expected count: 743 unchanged from Phase 26.2; no test changes).
3. `npm run build:ui` — clean. Verify `dist/ui/index.html` no longer contains `<div class="edition">` (grep the file).
4. Manual smoke #1 (visible change): open Board at `http://127.0.0.1:7180/?token=<good>` → masthead's top row shows only `§ Conductor / Control Room` left-aligned. No "Edition · Vol. X · N° Y" on the right.
5. Manual smoke #2 (layout integrity): confirm the `.masthead-rule` divider line still renders cleanly below the top row, and the nav + status meta-row sits beneath it unchanged.
6. Manual smoke #3 (zoom resilience): at 200% browser zoom and at mobile width (resize window to ≤ 560px), confirm the masthead layout still reads as expected — brand visible, divider visible, nav + status visible.
7. DevTools inspector: confirm no `<div class="edition">` element in the served HTML.

---

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Removing the edition stamp leaves the right side of `.masthead-row` empty, making the brand look orphaned | Low | Low | The `.masthead-row` uses `justify-content: space-between` — with one child it left-aligns naturally. The brand block is substantial (mark + name + italic tagline), so the visual weight stays balanced. Manual smoke #1 verifies. |
| Dead CSS rules at `app.css:126-135` (`.edition`, `.edition-label`, `.edition-value`) | Certain (after delete) | Very low | Documented: harmless dead CSS, removable in a separate cleanup. The mobile media-query rule at line 1288 (`.edition { text-align: left; }`) also becomes a no-op but remains harmless. |
| Future operator re-adds the edition stamp wanting it to be data-backed | Low | Low | The unfiled candidate finding #2 in the Analysis (no `engine_state` RPC exists) is documented; the file-back trail in `.relay/archive/` will guide a future operator through the rip → restore-with-RPC path. |

---

## Rollback Plan

Pure HTML deletion — no DB migrations, no config changes, no stored data format changes.

`git revert <commit-sha-of-26.3-feat-commit>` — single revert restores the 4-line `<div class="edition">…</div>` block. The hardcoded "Vol. 18 · N° 01" returns (along with the staleness).

Fill in the actual commit hash here after implementation lands:
- `feat(26.3): remove hardcoded edition stamp from masthead` → `<sha-pending>`

---

## Adversarial Review

*Reviewed: 2026-05-17*

### Issues Found

None. The plan is a single-step, single-file, 4-line HTML deletion with zero JS or test surface area. Re-read of `src/ui/index.html:22-25` matches the BEFORE block exactly. Re-read of `src/ui/app.css:87-92` confirms `.masthead-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }` — with one child, the brand left-aligns naturally; `justify-content: space-between` is a no-op for a single child.

### Edge Cases Tested

- Flex container with 1 child → `justify-content: space-between` reduces to left-alignment for the sole child. Brand stays left-aligned in the masthead's top row. ✓
- Mobile media query at `app.css:1287-1288` (`.masthead-row { flex-direction: column }`) — still applies to the 1-child row, harmless. ✓
- Mobile media query at `app.css:1288` (`.edition { text-align: left }`) — no element matches the selector after the delete; CSS rule is a no-op. Harmless. ✓
- No `aria-*` or `role` attributes are removed (the edition stamp had no accessibility roles); no a11y regression. ✓
- No JS code references the deleted attribute hooks (`data-edition-vol`, `data-edition-no`, `edition-stamp`, `edition-value`, `edition-label`) — grep across `src/` and `tests/` returns zero matches outside `index.html` and `app.css`. ✓
- No tests reference any of the deleted symbols — grep across `tests/` returns zero matches. ✓

### Regression Risk

None. Specifically verified:

- **Phase 19 (`ui-control-room-redesign`)** — established the masthead including the edition stamp. This change is a documented design step-back, operator-approved. The brand mark, brand name + tagline, paper-grain background, deliberate font stack, and `.masthead-rule` divider continue to carry the Control Room identity.
- **No active issue or feature references the edition stamp** — verified via grep across `.relay/issues/` and `.relay/features/`.
- **Daemon static file serving** (`tests/daemon/static.test.ts`) — serves `index.html` with correct content-type; doesn't assert content. No test regression.

### Verdict

**APPROVED**. Ready for implementation.

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
| 1 | Remove the `<div class="edition">…</div>` block (4 lines) from `src/ui/index.html` | YES | YES |

Diff: `src/ui/index.html` (-3 lines net — the 4 deleted lines minus 1 retained closing whitespace). No other files touched.

### Test Results

- **`npm run build:ui`** — clean. `dist/ui/index.html` no longer contains `edition` (grep returns 0 matches — pre-fix would have shown 3 matches for `edition`, `edition-label`, `edition-value`/`data-edition-vol`/`data-edition-no`/etc.).
- **`grep -c "edition" dist/ui/index.html src/ui/index.html`** → `0` in both. Element fully removed from both source and built output.
- **`npm test`** (full suite) — **743 total entries, 742 passed / 1 failed**. The single failure is the documented pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain`.
- **Flake isolation re-run** — `npx vitest run tests/conductor/loop.test.ts -t "Daemon shutdown stops the conductor brain"` → **697ms, 1 passed / 8 skipped**. Confirms flake-not-regression. Touches `src/conductor/loop.ts` (daemon shutdown), zero overlap with the masthead HTML change.
- **`npm run typecheck`** — not re-run (no TS files touched in this step); Phase 26.2 baseline applies.

### Issues Found

None. Single-step implementation matched the plan exactly. No new files, no JS changes, no test changes. The `.edition*` CSS rules at `src/ui/app.css:126-135` are now unused dead CSS as documented in the plan's Risks block — left in place per the operator's "minimum-scope cleanliness" pick; removable in a separate XS cleanup if desired.

Manual smoke deferred to operator's next UI inspection per the standard XS verification path (vitest's node env doesn't render HTML).

### Verdict

**COMPLETE**. The single plan step is implemented, suite at 742/743 with the documented flake passing in isolation, build clean, diff scoped exactly to the planned 4-line HTML deletion. Nothing else changed.

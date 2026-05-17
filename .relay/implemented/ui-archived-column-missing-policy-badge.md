# Board "archived" column missing policy badge (visual inconsistency)

## Summary

*Resolved: 2026-05-17*

- **Problem**: Every Board column rendered a `manual` / `assist` / `auto` policy badge except `archived` (terminal column), creating visual asymmetry in an otherwise deliberately-styled Control Room grid. Root cause: `policyForExit('archived', ...)` returned `null` because `nextColumn('archived')` returned `null` (terminal column has no forward transition per `FORWARD_MAP.archived = null` in `src/ui/views/board_validate.ts:32`); the render gate at `board.ts:93` (`policy ? policyBadge(policy) : ''`) then dropped the badge entirely.
- **Resolution**: Surface the engine's terminal-column semantics at the UI layer as a 4th badge variant. Widened `policyBadge`'s parameter type and `policyForExit`'s return type with `'final'`; changed the `if (!next) return null` terminal branch to `if (!next) return 'final'`. Added `.badge.final { color: var(--mute); }` CSS rule in `src/ui/app.css` — single line, `--mute` is the Phase 19 design system's "softer text" tone (`#a39988`), visually de-emphasized to read as "terminal state" without competing with the active `manual|assist|auto` colors. Adversarial review caught a width-fit concern with the original proposed value `'terminal'` (8 chars rendered ~25-75% wider than the other badges in monospace + uppercase + 0.12em letter-spacing); renamed to `'final'` (5 chars, fits between AUTO and MANUAL/ASSIST widths) per the review's LOW-severity revision. The render call site at `board.ts:92-93` stays unchanged — the existing ternary is now defensive (the `null` branch is unreachable for the current 7-column set after this change, but preserved as a guard against future column-shape additions).

## Files Modified

- **`src/ui/views/board.ts`** (+5 / -2 lines) — widened `policyBadge` parameter type (`'manual' | 'assist' | 'auto'` → `'manual' | 'assist' | 'auto' | 'final'`) and `policyForExit` return type (added `'final'` to the union, kept `null` defensively). Changed the terminal-column return from `null` to `'final'`. Added a two-line Phase 26.2 comment documenting the terminal-branch behavior.
- **`src/ui/app.css`** (+1 / -0 lines) — appended `.badge.final  { color: var(--mute); }` after the existing three badge variants at line 389.

## Verification

- **`npm test`** — 743/743 pass (suite unchanged from Phase 26.1 baseline; no tests added for this XS step per plan). The pre-existing parallel-runner flake on `tests/conductor/loop.test.ts > Daemon shutdown stops the conductor brain` passed in the run.
- **`npm run typecheck`** — clean (engine + UI configs). Widened union types compile without affecting any call site.
- **`npm run build`** — clean. `dist/ui/app.css` includes the new `.badge.final` rule; `dist/ui/views/board.js` includes the runtime change (string literal `'final'` instead of `null` in the terminal branch).
- Manual smoke deferred to operator's next UI inspection — open Board, confirm column `U archived` renders `<span class="badge final">final</span>` (uppercase `FINAL` due to base `.badge` text-transform) in `var(--mute)` gray, visually aligned with the other six column badges at comparable width.

## Caveats

- **`policyForExit`/`policyBadge` remain file-local and untested.** Both helpers are private to `src/ui/views/board.ts`; the badge-render branch has no automated coverage. The Phase 5 end-to-end integration test (`tests/integration/phase5-ui-end-to-end.test.ts`) exercises Board rendering but doesn't assert badge HTML. Adding unit tests would require either exporting the helpers (smell for test-only) or extracting them to a separate testable module (overkill for XS scope). Acknowledged as out-of-scope; if a future operator wants helper-extraction-for-testability, file as a new issue.
- **`'final'` chosen over `'terminal'` for width-fit, not engine-vocab alignment.** The engine has `TerminalColumn: Column = 'archived'` (`src/engine/lifecycle.ts:11`); naming the badge variant `'terminal'` would have aligned with that constant. The Adversarial Review's LOW-1 width analysis (monospace + uppercase + 0.12em letter-spacing makes badge width scale linearly with character count) preferred the shorter `'final'` (5 chars, `FINAL` ≈ 34-38px rendered) over `'terminal'` (8 chars, `TERMINAL` ≈ 52-58px — would have introduced a new asymmetry in the opposite direction). The engine constant isn't surfaced to the UI bundle so the naming divergence is harmless.
- **The `null` return branch in `policyForExit` is now unreachable for the current 7-column set.** Preserved as a defensive guard against future column-shape additions where a non-terminal-yet-no-forward column might want to suppress the badge (the render-site ternary at line 93 still handles `null` correctly). Marginal; could be removed in a future cleanup with no behavioral impact.
- **Pattern precedent: no new pattern advanced.** This is a localized cosmetic fix within an existing established pattern (`.badge.*` CSS variants from Phase 19 Control Room redesign). No n-count increments to pure-helper-extraction (still n=15) or shared-module-for-cross-feature-consumption (still n=4).

## Relay Phase 16 status

Closes Relay Phase 16 #36 (P3, XS). Phase 16 was bundled into Control Phase 26 (polish bundle); this resolves step **26.2**. Remaining Phase 26 steps: 26.3 (#37 edition-stamp), 26.4 (#38 favicon), 26.5 (#45 stream-label clipping).

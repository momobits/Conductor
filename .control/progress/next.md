# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-12T14:35:22Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action
Run `/relay-analyze .relay/issues/scan-bails-entirely-on-one-malformed-card.md` to begin step 9.2. The issue file already carries a step-9.1-resolved note pointing at the typed-error imports (`CardParseError` etc.) now available from `src/engine/state/card.js`; the analyze pass should fold those into the proposed approach.

## Notes for next session
Phase 9 step 9.2 is `scan` continues on per-card YAML failure. The typed-error pattern from 9.1 is the foundation:

- `import { CardParseError } from '../state/card.js'` and use `instanceof CardParseError` to differentiate per-file parse failures from unknown errors that should rethrow.
- The issue's proposed shape is `listCardsLenient(cardsDir): Promise<{ cards, errors }>` — choose between adding a lenient variant vs changing `listCards`'s return shape during `/relay-analyze`. The lenient variant is preferred per the issue (avoids breaking other callers: `src/conductor/loop.ts:209`, `src/rpc/methods.ts:77/111/200`, `src/engine/phase.ts:24-25`).
- Affected files: `src/engine/state/card.ts`, `src/engine/types.ts` (`Status` interface), `src/engine/ops/scan.ts`, `src/cli/commands/scan.ts`, `src/rpc/methods.ts` (scan path), `src/ui/views/*` (Board view check), plus tests.
- Sequential within Phase 9; do not branch — single branch per phase-1 relay-ordering rationale. After 9.2 lands, step 9.3 (`work` validates card before creating run dir) closes phase-9. Then `/phase-close` will tag `phase-9-malformed-yaml-error-surface-closed`.
- Verification: `npm run typecheck` first, then targeted `tests/engine/state/ tests/engine/ops/scan.test.ts tests/cli/scan.test.ts`, then full `npm test`. Notebook step is skipped per `relay-config.md § Notebook Setup`.
- One caveat for 9.2: the UI Board view at `src/ui/views/*` may need to render the new `errors` field on `Status`. Check during analyze; defer if it inflates scope (file a UI-polish companion).

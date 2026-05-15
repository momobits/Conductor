# Transition approval dialogs leak internal phase terminology to users

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P3 — visible text bug, internal jargon in user-facing copy.*

## Problem statement

Two approval dialogs surface internal Conductor phase numbers as user-facing text:

1. `src/ui/views/board_dnd.ts:77-78` — drag-drop assist dialog body:
   > "Assist transitions normally show a Task Agent recommendation. **Phase 5** surfaces the request without an LLM-driven recommendation; that lands in **Phase 6**."
2. `src/ui/views/card_detail.ts:30` — task-agent transition dialog body:
   > "The Task Agent halted at this gate. (**Phase 6** will surface a Conductor recommendation here.)"

We are now past those Control-side phases (Phase 21 starting, Phase 5/6 closed long ago). The text is also reader-hostile: a Control Room operator has no idea what "Phase 5" / "Phase 6" refer to.

## Current state

- `src/ui/views/board_dnd.ts:71-90` — `confirmTransition()` hand-writes the dialog body with the phase-number sentence inlined.
- `src/ui/views/card_detail.ts:24-41` — `showTransitionDialog()` same pattern.

## Impact

Confusing for first-time users; signals scaffold-grade copy to anyone evaluating the tool. The functional behavior is fine; only the prose is stale.

## Proposed direction

Rewrite both sentences in present-tense, no-internal-phase terms. E.g.:

- Assist: "An assist transition surfaces the move for your approval. The conductor will show a recommendation here once that capability is wired up."
- Manual: "A manual transition requires your explicit approval before the card advances."
- Task Agent halt: "The task agent halted at this gate. Approve to continue, cancel to halt."

Once rewritten, search the rest of `src/ui/**` for any other `Phase \d+` / `phase \d+` strings to catch siblings.

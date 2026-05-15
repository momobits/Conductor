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

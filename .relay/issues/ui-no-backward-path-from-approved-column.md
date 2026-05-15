# No backward UI path out of the `approved` column

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of forward / backward drag transitions.*
*Severity: P2 — workflow gap: accidental forward move into `approved` is irrecoverable via UI.*

## Problem statement

The lifecycle state machine (`src/engine/lifecycle.ts:22-26`) defines only three backward transitions:

```ts
const BACKWARD: ReadonlySet<string> = new Set([
  'planned->discovered',
  'building->approved',
  'verifying->building',
]);
```

`approved` has **no defined backward exit**. A card that has been advanced from `planned → approved` (often by an `assist` autonomy approval or by a click on **Approve** in the drag-drop dialog) cannot be returned to `planned` or `discovered` from the UI. The only paths forward from `approved` are `building` (which requires manual approval and downstream verify success) or nothing.

## Reproduction

1. Drag a card from `planned` → `approved` (assist policy, click **Approve**).
2. Try to drag it back to `planned`. UI fires the request; server returns `Invalid transition: approved → planned`.
3. Try `approved` → `discovered`. Same.
4. No CLI revert: `conductor transition <id> discovered` also fails with `Illegal transition`.

The only escapes are:
- Direct file edit of the card's frontmatter (bypasses Conductor's state machine).
- Move all the way forward through `building → verifying → shipped → archived` (irreversible work).

## Impact

- A user who accidentally over-clicks the dialog cannot undo without editing yaml frontmatter.
- The `assist` policy is designed for "you're shown the move and approve / cancel". The cancel side is fine; the *over-approve* side has no undo.
- Inconsistent with the other backward transitions (`planned→discovered`, `building→approved`, `verifying→building`) which DO exist — `approved→planned` is the only missing leg.

## Current state

- `src/engine/lifecycle.ts:13-32` — `FORWARD` defines all six forward moves; `BACKWARD` defines three. `canTransition` returns true only if the requested move is in one of those two sets.
- `src/ui/views/board_dnd.ts` — no client-side filtering; UI always offers the dialog and lets the server reject (see related issue [[ui-board-dnd-invalid-transition-uses-server-error-alert]]).

## Proposed direction

Add `'approved->planned'` to the `BACKWARD` set. Rationale: `planned → approved` is a low-stakes promotion ("looks good, agent can implement"); reverting to `planned` is the natural undo. No work has been performed at this stage — the build hasn't started — so the rollback is cheap.

```ts
const BACKWARD: ReadonlySet<string> = new Set([
  'planned->discovered',
  'approved->planned',     // ← add
  'building->approved',
  'verifying->building',
]);
```

Optional companion fix: also allow `shipped → verifying` for hot-revert of a regression caught after shipped (lower priority; ship is usually the explicit gate).

## Verification path

1. Drag a card `planned → approved`. Approve.
2. Drag back `approved → planned`. UI dialog → approve → server accepts. Card moves back.
3. Card body and frontmatter untouched apart from the column field.

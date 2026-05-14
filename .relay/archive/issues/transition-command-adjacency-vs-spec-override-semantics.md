> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/transition-command-adjacency-vs-spec-override-semantics.md). Bundled into Phase 15.1 docs PR.

# `conductor transition` rejects non-adjacent moves despite spec wording about human overrides

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T3-1*
*Severity: P3 — observation (spec/docs alignment)*

## Problem statement

The `conductor transition` CLI command is documented as the **human-controlled**
lifecycle move. The spec language around it suggests that a human override
should bypass autonomy gates — but the implementation rejects any non-adjacent
column jump (e.g., `approved → shipped`) with `Illegal transition: approved -> shipped`.

This is arguably the safer design and not a bug per se. But the spec wording
and the implementation differ enough that a user reading the spec expects
to be able to fast-forward a card with a single command, and is surprised
when they can't.

This is a spec/documentation alignment question, not a correctness defect.

## Current state

- `src/cli/commands/transition.ts:31-35` — `runTransition()` calls
  `canTransition(card.frontmatter.column, args.target)`. If false, throws
  `Illegal transition: ${from} -> ${to}`. The throw is unconditional —
  there is no `--force` flag and no human-override branch.
- `src/engine/lifecycle.ts:13-32` — the state machine. `FORWARD` allows
  exactly one step forward per column; `BACKWARD` allows three specific
  reverse moves (`planned→discovered`, `building→approved`,
  `verifying→building`). Any other transition returns false.
- `src/cli/commands/transition.ts:46-47` — the action handler also rejects
  unknown column names with `Unknown column: ${column}. Valid: ${COLUMNS.join(', ')}`.
- Spec / docs language (per dogfood notes): the `transition` command is
  presented as the human-override path, suggesting it should sit **outside**
  the autonomy gate machinery. But adjacency is enforced regardless of who
  invokes it.

The current behavior is safe: a developer who needs to jump multiple stages
runs `conductor transition` twice (or more). No data loss; no implicit
state change.

## Impact

- User-facing: a developer who tries `transition <card> shipped` from
  `approved` gets a rejection and may not realize they need two calls.
- Spec/implementation drift: any future reader of the spec who tries to
  rely on "human override" semantics is misled.
- No correctness or data-loss risk — the current design is defensible and
  arguably preferable.

## Proposed fix

This is a documentation/spec alignment question with two possible resolutions:

### Option A (preferred) — keep current behavior, fix the docs

Conductor's "human override" applies to **autonomy gates** (skipping the
`manual`/`assist` policy that blocks autonomous transitions), not to the
**adjacency rule** (which preserves the integrity of the lifecycle graph).
This is a defensible and safe stance.

- Update the spec wording so it clearly distinguishes: *"`conductor transition`
  bypasses autonomy policy gates but **not** lifecycle adjacency. To move a
  card across multiple stages, call `transition` once per step."*
- Update `conductor transition --help` to surface adjacency expectations.
- Document the adjacency table (forward column-by-column; three explicit
  backward moves) in the docs.

### Option B — add `--force` for multi-stage jumps

Add an opt-in flag to `transition` that bypasses `canTransition()`. Print
a warning so users know they crossed gates. This widens the blast radius
of `transition` and removes a safety check; not recommended unless there's
a concrete use case (e.g., importing legacy boards).

### Verification

- After landing Option A: re-read `conductor transition --help` and confirm
  it documents adjacency.
- Add a CLI integration test asserting that the help text mentions adjacency.

## Affected files

If Option A (recommended):
- `docs/operations.md` (or wherever the lifecycle is documented) — clarify
  the semantics of `transition` vs adjacency.
- `src/cli/commands/transition.ts` — extend the `.description(...)` text to
  mention adjacency.

If Option B (alternative):
- `src/cli/commands/transition.ts` — add `--force` flag, bypass
  `canTransition()` when set.
- `tests/cli/transition.test.ts` — coverage for forced moves.

---

## Analysis

*Analyzed: 2026-05-14*

### Validation
- Problem still exists at HEAD `3c7dc8f`: `src/cli/commands/transition.ts:31-35` throws `Illegal transition` unconditionally; `.description()` at line 44 reads `Manually transition a card. Columns: ...` with no adjacency mention. `docs/operations.md` has no manual-transition section.
- Approach (Option A — keep current behavior, fix docs + help text) still valid.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-14
*Rationale:* Bundled into the Phase 15.1 docs PR. See **primary item** [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated Implementation Plan, Adversarial Review, and Verification Report covering all 5 Phase 7 docs items.

### Approach
Option A from the issue. Two edits:
- `src/cli/commands/transition.ts:44` — extend `.description()` to mention adjacency.
- `docs/operations.md` — add a "Manual transitions and the adjacency rule" section.

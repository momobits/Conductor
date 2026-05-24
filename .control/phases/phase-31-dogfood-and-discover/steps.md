# Phase 31 Steps

- [ ] 31.1 — Kickoff dogfood + discover pass: run `/relay-scan` then `/relay-discover` against the post-Phase-30 codebase. Validate the empty issue backlog claim (no regressions from the +339-test sweep). Document any P1/P2 findings as Relay issues. Settle Phase 31 scope direction based on findings — either (a) fix-bundle phase, OR (b) new strategic brainstorm. Author scope into this README's "Why this phase exists" section + add 31.2+ steps to this file.
- [x] 31.2 — `/relay-auto` ephemeral-state-persistence (#63): persist in-memory pending-decisions + proposed-edits across daemon restart via on-disk JSON files under `.conductor/`. Extends `RuntimeStore` with `PendingDecisionRecord` + 4 new methods.
- [x] 31.3 — `/relay-auto` brain-loop-ui-rendering (#64): render `conductor-pending-decision`, `conductor-pending-decision-resolved`, `conductor-halt-loop-detected` SSE events in `card_detail.ts` and `monitor.ts`.

## Step detail

### 31.1 — Kickoff dogfood + discover pass

**Inputs:**
- The post-Phase-30 codebase (test suite at 1123/1123; +339 net tests across Phase 30; BIG-BANG SWITCH live)
- `.relay/relay-status.md` (should show 0 active issues, 0 active features after Phase 30 close)
- The 14 implementation docs in `.relay/implemented/` for the Phase 30 features (read for any documented v1 caveats that may surface as polish work)

**Inputs to consider for discovery:**
- The dual-driver-brain-loop-replacement impl doc Caveats section flags multiple deferred items: brain-loop UI rendering of pending-decision / halt-loop / lead-handed-off SSE events; pending-decision persistence across daemon restart; amend payload plumb-through; bridgeSpectrumToConductMode dead-code cleanup; step_resolver.ts orphaned-helper retention. These are NOT issues today (no operator pain reported) but they're known polish candidates.
- The Frame B Cohort A/B impl docs may flag UI-side caveats worth surfacing.
- Run `/relay-discover` to scan the codebase for anything not yet filed.

**Pipeline:** 31.1 is a docs/decision step (not a Relay-issue pipeline step). After 31.1 closes, 31.2+ may be Relay-issue-shaped steps OR new feature-brainstorm steps depending on what surfaces.

**Step-close commit:** `docs(31.1): dogfood + discover pass — <chosen direction>` (or `chore(31.1):` if the close-out includes a Phase 31 scope-decision rather than just docs).

### 31.2 — `/relay-auto` ephemeral-state-persistence (#63)

**Relay item:** `.relay/features/ephemeral-state-persistence.md` (items 1 + 8d from post-Phase-30 polish brainstorm)
**Pipeline:** analyze → plan → review → implement → verify → resolve (driven by `/relay-auto`)
**Step-close commit:** `docs(31.2): /relay-auto close out ephemeral-state-persistence (commits: <sha-list>)`

### 31.3 — `/relay-auto` brain-loop-ui-rendering (#64)

**Relay item:** `.relay/features/brain-loop-ui-rendering.md` (item 5 from post-Phase-30 polish brainstorm)
**Pipeline:** analyze → plan → review → implement → verify → resolve (driven by `/relay-auto`)
**Step-close commit:** `docs(31.3): /relay-auto close out brain-loop-ui-rendering (commits: <sha-list>)`

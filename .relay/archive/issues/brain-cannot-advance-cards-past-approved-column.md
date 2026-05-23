# Brain cannot advance cards past `approved` column — `defaultAgentFactory` has no step-tracking mechanism

*Created: 2026-05-23*
*Source: 2026-05-23 omniforge dogfood. Operator started the brain; card `2026-05-12-health-check-endpoint` advanced through `discovered → planned → approved`, then halted indefinitely. Log: `[halt] 2026-05-12-health-check-endpoint: unrecognized-error: 'approved' requires --step <id> (one step per call).`*
*Severity: P2 — real ceiling on brain autonomy; every card that reaches `approved` hits this halt forever. Brain visibly "stops working" from the operator's perspective; recovery requires reading source code OR asking out-of-band.*

> **Scope note (narrow):** this issue is bounded to the `--step` gap. The deeper architectural concern the operator surfaced ("brain has no meta-recovery layer; should LLM-reason about halts") is being explored separately via `/relay-brainstorm` for the `brain-meta-supervisor` feature. See `.relay/features/brain-meta-supervisor_brainstorm.md`. This issue ships the narrow fix; the brainstorm explores the deeper redesign.

## Problem statement

The autonomous brain (`Conductor` in `src/conductor/loop.ts`) loops through eligible cards and spawns a `TaskAgent` per card via `defaultAgentFactory`. The factory at lines 249-262 constructs `TaskAgent` WITHOUT a `step` arg:

```typescript
export function defaultAgentFactory(args: DefaultAgentFactoryArgs): AgentFactory {
  return (cardId: string) => {
    const agent = new TaskAgent({
      repo: args.repo,
      cardId,
      config: args.config,
      adapter: args.adapter,
      onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {
        args.runtime.addCost(cardId, { inputTokens, outputTokens, dollars });
      },
      // ← NO `step` field
    });
    return agent.run();
  };
}
```

The `TaskAgent.run()`'s `case 'approved':` (at `src/agent/task_agent.ts:162-176`) requires `this.step`:

```typescript
case 'approved': {
  if (!this.step) {
    yield await this.emit({
      kind: 'halt',
      cardId: this.cardId,
      reason: `'approved' requires --step <id> (one step per call).`,
      finalColumn: 'approved',
    });
    return;
  }
  // ... implement op runs with step ...
}
```

So **every card that the brain advances past `planned` halts indefinitely at `approved`**. The brain CAN walk:
- `discovered → planned` (analyze + plan)
- `planned → approved` (review)
- `building → verifying` (verify)
- `verifying → shipped` (notebook)
- `shipped → archived` (resolve)

But CANNOT walk:
- `approved → building` (implement, needs step)

The halt reason `'approved' requires --step <id> ...` doesn't match any case in `classifyHalt()` (per the operator log, it surfaces as `unrecognized-error`), so the existing halt-classification telemetry doesn't even tell the operator "this is a known design limitation" — it looks like a generic crash.

## Current state

`Conductor` halts and waits. No further action. The card stays in `approved` forever until the operator manually runs `conductor work <card-id> --step <stepId>` from the CLI.

The deeper architectural issue (broader than this narrow bug; see Open Questions): **there is no LLM-driven meta-recovery layer** on top of the deterministic state machine. When the brain halts for ANY reason — missing step arg, missing config, op error, transition gate without recommendation — it surfaces the halt to telemetry and stops. There's no supervisor that:
- Reads the halt reason + card state + recent run artifacts.
- Makes an LLM call to diagnose and recommend recovery.
- Either auto-executes the recommendation (e.g., "infer the next un-implemented step from `<runId>/plan.md` + git log") OR surfaces a typed `recommendation` event to the operator with rationale.

This makes the brain feel "static" in operator dogfood: it works when every column transition is mechanical, but the moment a state needs reasoning (which step is next? which transition gate should we approve when the recommendation is ambiguous?), it falls back to silent halt.

## Impact

**Operator-visible:**
- Brain looks broken. Logs show `[halt] ... unrecognized-error: ...` with a message that references CLI flags the operator wasn't using. Disconnect between "I started the brain" and "the brain is telling me to use `--step`" is jarring.
- Recovery requires reading Conductor source code OR asking out-of-band (e.g., the operator came to a separate Claude session to debug). The system doesn't self-explain.
- Every card hits this on its first `approved` transition. The brain cannot complete a single end-to-end card walk.

**Architectural:**
- The brain has no meta-recovery layer. It's a deterministic state machine with LLM ops at specific points (analyze, plan, review, etc.), but no LLM "supervisor" watching the loop itself. When the loop hits an edge case, it halts rather than reasons.
- This is the deeper issue the operator surfaced during the 2026-05-23 dogfood: "the brain seems very static, why couldn't an LLM call fix this, why did I have to come here to understand the issue. Shouldn't Conductor be dynamic enough to recommend what to do for this card to the user, or move it itself, maybe use the api layer of conductor to do what it needs to do."
- Frame B's UI work (Phase 30+) gives the OPERATOR per-op buttons + chat-driven authoring, which sidesteps this for human-driven flows. But the BRAIN as an autonomous loop doesn't get the same uplift.

## Reproduction

1. In any Conductor-init'd project (e.g., omniforge), create a card and put it through analyze + plan + review until it reaches `approved`. Easiest path: start the brain on a fresh card — it will autonomously advance `discovered → planned → approved` then halt at the bug.
2. Watch the brain telemetry log. Halt fires immediately on the first `iter <N>` against the card in `approved`.
3. Verify: card stays in `approved` indefinitely; `.conductor/runs/<latestRunId>/` has analyze.md + plan.md + review.md but no implement.md.

## Proposed direction

Teach the brain to compute the next step for an `approved` card. Three sub-options:

1. **Frontmatter `next_step: '1.1'` field** (simplest; introduces persistent state on the card). Brain reads it; passes to TaskAgent; bumps it after implement succeeds. Requires `CardFrontmatterSchema` extension + plan-op writing the initial value (or implement-op bumping post-success). Compat: existing cards default to `1.1`.
2. **Parse the plan substrate at runtime** (no schema change). Brain reads `<latestPlanRunId>/plan.md`, regex-matches `### <step-id>` headings, computes the set of step IDs. Walks git log for `feat(<phase>.<step>):` commit subjects to find already-implemented steps. Passes the next un-implemented step to TaskAgent. Cleaner long-term but more code (~50-80 lines of step-parsing + git-log inspection).
3. **Add `step?: string` to `AgentFactory`** + always start at `1.1` for `approved` (naive default). Lowest-effort; brittle for multi-step plans (would re-run step 1.1 forever if implement somehow doesn't bump the card to `building`). Useful as a stop-gap.

Recommend Option 2 (substrate parse + git log inspection). It needs no schema change, no manual frontmatter bookkeeping, and aligns with the Phase 28 substrate-first philosophy (the substrate IS the canonical store; the brain reads it). One option remains worth deferring to brainstorm-influenced revision: if the meta-supervisor brainstorm settles on a design that itself handles step-selection naturally, this narrow fix becomes unnecessary or shifts to "stub that the supervisor consumes." Re-check before /relay-plan binds an approach.

**Also includes the halt-classification fix**: `classifyHalt()` in `src/conductor/halt.ts` should learn the `'approved' requires --step` pattern so the halt surfaces as a typed `missing-step-arg` reason instead of `unrecognized-error`. ~5-line addition; should land regardless of which step-resolution sub-option ships.

## Open Questions

1. **Step-resolution preference**: which of the 3 narrow-fix sub-options does the operator prefer? Lean on (2) substrate parse, but waiting on `brain-meta-supervisor` brainstorm — if the supervisor lands first, this narrow fix simplifies to "supply step from supervisor's decision output" instead of having its own resolution logic.
2. **Step inference accuracy** (Option 2): how reliable is `feat(<phase>.<step>):` commit-subject regex matching? Commits may not follow the convention; squashed commits may bundle multiple steps; reverted commits may show un-reverted in the log. Worth surveying real dogfood git logs before committing.
3. **Interaction with meta-supervisor brainstorm**: if the brainstorm settles on a design where the supervisor handles step-selection as one of N halt-recovery cases, do we ship this narrow fix at all, or roll it into the supervisor feature? Determine after brainstorm reaches READY FOR DESIGN.

## Related

- `[[engine-ops-still-append-to-card-body]]` (archived; Phase 28) — established the substrate as canonical store, enabling Option 2's substrate-parse approach.
- `[[brain-meta-supervisor_brainstorm]]` (in flight) — the deeper architectural exploration this issue's narrow fix may be subsumed by. Re-check before /relay-plan binds this issue's approach.
- Phase 27.2 verify-fail-then-wedge halt dedup — partial precedent for halt-handling sophistication in the conductor loop.

## Severity rationale

P2, not P1: brain is still useful for the 5 transitions it handles cleanly; the operator can manually `conductor work --step` to push past `approved`; no data loss. But it IS a real ceiling on brain autonomy, hit on every card. Worth shipping as a narrow Phase 30 / 31 fix if the meta-supervisor brainstorm hasn't reached READY FOR DESIGN by then; otherwise roll into the supervisor feature.

---

## Analysis

*Analyzed: 2026-05-23*

### Validation

- **Problem still exists: YES**, at the cited line numbers (no drift).
  - `src/conductor/loop.ts:249-262` — `defaultAgentFactory` still constructs `TaskAgent` without a `step` arg. The `DefaultAgentFactoryArgs` interface (lines 242-247) has no step field.
  - `src/agent/task_agent.ts:168-177` — `case 'approved':` still requires `this.step` and emits the exact halt reason `'approved' requires --step <id> (one step per call).`
  - `src/conductor/halt.ts:26-35` — `PATTERNS` array has no entry matching `--step`, `requires step`, or `one step per call`. `classifyHalt('… requires --step <id> …')` returns `'unrecognized-error'` (default branch at line 41).
- **Proposed approach still valid: YES, with the substrate parse leaning confirmed.**
  - All infrastructure Option 2 needs already exists: `findLatestArtifactRunId(repo, cardId, op)` in `src/agent/run_artifact.ts:113-134` (returns `{runId, text}` for the latest run with a non-empty `<op>.md`); `simpleGit(repo).log({maxCount})` already used by `src/engine/ops/discover.ts:85`; plan substrate format is established (H3 step headings `### 1.1`, `### 1.2`, with WHAT/HOW/WHY/RISK/VERIFY/ROLLBACK fields per `src/engine/ops/plan.ts:39-51`).
  - Option 1 (frontmatter `next_step`) requires extending `CardFrontmatterSchema` (`.strict()` at `src/config/schema.ts:36`); broader blast radius (all fixture files in tests, RPC schema, UI render of frontmatter), and persistent state on the card that has to be bumped post-implement — adds a new write site. Rejected.
  - Option 3 (always default to `1.1`) re-runs step 1.1 forever if implement somehow doesn't bump the card to `building`. Rejected as a stop-gap not worth the test surface.
- **Closure-by-supersession path documented**: if Phase 22 feature #6 (`dual-driver-brain-loop-replacement`) lands first, the orchestrator-driven loop computes the next step naturally from substrate and this whole defaultAgentFactory path goes away. Phase 22 is 6+ sessions out — not a near-term concern. /relay-ordering.md keeps Phase 21 narrow.

### Root Cause

The brain's `defaultAgentFactory` at `src/conductor/loop.ts:249-262` was designed when `TaskAgent`'s `approved` column logic was being shaped — `case 'approved':` chose to require an explicit `--step` arg so the CLI's `conductor work --step 1.1` path could pass one step at a time (atomic implement = atomic commit, Control invariant). The brain factory was wired without that arg because no one decided what step the brain should pick. Result: a contract gap — the brain advances cards into `approved` but cannot advance them out. The halt reason text mentions a CLI flag (`--step`) the operator wasn't using, which is the secondary failure: the message was authored for the CLI caller, not the brain caller.

`classifyHalt()` doesn't recognize this halt reason because the catalog (`HALT_REASONS` in `src/conductor/halt.ts:7-16`) is closed-set and `PATTERNS` (lines 26-35) was last extended for cost/auth/budget reasons. The `--step` halt is a NEW class of halt (missing required input from the brain factory) that the catalog hasn't learned yet — surfaces as `unrecognized-error: <message>` which looks like a generic crash to the operator.

No deeper architectural issue: substrate is already canonical (Phase 28); reading the next step from plan.md aligns perfectly with the substrate-first philosophy.

### What This Means (User Impact)

**In plain terms:** The operator starts the autonomous brain, and the brain visibly works — cards march through analyze → plan → review and land in the `approved` column. Then the brain stops. The log shows an error message that mentions a CLI flag (`--step`) the operator never typed. The operator has to read source code OR ask out-of-band to understand that the brain can't pass `approved` without being told which step to implement. Every single card hits this on its first try.

**Scenario:** Operator dogfooding omniforge starts the brain at 14:00. A card `2026-05-12-health-check-endpoint` advances through `discovered → planned → approved` over ~3 LLM calls (analyze, plan, review). At iter 4, the brain picks the same card, spawns `defaultAgentFactory(cardId)`, the TaskAgent enters `case 'approved':`, sees `this.step` is undefined, emits a halt with reason `'approved' requires --step <id> (one step per call).`, and the conductor records:

```
[halt] 2026-05-12-health-check-endpoint: unrecognized-error: 'approved' requires --step <id> (one step per call).
```

The operator sees the message, thinks it's a crash, switches to a different Claude session to debug. The card sits in `approved` indefinitely. `.conductor/runs/<latestRunId>/` contains `analyze.md`, `plan.md`, `review.md` but NO `implement.md` — implement never ran.

**Before (current behavior):**
1. Brain advances `2026-05-12-health-check-endpoint` from `discovered → planned → approved` (3 iters).
2. Iter 4: brain picks the card again, factory builds TaskAgent without step.
3. TaskAgent halts with `--step` error; conductor surfaces as `unrecognized-error: 'approved' requires --step <id> ...`.
4. Card stays in `approved` forever. Operator has to read source to understand. Recovery requires `conductor work <id> --step 1.1` from CLI.

**After (with fix):**
1. Brain advances `2026-05-12-health-check-endpoint` from `discovered → planned → approved` (3 iters).
2. Iter 4: brain picks the card again. `defaultAgentFactory` reads `<latestPlanRunId>/plan.md`, regex-extracts `### 1.1`, `### 1.2`, … step IDs. Walks `git log` for `feat(<phase>.1.1):`, `feat(<phase>.1.2):` subjects already committed for this card's phase, takes the set difference, picks the lowest un-implemented step (default `1.1` if no commits and only one step). Passes `step: '1.1'` to TaskAgent.
3. TaskAgent runs `implement` op for step `1.1`, writes the diff + commits `feat(<phase>.1.1): <subject>`, advances card to `building`.
4. Operator sees telemetry of a clean advance. Brain keeps walking.
5. If anything DOES go wrong (no plan substrate; plan has no steps; git log unreadable), the halt surfaces as the new `missing-step-arg` typed reason instead of `unrecognized-error`, telling the operator "this is a known design limitation" rather than "the brain crashed."

### Blast Radius

**Files affected (with function names):**

- `src/conductor/loop.ts`
  - `defaultAgentFactory` (lines 249-262) — extended to resolve `step` from plan substrate + git log before constructing TaskAgent.
  - `DefaultAgentFactoryArgs` (lines 242-247) — unchanged (resolution is internal; no new public input).
  - NEW internal helper (or new module `src/conductor/step_resolver.ts`): `resolveNextStep(repo, cardId, phase): Promise<string | null>` — reads plan substrate, parses step IDs, walks git log, returns next un-implemented step ID OR null if cannot resolve.
- `src/conductor/halt.ts`
  - `HALT_REASONS` (line 7-16) — add `'missing-step-arg'`.
  - `PATTERNS` (line 26-35) — add `[/'approved' requires --step|requires --step <id>|one step per call/i, 'missing-step-arg']`.
- `tests/conductor/halt.test.ts` — new test for the missing-step-arg classification.
- `tests/adversarial/halt_redteam.test.ts` — optional red-team test extending the missing-step-arg pattern.
- `tests/conductor/loop.test.ts` — existing `defaultAgentFactory` test still passes (card-1 is `discovered` and walks to `planned`). New test: card in `approved` column with seeded plan substrate + commit log; brain advances to `building`.
- NEW: `tests/conductor/step_resolver.test.ts` — unit tests for the step parser + git-log inspection.

**Callers and consumers:**

- `defaultAgentFactory` is called from `src/rpc/methods.ts:331` (`conductor_start`). Behavior change is backward-compatible: cards in `discovered`/`planned`/`building`/`verifying`/`shipped`/`archived` columns don't touch the new path (TaskAgent doesn't read `this.step` outside `case 'approved':`).
- The new halt reason `missing-step-arg` is consumed downstream by:
  - `src/ui/views/monitor.ts` (brain telemetry render — already renders halt reasons as strings; no code change).
  - Phase 22 feature #8 (`dual-driver-halt-categories`) — future work; widening the catalog now is forward-compatible.

**Test coverage status:**

- `defaultAgentFactory` has 1 existing test (`tests/conductor/loop.test.ts:269-285`) — covers `discovered → planned` path only. New test needed for `approved → building`.
- `classifyHalt` has tests for all 7 existing reasons (`tests/conductor/halt.test.ts`) + adversarial red-team coverage (`tests/adversarial/halt_redteam.test.ts`) — the new pattern needs both.
- No test exercises the brain on an `approved`-column card today; this is the gap that allowed the bug to ship.

**Config interactions:**

- None. No config keys added. The step resolution algorithm is deterministic (substrate + git log).

**Cross-item interactions (active issues + features):**

- Phase 22 feature #6 (`dual-driver-brain-loop-replacement`) explicitly calls out THIS issue: "This feature is what FIXES the original `--step` halt that surfaced this whole brainstorm. … The narrow issue at `.relay/issues/brain-cannot-advance-cards-past-approved-column.md` becomes resolved-by-supersession when this ships." Phase 22 is 6+ sessions out per ordering. Our narrow fix interim-unsticks the brain; when Phase 22 #6 lands it deletes `defaultAgentFactory` entirely. No collision: both paths read the substrate the same way.
- Phase 22 feature #8 (`dual-driver-halt-categories`) widens the halt catalog further; our addition of `missing-step-arg` is a single-pattern, forward-compatible extension that #8 can subsume into its broader taxonomy.

**Past work regression risk:**

- `.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 28) established the substrate-first philosophy: plan substrate at `.conductor/runs/<runId>/plan.md`, read via `findLatestArtifactRunId`. Our fix builds ON this — no regression risk; we are extending the substrate read pattern from 6 op sites (analyze/plan/review/verify/notebook/implement) to a 7th caller (defaultAgentFactory).
- Phase 27.2 verify-fail-then-wedge halt dedup (`src/conductor/loop.ts:69-76` + `:101-115`) — our changes don't touch the wedge logic. The new halt reason flows through the same `classifyHalt` → `bus.publish({kind: 'conductor-halt', ...})` path. Existing dedup still applies.
- `defaultAgentFactory` was introduced in Phase 6 (per `docs/superpowers/plans/2026-05-08-phase-6-conductor-brain.md:1997-2012`). It has 1 test. Extending it is low-risk.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep only (no Serena MCP available in this environment)*

#### Findings

- **Target:** `.relay/features/dual-driver-brain-loop-replacement.md`
  - **Kind:** existing item
  - **Evidence:** strong (declared supersession of THIS issue at lines 14-15 of that feature file; replaces `defaultAgentFactory` directly)
  - **Why related:** This Phase 22 feature is the architectural replacement for `Conductor.runOneCard` + `defaultAgentFactory`. The feature file explicitly states our narrow fix becomes resolved-by-supersession when feature #6 ships. Both paths read plan substrate the same way; no conflict.
  - **Suggested handling:** keep narrow (Phase 22 is 6+ sessions out; near-term operator dogfood needs the unstick now)
- **Target:** `.relay/features/dual-driver-halt-categories.md`
  - **Kind:** existing item
  - **Evidence:** medium (shared root cause: halt catalog gaps; same file `src/conductor/halt.ts`)
  - **Why related:** Phase 22 feature #8 widens halt categorization broadly. Our `missing-step-arg` addition is a single-pattern extension forward-compatible with #8's broader taxonomy work.
  - **Suggested handling:** keep narrow (single pattern; doesn't preempt #8's broader rebalance)
- **Target:** `.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 28)
  - **Kind:** existing item (closed)
  - **Evidence:** strong (established `findLatestArtifactRunId` helper that Option 2 reuses; established substrate-first philosophy)
  - **Why related:** Our fix consumes Phase 28's `findLatestArtifactRunId(repo, cardId, 'plan')` directly. We're a downstream consumer, not a sibling.
  - **Suggested handling:** keep narrow (no new work to file; pattern continues)
- **Target:** `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` (Phase 6 — brain observability)
  - **Kind:** existing item (closed)
  - **Evidence:** weak (same subsystem `src/conductor/`; same telemetry surface as the operator-visible halt log)
  - **Why related:** Established the brain-log pattern that surfaces our halts. No code overlap.
  - **Suggested handling:** keep narrow
- **Target:** unfiled: `src/agent/task_agent.ts:168-177` — `case 'approved':` halt reason text refers to a CLI flag (`--step`) that the brain caller doesn't use
  - **Kind:** unfiled candidate
  - **Evidence:** medium (sibling-bug candidate in the same containing function; user-visible confusion)
  - **Why related:** The halt-message wording is authored for the CLI caller. With the brain now resolving step automatically, the message text could be updated to be caller-agnostic (e.g., "implement op requires a step id; brain factory did not provide one"). Lands naturally in scope with the step-resolution work because the halt should only fire on the genuine brain-factory failure path (no plan substrate, no parseable steps).
  - **Suggested handling:** group into current run (touch the same lines as the brain fix; one cohesive change)

#### Search Bounds

- Live codepath audit: complete (read `defaultAgentFactory`, `runOneCard`, `case 'approved':`, `classifyHalt`, plus first-order callers `rpc/methods.ts:conductor_start` + `cli/commands/work.ts`)
- Backlog codepath: complete (1 issue at `.relay/issues/`; 16 features at `.relay/features/`; 2 features cite the same files)
- Subsystem: complete (read all dual-driver features + Phase 28 implementation doc + Phase 6 brain plan)
- Archive: complete (44 archived issues + 5 archived features scanned; none touch `task_agent.ts:approved` case or `defaultAgentFactory`)
- Implementation: complete (37 implemented docs; only Phase 28 + Phase 6 directly relevant)
- Contract drift: complete (verified `--step`, `requires --step`, `one step per call` all resolve to the single halt site; no prose drift in `README.md` / docs/ / `.relay/` mentions the `--step` halt outside this issue file)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-23
*Rationale:* Per orchestrator brief and ordering rationale (`relay-ordering.md` Phase 21): the Phase 22 supersession path is real but 6+ sessions out — not a near-term grouping signal. The unfiled sibling (halt-message wording in `task_agent.ts:case 'approved':`) is part of the same per-step targets and lands inline. Phase 22 #6 (`dual-driver-brain-loop-replacement`) and #8 (`dual-driver-halt-categories`) are forward-compatible — both subsume the work cleanly when they ship; no rework needed.

### Approach

**Recommended (Option 2 — substrate parse + git log):**

1. **New module `src/conductor/step_resolver.ts`** exporting `async function resolveNextStep(args: { repo: string; cardId: string; phase: string }): Promise<string | null>`. Implementation:
   - Call `findLatestArtifactRunId(repo, cardId, 'plan')` (already exists in `src/agent/run_artifact.ts`). If `null`, return `null`.
   - Parse plan text for H3 step headings matching `/^###\s+(\d+(?:\.\d+)+)\b/m`. Collect ordered set of step IDs (e.g., `['1.1', '1.2', '1.3']`).
   - Walk `simpleGit(repo).log({ maxCount: 200 })` (pattern from `src/engine/ops/discover.ts:85`). Extract committed step IDs from subjects matching `/\b(?:feat|fix|test|docs|refactor|chore)\(([^.)]+)\.(\d+(?:\.\d+)+)\)/i` (capture phase + step). Filter by the requested phase to scope to this card's work.
   - Return the first step ID from the plan list NOT in the committed set. If all steps committed, return `null` (signals "all done" — caller will halt).
   - On any thrown error (git not initialized, plan unreadable), return `null` and let the caller surface the typed halt.
2. **Modify `defaultAgentFactory`** in `src/conductor/loop.ts:249-262`:
   - Inside the returned factory, `await readCard` for the card (we need column + phase). If column is `approved`, call `resolveNextStep({ repo, cardId, phase })`. If a step ID returns, pass to `TaskAgent` constructor as `step`. If `null`, build TaskAgent without step (existing path will halt with a clearer reason after step 3 below).
   - Other columns: unchanged — no step lookup needed.
   - Reasonable error handling: any throw from `resolveNextStep` is caught + swallowed; the original halt path still fires.
3. **Update halt reason text in `src/agent/task_agent.ts:173`**:
   - Change `'approved' requires --step <id> (one step per call).` to `'approved' requires a step id; resolveNextStep returned no candidate (no plan substrate, no parseable steps, or all steps already committed).`
   - Keep `requires --step` substring for backward-compat with the new classifyHalt pattern matching.
4. **Extend `src/conductor/halt.ts`**:
   - Add `'missing-step-arg'` to `HALT_REASONS`.
   - Add pattern `[/(?:requires --step|requires a step id|one step per call)/i, 'missing-step-arg']` to `PATTERNS`.
5. **Tests:**
   - `tests/conductor/step_resolver.test.ts` (new): unit tests for plan-only (no commits, returns first step), partial commits, all-committed (returns null), missing plan substrate (returns null), git not init (returns null), multi-phase plan (only filters this card's phase).
   - `tests/conductor/loop.test.ts`: extend `defaultAgentFactory` describe with a test for an `approved`-column card that walks to `building` via the resolver.
   - `tests/conductor/halt.test.ts`: add a test for `missing-step-arg` classification.
   - `tests/adversarial/halt_redteam.test.ts`: add a missing-step-arg red-team variant.

**Alternatives considered and rejected:**

- **Option 1 (frontmatter `next_step`)**: requires extending `CardFrontmatterSchema` (`.strict()`) at `src/config/schema.ts:36` AND adding a write site (plan op writes initial value or implement op bumps post-success). Broader blast radius (fixtures, RPC schema, UI render). Persistent state on cards we have to keep in sync. Worse alignment with Phase 28's substrate-as-canonical-store stance. Rejected.
- **Option 3 (always default `'1.1'`)**: too brittle. If implement runs but doesn't transition the card to `building` (e.g., due to a transition gate halt), brain re-spawns with step `'1.1'` and re-applies the same diff, which `applyDiffFile`'s create-but-exists guard will reject — wedge. Rejected.

**Open questions or decisions needed before implementation:**

- None. The plan substrate format is stable (per `src/engine/ops/plan.ts` SYSTEM_PROMPT). The git-log commit format `<type>(<phase>.<step>):` is enforced by `commitStep` in `src/engine/state/git.ts:46`. Both contracts are load-bearing and tested.

---

## Implementation Plan

*Generated: 2026-05-23*

### Step 1: New module — `src/conductor/step_resolver.ts`

**File**: `src/conductor/step_resolver.ts` (NEW; no existing file)

**Before** (current code):
```typescript
// (file does not exist)        // ← no step-resolution logic anywhere in src/conductor/
```

**After** (proposed change):
```typescript
// src/conductor/step_resolver.ts                                                   // ← new module: resolve the next implement step for an approved card
//
// Reads the latest plan substrate (.conductor/runs/<runId>/plan.md) for a card,   // ← documents the read sources: plan substrate + git log
// parses the H3 step headings (### 1.1, ### 1.2, ...), and subtracts the set of   // ← documents the subtraction algorithm
// step IDs already committed for this phase via `feat|fix|...(<phase>.<step>):`   // ← documents the commit-subject contract
// commit subjects. Returns the first un-committed step in plan order, or null     // ← documents the return contract
// when resolution is not possible (no plan, no steps, all done, git failure).     // ← lists the null cases
//
// Consumers: defaultAgentFactory in loop.ts uses this to populate the `step` arg  // ← documents the consumer
// on TaskAgent for cards in the `approved` column. Phase 28's substrate-first     // ← cites the philosophy
// substrate read pattern continues (findLatestArtifactRunId).

import { simpleGit } from 'simple-git';                                            // ← already used at src/engine/ops/discover.ts:85; same pattern
import { findLatestArtifactRunId } from '../agent/run_artifact.js';                // ← Phase 28.1 helper; returns {runId, text} for latest <op>.md

export interface ResolveNextStepArgs {                                             // ← struct args (project convention)
  repo: string;                                                                    // ← absolute repo path
  cardId: string;                                                                  // ← card frontmatter id
  phase: string;                                                                   // ← card frontmatter phase; scopes commit-log search
}

/** Parse plan markdown for atomic-step H3 headings.                               // ← documented separately so tests can target it
 *  The plan op's SYSTEM_PROMPT pins the format: "Number them 1.1, 1.2, etc."     // ← cites contract
 *  with one H3 per step. Captures the numeric dotted ID; rejects non-dotted IDs   // ← strict regex
 *  to avoid mis-capturing the "Resolved decisions from analysis" preamble. */
export function parsePlanSteps(planText: string): string[] {                       // ← exported for unit testing in isolation
  const ids: string[] = [];                                                        // ← ordered collector — plan order is canonical
  const re = /^###\s+(\d+(?:\.\d+)+)\b/gm;                                         // ← H3 anchored at line start; ID must contain a dot; m+g flags
  let match: RegExpExecArray | null;                                               // ← exec loop scaffold
  while ((match = re.exec(planText)) !== null) {                                   // ← iterate all matches in document order
    const id = match[1];                                                           // ← captured group is the step id
    if (id && !ids.includes(id)) ids.push(id);                                     // ← dedupe defensively (plan SHOULD be unique)
  }
  return ids;                                                                      // ← returns [] if no H3 dotted-ID heading found
}

/** Extract committed step IDs from recent commit subjects for a given phase.      // ← documented separately so tests can target it
 *  Commit format from src/engine/state/git.ts:46 — `<type>(<phase>.<step>): ...`. // ← cites contract
 *  Scopes by phase so unrelated commits in other phases don't poison the set.    // ← phase filter is load-bearing
 *  On any git error (not a repo, no commits yet), returns an empty Set so the    // ← graceful degradation
 *  resolver falls through to "pick the first plan step" rather than throwing. */
export async function committedStepsForPhase(repo: string, phase: string): Promise<Set<string>> {  // ← async because simple-git is async
  const set = new Set<string>();                                                   // ← collector
  try {                                                                            // ← bound failure mode
    const log = await simpleGit(repo).log({ maxCount: 200 });                      // ← same pattern as src/engine/ops/discover.ts:85
    const re = /\b(?:feat|fix|test|docs|refactor|chore)\(([^.)]+)\.(\d+(?:\.\d+)+)\):/i;  // ← matches commit-subject prefix; captures (phase, step)
    for (const c of log.all) {                                                     // ← simple-git returns DefaultLogFields[]; .message is subject + optionally body
      const m = re.exec(c.message);                                                // ← match the type(phase.step): prefix
      if (m && m[1] === phase) set.add(m[2]);                                      // ← only add when phase matches the requested one
    }
  } catch {                                                                        // ← simple-git throws on non-git dirs / detached HEAD with no commits
    /* no commits or not a git repo — empty set is the right answer */            // ← documented intentional swallow
  }
  return set;                                                                      // ← empty set means "no prior steps committed"
}

/** Discriminated return so defaultAgentFactory can emit a specific halt reason
 *  per failure mode. Issue 2 from Adversarial Review (operator-applied
 *  2026-05-23): the three "null" cases (no plan, unparseable plan, all
 *  committed) have different semantics and should surface as distinct halts. */
export type StepResolution =
  | { kind: 'resolved'; step: string }                                             // ← happy path
  | { kind: 'no-plan' }                                                            // ← no substrate
  | { kind: 'unparseable-plan' }                                                   // ← plan exists but no dotted-ID H3s
  | { kind: 'all-committed' };                                                     // ← plan steps all done

/** Resolve the next implement step for an approved card.                          // ← public entry point
 *  Returns a StepResolution discriminator so the caller can emit a specific      // ← contract
 *  halt reason per failure mode. */
export async function resolveNextStep(args: ResolveNextStepArgs): Promise<StepResolution> {  // ← discriminated union; async because substrate + git
  const { repo, cardId, phase } = args;                                            // ← destructure
  const found = await findLatestArtifactRunId(repo, cardId, 'plan');               // ← Phase 28.1 helper; returns {runId, text} or null
  if (!found) return { kind: 'no-plan' };                                          // ← typed: no plan substrate → cannot resolve
  const planSteps = parsePlanSteps(found.text);                                    // ← parse H3 dotted-ID headings
  if (planSteps.length === 0) return { kind: 'unparseable-plan' };                 // ← typed: plan present but no parseable steps
  const committed = await committedStepsForPhase(repo, phase);                     // ← walk recent git log; phase-scoped
  for (const id of planSteps) {                                                    // ← plan order is canonical
    if (!committed.has(id)) return { kind: 'resolved', step: id };                 // ← happy path: first un-committed step
  }
  return { kind: 'all-committed' };                                                // ← typed: all plan steps committed; brain should halt cleanly
}
```

**Why**: This is the load-bearing piece for Option 2 (substrate parse + git-log inspection). It encapsulates the resolution algorithm in one testable module, separate from `defaultAgentFactory`'s wiring concerns. Three exports: `parsePlanSteps` (pure, easy to unit-test) + `committedStepsForPhase` (async, isolated git interaction) + `resolveNextStep` (composes the two). Builds entirely on existing infrastructure — `findLatestArtifactRunId` from Phase 28.1, `simpleGit().log()` from Phase 6 discover op — no new dependencies.

**Risk**:
- `simpleGit(repo).log()` may throw on a freshly-init'd repo with zero commits. Wrapped in try/catch returning empty set.
- The commit-subject regex assumes the `<type>(<phase>.<step>):` format. If the operator merges commits with non-conforming subjects, those are silently ignored (correct: they don't represent a completed step in our taxonomy).
- Plan H3 regex requires dotted IDs (`\d+(?:\.\d+)+`) — won't capture `### 1` (single digit no dot). This matches the plan op's prompt (`Number them 1.1, 1.2, etc.`) and avoids accidentally capturing the "Resolved decisions from analysis" H3.

**Verify**:
- `npm run typecheck` clean.
- Step 5 adds unit tests; this step is the implementation.

**Rollback**: `git revert <commit-hash>` removes the new module. No other code depends on it yet at this step.

### Step 2: Wire resolver into `defaultAgentFactory`

**File**: `src/conductor/loop.ts` (function `defaultAgentFactory`, lines 249-262)

**Before** (current code):
```typescript
export function defaultAgentFactory(args: DefaultAgentFactoryArgs): AgentFactory {  // ← public factory; called from rpc/methods.ts:331
  return (cardId: string) => {                                                       // ← inner factory; called per-iteration by Conductor
    const agent = new TaskAgent({                                                    // ← builds TaskAgent
      repo: args.repo,                                                               // ← repo path
      cardId,                                                                        // ← card id from iter
      config: args.config,                                                           // ← project config
      adapter: args.adapter,                                                         // ← model adapter
      onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {                  // ← cost tracking callback
        args.runtime.addCost(cardId, { inputTokens, outputTokens, dollars });        // ← per-card cost accumulator
      },                                                                             // ← NO `step` field → this is the bug
    });
    return agent.run();                                                              // ← returns AsyncIterable<TaskEvent>
  };
}
```

**After** (proposed change):
```typescript
export function defaultAgentFactory(args: DefaultAgentFactoryArgs): AgentFactory {  // ← public factory; signature preserved (no new public input)
  return (cardId: string) => {                                                       // ← inner factory; still synchronous return of AsyncIterable
    // Phase 30 (item 53): resolve `step` for cards in the `approved` column by    // ← cites the phase + item for archaeology
    // reading the plan substrate + walking git log. Returns AsyncIterable so the  // ← documents the async wrapping
    // outer Conductor consumer keeps its current shape (iter-then-iterate).
    return (async function* runWithResolvedStep(): AsyncIterable<TaskEvent> {       // ← IIFE-style async generator: yields exactly the TaskAgent events
      let resolvedStep: string | undefined;                                          // ← optional; undefined for non-approved columns
      try {
        const card = await readCard(                                                 // ← read once to discover column + phase
          join(args.repo, '.conductor', 'cards', `${cardId}.md`),                    // ← canonical card path; mirrors task_agent.ts:70
        );
        if (card.frontmatter.column === 'approved') {                                // ← only resolve when needed; cheap fast-path for other columns
          const result = await resolveNextStep({                                     // ← discriminated StepResolution (Issue 2)
            repo: args.repo,                                                         // ← same repo
            cardId,                                                                  // ← same card
            phase: card.frontmatter.phase,                                           // ← phase-scoped so other phases' commits don't poison
          });
          if (result.kind === 'resolved') {                                          // ← happy path: pass step to TaskAgent
            resolvedStep = result.step;
          } else {                                                                   // ← detail in halt reason; emit synthetic halt + skip TaskAgent
            yield {
              kind: 'halt',
              cardId,
              reason:
                result.kind === 'no-plan'
                  ? `Brain cannot advance: card '${cardId}' is in 'approved' but has no plan substrate yet — run plan op (no implement step resolved).`
                  : result.kind === 'unparseable-plan'
                    ? `Brain cannot advance: card '${cardId}' plan substrate has no parseable step headings — re-run plan op (no implement step resolved).`
                    : `Brain cannot advance: card '${cardId}' has all plan steps already committed; manually transition the card or extend the plan (no implement step resolved).`,
              finalColumn: 'approved',
            };
            return;                                                                  // ← do NOT construct TaskAgent; halt directly
          }
        }
      } catch {                                                                      // ← any failure resolving (missing card, etc.) falls through
        /* swallow; TaskAgent halt path will surface the genuine issue */           // ← intentional: typed halt is more informative than a resolver throw
      }
      const agent = new TaskAgent({                                                  // ← unchanged construction shape
        repo: args.repo,                                                             // ← repo path
        cardId,                                                                      // ← card id
        config: args.config,                                                         // ← project config
        adapter: args.adapter,                                                       // ← model adapter
        step: resolvedStep,                                                          // ← NEW: brain-resolved step id; undefined for non-approved
        onAdapterUsage: ({ inputTokens, outputTokens, dollars }) => {                // ← cost tracking callback (unchanged)
          args.runtime.addCost(cardId, { inputTokens, outputTokens, dollars });      // ← per-card cost accumulator
        },
      });
      yield* agent.run();                                                            // ← delegate to TaskAgent's existing async generator
    })();                                                                            // ← invoke the generator immediately to satisfy AgentFactory's sync return
  };
}
```

Also add new import near top of file:

```typescript
import { resolveNextStep } from './step_resolver.js';                              // ← NEW: pulls in Step 1's module
```

**Why**: Wires the step resolver into the brain's per-iter card walk. Wraps the existing TaskAgent construction in an async generator so we can `await readCard` + `await resolveNextStep` BEFORE constructing TaskAgent. The `AgentFactory` type (`(cardId: string) => AsyncIterable<TaskEvent>`) is preserved because the IIFE returns an `AsyncIterable` synchronously; the awaits happen inside the generator before the first yield. No public API change.

**Risk**:
- `readCard` throws on missing card. The outer try/catch swallows it; TaskAgent's own `readCard` at task_agent.ts:73 will throw the same error and bubble it as an `error` event through the existing handler in `runOneCard:185-187`. Net behavior is unchanged for missing-card error path.
- Performance: one extra `readCard` per iter for the resolver + one `simpleGit().log()` for `approved`-column cards only. Existing iter cost is dominated by the LLM call; this overhead is negligible.

**Verify**:
- `npm run typecheck` clean.
- `npm test tests/conductor/loop.test.ts` — existing `defaultAgentFactory` test still passes (card-1 is in `discovered` column; the new `if (column === 'approved')` branch doesn't fire).
- Step 5 adds a new test exercising the `approved → building` path.

**Rollback**: `git revert <commit-hash>` reverts to the no-step factory. Brain returns to the old halt-forever-on-approved behavior; no data corruption.

### Step 3: Update halt reason text in `case 'approved':`

**File**: `src/agent/task_agent.ts` (lines 168-177)

**Before** (current code):
```typescript
case 'approved': {                                                                  // ← brain enters here for approved-column cards
  if (!this.step) {                                                                 // ← guards against missing step
    yield await this.emit({                                                          // ← emits the halt event
      kind: 'halt',                                                                   // ← halt event kind
      cardId: this.cardId,                                                            // ← card id
      reason: `'approved' requires --step <id> (one step per call).`,                 // ← message is CLI-flavored; misleading for brain caller
      finalColumn: 'approved',                                                        // ← column stays approved
    });
    return;                                                                           // ← bail out
  }
  // ... rest of approved case (implement op + transition gate) ...                  // ← unchanged downstream
```

**After** (proposed change):
```typescript
case 'approved': {                                                                  // ← brain enters here for approved-column cards
  if (!this.step) {                                                                 // ← guards against missing step (CLI no --step, or brain resolver returned null)
    yield await this.emit({                                                          // ← emits the halt event
      kind: 'halt',                                                                   // ← halt event kind
      cardId: this.cardId,                                                            // ← card id
      reason:                                                                         // ← reason text widened to cover both callers
        // Message wording: keeps "requires --step" for CLI users (back-compat) +    // ← documented design note for the regex matcher (Step 4)
        // adds the brain-resolver case so the operator understands which caller    // ← cites both callers
        // surfaced the halt. classifyHalt's missing-step-arg pattern (Step 4)      // ← cross-refs the pattern
        // matches the substring "requires --step" OR "no implement step".           // ← documents the regex shape
        `'approved' requires --step <id> (one step per call). ` +
        `Brain caller: no implement step resolved from plan substrate or git log.`,  // ← brain-specific suffix; only the brain path triggers this when resolver returns null
      finalColumn: 'approved',                                                        // ← column stays approved
    });
    return;                                                                           // ← bail out
  }
  // ... rest of approved case (implement op + transition gate) ...                  // ← unchanged downstream
```

**Why**: The halt message previously referred to a CLI flag (`--step`) the brain caller doesn't use. Widens the message to acknowledge both callers (CLI without --step OR brain resolver returning null). Critically retains the substring `requires --step` so the regex pattern in Step 4 (`/requires --step/`) matches both old-format CLI invocations AND the new combined message — keeps `classifyHalt` deterministic without a breaking change.

**Risk**:
- Existing tests that string-match on the old halt reason fragments could break. Grep confirms `'approved' requires --step` appears only at this site in `src/`. No test in `tests/` greps the literal string; the halt is observed via the `kind: 'halt'` event with `finalColumn: 'approved'` (assertion-shape, not message-substring).

**Verify**:
- `npm run typecheck` clean.
- `npm test` — no broken assertions on the literal old text (verified via grep below).

**Rollback**: `git revert <commit-hash>` restores the old single-sentence reason.

### Step 4: Extend `classifyHalt` with `missing-step-arg` pattern

**File**: `src/conductor/halt.ts` (`HALT_REASONS` lines 7-16; `PATTERNS` lines 26-35)

**Before** (current code):
```typescript
export const HALT_REASONS = [                                                      // ← const array of all halt reasons
  'adr-needed',                                                                    // ← spec § 9 catalog
  'blocker-no-hypothesis',                                                         // ← spec § 9 catalog
  'iteration-budget',                                                              // ← spec § 9 catalog
  'destructive-action',                                                            // ← spec § 9 catalog
  'confidence-below-threshold',                                                    // ← spec § 9 catalog
  'cost-ceiling',                                                                  // ← spec § 9 catalog
  'auth-needed',                                                                   // ← spec § 9 catalog
  'unrecognized-error',                                                            // ← fallback for un-classified
] as const;                                                                        // ← literal-type narrowing
// ... type alias + HaltEvent interface unchanged ...                              // ← documents lines we don't touch

const PATTERNS: Array<[RegExp, HaltReason]> = [                                   // ← regex-to-reason mapping
  [/\bADR\s+(needed|is required|required)\b/i, 'adr-needed'],                     // ← ADR variants
  [/\bnew ADR\b/i, 'adr-needed'],                                                  // ← additional ADR phrasing
  [/\b(DROP\s+TABLE|rm\s+-rf|force[- ]push|push\s+--force|TRUNCATE|DELETE\s+FROM)\b/i, 'destructive-action'],  // ← destructive ops
  [/(API_KEY|\bcredential\b|\bauthentication required\b|missing credential)/i, 'auth-needed'],  // ← auth issues
  [/\b(iteration budget|max iterations)\b/i, 'iteration-budget'],                  // ← budget
  [/\b(cost ceiling|per-card cost|per-day cost)\b/i, 'cost-ceiling'],              // ← cost
  [/\b(blocker without|no hypothesis|stuck without)\b/i, 'blocker-no-hypothesis'],  // ← blocker
  [/\bconfidence below\b/i, 'confidence-below-threshold'],                          // ← confidence
];
```

**After** (proposed change):
```typescript
export const HALT_REASONS = [                                                      // ← const array of all halt reasons
  'adr-needed',                                                                    // ← spec § 9 catalog
  'blocker-no-hypothesis',                                                         // ← spec § 9 catalog
  'iteration-budget',                                                              // ← spec § 9 catalog
  'destructive-action',                                                            // ← spec § 9 catalog
  'confidence-below-threshold',                                                    // ← spec § 9 catalog
  'cost-ceiling',                                                                  // ← spec § 9 catalog
  'auth-needed',                                                                   // ← spec § 9 catalog
  'missing-step-arg',                                                              // ← NEW: brain factory + implement op need a step id; resolver returned null
  'unrecognized-error',                                                            // ← fallback for un-classified (kept last; semantic ordering)
] as const;                                                                        // ← literal-type narrowing
// ... type alias + HaltEvent interface unchanged ...                              // ← documents lines we don't touch

const PATTERNS: Array<[RegExp, HaltReason]> = [                                   // ← regex-to-reason mapping
  [/\bADR\s+(needed|is required|required)\b/i, 'adr-needed'],                     // ← ADR variants
  [/\bnew ADR\b/i, 'adr-needed'],                                                  // ← additional ADR phrasing
  [/\b(DROP\s+TABLE|rm\s+-rf|force[- ]push|push\s+--force|TRUNCATE|DELETE\s+FROM)\b/i, 'destructive-action'],  // ← destructive ops
  [/(API_KEY|\bcredential\b|\bauthentication required\b|missing credential)/i, 'auth-needed'],  // ← auth issues
  [/\b(iteration budget|max iterations)\b/i, 'iteration-budget'],                  // ← budget
  [/\b(cost ceiling|per-card cost|per-day cost)\b/i, 'cost-ceiling'],              // ← cost
  [/\b(blocker without|no hypothesis|stuck without)\b/i, 'blocker-no-hypothesis'],  // ← blocker
  [/\bconfidence below\b/i, 'confidence-below-threshold'],                          // ← confidence
  [/(requires --step|one step per call|no implement step resolved)/i, 'missing-step-arg'],  // ← NEW: matches Step 3's widened halt reason text (covers both CLI + brain captions)
];
```

**Why**: The halt message previously surfaced as `unrecognized-error: ...` — looked like a crash. With the new reason `missing-step-arg`, operator-visible telemetry says "this is a known design limitation in the brain's step resolver" (after Phase 22 #6 ships and replaces this path, the reason is forward-compatible with the broader halt-categories taxonomy in Phase 22 #8). The pattern is anchored to substrings that exist ONLY in the widened halt message — won't false-positive on unrelated halts.

**Risk**:
- The `unrecognized-error` test at `tests/conductor/halt.test.ts:43` (`'some random failure mode we did not anticipate'`) — the new pattern doesn't match that string; test still passes.
- The pattern's `requires --step` substring matches both old and new wording (back-compat for any in-flight halt event still in a daemon process during upgrade).

**Verify**:
- `npm test tests/conductor/halt.test.ts` — existing tests still green; new test (Step 5) confirms classification.
- `npm test tests/adversarial/halt_redteam.test.ts` — existing red-team coverage still green.

**Rollback**: `git revert <commit-hash>` removes the new reason + pattern. Halts revert to `unrecognized-error` surface.

### Step 5: Tests — unit + integration + halt classification

**Files**: 3 new/modified test files

#### 5a: New `tests/conductor/step_resolver.test.ts` (NEW file)

```typescript
// tests/conductor/step_resolver.test.ts                                            // ← unit tests for the new module
import { describe, it, expect, beforeEach, afterEach } from 'vitest';               // ← vitest API (project convention)
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';                   // ← fs helpers
import { tmpdir } from 'node:os';                                                    // ← tmp dir
import { join } from 'node:path';                                                    // ← path helper
import { simpleGit } from 'simple-git';                                              // ← seed git history in tests
import { parsePlanSteps, committedStepsForPhase, resolveNextStep } from '../../src/conductor/step_resolver.js';  // ← module under test

let tmp: string;                                                                     // ← per-test tmp repo path
const CARD_ID = 'card-x';                                                            // ← stable id
const PLAN_RUN_ID = `20260523T000000-${CARD_ID}`;                                    // ← canonical YYYYMMDDTHHMMSS-<cardId>

async function seedPlanRun(repo: string, runId: string, planContent: string): Promise<void> {  // ← test fixture helper
  const dir = join(repo, '.conductor', 'runs', runId);                               // ← run dir
  await mkdir(dir, { recursive: true });                                              // ← create
  await writeFile(join(dir, 'events.jsonl'),                                          // ← listRuns requires events.jsonl
    '{"ts":"2026-05-23T00:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');   // ← seed marker event
  await writeFile(join(dir, 'plan.md'), planContent, 'utf8');                          // ← write plan substrate
}

async function initTmp(): Promise<void> {                                            // ← per-test setup
  tmp = await mkdtemp(join(tmpdir(), 'conductor-stepresolver-'));                     // ← create tmp
  const g = simpleGit(tmp);                                                            // ← init git so log() works
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });                  // ← cards dir
  await writeFile(join(tmp, 'seed.txt'), 'x', 'utf8');                                  // ← seed file so we can commit
  await g.add('.');
  await g.commit('init');
}
beforeEach(initTmp);
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('parsePlanSteps', () => {
  it('extracts dotted-ID H3 headings in plan order', () => {
    const plan = ['### Resolved decisions from analysis', '- foo', '', '### 1.1', 'WHAT: ...', '### 1.2', 'WHAT: ...', '### 1.10', 'WHAT: ...'].join('\n');
    expect(parsePlanSteps(plan)).toEqual(['1.1', '1.2', '1.10']);                       // ← plan order; numeric not lexicographic
  });
  it('ignores non-dotted IDs (Resolved decisions preamble)', () => {
    expect(parsePlanSteps('### Resolved decisions from analysis\n- foo')).toEqual([]);   // ← no dot → not a step
  });
  it('returns [] for empty / malformed input', () => {
    expect(parsePlanSteps('')).toEqual([]);
    expect(parsePlanSteps('# H1 only')).toEqual([]);
  });
});

describe('committedStepsForPhase', () => {
  it('returns set of step ids matching feat(<phase>.<step>): subjects', async () => {
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'a.txt'), 'a', 'utf8'); await g.add('.'); await g.commit('feat(30.1.1): one');
    await writeFile(join(tmp, 'b.txt'), 'b', 'utf8'); await g.add('.'); await g.commit('feat(30.1.2): two');
    await writeFile(join(tmp, 'c.txt'), 'c', 'utf8'); await g.add('.'); await g.commit('feat(other.1.1): unrelated phase');
    const set = await committedStepsForPhase(tmp, '30');                                // ← phase filter
    expect([...set].sort()).toEqual(['1.1', '1.2']);                                     // ← other-phase commit ignored
  });
  it('returns empty set on non-git dir', async () => {
    const noGit = await mkdtemp(join(tmpdir(), 'no-git-'));
    try { expect((await committedStepsForPhase(noGit, '30')).size).toBe(0); }
    finally { await rm(noGit, { recursive: true, force: true }); }
  });
});

describe('resolveNextStep', () => {
  it('returns {kind: "resolved", step} when no commits exist for the phase', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### 1.1\nWHAT: a\n### 1.2\nWHAT: b\n');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' })).toEqual({ kind: 'resolved', step: '1.1' });
  });
  it('returns {kind: "resolved", step} for first un-committed plan step (partial progress)', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### 1.1\n### 1.2\n### 1.3\n');
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'd.txt'), 'd', 'utf8'); await g.add('.'); await g.commit('feat(30.1.1): done');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' })).toEqual({ kind: 'resolved', step: '1.2' });
  });
  it('returns {kind: "all-committed"} when all plan steps committed', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### 1.1\n### 1.2\n');
    const g = simpleGit(tmp);
    await writeFile(join(tmp, 'e.txt'), 'e', 'utf8'); await g.add('.'); await g.commit('feat(30.1.1): a');
    await writeFile(join(tmp, 'f.txt'), 'f', 'utf8'); await g.add('.'); await g.commit('feat(30.1.2): b');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' })).toEqual({ kind: 'all-committed' });
  });
  it('returns {kind: "no-plan"} when no plan substrate exists', async () => {
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' })).toEqual({ kind: 'no-plan' });
  });
  it('returns {kind: "unparseable-plan"} when plan has no parseable steps', async () => {
    await seedPlanRun(tmp, PLAN_RUN_ID, '### Resolved decisions\n- nothing here\n');
    expect(await resolveNextStep({ repo: tmp, cardId: CARD_ID, phase: '30' })).toEqual({ kind: 'unparseable-plan' });
  });
});
```

#### 5b: Extend `tests/conductor/halt.test.ts`

Add new test:
```typescript
it('classifies missing-step-arg from brain-resolver halt reasons', () => {
  expect(classifyHalt("'approved' requires --step <id> (one step per call).")).toBe('missing-step-arg');
  expect(classifyHalt("'approved' requires --step <id> (one step per call). Brain caller: no implement step resolved from plan substrate or git log.")).toBe('missing-step-arg');
  expect(classifyHalt('no implement step resolved')).toBe('missing-step-arg');
});
```

#### 5c: Extend `tests/conductor/loop.test.ts` `defaultAgentFactory` describe

**Required import changes** (Issue 1 — explicit per Adversarial Review):
- Modify line 2 of tests/conductor/loop.test.ts:
  - BEFORE: `import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';`
  - AFTER:  `import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';`
- Add new import line:
  - `import { simpleGit } from 'simple-git';`
- Add new import line for the post-state assertion (Issue 4):
  - `import { readCard } from '../../src/engine/state/card.js';`

Add new test that seeds an approved-column card + plan substrate + drives the brain through `defaultAgentFactory`:
```typescript
it('resolves step from plan substrate for approved-column cards (brain advances past approved)', async () => {
  const repo = setupRepoWithOrdering(['card-x']);                                       // ← reuse helper
  // Override card column to 'approved' + seed plan substrate                          // ← fixture mutation
  const cardPath = join(repo, '.conductor', 'cards', 'card-x.md');
  const text = readFileSync(cardPath, 'utf8').replace('column: discovered', 'column: approved').replace('phase: phase-1', "phase: '30'");
  writeFileSync(cardPath, text, 'utf8');
  const runDir = join(repo, '.conductor', 'runs', '20260523T000000-card-x');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'events.jsonl'), '{"ts":"2026-05-23T00:00:00.000Z","kind":"op_start"}\n', 'utf8');
  writeFileSync(join(runDir, 'plan.md'), '### 1.1\nWHAT: x\n', 'utf8');
  // git init so committedStepsForPhase has something to read (no commits yet → empty set → returns first plan step)
  const g = simpleGit(repo); await g.init(); await g.addConfig('user.name', 't'); await g.addConfig('user.email', 't@e'); await g.add('.'); await g.commit('seed');
  const runtime = new InMemoryRuntime();
  const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto', transitions: { approved_to_building: 'auto' } } });
  const adapter = new MockAdapter([
    JSON.stringify({ step: '1.1', commit_type: 'feat', commit_subject: 'add y', files: [{ path: 'src/y.ts', action: 'create', content: 'export const y = 1;\n' }], notes: '' }),
  ]);
  const factory = defaultAgentFactory({ repo, config, runtime, adapter });
  const events: TaskEvent[] = [];
  for await (const ev of factory('card-x')) events.push(ev);
  // Brain successfully advanced past 'approved' — no halt with missing-step-arg semantics:
  expect(events.find((e) => e.kind === 'halt' && /requires --step|no implement step resolved/.test(e.reason ?? ''))).toBeUndefined();
  expect(events.find((e) => e.kind === 'op_complete' && e.operation === 'implement')).toBeDefined();
  // NEW positive assertion (Issue 4) — card column is 'building' after the auto-transition fired:
  const finalCard = await readCard(cardPath);
  expect(finalCard.frontmatter.column).toBe('building');
});
```

**Why**: 5a pins the resolver's plan parse + git-log subtraction + null fallthrough. 5b pins the classifyHalt extension. 5c is the integration test that exercises the full bug scenario — an `approved`-column card walking to `building` through `defaultAgentFactory` — which was the missing test (per analysis: "No test exercises the brain on an `approved`-column card today; this is the gap that allowed the bug to ship").

**Risk**:
- 5c depends on `MockAdapter` returning a single response for the implement op. The auto-transition from `approved → building` after `implement` runs in TaskAgent does NOT issue another LLM call (transition gate is policy-driven, not LLM-driven, so a single MockAdapter response covers it).
- Vitest timeouts default to 5s — these tests do trivial work; well within budget.

**Verify**: `npm test tests/conductor/` (runs all 3 files).

**Rollback**: `git revert <commit-hash>` removes the new tests. Coverage drops back to the pre-fix baseline.

### Plan revisions from review

Issues 1, 2, 4 from Adversarial Review applied 2026-05-23 per operator decision. Specifically: StepResolution discriminated union added (Step 1) — `resolveNextStep` now returns one of `{kind:'resolved', step}`, `{kind:'no-plan'}`, `{kind:'unparseable-plan'}`, `{kind:'all-committed'}` instead of `string | null`; defaultAgentFactory branches on the discriminator and emits three case-specific halt messages (Step 2) when resolution fails (skipping TaskAgent construction entirely for the typed-null cases); test imports + positive post-state assertion (`column: 'building'`) added (Step 5c).

## Test Changes

- **NEW**: `tests/conductor/step_resolver.test.ts` — 11 unit tests across `parsePlanSteps`, `committedStepsForPhase`, `resolveNextStep`.
- **MODIFIED**: `tests/conductor/halt.test.ts` — 1 new test for `missing-step-arg` classification.
- **MODIFIED**: `tests/conductor/loop.test.ts` — 1 new test in `defaultAgentFactory` describe for the approved-column happy path.
- **No changes**: `tests/adversarial/halt_redteam.test.ts` — existing coverage already adequate; adding a missing-step-arg adversarial case is optional and would be a single line. SKIPPED to keep blast radius bounded; revisit if /relay-review flags.

## Post-Implementation Checks

1. `npm run typecheck` — zero errors.
2. `npm test` — full suite green; expect baseline `772` → `~785` (+13 across 5a's 11 + 5b's 1 + 5c's 1).
3. `Grep "defaultAgentFactory" src/ tests/` — confirm the new wiring is the only mutation site.
4. `Grep "'approved' requires --step"` in `src/` — confirm only `src/agent/task_agent.ts:173` has the substring; no other site emits this literal.
5. Manual integration smoke (operator-driven, NOT part of CI): drop an approved-column card in a test repo with a seeded `<runId>/plan.md`, start the brain via `conductor_start` RPC, observe the brain advances to `building` and emits a successful implement op_complete event.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Resolver returns wrong step when plan-op writes a non-dotted ID (e.g., `### 1` instead of `### 1.1`) | Plan op's SYSTEM_PROMPT pins dotted IDs (`1.1, 1.2, etc.`); regex enforces dot; no plan-substrate emitted by the codebase has non-dotted IDs (verified via grep). Forward risk if SYSTEM_PROMPT changes — covered by `parsePlanSteps` test. |
| Squashed merge commits bundle multiple steps in one subject (`feat(30.1.1, 30.1.2): two-step combo`) | The phase-step regex captures the FIRST `<phase>.<step>` pair; subsequent step IDs in the same subject are missed. Resolver returns the SECOND step ID as "next" — re-runs it; implement op refuses to create over existing file (existing `applyDiffFile` guard at `src/engine/ops/implement.ts:80`). Operator sees a clean halt rather than corrupting state. Documented as a known limitation; not blocking. |
| Reverted commits leave their step IDs in `git log` so resolver considers them "done" | True for `git revert` (which adds a new revert commit but doesn't remove the original from log). Resolver only counts the ORIGINAL commit as "step done" — so a reverted step incorrectly classified as done. Operator workaround: re-commit the work or use `git reset --soft` before re-running. Documented as a known limitation; ALSO removed by Phase 22 #6's substrate-driven loop. |
| `defaultAgentFactory`'s wrapped async generator pattern (IIFE) is unfamiliar to other contributors | The pattern is documented inline with a clear comment block. Existing `runOneCard` in the same file already uses async generators via `for await (const ev of this.agentFactory(cardId))`; we are extending, not introducing, the async-iter shape. |
| Phase 22 supersession path: Phase 22 #6 will delete `defaultAgentFactory` entirely | Forward-compatible: the resolver module (`step_resolver.ts`) is independent of `defaultAgentFactory` and Phase 22 #6's orchestrator can import the same `resolveNextStep` helper (or supersede with its substrate-aware decide() call). Worst case Phase 22 deletes the resolver module too — small loss, well-tested code with no external dependencies. |
| New halt reason `missing-step-arg` might collide with Phase 22 #8's planned halt taxonomy | Phase 22 #8 is forward-compatible by design; our single-pattern addition can be subsumed cleanly. Re-check during /relay-review only if reviewer flags. |

## Rollback Plan

`git revert <actual-commit-hash>` — single rollback removes all four code-change steps (1, 2, 3, 4) AND the test additions (5a, 5b, 5c) since they will be committed atomically in one step (Phase 30.1). The change is pure code: no DB migrations, no config changes, no stored data format changes, no schema migrations. Pre-revert brain behavior (halt-forever-on-approved) returns immediately; operator can still drive cards via `conductor work <id> --step <id>` CLI.

Commit hash to fill in after implementation: `<pending>` (will be captured during /relay-resolve).

---

## Adversarial Review

*Reviewed: 2026-05-23*

### Source Verification

Re-read each target file at HEAD as part of this review:

- **`src/conductor/loop.ts:29`** — `export type AgentFactory = (cardId: string) => AsyncIterable<TaskEvent>;` confirmed. Plan's IIFE-returns-async-generator pattern satisfies this (async generator extends AsyncIterable).
- **`src/conductor/loop.ts:22`** — `readCard` is already imported via `import { readCard, writeCard, listCards } from '../engine/state/card.js';`. Plan needs no new import for readCard; only adds `import { resolveNextStep } from './step_resolver.js'`.
- **`src/conductor/loop.ts:249-262`** — `defaultAgentFactory` matches the plan's BEFORE block exactly. No drift.
- **`src/agent/task_agent.ts:168-177`** — `case 'approved':` halt block matches the plan's BEFORE block exactly. The halt reason string `'approved' requires --step <id> (one step per call).` is the only literal site (grep confirms).
- **`src/conductor/halt.ts:7-35`** — `HALT_REASONS` and `PATTERNS` arrays match the plan's BEFORE block exactly.
- **`tests/conductor/loop.test.ts:1-50`** — imports include `mkdtempSync, mkdirSync, writeFileSync` (line 2). Plan's 5c adds `readFileSync` and `simpleGit`; not yet imported.
- **`src/engine/ops/discover.ts:83-90`** — `simpleGit(repo).log({ maxCount: n })` pattern confirmed. `c.message` is the commit subject (single line per simple-git's DefaultLogFields). Plan's regex on `c.message` is correct.
- **`src/engine/lifecycle.ts:51-59`** — `transitionPolicy` reads `config.autonomy.transitions.approved_to_building`. Schema default at `src/config/schema.ts:55` is `'manual'`. Step 5c's test config sets `approved_to_building: 'auto'` correctly.
- **`src/agent/run_artifact.ts:113-134`** — `findLatestArtifactRunId` returns `{ runId, text } | null`. Plan's `step_resolver.ts` uses this shape correctly.
- **`src/engine/state/git.ts:33-49`** — `commitStep` does NOT check `isCleanTree`; only requires non-empty `files` and stages them via `git.add(files)`. Step 5c's test fixture works.

### Issues Found

**No CRITICAL issues found.** Three MEDIUM and one LOW issue raised below; all addressed with inline corrections to the plan.

---

#### Issue 1 — MEDIUM: Step 5c missing imports for `readFileSync` and `simpleGit`

**What's wrong**: The plan's Step 5c calls `readFileSync(cardPath, 'utf8')` and `simpleGit(repo)` but those imports are not yet present in `tests/conductor/loop.test.ts`. The plan's risk register acknowledges this ("Adds these imports to `loop.test.ts` if not already present"), but the BEFORE-the-imports state needs to be tracked precisely so the implementer doesn't miss it.

**Plan has** (loose imports note):
```typescript
// (loose, end-of-step) Adds these imports to `loop.test.ts` if not already present:  // ← informal — implementer may miss
//   import { readFileSync } from 'node:fs'                                             // ← needs to land
//   import { simpleGit } from 'simple-git'                                              // ← needs to land
```

**Should be** (explicit modification to loop.test.ts's import block):
```typescript
// Modify line 2 of tests/conductor/loop.test.ts:                                       // ← explicit line cite
// BEFORE: import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';             // ← current state
// AFTER:  import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';  // ← add readFileSync
// Add new import line near line 10 (alongside other simple-git imports if any):         // ← explicit placement
//   import { simpleGit } from 'simple-git';                                              // ← required for 5c's git seed
```

**Resolution**: Issue 1 applied inline below by re-stating the import diff. Trivial (1 line + 1 new import); no rework of the plan body.

---

#### Issue 2 — MEDIUM: `resolveNextStep` returns null doesn't differentiate "all done" vs "no plan"

**What's wrong**: The plan's `resolveNextStep` returns `null` in THREE scenarios that have different semantics:
1. No plan substrate exists → operator should run `/relay-plan` or wait for the brain's plan op.
2. Plan exists but has no parseable H3 dotted-ID headings → plan op output is malformed; needs re-plan.
3. All plan steps already committed → card is "done" with respect to implement; should transition to `building` (or be moved manually).

All three surface as the same halt with the same reason string. Operator can't tell which case fired without looking at substrate manually.

**Why it matters**: The whole point of the halt-classification fix is to give operator-visible signal. Conflating three cases under one reason text is a step backwards relative to that goal.

**Plan has** (Step 1's resolveNextStep):
```typescript
export async function resolveNextStep(args: ResolveNextStepArgs): Promise<string | null> {  // ← returns string | null
  const found = await findLatestArtifactRunId(repo, cardId, 'plan');                         // ← null case 1
  if (!found) return null;                                                                    // ← collapsed
  const planSteps = parsePlanSteps(found.text);                                                // ← parse
  if (planSteps.length === 0) return null;                                                     // ← null case 2 (collapsed with case 1)
  const committed = await committedStepsForPhase(repo, phase);                                 // ← walk log
  for (const id of planSteps) {                                                                // ← plan order
    if (!committed.has(id)) return id;                                                          // ← first un-committed
  }
  return null;                                                                                  // ← null case 3 (collapsed with cases 1, 2)
}
```

**Should be** (return a discriminated result so the caller can distinguish):

Step 1 update — change return shape:
```typescript
// Discriminated return so defaultAgentFactory can emit a specific halt reason.       // ← documents the design
export type StepResolution =
  | { kind: 'resolved'; step: string }                                                 // ← happy path
  | { kind: 'no-plan' }                                                                // ← no substrate
  | { kind: 'unparseable-plan' }                                                       // ← plan exists but no dotted-ID H3s
  | { kind: 'all-committed' };                                                         // ← plan steps all done

export async function resolveNextStep(args: ResolveNextStepArgs): Promise<StepResolution> {  // ← discriminated union
  const { repo, cardId, phase } = args;
  const found = await findLatestArtifactRunId(repo, cardId, 'plan');                   // ← Phase 28.1 helper
  if (!found) return { kind: 'no-plan' };                                              // ← typed null case 1
  const planSteps = parsePlanSteps(found.text);                                         // ← parse
  if (planSteps.length === 0) return { kind: 'unparseable-plan' };                     // ← typed null case 2
  const committed = await committedStepsForPhase(repo, phase);                          // ← walk log
  for (const id of planSteps) {
    if (!committed.has(id)) return { kind: 'resolved', step: id };                     // ← happy path
  }
  return { kind: 'all-committed' };                                                     // ← typed null case 3
}
```

Step 2 update — defaultAgentFactory branches on the discriminator AND constructs a more-informative halt when the resolver couldn't resolve:

```typescript
// Inside the IIFE in defaultAgentFactory:
if (card.frontmatter.column === 'approved') {                                          // ← only resolve when needed
  const result = await resolveNextStep({                                                // ← discriminated result
    repo: args.repo,
    cardId,
    phase: card.frontmatter.phase,
  });
  if (result.kind === 'resolved') {                                                     // ← happy path
    resolvedStep = result.step;
  } else {                                                                              // ← detail in halt reason
    // Emit a synthetic halt event with the SPECIFIC reason BEFORE building TaskAgent.  // ← skip TaskAgent entirely
    // This gives operator-visible discrimination of the three failure modes.            // ← justification
    yield {
      kind: 'halt',
      cardId,
      reason:
        result.kind === 'no-plan'
          ? `Brain cannot advance: card '${cardId}' is in 'approved' but has no plan substrate yet — run plan op (no implement step resolved).`
          : result.kind === 'unparseable-plan'
            ? `Brain cannot advance: card '${cardId}' plan substrate has no parseable step headings — re-run plan op (no implement step resolved).`
            : `Brain cannot advance: card '${cardId}' has all plan steps already committed; manually transition the card or extend the plan (no implement step resolved).`,
      finalColumn: 'approved',
    };
    return;                                                                              // ← do NOT construct TaskAgent; halt directly
  }
}
```

All three halt reasons contain the substring `no implement step resolved` so Step 4's classifyHalt pattern matches them as `missing-step-arg`. The reason text now tells the operator which case fired without inspecting substrate.

**Resolution**: Issue 2 applied inline below — Step 1's StepResolution union and Step 2's branch logic re-stated. This is a NON-trivial change — it affects the return type, the caller, and the new test expectations (5a needs to assert on the discriminator kind, not null). Per the orchestrator-pause trigger #2 ("APPROVED-WITH-CHANGES with non-trivial edits → return paused-for-user"), this is borderline. However, the change is mechanically simple, fully covered by the existing test plan (just update assertions), and is the right design — the alternative is a worse user experience that conflicts with the issue's stated goal. Applying inline as APPROVED-WITH-CHANGES, with the change documented prominently below.

---

#### Issue 3 — MEDIUM: Phase parsing — `phase: 'phase-1'` test fixtures vs `phase: '30'` resolver expectation

**What's wrong**: The plan's resolver builds `committedStepsForPhase(repo, '30')` by reading `card.frontmatter.phase` and the commit regex captures `<phase>.<step>` greedy by `[^.)]+`. But the project's fixtures (e.g., `tests/conductor/loop.test.ts:36`) use `phase: phase-1`. The card frontmatter passes through Zod `z.string().default('unassigned')` (`src/config/schema.ts:25`) — anything is permitted. So if a card has `phase: 'phase-1'` and a commit subject `feat(phase-1.1.1): foo`, the regex `\b(?:feat|...)\(([^.)]+)\.(\d+(?:\.\d+)+)\):/i` captures `phase-1` as group 1 and `1.1` as group 2 — works. But if a card has `phase: 'phase-1a'` (a sub-phase, per `relay-config.md` "Phase ordinal vs short name in commitStep"), commit subjects may be `feat(phase-1a.1.1): foo` and the regex still works. Good.

Real issue: the resolver runs `committedStepsForPhase(repo, card.frontmatter.phase)`. If the card's `phase` field is `'unassigned'` (the schema default), commit subjects with `feat(unassigned.1.1):` are unlikely to exist — resolver returns empty set, picks first plan step. That's the desired behavior (start from step 1.1 if there's no phase context).

Verified: NO drift. Plan correct as-is.

**Resolution**: No change needed; raising the issue for completeness — re-read confirmed plan handles phase variants correctly.

---

#### Issue 4 — LOW: Step 5c test relies on auto-transition writing the card column

**What's wrong**: Step 5c's test config sets `autonomy.default: 'auto'` AND `transitions.approved_to_building: 'auto'`. When the TaskAgent's `case 'approved':` succeeds at implement, its `transitionWithGate(cardPath, 'approved', 'building')` runs and (auto branch) writes the card column itself via `writeCard`. So after the test, the card's frontmatter `column` is `'building'`.

But — the test calls `factory('card-x')` directly, NOT through Conductor. The auto-transition path in TaskAgent (`task_agent.ts:293-299`) writes the card; it does NOT go through `runOneCard`'s conduct() flow. The test SHOULD assert post-state on `column: 'building'` (or at least that no halt with missing-step-arg fired) to confirm the full path worked.

**Plan has** (Step 5c assertion):
```typescript
// Brain successfully advanced past 'approved' — no halt with missing-step-arg semantics: // ← negative assertion only
expect(events.find((e) => e.kind === 'halt' && /requires --step|no implement step resolved/.test(e.reason ?? ''))).toBeUndefined();
expect(events.find((e) => e.kind === 'op_complete' && e.operation === 'implement')).toBeDefined();
```

**Should be** (add a positive post-state assertion for the column write):
```typescript
// Same negative + positive op_complete:                                                  // ← unchanged from plan
expect(events.find((e) => e.kind === 'halt' && /requires --step|no implement step resolved/.test(e.reason ?? ''))).toBeUndefined();
expect(events.find((e) => e.kind === 'op_complete' && e.operation === 'implement')).toBeDefined();
// NEW positive assertion — the card column should be 'building' after the auto-transition: // ← confirms transitionWithGate ran the writeCard
const finalCard = await readCard(cardPath);                                                // ← re-read after the run
expect(finalCard.frontmatter.column).toBe('building');                                     // ← happy-path post-state pin
```

Requires importing `readCard` from `../../src/engine/state/card.js` in `loop.test.ts`.

**Resolution**: Issue 4 applied inline — Step 5c gains one positive assertion plus one import.

### Edge Cases to Handle

(Per `.relay/relay-config.md` § Edge Cases, applied to this plan.)

- **Provider adapters lazy-instantiated**: not affected — step_resolver.ts has no provider imports.
- **`tracker.kind: 'none'`**: not affected — no tracker code touched.
- **Cost-ceiling `halt_on_breach: false`**: not affected — cost guard not touched.
- **`autonomy.transitions.*` policy** (`manual` / `assist` / `auto`): the new code only runs when card.column === 'approved'; the policy reading happens DOWNSTREAM in TaskAgent.transitionWithGate. All three modes exercised by existing TaskAgent tests; new code doesn't bypass them.
- **MOCK adapter for tests**: step_resolver.ts doesn't touch adapters; test fixtures use MockAdapter only for implement op. OK.
- **Card frontmatter strict schema**: NOT extended — Option 2 was chosen specifically to avoid this. Confirmed via plan; no risk.
- **ProjectConfigSchema strict**: not extended.
- **Card id regex / phase ordinal vs short name**: phase ordinal handled — the regex `[^.)]+` captures phase including dashes (`phase-1a`); test 5a's `feat(30.1.1):` matches.
- **Verify command default**: not affected.
- **Conductor loop one card at a time**: preserved — the resolver runs per-iter, not concurrently.
- **Chokidar polling**: not affected — no filesystem watchers touched.
- **Daemon SSE event bus fan-out**: the new halt event from Step 2 (Issue 2 fix) publishes BEFORE returning from the generator — publish-before-yield invariant maintained (the yield IS the publish point for events in this flow).
- **commitStep requires explicit file list**: not affected — implement op already complies (`filesToCommit = diff.files.map(...)`).
- **Markdown-fenced JSON from models**: not affected — no JSON parsing in step_resolver.ts.
- **Adapter env-var absence**: not affected.
- **`.conductor/auth.token` regen**: not affected.
- **Run-log retention `pruneRuns`**: ENTANGLEMENT — if the prune policy removes the latest plan run between iters, `findLatestArtifactRunId` returns null and the resolver halts with `no-plan` (typed). Acceptable; documented in Issue 2's resolution.
- **Card body sections accrete**: NOT affected — no body writes.
- **YAML date normalization**: not affected.
- **`readCard` throws typed errors**: Step 2's outer try/catch swallows them; falls through to TaskAgent's own readCard which will throw the same error. Net behavior unchanged for malformed-card path.
- **`listCardsLenient` vs `listCards`**: the resolver calls `readCard` (single card, not list). Not affected.
- **TaskAgent throw vs yield**: Step 2's IIFE catches the resolver throws; resolver returns typed result OR the catch swallows. TaskAgent's own throw on bad readCard still surfaces via the outer Conductor's try/catch in `runOneCard:192-194`.
- **`uncommittedSnapshot` buckets**: not affected — resolver only reads `git.log()`, not `status`.

**Specific edge cases evaluated for the plan**:

- **Plan H3 heading with non-dotted ID like `### 1`** → `parsePlanSteps` regex requires a dot (`\d+(?:\.\d+)+`) → not captured → if no other steps, returns `unparseable-plan`. Correct.
- **Plan H3 heading with 3-level ID like `### 1.2.3`** → regex `(?:\.\d+)+` matches → captures `1.2.3` → resolver returns it. Correct.
- **Commit subject with leading whitespace `  feat(30.1.1): foo`** → `\b(?:feat|...)` requires word boundary; commit subjects from `commitStep` never have leading whitespace → not a real case.
- **Commit subject with parens nested `feat(30.1.1): foo(bar)`** → regex `[^.)]+` stops at `.` or `)`; `feat(30.1.1):` matches cleanly; nested parens in description don't interfere. Correct.
- **Plan with H3 in fenced code block `\n\`\`\`\n### 1.1\n\`\`\`\n`** → regex `^###\s+` matches lines starting with `###`; doesn't distinguish code-fence membership. Plan op SYSTEM_PROMPT puts step headings at top-level, not in code blocks. Theoretical false-positive; not real in production. Acceptable; documented as a limitation if it ever fires (operator can repair the plan).
- **Concurrent brain iters racing the resolver** → Conductor's loop runs one card at a time (`relay-config.md` invariant); resolver is sequential per iter. Safe.
- **Plan substrate empty file `<runId>/plan.md` is 0 bytes** → `findLatestArtifactRunId` already treats empty text as "no artifact" (line 130: `if (text.trim().length === 0) continue;`) → iterates to next run. If no non-empty run found, returns null. Correct.
- **Git log with `--no-merges` filter / squash-and-merge** → `simpleGit.log()` defaults include all commits. Squash commits collapsing two steps into `feat(30.1.1): step 1.1` lose the `1.2` step ID; resolver returns `1.2` as "next" → implement op re-runs it. As documented in risks.

### Regression Risk

(Per workflow step 3, checked across `.relay/issues/`, `.relay/features/`, `.relay/archive/issues/`, `.relay/archive/features/`, `.relay/implemented/`.)

- **No archived issue or implemented item conflicts.** Specifically checked:
  - `.relay/implemented/engine-ops-still-append-to-card-body.md` (Phase 28) — established the substrate-first read pattern this plan EXTENDS. No conflict; we're adding a 7th consumer (defaultAgentFactory) of `findLatestArtifactRunId`. Phase 28's `appendSection`/`extractSection` deprecation status unchanged.
  - `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` (Phase 6) — established BrainLogWriter. We don't touch it; new halt reasons flow through existing telemetry. No conflict.
  - `.relay/archive/issues/ui-brain-fires-two-halts-19ms-apart-for-single-wedge-event.md` (Phase 27.2) — established wedge halt dedup at `src/conductor/loop.ts:69-76, 101-115`. The new halt from Step 2's IIFE flows through the conductor's existing halt handler at `runOneCard:180-184, 197-202`. `runOneCard`'s lastIterationHalted gating still works correctly because our halt is published via the existing path (not a side-channel publish).
  - `.relay/archive/issues/ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md` (Phase 13) — touches config schema. Plan does NOT modify any schema. No conflict.
  - **Phase 22 features (designed; not in flight):** `dual-driver-brain-loop-replacement.md` explicitly calls out THIS issue as resolved-by-supersession. Our narrow fix is forward-compatible — Phase 22 #6 deletes `defaultAgentFactory` entirely, but the new `step_resolver.ts` module is independent and could be either subsumed by the orchestrator's substrate-aware `decide()` call OR deleted alongside. No work has started on Phase 22 #6; no merge conflict.
- **Test breakage check:**
  - `tests/conductor/loop.test.ts:269-285` existing `defaultAgentFactory` test — uses card-1 in `discovered` column. Plan's Step 2 only adds the resolver call when `column === 'approved'`. Test still passes.
  - `tests/conductor/halt.test.ts:42-44` `unrecognized-error` test — uses `'some random failure mode we did not anticipate'` which doesn't match the new pattern. Test still passes.
  - `tests/adversarial/halt_redteam.test.ts` — checked; no test asserts on the literal `'approved' requires --step` substring or expects the halt to surface as `unrecognized-error`. New pattern doesn't false-positive on any adversarial input there.
  - `tests/adversarial/loop_redteam.test.ts` — checked; uses synthetic agent factories (not `defaultAgentFactory`). Plan's changes to `defaultAgentFactory` don't affect these tests. Safe.
  - `tests/engine/ops/implement.test.ts` — exercises `implement` directly; not affected by `defaultAgentFactory` changes. Plan doesn't touch implement.ts. Safe.
- **Backward-compat for CLI path:** `conductor work <id> --step 1.1` (CLI) goes through `src/cli/commands/work.ts:78` and bypasses `defaultAgentFactory` entirely (CLI builds TaskAgent directly with `opts.step`). Plan's changes don't touch this CLI path. CLI users see no behavior change.

### Verdict

**APPROVED WITH CHANGES**

The plan is fundamentally sound — Option 2 is the right choice; the substrate read + git-log subtraction approach is correct; the test plan is complete. Three changes applied inline:

1. **Issue 1 (MEDIUM)** — Step 5c imports made explicit.
2. **Issue 2 (MEDIUM)** — `resolveNextStep` returns a discriminated `StepResolution` union (4 variants); `defaultAgentFactory` emits a SPECIFIC halt reason per failure mode. Step 5a's tests update to assert on `{ kind: 'resolved'/'no-plan'/'unparseable-plan'/'all-committed' }`.
3. **Issue 4 (LOW)** — Step 5c gains a positive post-state assertion on `card.frontmatter.column === 'building'` after the run.

Plan body updated in-place below this Adversarial Review section: see the revised Step 1 (StepResolution union), Step 2 (discriminated branching + specific halt reasons), Step 5a (updated assertions), Step 5c (added imports + post-state assertion).

> **NOTE FOR THE ORCHESTRATOR**: Per the auto-mode brief's pause-trigger #2 ("APPROVED-WITH-CHANGES with non-trivial edits → return paused-for-user"), the auto-pipeline is pausing here. Issue 2 changes the resolver's return type from `string | null` to a 4-variant discriminated union AND adds per-variant halt-reason text — more than one line, and affects the public API of the new module. Issues 1 and 4 are trivial and would not trigger a pause on their own. The plan-body update has NOT been performed yet; this allows the user to review the proposed APPROVED-WITH-CHANGES delta before implementation begins. To resume: confirm or override the verdict, then run /relay-review again (idempotent on already-reviewed plans — it will detect the existing Adversarial Review block) OR proceed directly with implementation if the user wants to apply the changes from the inline "Should be" code in Issue 2.

---

## Implementation Deviations

*Implemented: 2026-05-23*

- **TypeScript strictness — `c.message` typed as optional**: simple-git's `DefaultLogFields.message` is `string | undefined` under strict TS. The plan's `for (const c of log.all) { const m = re.exec(c.message); ... }` produced TS2345. Mitigated inline by `const message: string = c.message ?? ''; if (!message) continue; const m = re.exec(message);` — preserves behavior (an undefined message yields no regex match, same as before) and satisfies strict mode. Same fix applied to the `m[2]` index access (also strictly `string | undefined`): wrapped in `if (m && m[1] === phase && m[2]) set.add(m[2]);`.

No other deviations. All other steps applied as specified in the revised plan.

---

## Verification Report

*Verified: 2026-05-23*

**Verdict: COMPLETE.**

- **Typecheck**: `npm run typecheck` — clean (both engine `tsconfig.json` and UI `tsconfig.ui.json`).
- **Targeted tests**: `npx vitest run tests/conductor/step_resolver.test.ts tests/conductor/halt.test.ts tests/conductor/loop.test.ts` — 29 tests passed (10 new in step_resolver.test.ts + 8 existing + 1 new in halt.test.ts + 9 existing + 1 new in loop.test.ts + existing loop tests).
- **Full suite**: `npm test` — 784 tests passed across 113 test files (baseline 772 → 784, +12 net new tests counting all describes; matches plan projection of +13 within rounding for the test-bookkeeping baseline drift since plan was authored).
- **No regressions**: every pre-existing test still green. The existing `defaultAgentFactory > walks discovered → planned` test passes because the new resolver only fires on `column === 'approved'`.
- **Spot checks**:
  - The new halt-reason variants (`Brain cannot advance: card '<id>' is in 'approved' but has no plan substrate yet — run plan op (no implement step resolved).` etc.) all classify as `missing-step-arg` via the new pattern (verified by halt.test.ts coverage of the substring `no implement step resolved`).
  - The CLI path (`conductor work <id> --step 1.1`) is unaffected: it bypasses `defaultAgentFactory` and builds `TaskAgent` directly.

No fix loop iterations required; the typecheck deviation was a single inline strictness fix surfaced and resolved on the first verify pass.

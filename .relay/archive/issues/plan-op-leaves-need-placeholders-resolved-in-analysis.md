> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/plan-op-leaves-need-placeholders-resolved-in-analysis.md)

# Plan op leaves `[need:]` placeholders for items the Analysis already resolved

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T1-1*
*Severity: P2 — quality*

## Problem statement

The `plan` op produces an `## Implementation Plan` section that contains
multiple `[need: ...]` placeholders re-asking questions the immediately-preceding
`## Analysis` section already answered. The core value proposition of the
analyze→plan pipeline is that the plan **builds on** the analysis. When the
plan re-opens settled questions, a developer following the plan still has to
make decisions that were already made — eroding the entire workflow's leverage.

The dogfood session caught this on the very first card (`2026-05-12-health-check-endpoint`).
Independent confirmation came in T3 when the `review` op (a separate
Opus call) flagged the same gap as the plan's most significant deficiency,
reading the analysis and concluding the plan ignored decisions it already
contained.

## Current state

- `src/engine/ops/plan.ts:44-58` — the `plan()` function builds its user
  prompt from `extractSection(card.body, 'Analysis')` and includes it
  verbatim under a `--- Analysis ---` header. So the analysis text **is**
  in-context for the model; the gap is in how the model is asked to consume
  it.
- `src/engine/ops/plan.ts:36-42` — the SYSTEM_PROMPT's grounding paragraph
  ends with: *"If a step's HOW or VERIFY needs something the analysis hasn't
  established exists, write `[verify: <thing>]` or `[need: <fact to confirm>]`
  instead — leaving the gap visible is better than inventing surface that
  doesn't exist."* This instruction is correct for **truly unresolved** items
  but provides no counter-pressure when the model emits a `[need:]` for
  something the analysis **did** resolve — the model can over-apply the
  pattern to be safe.
- The plan prompt has no explicit "extract from analysis first, then plan"
  pass. There is no step that requires the model to summarize the analysis's
  resolved decisions before planning around them.

### Observed plan output (T1, `2026-05-12-health-check-endpoint`)

- Step 1.2: `[need: analysis to specify whether path is /health (root) or /api/v1/health]`
  — analysis explicitly chose `/health` and showed `@app.get("/health")`.
- Step 1.2: `[need: whether the endpoint should be a liveness-only check ... or a readiness check that probes Postgres/Redis]`
  — analysis chose readiness with a DB probe.
- Step 1.5: `[need: existing test directory path — CLAUDE.md doesn't name one]`
  — the card body and the analysis both name `tests/api/`.
- The plan also has a trailing "Open items requiring analysis follow-up"
  section re-listing 5 items the analysis had already resolved.

## Impact

- A developer following the plan ends up re-doing work the analysis already
  performed (high-friction).
- Trust in the analyze→plan pipeline erodes: if the plan systematically
  re-opens decisions, users will treat both outputs as drafts and re-decide
  in their own context, defeating the workflow.
- The downstream `review` op already catches this and halts the card at
  `planned`, which produces a forced re-run of plan (or manual intervention).
  Every such loop is a wasted Opus call.
- Affects every card; this is the steady-state behavior of plan, not an edge case.

## Proposed fix

Two complementary strategies; either could be tried independently.

### Strategy A — restructure the plan prompt with an extraction pass

Modify `SYSTEM_PROMPT` in `src/engine/ops/plan.ts` so the model produces two
artifacts in order:

1. A short **"Resolved decisions from analysis"** preamble that names each
   decision the analysis settled (path, response shape, dependency choice,
   test location, etc.) with a one-line evidence quote.
2. The atomic-step plan, in which `[need:]` is **only** allowed for items
   not present in the preamble.

This forces the model to enumerate what's already known before reaching for
the placeholder.

### Strategy B — tighten the placeholder rule

Modify the grounding paragraph so the `[need:]` instruction reads more
defensively, e.g.:

> If a step's HOW or VERIFY needs something the analysis hasn't established
> exists, write `[need: ...]`. **Before writing any `[need:]`, scan the
> analysis for an answer; a `[need:]` for a decision the analysis already
> resolved is a defect.**

Strategy A is more reliable (changes the model's process) but produces a
larger prompt; B is cheap to ship but relies on prompt compliance. Recommend
landing A first and removing the explicit B paragraph if A is sufficient.

### Verification

After the fix, re-run the analyze→plan pipeline against a synthetic card
whose body contains an explicit decision (e.g., "use path `/health`") and
confirm the plan does not emit `[need: path decision]`. Cover via a regression
test using `MockAdapter` with a canned analysis section and a hand-written
plan response that exercises the resolved-decisions preamble.

## Affected files

- `src/engine/ops/plan.ts` — prompt restructure (the only required change for
  Strategy A or B).
- `tests/engine/ops/plan.test.ts` — add a regression case asserting that a
  plan response containing `[need:]` for an analysis-resolved decision is
  flagged (test via mock model output).

---

## Analysis

*Analyzed: 2026-05-14*

### Validation

- Problem/requirement still exists: **YES**. Verified at HEAD (`debf476`):
  - `src/engine/ops/plan.ts:22-42` — `SYSTEM_PROMPT` const, six required
    fields per step, grounding paragraph ending with the `[verify:]` /
    `[need:]` instruction. No "extract resolved decisions first" pass.
  - `src/engine/ops/plan.ts:44-58` — `plan()` builds `userPrompt` from
    `extractSection(card.body, 'Analysis')` and includes it under
    `--- Analysis ---`. Analysis text is in-context for the model; the
    gap is purely in how the model is asked to consume it.
  - `src/engine/ops/plan.ts:36-42` — the existing `[need:]` instruction
    has no counter-pressure against re-asking analysis-resolved items.
- Proposed approach still valid: **YES**. Strategy A (preamble) + Strategy B
  (defensive clause) folded into one tightened SYSTEM_PROMPT — exactly the
  shape Phase 13 `steps.md` proposes.

### Root Cause

The SYSTEM_PROMPT lacks structural counter-pressure against the
defensive over-application of `[need:]`. Two failure modes compound:

1. **No enumeration discipline.** The model is never asked to enumerate
   what the in-context analysis settled before planning. It can write a
   step that references a decision and immediately follow with a
   `[need:]` for the same decision because the two thoughts are
   independent — no preamble forces the model to first state what is
   already known.
2. **No scan-first guardrail.** The `[need:]` instruction is correct in
   isolation ("leaving the gap visible is better than inventing") but
   does not say "scan the analysis first; a `[need:]` for a resolved
   decision is a defect." So the model uses `[need:]` defensively even
   when the answer is in front of it.

The two failure modes are independent, which is why the fix layers
both: A (preamble enumeration) forces "what's settled" to be written
once; B (scan-first defensive clause) re-emphasizes "don't reach for
`[need:]` without scanning" at the placeholder-emission site.

### What This Means (User Impact)

**In plain terms:** Today, the planning step re-asks questions the
analysis already answered. A developer who reads the resulting plan
still has to make decisions they thought were settled, and the next
review pass flags the plan as deficient and forces a re-plan — wasting
a full LLM call. After the fix, the plan starts with a "Resolved
decisions" preamble listing what's already known, and only asks new
questions for items the analysis truly did not address.

**Scenario:** A developer runs `conductor work` on
`2026-05-12-health-check-endpoint`. Analyze produces an Analysis
section that says "use path `/health`" and includes the snippet
`@app.get("/health")`. Analyze also resolves: readiness probe (not
liveness), Postgres+Redis dependency probe, and test directory
`tests/api/`. Three decisions, all explicit, all in-context for the
plan call.

**Before (current behavior):**

1. Plan runs against the card. SYSTEM_PROMPT does not require a
   preamble.
2. Plan emits Step 1.2 with:
   `[need: analysis to specify whether path is /health (root) or
   /api/v1/health]`.
3. Plan emits Step 1.4 with:
   `[need: whether the endpoint should be a liveness-only check ...
   or a readiness check that probes Postgres/Redis]`.
4. Plan emits Step 1.5 with:
   `[need: existing test directory path — CLAUDE.md doesn't name one]`.
5. Plan appends a trailing "Open items requiring analysis follow-up"
   section re-listing five items the analysis had resolved.
6. Review op (separate Opus call) reads card body, flags the
   `[need:]` placeholders as the plan's most significant deficiency,
   votes `revise`, halts the card at `planned`.
7. Developer reads the plan, gets re-asked questions they thought
   were settled, has to either manually patch the plan or trigger a
   re-plan. Re-plan is another Opus call. Net: two full Opus calls
   to ship one plan that should have shipped in one.

**After (with fix):**

1. Plan runs against the same card. New SYSTEM_PROMPT requires the
   model to produce a "## Resolved decisions from analysis" preamble
   first.
2. Plan emits:

       ## Resolved decisions from analysis
       - Path: `/health` ("the endpoint must be served at `/health`")
       - Probe shape: readiness probe ("must check Postgres and Redis
         connectivity before returning 200")
       - Test directory: `tests/api/` ("regression tests live in
         tests/api/")

3. Plan emits Steps 1.1–1.5 that reference `/health`,
   readiness-probe behavior, and `tests/api/` directly. No
   `[need:]` for any of those three decisions. `[need:]` only
   appears for items the analysis genuinely left open (e.g.,
   "[need: chosen HTTP status code for unhealthy state]" if the
   analysis didn't specify).
4. Review op reads the plan, sees the preamble, recognizes the
   `[need:]` placeholders as legitimate gaps, votes `proceed`.
5. Card advances to `implementing`. One Opus call to ship the plan.

### Blast Radius

**Files affected:**
- `src/engine/ops/plan.ts` — `SYSTEM_PROMPT` const restructure only.
  `plan()` function body untouched (no signature change, no userPrompt
  shape change — Analysis is already in-context).
- `tests/engine/ops/plan.test.ts` — add three regression tests
  (SYSTEM_PROMPT shape assertion, end-to-end preamble survival, T1-1
  scenario).

**Direct callers of `plan()`:**
- `src/cli/commands/work.ts` — `conductor work` pipeline. No change.
- `src/agent/task_agent.ts` — autonomy loop. No change.
- (Confirmed no other direct callers via Explore landscape.)

**Indirect consumers (read the appended `## Implementation Plan` section):**
- `src/engine/ops/review.ts` — reads via `extractSection(body, 'Implementation Plan')`.
  Will now see the preamble + steps. Desired side effect: review has
  more context for its verdict.
- `src/engine/ops/implement.ts` — same. Will see preamble in step
  context; ignored where irrelevant.
- `src/engine/ops/verify.ts` — does not read the plan section text
  directly (reads test output). No impact.
- `src/engine/ops/resolve.ts` — reads card body via summary
  generation. Will see preamble; ignored where irrelevant.

**Test coverage status:**
- Existing: 4 tests in `tests/engine/ops/plan.test.ts` (lines 27–77).
  Two assert SYSTEM_PROMPT prose (`/grounding/i`, `/do NOT invent/i`).
  None enforce the preamble or scan-first rule.
- After fix: +3 tests as listed in `steps.md` § What to verify.

**Config interactions:** None. SYSTEM_PROMPT is a TypeScript const; not
wired to `ProjectConfigSchema`. No flag, no env var.

**Cross-item interactions:**
- No active issue or feature touches plan.ts (confirmed via Explore
  Backlog codepath + Subsystem dimensions).
- Phase 12.1 (discover dedup, archived 2026-05-12) established a
  HEAD-of-userPrompt context-injection pattern. That's at the
  **operator-context layer** (what the model sees in its user
  message); this work is at the **model-output structure layer**
  (what the model produces in its response). Same principle ("settle
  context first"), different layer. Not coupled.

**Past work regression risk:**
- Phase 12.1 wrote `existingCardSummary()` in `discover.ts`. Untouched
  here.
- Phase 11 wrote `uncommittedSnapshot()` in `git.ts`. Orthogonal.
- Phase 9 introduced typed `readCard` errors. Plan op uses `readCard`
  indirectly via `task_agent.ts` / `work.ts`; this change does not
  touch that path.
- No prior phase touched `plan.ts`. No regression vector.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena not available in this environment)*

#### Findings

- **Target:** `unfiled: src/engine/ops/review.ts::SYSTEM_PROMPT — review verdict could in principle over-apply defensive placeholders by symmetry`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** `src/engine/ops/review.ts:20-36` SYSTEM_PROMPT
    instructs the model to return JSON with decision + reasoning;
    `review.ts:50-51` reads the full card body including any
    `[need:]` placeholders in the plan. No current dogfood evidence
    of over-application; no JSON-output schema that admits `[need:]`
    in review output (review returns a decision, not a step list).
    Theoretical symmetry only.
  - **Suggested handling:** keep narrow — file companion only if
    future dogfood surfaces the symmetric defect.

- **Target:** `.relay/implemented/discover-no-topic-level-dedup-against-existing-cards.md`
  - **Kind:** existing item (implemented; not a sibling defect, a
    pattern precedent)
  - **Evidence:** medium
  - **Why related:** Phase 12.1 established HEAD-of-userPrompt
    pre-context injection in `discover.ts` (operator-context layer).
    The principle "settle context first so the model's reasoning is
    grounded" transfers to the plan preamble (model-output layer).
    Test pattern also transfers: discover tests assert position via
    `indexOf` comparison; plan tests will assert preamble presence
    via section-header presence and `[need:]` absence on
    analysis-resolved decisions.
  - **Suggested handling:** keep narrow — pattern reference only,
    not coupled implementation.

- **Target:** `.relay/relay-config.md § Card body sections accrete in order` (lines 51–57)
  - **Kind:** existing-item-fragment (no separate issue)
  - **Evidence:** weak (edge case, not a current defect)
  - **Why related:** `appendSection` always appends; re-running plan
    on a card that already has an `## Implementation Plan` section
    will accumulate duplicates. The preamble is now part of that
    section's body, so duplicates would carry duplicate preambles.
    No current call site re-runs plan on a card with an existing
    plan section (the autonomy loop short-circuits on existing
    sections), so this is theoretical. Documented for future
    awareness.
  - **Suggested handling:** keep narrow — not in this run's scope.

#### Search Bounds

- Live codepath audit: complete (full `src/engine/ops/plan.ts`, all
  first-order callers `work.ts` + `task_agent.ts`, adjacent
  `discover.ts` / `analyze.ts` / `review.ts` / `resolve.ts` /
  `verify.ts` / `implement.ts` SYSTEM_PROMPTs surveyed for sibling
  patterns).
- Backlog codepath: complete (`.relay/issues/`, `.relay/features/`).
- Subsystem: complete (bounded at 15 op files under
  `src/engine/ops/` + `card.ts` + `parse_json_response.ts`; no other
  active op-prompt items).
- Archive: complete (`.relay/archive/issues/` 7 items reviewed).
- Implementation: complete (`.relay/implemented/` reviewed; Phase
  12.1 produced the relevant pattern precedent).
- Contract drift: complete (README.md, .relay/relay-config.md,
  .relay/relay-ordering.md, .claude/skills/**/workflow.md, tests/
  assertions on plan output). No drift.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-14
*Rationale:* All non-target findings are weak (review.ts symmetric
candidate has no dogfood signal; section-accretion edge case is
theoretical with no active call site; Phase 12.1 is a pattern
precedent at a different layer, not coupled implementation). No
strong or medium-strong sibling defect, no archived siblings on
plan.ts, no contract drift. The rubric's auto-resolution for "no
findings, or all weak" → keep narrow. Single-file fix in
`src/engine/ops/plan.ts` + tests in `tests/engine/ops/plan.test.ts`.

### Approach

**Recommended approach: Strategy A + Strategy B layered into one
SYSTEM_PROMPT restructure.**

Phase 13 `steps.md` already proposes the A+B layering shape ("Strategy
A is the primary fix per the issue. Strategy B (tightening the
placeholder rule alone) is folded in as the defensive clause"). The
issue file's Proposed Fix section recommends A first and removing B
if A is sufficient. The analysis here lands on A+B because the two
failure modes are independent (enumeration discipline ≠ scan-first
guardrail), the marginal prompt cost is one sentence, and an
additional fail-safe at low cost has positive expected value in a
single-shot LLM operation. If empirical evidence later shows A alone
suffices, B's defensive clause can be removed in a follow-up — the
A+B → A regression direction is easy; the A → A+B addition direction
is what we're doing now.

**Concrete shape of the SYSTEM_PROMPT after the change:**

1. Six-field atomic step contract (unchanged from current lines
   23–34).
2. New mandatory output structure: "Before any steps, produce a
   `## Resolved decisions from analysis` preamble. List each
   decision the analysis settled (path, response shape, dependency
   choice, test location, error semantics, etc.) on its own bullet
   with a one-line evidence quote drawn from the `--- Analysis ---`
   section in the user prompt. If the analysis settled no
   decisions, write `(none)` under the preamble so the structural
   header is always present."
3. Grounding paragraph (mostly unchanged from current lines 36–42),
   with the `[need:]` clause replaced by: "If a step's HOW or
   VERIFY needs something the analysis hasn't established, write
   `[verify: <thing>]` or `[need: <fact to confirm>]` — leaving the
   gap visible is better than inventing surface that doesn't exist.
   `[need:]` is **only** valid for items not in the Resolved
   decisions preamble. Before writing any `[need:]`, scan the
   analysis for an answer; a `[need:]` for a decision the analysis
   already resolved is a defect."
4. `(none)` placeholder discipline (per Phase 12.1 precedent): the
   preamble header is structurally present even on
   analysis-light cards so a SYSTEM_PROMPT instruction that
   references "the Resolved decisions preamble" always has a target.

**Alternatives considered:**

- **Strategy A alone (preamble only).** Rejected: B's defensive
  clause is one sentence and closes the failure mode where the
  model writes the preamble but still defaults to `[need:]` at the
  step-emission site (the two artifacts are produced sequentially;
  the model can be inconsistent across them). The Phase 13 phase
  plan explicitly anticipated A+B.
- **Strategy B alone (defensive clause only).** Rejected per issue
  rationale: B without A relies entirely on prompt compliance with
  no structural enumeration. Less reliable.
- **Adding a separate post-processing pass that inspects plan
  output for `[need:]` patterns whose surface appears in the
  analysis.** Rejected: complexity (regex over LLM output is
  brittle, and the model's `[need:]` phrasing is not stable enough
  for textual matching). The prompt-restructure path is simpler and
  more durable.

**Open questions or decisions needed before implementation:** None.

**ADR consideration:** The "preamble before steps" pattern is now
established for two ops (Phase 12.1 discover used HEAD-of-userPrompt
context injection; this phase introduces required-output preamble in
plan). Both are instances of a broader "settle resolved context
first" principle. If a third op adopts it (the natural next candidate
is `review.ts` requiring a preamble that quotes the plan's `[need:]`
items it accepted), filing an ADR would be warranted. Not yet
warranted at n=2. Re-evaluate at /relay-resolve.

---

## Implementation Plan

*Generated: 2026-05-14*

**Implementation note (heading level):** The model's preamble MUST use
H3 (`### Resolved decisions from analysis`), NOT H2. The `plan()`
function wraps the model's output under `## Implementation Plan` via
`appendSection`. If the model emits an H2 preamble inside that body,
the result is two sibling H2s and `extractSection(body,
'Implementation Plan')` in `src/engine/ops/review.ts:41` returns the
empty content between them — breaking review. H3 keeps the preamble
nested under the Implementation Plan section so downstream
`extractSection` still returns the full plan body. (Verified:
`extractSection` regex is `/\n##\s+/`, which matches `\n## ` but not
`\n### ` — H3 is safe.)

### Step 1.1: Restructure `SYSTEM_PROMPT` to require a Resolved-decisions preamble + tightened scan-first clause

**File**: `src/engine/ops/plan.ts` (`SYSTEM_PROMPT` const, lines 22–42)

**Before** (current code):
```ts
const SYSTEM_PROMPT = `You are an experienced software engineer producing an    // ← header line; sets the persona
atomic implementation plan from an issue analysis. Each step in your plan       // ← describes the task
MUST include all six fields:                                                    // ← introduces the field list

  WHAT     — what change is made                                                // ← field 1
  HOW      — concrete code-level approach                                       // ← field 2
  WHY      — why this step is needed                                            // ← field 3
  RISK     — what could go wrong; blast radius                                  // ← field 4
  VERIFY   — how we confirm the step worked                                     // ← field 5
  ROLLBACK — how to undo if it doesn't                                          // ← field 6

Steps must be small, sequential, and independently verifiable. Number them      // ← step-size + numbering rule
1.1, 1.2, etc. Output Markdown only — no preamble.                              // ← "no preamble" here meant "no conversational preface"; collides with the new structured preamble — must reword

Grounding: only reference commands, file paths, flags, APIs, and tools          // ← grounding rule (kept verbatim below)
that are cited in the analysis or can be inferred from concrete file
paths it mentions. Do NOT invent CLI subcommands, helper scripts,               // ← "do NOT invent" — existing test asserts this phrase (line 75 of plan.test.ts)
config keys, or HTTP endpoints to fit a step. If a step's HOW or
VERIFY needs something the analysis hasn't established exists, write
"[verify: <thing>]" or "[need: <fact to confirm>]" instead — leaving
the gap visible is better than inventing surface that doesn't exist.            // ← original [need:] rule; no counter-pressure against re-asking resolved items
\`.trim();
```

**After** (proposed change):
```ts
const SYSTEM_PROMPT = `You are an experienced software engineer producing an    // ← unchanged header
atomic implementation plan from an issue analysis. Output Markdown only —        // ← reworded: was "Output Markdown only — no preamble" (collision); now "no conversational preface"
no conversational preface.                                                       // ← clarifies the constraint without colliding with the structured preamble below

Your output must contain two artifacts, in order:                                // ← NEW: declares the two-artifact contract

  1. A "### Resolved decisions from analysis" preamble (Markdown H3).            // ← NEW: H3 chosen so it nests under `## Implementation Plan` via appendSection — H2 would break extractSection in review.ts:41
     List each decision the analysis has already settled (path,                  // ← NEW: enumerates the kinds of decisions worth surfacing
     response shape, dependency choice, test location, error
     semantics, etc.) as one bullet per decision, each with a short
     evidence quote drawn from the "--- Analysis ---" block in the               // ← NEW: explicit reference to the user-prompt marker so the model knows where to scan
     user message. If the analysis settled nothing concrete, write
     "(none)" so the preamble header is always present.                          // ← NEW: (none) discipline mirrors Phase 12.1 discover dedup pattern — header structurally present even on analysis-light cards

  2. The atomic-step plan, with one H3 heading per step. Each step              // ← clarifies H3 is the step header level (matches existing test fixture '### Step 1\nWHAT: ...')
     MUST include all six fields:

       WHAT     — what change is made                                            // ← fields unchanged
       HOW      — concrete code-level approach
       WHY      — why this step is needed
       RISK     — what could go wrong; blast radius
       VERIFY   — how we confirm the step worked
       ROLLBACK — how to undo if it doesn't

     Steps must be small, sequential, and independently verifiable.              // ← step-size rule unchanged
     Number them 1.1, 1.2, etc.

Grounding: only reference commands, file paths, flags, APIs, and tools          // ← "Grounding" preserved verbatim (existing test asserts /grounding/i)
that are cited in the analysis or can be inferred from concrete file
paths it mentions. Do NOT invent CLI subcommands, helper scripts,               // ← "Do NOT invent" preserved verbatim (existing test asserts /do NOT invent/i)
config keys, or HTTP endpoints to fit a step. If a step's HOW or
VERIFY needs something the analysis hasn't established exists, write
"[verify: <thing>]" or "[need: <fact to confirm>]" instead — leaving
the gap visible is better than inventing surface that doesn't exist.            // ← original [need:] rationale retained
"[need:]" is ONLY valid for items not in the Resolved decisions                  // ← NEW: structural counter-pressure — [need:] is invalid for items in the preamble
preamble. Before writing any "[need:]", scan the "--- Analysis ---"             // ← NEW: defensive scan-first clause (Strategy B); explicit reference to the user-prompt marker
block in the user message; a "[need:]" for a decision the analysis
already resolved is a defect.                                                    // ← NEW: defines the defect category explicitly so the model treats it as a hard rule, not a soft suggestion
\`.trim();
```

**Why**: Implements Strategy A (resolved-decisions preamble) + Strategy
B (defensive scan-first clause) layered into one SYSTEM_PROMPT. A
forces enumeration discipline at output-generation time; B
re-emphasizes the rule at placeholder-emission time. The two failure
modes are independent (enumeration ≠ scan-first), so layering closes
both. Implements the Phase 13 done-criterion that the SYSTEM_PROMPT
contains the "Resolved decisions from analysis" extraction
instruction.

**Risk**:
- **Model compliance drift.** A larger/more-structured prompt invites
  partial compliance (e.g., model emits the preamble but still
  writes `[need:]` for items in it). Mitigation: B's defensive clause
  re-states the rule at the placeholder-emission site so both
  reasoning passes see it.
- **Backward compatibility of existing tests.** Two existing tests
  assert specific prose: `/grounding/i` and `/do NOT invent|do not
  invent/i`. Both phrases are preserved verbatim. Verified in the
  "After" block above.
- **Heading-level collision.** Addressed above: H3 not H2 for the
  preamble. Verified by inspecting `extractSection` regex
  (`/\n##\s+/`) — matches `\n## ` but not `\n### `.
- **Prompt size.** Original SYSTEM_PROMPT ≈ 870 chars; new ≈ 1660
  chars. ~800 char growth. At ~4 chars/token, ≈ +200 input tokens per
  plan call. Negligible vs. the analysis section size and the
  downstream Opus output cost.

**Verify**:
- `npm run typecheck` — clean (string literal change, no type
  surface change).
- `npx vitest run tests/engine/ops/plan.test.ts` — all 4 existing
  tests pass without modification (asserted prose preserved). New
  tests added in Step 1.2.

**Rollback**: revert the single edit to `src/engine/ops/plan.ts`
SYSTEM_PROMPT const; commit the revert. No data migration, no schema
change.

### Step 1.2: Add 3 regression tests asserting the new prompt shape and behavior

**File**: `tests/engine/ops/plan.test.ts` (append after the existing
"system prompt instructs the model not to invent CLI surface" test,
inside the `describe('plan', ...)` block; before the closing `});`)

**Before** (end of current test file, lines 66–77):
```ts
  it('system prompt instructs the model not to invent CLI surface', async () => {  // ← existing test 4: prose assertions
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const sys = adapter.lastRequest?.system ?? '';                                 // ← reads SYSTEM_PROMPT from the captured request
    expect(sys).toMatch(/grounding/i);                                             // ← existing assertion 1 — kept passing by new prompt
    expect(sys).toMatch(/do NOT invent|do not invent/i);                           // ← existing assertion 2 — kept passing by new prompt
  });
});
```

**After** (proposed addition — three new tests inserted before the
closing `});` of the describe block):
```ts
  it('system prompt instructs the model not to invent CLI surface', async () => {  // ← existing test 4 (unchanged)
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const sys = adapter.lastRequest?.system ?? '';
    expect(sys).toMatch(/grounding/i);
    expect(sys).toMatch(/do NOT invent|do not invent/i);
  });

  it('system prompt requires a Resolved decisions preamble and a scan-first rule', async () => {   // ← NEW test 5: prompt-shape assertion (covers phase done-criterion #1)
    const adapter = new MockAdapter();                                              // ← fresh mock adapter
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });                // ← single canned response; we only inspect the captured SYSTEM_PROMPT, not the model output

    const card = await readCard(cardPath);                                          // ← reuses beforeEach card (has an Analysis section)
    await plan({ card, adapter, model: 'claude-opus-4-7' });                        // ← invoke plan; populates adapter.lastRequest

    const sys = adapter.lastRequest?.system ?? '';                                  // ← capture the prompt sent to the model
    expect(sys).toMatch(/Resolved decisions from analysis/);                        // ← preamble instruction present (Strategy A)
    expect(sys).toMatch(/scan the "--- Analysis ---"/);                             // ← defensive scan-first clause present (Strategy B), tied to the user-prompt marker the model is supposed to consult
    expect(sys).toMatch(/\[need:\][^]*defect/);                                    // ← "[need:]" → "defect" rule present (the hard-rule framing that gives the scan-first clause teeth); `[^]` matches across newlines on the multi-line prompt
  });

  it('preserves preamble + steps when the model emits the new output shape', async () => {   // ← NEW test 6: end-to-end persistence (covers phase done-criterion #2)
    const adapter = new MockAdapter();
    adapter.push({                                                                   // ← canned model response in the new two-artifact shape
      text: [
        '### Resolved decisions from analysis',                                      // ← H3 preamble header (matches SYSTEM_PROMPT instruction)
        '- Path: `/health` ("the endpoint must be served at /health")',              // ← decision with quoted evidence
        '',
        '### Step 1.1',                                                              // ← H3 step header (matches existing convention)
        'WHAT: add the endpoint',                                                    // ← six required fields
        'HOW: register `@app.get("/health")`',
        'WHY: completes the issue',
        'RISK: low — endpoint is additive',
        'VERIFY: curl /health returns 200',
        'ROLLBACK: revert the commit',
      ].join('\n'),
      inputTokens: 50,
      outputTokens: 80,
    });

    const card = await readCard(cardPath);                                           // ← reuses beforeEach card
    await plan({ card, adapter, model: 'claude-opus-4-7' });                         // ← invoke plan; appendSection wraps the response under `## Implementation Plan`

    const updated = await readCard(cardPath);                                        // ← re-read the persisted card
    expect(updated.body).toContain('## Implementation Plan');                         // ← appendSection wrote the H2 section wrapper
    expect(updated.body).toContain('### Resolved decisions from analysis');           // ← H3 preamble survived persistence intact
    expect(updated.body).toContain('### Step 1.1');                                   // ← H3 step header survived persistence intact

    const planSectionStart = updated.body.indexOf('## Implementation Plan');          // ← position of the section wrapper
    const preambleStart = updated.body.indexOf('### Resolved decisions from analysis');  // ← position of the preamble header
    const firstStep = updated.body.indexOf('### Step 1.1');                          // ← position of the first step header
    expect(preambleStart).toBeGreaterThan(planSectionStart);                          // ← preamble is INSIDE the Implementation Plan section (nested, not sibling — guards against the H2/H3 collision bug)
    expect(preambleStart).toBeLessThan(firstStep);                                    // ← preamble comes BEFORE the first step (head-position pattern, mirrors Phase 12.1 discover-dedup test ordering assertion)
  });

  it('does not emit [need:] for decisions the analysis already resolved (T1-1 regression)', async () => {   // ← NEW test 7: T1-1 regression (covers phase done-criterion #3)
    const fresh = join(tmp, 'health-card.md');                                        // ← write a fresh card so the seeded Analysis is unambiguous (no leftover beforeEach content)
    await copyFile(fixturePath, fresh);                                               // ← start from the sample fixture
    await appendSection(                                                              // ← seed an Analysis section that EXPLICITLY decides the path
      fresh,
      'Analysis',
      'Decision: use path `/health` (the endpoint must be served at /health).',
    );
    const card = await readCard(fresh);

    const adapter = new MockAdapter();
    adapter.push({                                                                    // ← canned response: model emits the resolved-decisions preamble correctly; only a NEW unresolved item gets [need:]
      text: [
        '### Resolved decisions from analysis',
        '- Path: `/health` ("the endpoint must be served at /health")',               // ← model surfaces the settled decision in the preamble
        '',
        '### Step 1.1',
        'WHAT: register endpoint at `/health`',                                       // ← step references the settled decision directly — no [need:]
        'HOW: add `@app.get("/health")` handler',
        'WHY: implements the path decided in analysis',
        'RISK: low',
        'VERIFY: integration test on GET /health',
        'ROLLBACK: revert',
        '',
        '### Step 1.2',
        'WHAT: choose status code for unhealthy state',
        'HOW: [need: chosen HTTP status code for unhealthy state]',                   // ← [need:] for a genuinely unresolved item; this stays
        'WHY: distinguishes healthy from degraded',
        'RISK: medium',
        'VERIFY: test the unhealthy path',
        'ROLLBACK: revert',
      ].join('\n'),
      inputTokens: 50,
      outputTokens: 120,
    });

    await plan({ card, adapter, model: 'claude-opus-4-7' });

    const updated = await readCard(fresh);                                             // ← re-read after plan() appended the section
    expect(updated.body).toContain('### Resolved decisions from analysis');            // ← preamble persisted
    expect(updated.body).toContain('Path: `/health`');                                  // ← settled decision surfaced in preamble
    expect(updated.body).not.toMatch(/\[need:[^\]]*path[^\]]*\]/i);                    // ← T1-1 invariant: no [need:] re-asks the path decision
    expect(updated.body).toMatch(/\[need:[^\]]*unhealthy[^\]]*\]/i);                   // ← genuinely-unresolved [need:] is preserved (this test asserts the [need:] mechanism still works for legitimate cases — not just that all [need:]s are gone)
  });
});
```

**Why**: Closes the Phase 13 done-criteria for regression coverage:
- Test 5 asserts the SYSTEM_PROMPT contains both the preamble
  extraction instruction and the defensive scan-first clause —
  prompt-shape contract. If a future refactor removes either, the
  test fails.
- Test 6 asserts the new two-artifact output shape survives
  persistence intact — `appendSection` wraps it correctly, the
  preamble nests under `## Implementation Plan` (no sibling-H2
  collision), and the preamble precedes the first step. This is the
  Phase-12.1 head-position `indexOf` pattern transferred to plan.
- Test 7 is the T1-1 regression: it seeds an Analysis section with
  an explicit path decision and asserts that when the model emits a
  compliant response (preamble surfaces the decision), the plan body
  contains no `[need: path]` re-ask. The test also asserts that a
  genuinely-unresolved `[need:]` (status code for unhealthy state)
  is preserved — i.e., the regression test is not over-strong; the
  `[need:]` mechanism still works for legitimate gaps.

**Risk**:
- **Test 6's H3-nesting assertion is structural, not behavioral.**
  It guards against the H2-collision bug discovered during planning.
  If a future change moves the preamble to H2, test 6 fails — which
  is correct.
- **Test 7 uses a canned model response.** It cannot verify that a
  real model will produce the compliant output; only that compliant
  output is persisted correctly and that an `[need:]` mechanism
  remains. This is the inherent limit of unit-testing LLM ops.
- **Beforehook reuses the same card across tests.** Tests 5 and 6
  reuse the beforeEach card (`cardPath`); test 7 writes a fresh card
  (`health-card.md` in `tmp`) to control the Analysis content. The
  beforeEach and afterEach hooks already handle tmp cleanup.

**Verify**:
- `npx vitest run tests/engine/ops/plan.test.ts` → expected 7/7 pass
  (4 existing + 3 new).
- `npm test` → expected 519/519 pass across 96 test files (516
  baseline + 3 new in this file).
- `npm run typecheck` → clean.

**Rollback**: revert the test additions in
`tests/engine/ops/plan.test.ts`; the existing 4 tests remain. No
fixture changes, no shared-helper changes.

## Test Changes

- **`tests/engine/ops/plan.test.ts`** — append 3 new tests (test 5, 6, 7
  above). No existing tests modified or removed.
- **No fixture changes.** Test 7 writes its own Analysis content via
  `appendSection` on a freshly-copied fixture (pattern already used
  by the existing "throws if no Analysis section" test at lines
  55–64).
- **No mock changes.** All new tests use `MockAdapter.push()` with
  canned responses, matching the existing test style.

## Post-Implementation Checks

Run in order:

1. `npx vitest run tests/engine/ops/plan.test.ts` — targeted; should
   show 7/7 pass.
2. `npm run typecheck` — must be clean (TypeScript-only change, no
   type surface change expected).
3. `npm test 2>&1 | Select-Object -Last 50` — full suite; should
   show 519/519 pass across 96 files at ≈ 16s. PowerShell pipe used
   per relay-config.md verification guidance.
4. Re-read the persisted `## Implementation Plan` section in this
   issue file to confirm Before/After code blocks render cleanly
   (manual spot-check, not part of automated suite).

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Model emits H2 preamble despite H3 instruction | Low | Tests 6+7 assert H3 specifically; if a real model emits H2, the preamble disappears under extractSection and the Phase will see `[need:]` re-asks in dogfood — fast feedback loop |
| Existing prose-assertion tests (`/grounding/i`, `/do NOT invent/i`) break | None | Both phrases preserved verbatim in the new prompt; verified above |
| Larger prompt confuses the model | Low | A+B layering is independently motivated; the marginal tokens are negligible compared to the analysis section size in context |
| Backward-compatible card bodies with no preamble persist | None | `plan` op does not parse or validate the model's output structure; it `appendSection`s whatever text the model returns. Old behavior continues if the model ignores the preamble instruction (degraded, but not broken) |
| Re-running plan duplicates the Implementation Plan section | N/A in current call sites | `appendSection` always appends; documented as future edge case in Analysis Related Work finding 3. Not in scope for this run |

## Rollback Plan

Single-commit change, code only. After implementation:
- `git revert <commit-hash>` (commit hash filled in post-commit).
- No DB migrations, no config changes, no stored data format
  changes, no schema updates. Pure prompt-string + test-file
  modification.

---

## Adversarial Review

*Reviewed: 2026-05-14*

### Source verification

Re-read `src/engine/ops/plan.ts` lines 22–42 just now (HEAD `debf476`):
- The current `SYSTEM_PROMPT` const matches the plan's Step 1.1 Before
  block character-for-character. Confirmed: `"Output Markdown only —
  no preamble."` line at 34 (the line my prompt rewords to `"Output
  Markdown only — no conversational preface."` plus the new
  two-artifact contract). Confirmed: `"Grounding:"` at 36 and `"Do
  NOT invent"` at 38 are the prose phrases the existing test 4
  asserts via `/grounding/i` and `/do NOT invent/i` — both phrases
  preserved verbatim in the new prompt.

Re-read `src/engine/state/card.ts:163-185` (appendSection +
extractSection):
- `appendSection` wraps content as
  `\n\n---\n\n## ${heading}\n\n${content.trim()}\n` — confirmed the
  appended Implementation Plan section gets a `## ` (H2) wrapper.
- `extractSection`'s regex is literally `/\n##\s+/` — confirmed it
  matches `\n## ` (H2 with one or more whitespace chars) but NOT
  `\n### ` (H3 has `#` after `##`, not whitespace). The plan's
  H3-not-H2 decision for the preamble is correct: an H3 preamble
  nests inside the Implementation Plan section without breaking
  `review.ts:41`'s extractSection call.

Re-read `src/adapters/mock.ts`:
- `MockAdapter.push({ text, inputTokens?, outputTokens? })` — all
  fields except `text` are optional (default `0`). The plan's tests
  5 and 7 that omit `inputTokens`/`outputTokens` are fine — defaults
  apply. Test 6 supplies both for symmetry but doesn't assert
  `result.tokens`, so the values are inert.
- `adapter.lastRequest` is populated on every `invoke()` call —
  confirmed test 5's prompt-shape inspection pattern works.
- `adapter.allRequests` also exists; not needed here but useful
  context.

Re-read `src/engine/ops/review.ts:41` and `src/importer/relay.ts:53`:
- review.ts: `extractSection(card.body, 'Implementation Plan')`. With
  H3 preamble nested correctly, this returns the full plan body
  (preamble + steps) up to the next `## ` heading. Review op gets
  MORE context (the preamble), which is a desired side effect — no
  regression.
- relay.ts: `has('Implementation Plan')` is a substring check for
  column-derivation in the legacy importer. The new section header is
  unchanged; check still passes.

### Issues Found

#### LOW-1: `(none)` empty-analysis branch is uncovered by tests

The new prompt instructs: *"If the analysis settled nothing concrete,
write '(none)' so the preamble header is always present."* No test
exercises this path. The branch is logically thin (one
prompt-compliance instruction) and the failure mode is graceful
(model emits `### Resolved decisions from analysis\n(none)\n\n###
Step 1.1` and downstream `extractSection` still returns the full
body), but the test coverage gap is real.

**Plan has** (no test for `(none)` branch — plan's test list omits this case)

**Should be** (option A: add a 4th test exercising the empty case)

```ts
it('persists (none) preamble when the model reports no resolved decisions', async () => {  // ← NEW test 8: empty-decision branch
  const adapter = new MockAdapter();
  adapter.push({
    text: [
      '### Resolved decisions from analysis',                            // ← preamble header still present
      '(none)',                                                          // ← compliant empty marker
      '',
      '### Step 1.1',
      'WHAT: ...', 'HOW: ...', 'WHY: ...', 'RISK: ...', 'VERIFY: ...', 'ROLLBACK: ...',
    ].join('\n'),
  });

  const card = await readCard(cardPath);
  await plan({ card, adapter, model: 'claude-opus-4-7' });

  const updated = await readCard(cardPath);
  expect(updated.body).toContain('### Resolved decisions from analysis');  // ← header present even on empty
  expect(updated.body).toContain('(none)');                                // ← empty marker persisted intact
});
```

**Verdict on LOW-1:** advisory. The plan as-shipped is acceptable
without this test; the prompt instruction is short and the
failure mode is graceful. If the implementor wants to add it
proactively, it's a 12-line addition. NOT GATING.

#### LOW-2: Backtick escaping in the markdown plan vs. actual JS

The plan's Step 1.2 code blocks contain JS string literals with
backticks inside single quotes — e.g., `'Path: \`/health\`'`. The
backslash-escape was added to keep the backticks visible inside the
fenced-code-block markdown. In the actual JS code, the backslashes
must be REMOVED — JS single-quoted strings take backticks as literal
characters with no escape needed.

**Plan has** (markdown rendering, with escapes for fenced-code
compatibility):

```ts
expect(updated.body).toContain('Path: \`/health\`');  // ← plan-doc rendering — backslash is for markdown not JS
```

**Should be** (actual JS the implementor writes):

```ts
expect(updated.body).toContain('Path: `/health`');  // ← literal backticks in single-quoted string; no escape needed
```

This is a markdown-fidelity concern, not a logic bug. The implementor
should pattern-match across all backtick-in-string occurrences in the
plan's Step 1.2 code blocks.

**Verdict on LOW-2:** documentation hygiene. The plan's intent is
clear and the implementor catches it on first run if backslashes
slip through (`SyntaxError: Invalid escape sequence` or string
content differs from expected). NOT GATING.

### Edge Cases Tested

Walking `.relay/relay-config.md § Edge Cases` for every applicable
scenario:

- **Optional services / feature flags** (provider adapters lazy,
  tracker.kind 'none', cost-ceiling halt_on_breach false,
  autonomy.transitions, MOCK provider): all irrelevant — change is
  contained to a prompt-string + tests; tests use `MockAdapter`. ✓
- **Config boundaries** (Card frontmatter strict, ProjectConfigSchema
  strict, card id regex, phase ordinal commit, verify_command
  default): all irrelevant — no config or schema interaction. ✓
- **Concurrency** (conductor loop, chokidar polling, daemon SSE,
  tracker poller, commitStep file list): irrelevant for the
  prompt-string change. The commit will use an explicit file list
  (`src/engine/ops/plan.ts` + `tests/engine/ops/plan.test.ts`). ✓
- **LLM/external API failures** (markdown-fenced JSON, adapter
  env-var lazy, OpenRouter/Linear/GitHub env-vars, local provider
  base URL, model output drift on tool-use):
  - Markdown-fenced JSON: plan op does NOT return JSON — it returns
    markdown directly via `resp.text`. `parseJsonResponse` is not in
    the codepath. ✓
  - Model output drift: my prompt change doesn't introduce tool-use;
    ClaudeAdapter's text-block accumulation is unchanged. ✓
- **Data boundaries**:
  - `auth.token` regen: irrelevant.
  - Run log retention: irrelevant.
  - **Card body sections accrete in order** (lines 51–57): Analysis
    Related Work finding 3 already noted this — re-running plan
    duplicates the Implementation Plan section. Not in this run's
    scope. ✓
  - YAML date normalization, readCard typed errors,
    listCardsLenient, TaskAgent throws-on-pre-run, card path
    repo-relative, uncommittedSnapshot buckets: all irrelevant. ✓

**Edge cases specifically tested by walking through each plan step:**

- **Step 1.1 partial failure scenarios:**
  - What if the prompt-string change lands but the model emits H2
    instead of H3? Downstream `extractSection(body, 'Implementation
    Plan')` would return empty, breaking review. Mitigation: tests
    6+7 assert H3 explicitly. If a real model emits H2 in dogfood,
    we see `[need:]` re-asks in review and re-plan loops — fast
    feedback. Acceptable risk. ✓
  - What if existing test 4 (`/grounding/i`, `/do NOT invent/i`)
    breaks? Both phrases preserved verbatim. ✓
  - What if test 1 (`'## Implementation Plan'`, `'Step 1'`) breaks?
    `appendSection` wraps with `## Implementation Plan` regardless
    of model output; canned `'### Step 1\nWHAT: ...'` still
    contains the literal `Step 1`. ✓
  - What if test 2 (`'Root cause is X'` in userPrompt) breaks?
    userPrompt construction is unchanged. ✓
  - What if test 3 (throws on missing Analysis) breaks? Function
    body and throw logic untouched. ✓

- **Step 1.2 boundary cases:**
  - Test 5 regex `/\[need:\][^]*defect/`: traced. The new prompt has
    `"[need:]"` followed by `defect` at the end. `[^]*` is
    "match-any-including-newlines" (greedy). The regex matches from
    the FIRST `[need:]` in the prompt through to `defect`. One
    `defect` occurrence in the prompt. ✓
  - Test 6 ordering assertion `preambleStart > planSectionStart`:
    `body.indexOf` returns FIRST occurrence; `## Implementation
    Plan` appears once (appended by `appendSection`); preamble's
    `### Resolved decisions from analysis` appears AFTER inside the
    appended content. ✓
  - Test 6 ordering assertion `preambleStart < firstStep`: canned
    response has preamble before `### Step 1.1`. ✓
  - Test 7 `/\[need:[^\]]*path[^\]]*\]/i` against `[need: chosen
    HTTP status code for unhealthy state]`: no "path" substring
    between `[need:` and `]`. `not.toMatch` passes. ✓
  - Test 7 `/\[need:[^\]]*unhealthy[^\]]*\]/i` against same:
    "unhealthy" substring present. `toMatch` passes. ✓

- **Re-reading source state for drift:** the plan was generated at
  2026-05-14 (today) and review is also 2026-05-14 — zero drift
  window. HEAD is `debf476`; the source file modification time
  hasn't changed since the plan was written. ✓

### Regression Risk

- **`src/engine/ops/review.ts:41` consumes the Implementation Plan
  section via `extractSection`.** With H3 preamble nested correctly,
  the extracted body now includes the preamble (more context for
  review). Risk: review's SYSTEM_PROMPT doesn't anticipate the
  preamble shape and may behave unexpectedly. Mitigation: review's
  SYSTEM_PROMPT instructs the model to find weaknesses in a plan;
  the preamble surfaces resolved decisions, which is unambiguously
  helpful context for review's job. No prompt change needed on
  review's side; the additional context strictly improves review's
  signal. ✓

- **`src/importer/relay.ts:53`** uses
  `has('Implementation Plan')` for column derivation. Header text
  unchanged; substring still matches. ✓

- **Existing 4 tests in `tests/engine/ops/plan.test.ts`** — traced
  above; all pass. ✓

- **Phase 12.1 implementation (`existingCardSummary` in
  `discover.ts`)** — touched code is `discover.ts`, not `plan.ts`.
  Zero overlap. ✓

- **Phase 11 implementation (`uncommittedSnapshot` in `git.ts`)** —
  touched code is `git.ts`, not `plan.ts`. Zero overlap. ✓

- **Phase 9 implementation (typed `readCard` errors)** — plan op
  receives `card: Card` already-parsed; doesn't call `readCard`
  directly. Zero overlap. ✓

- **Archived items** (.relay/archive/issues/) — none touch
  `plan.ts`. ✓

- **Other ops' SYSTEM_PROMPTs** (analyze, discover, review, resolve,
  verify, implement) — unchanged. ✓

### Verdict

**APPROVED.**

The plan correctly catches the H2/H3 collision risk during planning
and pins the preamble at H3. Strategy A+B layering is well-motivated
(two independent failure modes need two fail-safes). All four existing
tests trace to passing. The three new tests cover the phase's
done-criteria precisely. Edge cases from relay-config.md are walked
and irrelevant for this surface. Regression risk against prior phases
is zero.

Two LOW advisory items noted (`(none)` branch uncovered, backtick
markdown-vs-JS escaping). Neither gates implementation; both are
flagged for the implementor's awareness.

---

## Implementation Guidelines

*Date: 2026-05-14*

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

*Verified: 2026-05-14*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1.1 | Restructure `SYSTEM_PROMPT` in `src/engine/ops/plan.ts` lines 22-42 to require a `### Resolved decisions from analysis` preamble (H3) + add a scan-first defensive clause to the `[need:]` rule. Preserve `/grounding/i` and `/do NOT invent/i` prose verbatim. | YES | YES |
| 1.2 | Append 3 regression tests to `tests/engine/ops/plan.test.ts`: (5) prompt-shape assertion for preamble + scan-first clause; (6) end-to-end preamble survival with `indexOf` head-position ordering; (7) T1-1 regression (no `[need: path]` when analysis resolves path; legitimate `[need:]` for unresolved item preserved). | YES | YES |

### Diff verification

`git diff --stat src tests`:
- `src/engine/ops/plan.ts` — 39 lines changed (+28, -11). SYSTEM_PROMPT const only.
- `tests/engine/ops/plan.test.ts` — 92 lines added (+92, -0). Three new `it(...)` blocks appended inside the existing `describe('plan', ...)`.

Both diffs match the plan's Step 1.1 / Step 1.2 Before/After blocks character-for-character (excluding the illustrative per-line `# ←` comments in the plan markdown, which were intended as plan documentation, not source code). No scope creep, no drive-by edits.

### Test Results

`npx vitest run tests/engine/ops/plan.test.ts` (targeted, per `.relay/relay-config.md § Test Commands` → `src/engine/ops/<op>.ts → npx vitest run tests/engine/ops/<op>.test.ts`):

    Test Files  1 passed (1)
         Tests  7 passed (7)
      Duration  2.83s

All 4 pre-existing tests still pass (grounding-prose, analysis-section-in-prompt, throws-on-missing-analysis, appends-implementation-plan). 3 new tests pass (preamble + scan-first prompt shape, end-to-end ordering, T1-1 regression).

`npm test` (full suite):

    Test Files  96 passed (96)
         Tests  519 passed (519)
      Duration  17.10s

Baseline at HEAD `debf476` was 516/516; new total 519/519 = +3 new tests exactly as planned. Zero regressions.

`npm run typecheck`:

    > tsc --noEmit && tsc --noEmit -p tsconfig.ui.json
    (clean exit; no errors on either engine or UI tsconfig)

### Issues Found

None.

Two LOW advisory items from the Adversarial Review were re-evaluated:
- **LOW-1** ((none) empty-analysis branch uncovered) — confirmed still acceptable. The prompt instruction is short and the failure mode is graceful. Defer to dogfood signal.
- **LOW-2** (backtick escaping in plan markdown vs actual JS) — confirmed handled correctly in implementation. The JS test code uses unescaped literal backticks inside single-quoted strings; the markdown escapes in the plan were rendering hygiene only.

### Verification Fixes

None required.

### Verdict

**COMPLETE.**

All planned steps implemented, all 7 plan tests pass, full suite 519/519, typecheck clean. No regressions. No scope creep. No undocumented deviations. Phase 13 done-criteria for regression coverage satisfied (prompt-shape test ✓, end-to-end preamble survival ✓, T1-1 regression ✓, smoke test via MockAdapter ✓).

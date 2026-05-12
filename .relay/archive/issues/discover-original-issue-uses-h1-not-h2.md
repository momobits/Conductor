> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/discover-original-issue-uses-h1-not-h2.md).

# Card body uses `# Original Issue` (H1) — inconsistent with H2 sections appended later

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T2-2*
*Severity: P2 — quality*

## Problem statement

Cards filed by `conductor discover` and by `conductor card new` start with a
`# Original Issue` (H1) body section. Every section appended **after** that
by the lifecycle ops (`analyze`, `plan`, `review`, `implement`, `verify`,
`resolve`) uses H2 — `## Analysis`, `## Implementation Plan`,
`## Adversarial Review`, `## Implementation Guidelines`, etc.

Result: the original issue is visually over-prominent (an H1 typically renders
larger than every other heading on the card) and inconsistent with the rest
of the document outline. The section-extraction helper
`extractSection(body, heading)` in `src/engine/state/card.ts:85-92` only
looks for `## <heading>` — it could not extract `# Original Issue` even if a
downstream op needed to.

## Current state

H1 is written in **two** sites, not just discover:

- `src/cli/commands/discover.ts:57` — discover's filed-card body template:
  ```ts
  body: [
    '# Original Issue',
    '',
    item.rationale,
    ...
  ].join('\n'),
  ```
- `src/engine/state/card.ts:118` — `createCard()` default body for
  `conductor card new`:
  ```ts
  const body = args.body ?? '# Original Issue\n\n';
  ```
- `src/engine/state/card.ts:6` — the file's doc comment also documents the
  convention as `# Original Issue` followed by H2 sections for every op:
  ```
  //   # Original Issue
  //   ---
  //   ## Analysis
  ```

Subsequent appends through `appendSection()` (line 70-80) always use
`## ${heading}`, so the in-card outline is:

```
# Original Issue        ← H1 (only this heading)
## Analysis              ← H2
## Implementation Plan   ← H2
## Adversarial Review    ← H2
## Implementation Guidelines  ← H2
## Verification Report   ← H2
```

The dogfood log noted this on T2 specifically about `discover` — the same
inconsistency applies to manually-filed cards via `conductor card new`.

## Impact

- Visual hierarchy is wrong — H1 dwarfs every appended section.
- Markdown renderers and Table-of-Contents generators treat the original
  issue as the document title (H1 = page title in most conventions), which
  is misleading.
- `extractSection()` is keyed to H2 (`## ${heading}`). If any future op
  needs to programmatically read the original issue, the helper does not
  match it.
- Users who hand-write a card and follow the existing examples will perpetuate
  the inconsistency.

## Proposed fix

Promote `# Original Issue` to `## Original Issue` in both sites and update
the docstring.

1. `src/cli/commands/discover.ts:57` — change the first array element from
   `'# Original Issue'` to `'## Original Issue'`.
2. `src/engine/state/card.ts:118` — change the default body from
   `'# Original Issue\n\n'` to `'## Original Issue\n\n'`.
3. `src/engine/state/card.ts:6` — update the doc comment:
   ```
   //   ## Original Issue
   //   ---
   //   ## Analysis
   ```

Migration: existing cards in deployed `.conductor/cards/` directories still
have `# Original Issue`. A best-effort migration that rewrites `# Original Issue`
to `## Original Issue` on read could be added to `readCard()` but is not
required — the inconsistency does not break any read path.

### Verification

- Run `conductor card new test --title "test card"` and confirm the resulting
  file's body opens with `## Original Issue`.
- Add an assertion to `tests/engine/state/card.test.ts` that `createCard()`
  default body starts with `## Original Issue`.
- Add an assertion to `tests/cli/discover.test.ts` that filed-card bodies
  start with `## Original Issue`.

## Affected files

- `src/cli/commands/discover.ts`
- `src/engine/state/card.ts`
- `tests/cli/discover.test.ts`
- `tests/engine/state/card.test.ts`
- `tests/cli/card-new.test.ts` (verify default-body assertion still passes)

---

## Analysis

*Analyzed: 2026-05-12*

### Validation

- **Problem still exists: YES**, at slightly shifted line numbers.
  - `src/cli/commands/discover.ts:57` — confirmed: the body-template array still leads with `'# Original Issue',`. Unchanged since the issue was filed.
  - `src/engine/state/card.ts:211` — confirmed at the new line number. The issue cited `card.ts:118` but phase-9 inserted the typed-error infrastructure (`CardNotFoundError`, `CardParseError`, `messageForReadCardError`) ahead of `createCard`, shifting it down. The literal `args.body ?? '# Original Issue\n\n'` is still present.
  - `src/engine/state/card.ts:6` — confirmed: docstring still shows `// # Original Issue` at the head of the accretion-order example.
- **Proposed approach still valid: YES.** Three single-line edits, no behavioral change to readers.
- **Section-extraction asymmetry confirmed**: `extractSection` (`card.ts:178`) only matches `## ${heading}`. It is never called for `Original Issue` today, so the asymmetry is latent (no live consumer is broken by it) — but the post-fix shape makes the helper future-proof for any op that ever wants to read the original-issue text programmatically.

### Root Cause

The card-body convention was inherited from an early design where the user-supplied issue text was conceptually "the title block" of the document, so H1 felt natural. Every lifecycle op added later (`analyze`, `plan`, `review`, `implement`, `verify`, `resolve`, `notebook`) standardized on H2 sections via `appendSection`, which hard-codes `## ${heading}`. The lead heading was never realigned, leaving one H1 floating above a uniform H2 outline. This is a convention drift, not a behavioral bug — but it makes the document visually unbalanced, breaks Table-of-Contents expectations (H1 = page title in most renderers), and would prevent the existing `extractSection` helper from ever reading the original-issue text if a future op needed it.

No deeper architectural issue. The fix is purely a string change in two write sites and a docstring update.

### What This Means (User Impact)

**In plain terms:** When a user opens any card filed by `conductor discover` or created by `conductor card new`, the original-issue text renders with a much larger heading than every other section on the card (Analysis, Plan, Review, Verification, etc.). It looks like the first section is the *title* of the document and the rest are subsections of it — which is misleading, because all the lifecycle sections are peers, not children.

**Scenario:** A developer named Priya runs `conductor discover` after her team's afternoon code-cleanup session. The op files four cards into `.conductor/cards/`. She opens `2026-05-12-fix-auth-token-rotation.md` in her editor's markdown preview to triage. The preview shows:

> **Original Issue** *(rendered at the largest heading size, like a page title)*
>
> The `rotateAuthToken()` helper at `src/auth/token.ts:42` does not handle the case where the refresh token has expired. When `--rotate` is passed and the refresh token is >90 days old, the function returns `undefined` silently…
>
> **Analysis** *(rendered noticeably smaller, like a sub-section)*
>
> ...

She reads it as "the document is about the original issue, and the analysis is a sub-note on the original issue." When the analyze op later appends `## Implementation Plan` and `## Adversarial Review`, they appear as more sub-notes under the same conceptual parent. The visual hierarchy obscures the actual relationship: these are all sibling sections that accrete in temporal order over the card's lifecycle.

**Before (current behavior):**
1. Priya runs `conductor discover`.
2. A new card opens with `# Original Issue` at H1 and every other section at H2.
3. The H1 renders 1.5–2× larger than the H2 sections.
4. The document outline (in her editor's "outline" panel, or in a TOC generator) lists "Original Issue" as the page title, with "Analysis", "Implementation Plan", etc. nested beneath it as children.
5. Priya internalizes a false mental model: original-issue is the parent, lifecycle sections are children.

**After (with fix):**
1. Priya runs `conductor discover`.
2. The new card opens with `## Original Issue` at H2, alongside the other H2 lifecycle sections.
3. All headings render at the same size — peer sections of one document.
4. The outline panel lists "Original Issue", "Analysis", "Implementation Plan", etc. as siblings at the same level.
5. Priya's mental model matches reality: these are sequential, peer artifacts of the card's lifecycle.

### Blast Radius

**Files directly modified (3 source-code changes):**
- `src/cli/commands/discover.ts:57` — single-string change in the `body:` array passed to `writeCard()`. Function: `runDiscover()`.
- `src/engine/state/card.ts:211` — single-string change in the `body` default for `createCard()`.
- `src/engine/state/card.ts:6` — docstring update (no runtime impact).

**Tests modified (additive assertions per the issue's verification list):**
- `tests/cli/discover.test.ts` — add an assertion to the existing "files a card per discovered item" test that the written file body starts with `## Original Issue`.
- `tests/engine/state/card.test.ts` — add a test asserting `createCard()` default body starts with `## Original Issue`. (Note: `createCard` is not currently exported from `card.ts` — it is exported as a named export, but no existing test covers its default-body path. This adds the first coverage.)

**Direct callers of the changed write sites:**
- `runDiscover()` — called from `src/cli/index.ts` (the `conductor discover` CLI binding) and from `tests/cli/discover.test.ts`. No internal callers in `src/`.
- `createCard()` — called only from `src/rpc/methods.ts:63-65` (`conductor.card_new` RPC handler), which always passes `body: p.body ?? ''`. Because `??` treats `''` as defined, **the `'# Original Issue\n\n'` default is never reached at runtime**. The CLI handler at `src/cli/commands/card-new.ts:37-83` does NOT call `createCard` — it writes its own body via `writeFile`. No test exercises the default body today; Step 5 adds the first one. (Re-verified at adversarial review 2026-05-12 — earlier analysis incorrectly described `runCardNew` as a caller.)

**Indirect consumers (downstream ops that read card bodies after the fix):**
- `appendSection` at `card.ts:163` — appends `\n\n---\n\n## ${heading}\n\n${content}\n` regardless of leading heading shape. Behavior unaffected by H1→H2.
- `extractSection` at `card.ts:178` — only matches `## ${heading}`. Never invoked with `Original Issue` today. Post-fix it *could* be invoked for that section, but no current op does.
- All ops (`analyze`, `plan`, `review`, etc.) read `card.body` for full-text context; none parse the leading heading specifically.

**Test fixtures that contain the literal `# Original Issue`:**
~25 test files construct synthetic card bodies inline (e.g., `tests/agent/task_agent.test.ts:32,146`, `tests/integration/phase3-end-to-end.test.ts:170`, `tests/conductor/loop.test.ts:45`, `tests/engine/blast_radius.test.ts:52`, `tests/cli/import.test.ts:21`, `tests/cli/work-phase2.test.ts:42`, `tests/cli/work-phase3.test.ts:53`, `tests/engine/ops/*.test.ts` ×6, `tests/agent/recommendation.test.ts:32`, `tests/agent/autonomy_gate.test.ts:30`, `tests/rpc/conductor_methods.test.ts:30`, `tests/fixtures/sample-card.md:18`, `tests/fixtures/relay/issues/auth_token_expired.md:6`, `tests/fixtures/relay/archive/issues/2025-12-01-fixed.md:6`). **These are input fixtures, not output assertions.** They construct minimal card bodies that downstream ops then append sections to. No test asserts about the leading heading shape — they only `toContain(...)` on titles/IDs/section content. The suite will pass unchanged after the production code is updated. Updating them is cosmetic-only; out of scope for this XS fix.

**Config interactions:** None. No `ProjectConfigSchema` field references heading conventions.

**Past work regression risk:**
- `.relay/implemented/misleading-card-not-found-for-malformed-yaml.md` (step 9.1) — added typed-error classes ahead of `createCard`, causing the line-number shift the issue noted. No regression risk: the change does not touch the error-handling code path.
- `.relay/implemented/scan-bails-entirely-on-one-malformed-card.md` (step 9.2) and `work-creates-run-dir-before-validating-card.md` (step 9.3) — neither touches the body-template strings or the docstring.
- No risk of undoing phase-9 work.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose + symbol queries (Serena MCP not declared in `.relay/relay-config.md` for this project)*

#### Findings

- **Target:** `unfiled: .relay/relay-readme.md:332 — lifecycle ASCII diagram still shows '# Original Issue' as the card-creation step`
  - **Kind:** unfiled candidate
  - **Evidence:** medium
  - **Why related:** The lifecycle diagram on line 332 documents the canonical card body convention shown to operators: `│ # Original Issue │ ← /relay-discover or /relay-new-issue`. After 10.1 lands, this diagram describes a state that no longer exists. Pure prose drift; not a code bug.
  - **Suggested handling:** file companion (one-line doc fix as a separate cleanup PR or bundled into the phase-7 docs bundle from `.relay/relay-ordering.md`)

- **Target:** `.relay/issues/plan-op-leaves-need-placeholders-resolved-in-analysis.md`
  - **Kind:** existing item
  - **Evidence:** weak
  - **Why related:** Cites the same `extractSection` helper (`card.ts:178`). After 10.1, the helper is uniformly applicable to every section in a card body (including original-issue), which is a latent enabler for any future op that might want to extract original-issue text — but the plan-op issue does NOT need that capability, so there is no functional dependency.
  - **Suggested handling:** keep narrow

- **Target:** `unfiled: docs/dogfood-log.md:76,281,285,286 — historical record of the bug`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** The dogfood log is the source-of-record document the issue was generated from. It describes the bug accurately (using the H1 wording to *describe the bug*) and the expected fix (H2). No action needed — historical record is correct as written.
  - **Suggested handling:** keep narrow (no change)

- **Target:** `unfiled: tests/fixtures/sample-card.md:18, tests/fixtures/relay/issues/auth_token_expired.md:6, tests/fixtures/relay/archive/issues/2025-12-01-fixed.md:6 — fixture files containing '# Original Issue'`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** Fixture files used as inputs to test scenarios. No test asserts on their leading heading; updating them is cosmetic-only.
  - **Suggested handling:** keep narrow (leave fixtures; they're input data, not assertion targets)

- **Target:** `unfiled: docs/superpowers/plans/*.md — historical phase plan documents with `# Original Issue` in code examples`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** Pre-implementation design documents from 2026-05-07 and 2026-05-08 quoting the (then-current, now-stale) convention. Historical artifacts; never re-read by tooling.
  - **Suggested handling:** keep narrow (no change)

#### Search Bounds

- Live codepath audit: complete — full `runDiscover` (`discover.ts:21-69`), full `createCard` (`card.ts:189-216`), full `appendSection`/`extractSection` (`card.ts:163-185`), and the docstring (`card.ts:1-12`) all read end-to-end.
- Backlog codepath: complete — all 13 active issues + 0 active features inspected.
- Subsystem: complete — `src/engine/state/card.ts`, `src/cli/commands/discover.ts`, `src/cli/commands/card.ts` (card_new caller), and all consumer ops in `src/engine/ops/` checked.
- Archive: complete — 3 archived issues inspected; none touch heading conventions.
- Implementation: complete — 3 implemented items inspected; none touch heading conventions.
- Contract drift: complete — repo-wide grep for `# Original Issue` and `## Original Issue` covered; symbol-existence guard passes (`createCard`, `extractSection`, `appendSection`, `runDiscover` all confirmed present).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* All `medium`/`weak` findings are documentation drift (relay-readme, dogfood-log, historical phase plans) that are either correct-as-historical-record or belong in the phase-7 docs bundle per `.relay/relay-ordering.md`. The `extractSection` asymmetry noted in the plan-op issue is a latent enabler, not a coupled dependency. No `strong` findings beyond the issue itself. The original scope (3 source-code lines + 2 test assertions) fully resolves the user-facing problem; bundling docs work would inflate an XS into a small-S without addressing a shared root cause.

### Approach

**Recommended approach** — the issue's proposed fix as-written, with the line-number correction for `card.ts:211` (was cited as `:118`):

1. `src/cli/commands/discover.ts:57` — change `'# Original Issue'` → `'## Original Issue'` in the body-template array.
2. `src/engine/state/card.ts:211` — change `'# Original Issue\n\n'` → `'## Original Issue\n\n'` in `createCard`'s default-body fallback.
3. `src/engine/state/card.ts:6` — update the docstring's accretion-example so the leading line is `## Original Issue` (consistent with the rest of the example).
4. `tests/cli/discover.test.ts` — add `expect(card).toContain('## Original Issue')` to the "files a card per discovered item" test (asserts on the existing in-test `card` variable that already reads the written file).
5. `tests/engine/state/card.test.ts` — add a new `describe('createCard')` block (or similar) that exercises `createCard()` with no body argument and asserts the resulting on-disk file body starts with `## Original Issue\n\n`. Use the existing `tmp`/`cardsDir` fixture from `beforeEach`.

**Alternatives considered and rejected:**

- *Bundle the relay-readme docs fix.* Rejected — adds out-of-phase scope (docs belong to phase-7 per ordering) and the visual lifecycle diagram is a single-line cosmetic update that survives the time gap fine.
- *Best-effort read-time migration (`# Original Issue` → `## Original Issue` in `readCard`).* The issue mentions this as optional. Rejected — adds non-trivial parse-shape branching to the hot read path for cosmetic-only benefit, and existing cards in deployed `.conductor/cards/` directories continue to render fine (they just keep their old H1 until next manually re-edit). Migration belongs in a separate, opt-in pass if ever needed.
- *Update all ~25 test-fixture inline body strings to `## Original Issue` for consistency.* Rejected — those fixtures are synthetic input data, not assertions about output. The change would be invisible to test behavior and would inflate the diff by ~25 file touches with no observable benefit.

**Open questions or decisions needed before implementation:** None. The fix is mechanical.

---

## Implementation Plan

*Generated: 2026-05-12*

### Step 1: Promote `# Original Issue` → `## Original Issue` in the discover op's body template

**File**: `src/cli/commands/discover.ts` (`runDiscover`, lines 56–63)

**Before** (current code):
```ts
      body: [                                          // ← array of body lines joined with '\n' below
        '# Original Issue',                            // ← H1 — out of step with the H2 sections every later op appends
        '',                                            // ← blank line separating heading from rationale
        item.rationale,                                // ← LLM-supplied rationale text from the discover op
        '',                                            // ← blank line before the source-evidence footer
        `_Source evidence:_ ${item.source_evidence}`,  // ← italic footer line citing the repo location that triggered the finding
        '',                                            // ← trailing blank to leave the body open for appendSection writes
      ].join('\n'),                                    // ← collapse the array into the final body string for writeCard
```

**After** (proposed change):
```ts
      body: [                                          // ← unchanged: array of body lines joined with '\n'
        '## Original Issue',                           // ← CHANGED: H2 to match every other lifecycle section in the card
        '',                                            // ← unchanged: blank line separating heading from rationale
        item.rationale,                                // ← unchanged: LLM-supplied rationale text
        '',                                            // ← unchanged: blank line before footer
        `_Source evidence:_ ${item.source_evidence}`,  // ← unchanged: italic source-evidence footer
        '',                                            // ← unchanged: trailing blank for downstream appendSection
      ].join('\n'),                                    // ← unchanged: collapse to final body string
```

**Why**: This is the primary write site — every card filed via `conductor discover` flows through here. Changing the lead heading to H2 aligns the discover-filed cards with the H2 sections every downstream op (`analyze`, `plan`, `review`, `implement`, `verify`, `resolve`, `notebook`) appends via `appendSection`. Addresses root cause: a single H1 floating above a uniform H2 outline.

**Risk**: Test fixtures that construct synthetic cards as input data still use `# Original Issue` (~25 files); they continue to work because no test asserts on the leading heading shape — they only use the body as input for downstream-op behavior. No production consumer reads `card.body` looking for `# Original Issue`. `appendSection`/`extractSection` are heading-shape-agnostic for the leading section (extractSection only matches `## ${heading}`; it never queries for `Original Issue`).

**Verify**: `npx vitest run tests/cli/discover.test.ts` — the existing "files a card per discovered item" test, augmented in Step 4 below, will assert the written file body now contains `## Original Issue`.

**Rollback**: revert the single character (`'# '` → `'## '`) in the body array.

### Step 2: Promote `# Original Issue` → `## Original Issue` in `createCard`'s default body

**File**: `src/engine/state/card.ts` (`createCard`, lines 210–212)

**Before** (current code):
```ts
  const head = yaml.dump(frontmatter, { lineWidth: 0, noRefs: true });   // ← serialize frontmatter to YAML for the file header
  const body = args.body ?? '# Original Issue\n\n';                       // ← default body when caller did not supply one — H1, out of step
  const out = `---\n${head}---\n\n${body}`;                               // ← assemble the full file: --- frontmatter --- body
```

**After** (proposed change):
```ts
  const head = yaml.dump(frontmatter, { lineWidth: 0, noRefs: true });   // ← unchanged: serialize frontmatter to YAML
  const body = args.body ?? '## Original Issue\n\n';                      // ← CHANGED: H2 default body so `card new` produces the same shape discover does
  const out = `---\n${head}---\n\n${body}`;                               // ← unchanged: full-file assembly
```

**Why**: `createCard` is the other site in `card.ts` that hard-codes `# Original Issue`. Aligning its default with the discover-op default and the docstring example keeps the contract self-consistent (`card.ts:6` docstring now matches `card.ts:211` default after Steps 2+3). The new Step 5 test will be the first exerciser of this default path and pins the convention.

**Caveat on production reach** (surfaced during adversarial review, 2026-05-12): no live production caller currently exercises this default fallback. The two real callers are:
  - `src/rpc/methods.ts:63-65` (`conductor.card_new` RPC handler) — always passes `body: p.body ?? ''`. The empty string `''` is **defined** for `??`, so the `'# Original Issue\n\n'` fallback is never reached.
  - `src/cli/commands/card-new.ts:79` (`runCardNew` direct-write path when no daemon is running) — bypasses `createCard` entirely; writes its own `\n# Original\n\n${args.title}\n\n...` body via `writeFile` directly.

  The default is therefore dead-code-at-runtime today. Updating it is still the right move because: (a) it keeps the docstring contract truthful — anyone reading `card.ts` should see internally consistent examples — and (b) future callers that opt into the default will get the H2 convention. The convention drift in `runCardNew:79` (`# Original` H1) is a separate, unfiled concern tracked under Related Work below.

**Risk**: `tests/cli/card-new.test.ts` exercises `runCardNew`, not `createCard`, and does not assert on body-heading shape (verified at review). No existing test breaks. The new Step 5 test will pin the default.

**Verify**: `npx vitest run tests/engine/state/card.test.ts` — the new test from Step 5 will assert `## Original Issue\n\n` is the default body.

**Rollback**: revert the single character (`'# '` → `'## '`) in the default-body string.

### Step 3: Update the `card.ts` docstring accretion example

**File**: `src/engine/state/card.ts` (file header, lines 1–12)

**Before** (current code):
```ts
// src/engine/state/card.ts                          // ← module identifier
//                                                    // ← blank doc line
// Card persistence: read, write, list, and append-section.  // ← module purpose
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.  // ← storage location + format
// Body sections accrete over the lifecycle (Relay-style):  // ← documents the body shape contract
//   # Original Issue                                  // ← H1 — example contradicts every other line in the example
//   ---                                               // ← horizontal-rule separator between sections
//   ## Analysis                                       // ← H2 — analyze op's section
//   ---                                               // ← H-rule
//   ## Implementation Plan                            // ← H2 — plan op's section
//   ---                                               // ← H-rule
//   etc.                                              // ← elided remaining sections
```

**After** (proposed change):
```ts
// src/engine/state/card.ts                          // ← unchanged: module identifier
//                                                    // ← unchanged: blank doc line
// Card persistence: read, write, list, and append-section.  // ← unchanged: module purpose
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.  // ← unchanged: storage location
// Body sections accrete over the lifecycle (Relay-style):  // ← unchanged: contract intro
//   ## Original Issue                                 // ← CHANGED: H2 to match the rest of the example (and the post-fix code)
//   ---                                               // ← unchanged: H-rule separator
//   ## Analysis                                       // ← unchanged: analyze op section
//   ---                                               // ← unchanged: H-rule
//   ## Implementation Plan                            // ← unchanged: plan op section
//   ---                                               // ← unchanged: H-rule
//   etc.                                              // ← unchanged: elision
```

**Why**: The docstring is the contract reference any future code-reader will check when adding a new op. Leaving the H1 line in place would perpetuate the inconsistency in any new contributor's mental model.

**Risk**: None — pure comment change with no runtime effect.

**Verify**: `npm run typecheck` (proves the file still compiles; comments don't affect typecheck but Step 1 and Step 2 changes do).

**Rollback**: revert the single character in the comment line.

### Step 4: Add a heading assertion to the discover CLI test

**File**: `tests/cli/discover.test.ts` (the existing `'files a card per discovered item'` test, lines 27–52)

**Before** (current code):
```ts
    const filed = await runDiscover({                                                  // ← invoke the discover CLI helper
      cwd: tmp, adapter, model: 'mock-model',                                          // ← isolated tmp repo + mock LLM
      now: new Date('2026-05-07T00:00:00Z'),                                           // ← deterministic clock for id generation
    });                                                                                 // ←
    expect(filed).toHaveLength(1);                                                      // ← discover should file exactly one card
    expect(filed[0]).toBe('2026-05-07-fix-x');                                          // ← id matches date prefix + slug
    const card = await readFile(join(tmp, '.conductor', 'cards', '2026-05-07-fix-x.md'), 'utf8');  // ← read the written file as raw text
    expect(card).toContain('Fix x');                                                    // ← title from the LLM response made it into the file
    expect(card).toContain('source: discover');                                         // ← frontmatter records the source op
  });                                                                                   // ← end of "files a card" test
```

**After** (proposed change):
```ts
    const filed = await runDiscover({                                                  // ← unchanged: invoke discover CLI helper
      cwd: tmp, adapter, model: 'mock-model',                                          // ← unchanged: tmp repo + mock LLM
      now: new Date('2026-05-07T00:00:00Z'),                                           // ← unchanged: deterministic clock
    });                                                                                 // ← unchanged
    expect(filed).toHaveLength(1);                                                      // ← unchanged
    expect(filed[0]).toBe('2026-05-07-fix-x');                                          // ← unchanged
    const card = await readFile(join(tmp, '.conductor', 'cards', '2026-05-07-fix-x.md'), 'utf8');  // ← unchanged
    expect(card).toContain('Fix x');                                                    // ← unchanged
    expect(card).toContain('source: discover');                                         // ← unchanged
    expect(card).toContain('## Original Issue');                                        // ← NEW: pin the H2 convention post-fix
    expect(card).not.toMatch(/^# Original Issue/m);                                     // ← NEW: regression guard — assert no H1 at line-start
  });                                                                                   // ← unchanged
```

**Why**: Pins the new convention with both a positive assertion (`## Original Issue` is present) and a negative regression guard (no leading-`# Original Issue` at any line start in the body). The negative guard uses `/m` (multiline) so the match anchors to line starts, catching only the H1 form (`# Original Issue`) — `## Original Issue` does NOT match because the anchor requires `#` followed by a space, not `##`.

**Risk**: The negative-guard regex must not over-match. Verified: `/^# Original Issue/m` matches only when a line begins with `# ` (single hash, space). The frontmatter YAML cannot produce such a line; the body now contains `## Original Issue` which starts with `##` (no false positive). The fixture string `source: discover` does not begin with `#`. Safe.

**Verify**: `npx vitest run tests/cli/discover.test.ts` — both new assertions pass after Step 1 lands; both fail in a hypothetical regression where Step 1 is reverted.

**Rollback**: remove the two new `expect(...)` lines.

### Step 5: Add a new test exercising `createCard`'s default body

**File**: `tests/engine/state/card.test.ts` (append a new `describe('createCard')` block after the existing `describe('buildCardPath')` block at line 236)

**Before** (current end of file):
```ts
describe('buildCardPath', () => {                                                       // ← existing tests for the path helper
  it('joins cardsDir with id and .md suffix', () => {                                   // ←
    const p = buildCardPath('/tmp/c', 'abc-123');                                       // ←
    // Cross-platform: path.join uses platform separator. Just check the                // ←
    // result ends with the expected filename.                                          // ←
    expect(p.endsWith('abc-123.md')).toBe(true);                                        // ←
  });                                                                                    // ←
});                                                                                      // ← end of buildCardPath describe block
```

**After** (proposed change):
```ts
describe('buildCardPath', () => {                                                       // ← unchanged: existing path-helper tests
  it('joins cardsDir with id and .md suffix', () => {                                   // ← unchanged
    const p = buildCardPath('/tmp/c', 'abc-123');                                       // ← unchanged
    // Cross-platform: path.join uses platform separator. Just check the                // ← unchanged
    // result ends with the expected filename.                                          // ← unchanged
    expect(p.endsWith('abc-123.md')).toBe(true);                                        // ← unchanged
  });                                                                                    // ← unchanged
});                                                                                      // ← unchanged

describe('createCard', () => {                                                          // ← NEW: pin createCard's default body shape
  it('default body starts with `## Original Issue` (H2 to match lifecycle section convention)', async () => {  // ← NEW
    const id = await createCard(tmp, { slug: 'h2-default', title: 'H2 default', kind: 'issue' });  // ← NEW: invoke with no body override
    const written = await readFile(join(cardsDir, `${id}.md`), 'utf8');                 // ← NEW: read the file just created
    expect(written).toMatch(/\n\n## Original Issue\n\n/);                               // ← NEW: positive — H2 default present after frontmatter
    expect(written).not.toMatch(/\n\n# Original Issue\n\n/);                            // ← NEW: regression guard — H1 form is absent
  });                                                                                    // ← NEW
});                                                                                      // ← NEW: end of createCard describe block
```

**Imports update** at the top of the file (line 6–16) — add `createCard` to the existing named import and `readFile` to the `node:fs/promises` import:

**Before**:
```ts
import { mkdtemp, rm, copyFile, writeFile, mkdir } from 'node:fs/promises';   // ← fs helpers used by existing tests
// ...
import {                                                                       // ← existing card-module named imports
  readCard,                                                                    // ←
  writeCard,                                                                   // ←
  listCards,                                                                   // ←
  listCardsLenient,                                                            // ←
  appendSection,                                                               // ←
  buildCardPath,                                                               // ←
  CardNotFoundError,                                                           // ←
  CardParseError,                                                              // ←
  messageForReadCardError,                                                     // ←
} from '../../../src/engine/state/card.js';                                    // ←
```

**After**:
```ts
import { mkdtemp, rm, copyFile, writeFile, mkdir, readFile } from 'node:fs/promises';  // ← CHANGED: add readFile for the new test
// ...
import {                                                                       // ← unchanged
  readCard,                                                                    // ← unchanged
  writeCard,                                                                   // ← unchanged
  listCards,                                                                   // ← unchanged
  listCardsLenient,                                                            // ← unchanged
  appendSection,                                                               // ← unchanged
  buildCardPath,                                                               // ← unchanged
  createCard,                                                                  // ← NEW: needed for the new describe block
  CardNotFoundError,                                                           // ← unchanged
  CardParseError,                                                              // ← unchanged
  messageForReadCardError,                                                     // ← unchanged
} from '../../../src/engine/state/card.js';                                    // ← unchanged
```

**Why**: `createCard` had no direct test coverage before. The new describe block pins the H2 default behavior with both positive and negative assertions, preventing silent regression if anyone re-introduces the H1 default.

**Risk**: `createCard` writes to `<repo>/.conductor/cards/<date>-<slug>.md` and `mkdir`s the parent. The existing `beforeEach` already creates `tmp` and `cardsDir = <tmp>/.conductor/cards`, so the on-disk write lands in the right place and is cleaned up in `afterEach`. The id is date-prefixed by `createCard` itself, so the test reads via the returned `id` rather than a hard-coded date.

**Verify**: `npx vitest run tests/engine/state/card.test.ts` — the new test passes after Step 2 lands; the regression guard fails if anyone re-introduces `# Original Issue`.

**Rollback**: remove the new `describe('createCard')` block and the two import additions.

## Test Changes

- **Updated:** `tests/cli/discover.test.ts` — Step 4 adds two assertions to the existing "files a card per discovered item" test (positive H2 + negative H1 regression guard).
- **New:** `tests/engine/state/card.test.ts` — Step 5 adds a new `describe('createCard')` block with one test asserting the default body starts with `## Original Issue` (plus the regression guard). Adds `createCard` and `readFile` to the existing imports.
- **No fixture file updates.** ~25 test files contain `# Original Issue` in synthetic input data — none assert on the heading shape, all continue to pass unchanged.
- **No snapshot updates.** The suite uses inline `expect(...)` assertions, not file-based snapshots, for the changed code paths.

## Post-Implementation Checks

Run in this order:

1. `npm run typecheck` — catches any TypeScript regression in the touched files (`tsc -p tsconfig.json && tsc -p tsconfig.ui.json`).
2. `npx vitest run tests/cli/discover.test.ts` — Step 4 assertions green.
3. `npx vitest run tests/engine/state/card.test.ts` — Step 5 new test green, all existing tests still green.
4. `npm test` — full suite (497 tests baseline per STATE.md). Expect 498 (497 baseline + 1 new test in Step 5). Step 4 adds assertions to an existing test, not a new test entry, so the total goes up by exactly 1.

If any of (2)/(3)/(4) fail with messages mentioning `# Original Issue` in a test fixture, that means a test was asserting on the heading shape (not just using it as input) — investigate and update the assertion to expect `## Original Issue`. Per the analysis, none should fail; this note is the recovery path if the assumption is wrong.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A test fixture asserts on `# Original Issue` and fails after Step 1 | Low | Grep confirmed all ~25 hits are input data, not assertions. Recovery is mechanical: change the assertion to `## Original Issue`. |
| Negative-guard regex over-matches and produces false-positive test failures | Very low | `/^# Original Issue/m` requires `#` + space at line start; `## Original Issue` does not match. Verified mentally; will confirm at verify. |
| `createCard` cannot be invoked from the test without setup that the existing fixture doesn't provide | Very low | The existing `beforeEach` already creates `<tmp>/.conductor/cards`, which is where `createCard` writes. Just need `createCard` + `readFile` in imports. |
| Stale cards in deployed `.conductor/cards/` directories still show `# Original Issue` | N/A (out of scope) | Existing cards keep their original heading; only newly-created cards adopt H2. No migration is in scope per the analysis's "Alternatives considered". |
| Docs drift — `.relay/relay-readme.md:332` lifecycle diagram still shows `# Original Issue` | Known | Tracked as a Related Work finding with suggested handling **file companion**. Not addressed in this fix per scope-decision `keep narrow`. |

## Rollback Plan

`git revert <commit-sha>` — single commit, pure code change, no DB migrations, no config changes, no stored data format changes. Real commit hash filled in after implementation lands.

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source-verification (re-read at review time)

Re-read all three production target lines via `grep "Original Issue" src/` — current state matches the plan's BEFORE blocks byte-for-byte:

```
src/cli/commands/discover.ts:57:        '# Original Issue',
src/engine/state/card.ts:6://   # Original Issue
src/engine/state/card.ts:211:  const body = args.body ?? '# Original Issue\n\n';
```

No drift between analysis and review.

### Issues Found

**1. MEDIUM — Step 2 rationale incorrectly described `createCard`'s production reach (fixed in-place).**

The plan's original "Why" claimed `createCard` is "invoked by `conductor card new`." Re-reading `src/cli/commands/card-new.ts:37-83` and `src/rpc/methods.ts:61-67` showed otherwise:

**Plan had** (now corrected in-place):
```ts
// Why: `createCard` is the other write path that emits `# Original Issue` —
// invoked by `conductor card new`. Aligning the default with the discover-op
// default keeps the convention consistent regardless of which entry point
// created the card.
```

**Should be** (now in the plan):
```ts
// Why: `createCard` is the other site in `card.ts` that hard-codes
// `# Original Issue`. Aligning its default with the discover-op default
// and the docstring example keeps the contract self-consistent. The new
// Step 5 test will be the first exerciser of this default path.
//
// Caveat: no live production caller exercises this default today.
//   - `src/rpc/methods.ts:63-65` always passes `body: p.body ?? ''` (empty
//     string is defined for `??`, so the fallback never triggers).
//   - `src/cli/commands/card-new.ts:79` bypasses `createCard` entirely —
//     writes its own body via `writeFile`.
// The fix is still warranted on docstring-contract and future-caller grounds.
```

**Why it matters:** The original rationale would mislead a future reader into believing `conductor card new` produces `# Original Issue` cards today (it does not — it produces `# Original` via the `runCardNew` direct-write path, a separate string entirely). Correct rationale prevents downstream misdiagnosis. The Blast Radius's "Direct callers" entry has been corrected in lockstep.

**2. LOW — `runCardNew` writes a different H1 heading (`# Original`, not `# Original Issue`) — same convention-drift root cause, separate string, out of scope per `keep narrow`.**

`src/cli/commands/card-new.ts:79` writes:
```ts
const body = `\n# Original\n\n${args.title}\n\n(Edit this card to add detail before running \`conductor work\`.)\n`;
```

This is a different literal from the one this issue targets, but the same underlying convention drift: H1 lead heading floating above H2 lifecycle sections. Filed below as a Related Work finding for a possible follow-up issue; not blocking this PR.

**No CRITICAL or HIGH severity issues found.** The code changes in all 5 steps are correct and minimal; the negative-guard regexes are sound (verified below); the new test exercises a path with no prior coverage.

### Related Work (new finding from adversarial review)

- **Target:** `unfiled: src/cli/commands/card-new.ts:79 — runCardNew body template uses '# Original' (H1)`
  - **Kind:** unfiled candidate
  - **Evidence:** medium (same root cause as the issue; different string)
  - **Why related:** When the daemon is not running, `conductor card new` falls through to `runCardNew` which writes `\n# Original\n\n...` directly. This is the same convention drift the current issue targets, on a parallel string the issue didn't catch. After 10.1 lands, `conductor card new` (no daemon) will continue to emit an inconsistent H1.
  - **Suggested handling:** file companion — a new XS issue post-10.1 to either change `# Original` → `## Original Issue` (better — matches the new convention) or `## Original` (keeps the existing intent but as H2). Decision deferrable.

### Edge Cases to Handle

Walked through `.relay/relay-config.md § Edge Cases` against the plan:

- **Card frontmatter `.strict()`** — plan touches body only, not frontmatter. ✓
- **Card body sections accrete in order** — initial body shape change does not affect `appendSection` semantics (still writes `\n\n---\n\n## ${heading}\n\n${content}\n` regardless of leading heading). ✓
- **readCard typed errors** (`CardParseError` / `CardNotFoundError`) — body-content change does not affect YAML or schema parsing. ✓
- **listCardsLenient instanceof discrimination** — unaffected. ✓
- **YAML date normalization** — unaffected. ✓
- **MockAdapter / RoutingAdapter / mock provider** — `tests/cli/discover.test.ts` already uses `MockAdapter` correctly for the existing test; the new assertions in Step 4 use the same fixture. ✓
- **`conductor card new` daemon vs direct-write path** — surfaced as Issue #1 and Related Work above; addressed.

Regex correctness (re-verified):

- Step 4 negative guard `/^# Original Issue/m`: requires `#` + space + `Original Issue` anchored to a line start. After Step 1, the discover-filed body contains `## Original Issue` — the regex requires `#` followed by space, but `##` has `#` after `#` (no space match). **No false positive.** Frontmatter YAML lines (`id:`, `title:`, `kind:`, `column:`, `source:`, etc.) do not begin with `#`. **No false positive.** ✓
- Step 5 positive match `/\n\n## Original Issue\n\n/`: traces to `out = \`---\n${head}---\n\n${body}\`` where `body = '## Original Issue\n\n'`. The file content contains `---\n\n## Original Issue\n\n` after the second `---`. **Matches.** ✓
- Step 5 negative guard `/\n\n# Original Issue\n\n/`: same analysis — `\n\n##` does not match `\n\n# ` (single hash + space). **No false positive.** ✓

### Regression Risk

Walked `.relay/issues/`, `.relay/features/`, `.relay/archive/issues/`, `.relay/archive/features/`, `.relay/implemented/`:

- **`.relay/implemented/misleading-card-not-found-for-malformed-yaml.md` (phase 9.1)** — touched typed-error infrastructure ahead of `createCard`. Plan does not touch error-handling code paths. ✓
- **`.relay/implemented/scan-bails-entirely-on-one-malformed-card.md` (phase 9.2)** — added `listCardsLenient`. Body-heading change cannot affect aggregate list semantics. ✓
- **`.relay/implemented/work-creates-run-dir-before-validating-card.md` (phase 9.3)** — pre-run `readCard` validation in `task_agent.ts`. Body-content change cannot affect read-side validation. ✓
- **Active issues** — none assume the H1 convention. The `plan-op-leaves-need-placeholders-resolved-in-analysis.md` issue cites `extractSection` as H2-only; this fix moves the lead heading into the H2-extractable set (a latent enabler, not a coupled dependency). ✓
- **Test suite** — ~25 test files contain `# Original Issue` in synthetic body fixtures. None assert on the heading shape; they `toContain(...)` on titles/IDs/section content. **Confirmed by reviewing the file list:** `tests/agent/task_agent.test.ts`, `tests/integration/phase3-end-to-end.test.ts`, `tests/integration/phase6-end-to-end.test.ts`, `tests/conductor/loop.test.ts`, `tests/engine/blast_radius.test.ts`, `tests/cli/import.test.ts`, `tests/cli/work-phase2.test.ts`, `tests/cli/work-phase3.test.ts`, `tests/engine/ops/*.test.ts` (6 files), `tests/agent/autonomy_gate.test.ts`, `tests/agent/recommendation.test.ts`, `tests/rpc/conductor_methods.test.ts`. None pattern-match `# Original Issue` in assertions. ✓
- **`tests/fixtures/sample-card.md`** — body content `# Original Issue` is input data for `card.test.ts`'s roundtrip and `appendSection` tests. Neither test asserts on the heading. ✓

No regression risk identified.

### Verdict

**APPROVED WITH CHANGES** — Step 2's "Why" rationale + Blast Radius "Direct callers" entry have been corrected in-place. Code changes in all 5 steps remain unchanged and correct.

---

## Implementation Guidelines

*Date: 2026-05-12*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-12*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | `src/cli/commands/discover.ts:57` — `'# Original Issue'` → `'## Original Issue'` | YES | YES |
| 2 | `src/engine/state/card.ts:211` — `'# Original Issue\n\n'` → `'## Original Issue\n\n'` | YES | YES |
| 3 | `src/engine/state/card.ts:6` — docstring `// # Original Issue` → `// ## Original Issue` | YES | YES |
| 4 | `tests/cli/discover.test.ts` — added `toContain('## Original Issue')` + `not.toMatch(/^# Original Issue/m)` | YES | YES |
| 5 | `tests/engine/state/card.test.ts` — added `describe('createCard')` block + imports for `createCard`, `readFile` | YES | YES |

### Test Results

- **`npm run typecheck`** — clean (no output, exit 0). Both `tsc -p tsconfig.json` (engine) and `tsc -p tsconfig.ui.json` (UI) passed.
- **`npx vitest run tests/cli/discover.test.ts`** — 2/2 pass (1.89s). Step 4's two new assertions executed inside the existing "files a card per discovered item" test.
- **`npx vitest run tests/engine/state/card.test.ts`** — 25/25 pass (871ms). Previously 24; Step 5's new `createCard` test brings total to 25. Existing tests (readCard, writeCard, listCards, listCardsLenient, appendSection, buildCardPath, messageForReadCardError) all unaffected.
- **`npm test`** — **498/498 pass across 96 test files in 15.30s.** Baseline was 497 per STATE.md; expected delta is +1 (Step 5 added one new test entry; Step 4 added assertions to an existing test). Match confirmed. Zero regressions.

### Source-diff confirmation (re-read at verify time)

```
src/cli/commands/discover.ts:57:        '## Original Issue',
src/engine/state/card.ts:6://   ## Original Issue
src/engine/state/card.ts:211:  const body = args.body ?? '## Original Issue\n\n';
```

All three production lines are at the expected `##` shape. No unplanned changes anywhere else in the file (`git diff` would show three single-character edits in `src/` plus two test additions).

### Issues Found

- None.

### Verdict

**COMPLETE** — all planned changes implemented exactly as specified, all targeted tests pass, full suite passes with expected +1 delta, zero regressions, no scope creep.

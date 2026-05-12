> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/drift-doesnt-distinguish-staged-vs-unstaged.md)

# `conductor drift` does not distinguish staged vs unstaged changes in `uncommitted-state-mismatch`

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T5-4*
*Severity: P3 — observation (low-priority UX)*

## Problem statement

The `uncommitted-state-mismatch` drift signal lumps **staged-but-uncommitted**
and **unstaged** changes into a single bucket. A developer running
`git add .conductor/` and then `conductor drift` sees the same output as
before staging — same count, same file list. They cannot tell from drift
output whether their changes are queued for the next commit or still
waiting to be staged.

This is not a bug — "uncommitted" is correctly defined as the union of the
two states. But the bucketing is coarser than it needs to be.

## Current state

- `src/engine/ops/detect_drift.ts:93-103`:
  ```ts
  const dirty = (await uncommittedFiles(repo)).filter(
    (f) => !f.startsWith('.conductor/') && !f.startsWith('.conductor\\'),
  );
  if (dirty.length > 0) {
    drifts.push({
      kind: 'uncommitted-state-mismatch',
      expected: 'clean working tree',
      actual: `${dirty.length} uncommitted file(s)`,
      detail: dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? ', …' : ''),
    });
  }
  ```
- `src/engine/state/git.ts:90-102`:
  ```ts
  export async function uncommittedFiles(repo: string): Promise<string[]> {
    const status = await git(repo).status();
    const all = [
      ...status.modified,
      ...status.created,
      ...status.deleted,
      ...status.not_added,
      ...status.staged,
      ...status.conflicted,
      ...status.renamed.map((r) => r.to),
    ];
    return [...new Set(all)];
  }
  ```
  All seven status buckets are collapsed into one array; the call site has
  no visibility into which are staged.
- T5.5 dogfood: `conductor drift` output was byte-identical before and
  after `git add .conductor/` — both reported 18 uncommitted files with
  the same truncated detail line.

## Impact

- A developer about to commit can't use `drift` to confirm everything is
  staged.
- A developer reviewing why drift fires can't quickly see whether the
  problem is "I forgot to stage" or "I forgot to commit."
- Mostly affects power users; most users will just run `git status`
  alongside drift.
- No correctness or safety issue.

## Proposed fix

Split the count and detail into the two sub-categories.

### Recommended shape

1. Extend `uncommittedFiles()` in `src/engine/state/git.ts` to return a
   richer object that distinguishes staged from unstaged:
   ```ts
   export interface UncommittedSnapshot {
     staged: string[];      // status.staged + status.renamed.map(r => r.to)
     unstaged: string[];    // modified + created + deleted + not_added
     conflicted: string[];  // separate — these block commits
   }

   export async function uncommittedSnapshot(repo: string): Promise<UncommittedSnapshot> { ... }
   ```
   Keep the old `uncommittedFiles()` as a convenience that returns the
   union, for any other callers that don't care about the breakdown.
2. In `src/engine/ops/detect_drift.ts`, render the breakdown:
   ```ts
   const snap = await uncommittedSnapshot(repo);
   const ignored = (p: string) => p.startsWith('.conductor/') || p.startsWith('.conductor\\');
   const staged = snap.staged.filter(p => !ignored(p));
   const unstaged = snap.unstaged.filter(p => !ignored(p));
   if (staged.length + unstaged.length > 0) {
     drifts.push({
       kind: 'uncommitted-state-mismatch',
       expected: 'clean working tree',
       actual: `${staged.length + unstaged.length} uncommitted file(s) (${staged.length} staged, ${unstaged.length} unstaged)`,
       detail: [...staged, ...unstaged].slice(0, 10).join(', ') + ...,
     });
   }
   ```

### Verification

- Add a regression test in `tests/engine/state/git.test.ts` that creates a
  tmp repo with some staged and some unstaged changes, calls
  `uncommittedSnapshot()`, and asserts the breakdown.
- Add a regression test in `tests/engine/ops/detect_drift.test.ts` that
  asserts the new "(N staged, M unstaged)" formatting.

## Affected files

- `src/engine/state/git.ts` — add `uncommittedSnapshot()`.
- `src/engine/ops/detect_drift.ts` — use the new snapshot; render breakdown
  in the `actual` field.
- `tests/engine/state/git.test.ts`, `tests/engine/ops/detect_drift.test.ts`
  — regression coverage.

---

## Analysis

*Analyzed: 2026-05-12*

### Validation
- **Problem still exists:** YES.
  - `uncommittedFiles()` at `src/engine/state/git.ts:90-102` unchanged from
    citation; still unions all seven `simple-git` status fields into a single
    deduplicated array.
  - The sole consumer at `src/engine/ops/detect_drift.ts:93-103` reads the
    flat array, renders `${dirty.length} uncommitted file(s)` with no staged
    /unstaged breakdown, and truncates to 10 silently.
- **Proposed approach still valid:** YES, with minor refinement (edge-case
  rules decided below).

### Root Cause
- `uncommittedFiles()` was authored for a single yes/no caller (`isCleanTree`-style
  consumers and the early drift detector). The drift consumer is now the only
  caller and needs richer breakdown. The fix is a non-invasive widening:
  introduce `uncommittedSnapshot()` returning `{staged, unstaged, conflicted}`
  and **redefine** `uncommittedFiles()` as a convenience union over the
  snapshot — keeps the external contract for any future caller that doesn't
  care about the breakdown.
- Not a symptom of a deeper architectural issue — drift's `actual` field has
  no contract beyond "a human-readable string" (no RPC/UI consumer parses it).
- T5-5 (`drift-truncates-file-list-at-10.md`, phase-11 step 11.2) shares the
  same surface and explicitly depends on this helper; resolving 11.1
  unlocks 11.2.

### What This Means (User Impact)

**In plain terms:** When an operator runs `conductor drift`, today they
cannot tell whether the working-tree changes are *queued for the next
commit* (staged) or *still loose* (unstaged). The single "N uncommitted
file(s)" line collapses both states. After the fix, the same line will
break it down — "5 uncommitted file(s) (3 staged, 2 unstaged)" — so the
operator can see at a glance whether they're one `git commit` away from
clean or whether they still need to run `git add`.

**Scenario:** Alex is preparing to land a feature on `conductor`. They've
made edits across 18 files; they run `git add .conductor/` to stage the
card + run-log mutations and leave the source edits unstaged for review.
They run `conductor drift` to confirm the staging looks right before
committing.

**Before (current behavior):**
1. Alex sees `[control:drift]` with one entry:
   `uncommitted-state-mismatch: expected=clean working tree actual=18
   uncommitted file(s) — detail: a.ts, b.ts, c.ts, ..., …`
2. Output is **byte-identical** to the pre-`git add` run.
3. Alex must run `git status` to see the staged/unstaged split — drift
   added no signal beyond "things are dirty."

**After (with fix):**
1. Same drift entry, but now: `actual=18 uncommitted file(s) (12 staged,
   6 unstaged)`.
2. Alex confirms the staged count matches the expected card+run-log fan-out
   and that the source-edit count matches the unstaged fan-out.
3. If a conflict exists, a third sub-count appears: `(3 staged, 2 unstaged,
   1 conflicted)` — surfacing the merge-state explicitly because conflicts
   block commits.

### Blast Radius
- **Files modified:**
  - `src/engine/state/git.ts` — add `UncommittedSnapshot` interface and
    `uncommittedSnapshot()` function; refactor `uncommittedFiles()` to call
    it.
  - `src/engine/ops/detect_drift.ts` — replace the `uncommittedFiles()` call
    with `uncommittedSnapshot()`; render the breakdown in `actual`.
  - `tests/engine/state/git.test.ts` — add `describe('uncommittedSnapshot')`
    block (currently zero coverage for any uncommitted-* function).
  - `tests/engine/ops/detect_drift.test.ts` — extend the existing
    "uncommitted-state-mismatch" test to assert the new format; add a
    multi-bucket fixture.
- **Direct callers of `uncommittedFiles()`:** exactly one production caller —
  `src/engine/ops/detect_drift.ts:93`. No other `src/` reference; no test
  reference. (Verified by Explore landscape scan.)
- **Indirect consumers of the `uncommitted-state-mismatch` drift kind:**
  - `src/cli/commands/drift.ts:19` — `formatDrift()` concatenates all four
    fields generically; doesn't parse `actual` or `detail`. Will display the
    new breakdown verbatim.
  - `src/engine/types.ts:116` — `DriftKind` union; no shape coupling.
  - Tests at `tests/engine/ops/detect_drift.test.ts:74` and
    `tests/cli/drift.test.ts:22-28` only assert `kind === ...` — no
    coupling to `actual`/`detail` content. Refactor will not break them.
- **No RPC consumer** (`src/rpc/methods.ts` exports no drift method). **No
  UI consumer** (`src/ui/` references nothing in this path). **No persisted
  shape** — drift output is ephemeral.
- **Config interactions:** None. No `ProjectConfigSchema` keys gate this
  behavior.
- **Cross-item interactions:** T5-5 (step 11.2) consumes the new helper;
  T5-5's per-bucket truncation accounting is **enabled** by this refactor.
  No item is harmed.
- **Past work regression risk:** None. Drift subsystem has zero prior
  refactors in `.relay/implemented/` and zero archived siblings.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose; live-source reads for symbol queries (Serena MCP not declared in `relay-config.md`).*

#### Findings

- **Target:** `.relay/issues/drift-truncates-file-list-at-10.md`
  - **Kind:** existing item (phase-11 step 11.2)
  - **Evidence:** strong
  - **Why related:** Same file (`src/engine/ops/detect_drift.ts:101`),
    immediately downstream of the helper introduced here. T5-5 needs
    `uncommittedSnapshot()`'s per-bucket arrays to emit `… N more` suffixes
    per bucket and to power the `--verbose` flag. Confirmed by Explore
    landscape scan and by the phase-11 plan in `relay-ordering.md § Phase 3`.
  - **Suggested handling:** keep narrow — T5-5 is already a separately filed
    Relay issue with its own /relay-analyze → /relay-plan cycle and ships
    as Control step 11.2 (its own commit). Coupling the two scopes into one
    grouped run would not change the ordering and would conflate two
    independently-resolvable items in one PR. The helper introduced here is
    the contract surface T5-5 will build on; that's a build-time dependency,
    not a scope-coupling signal.

#### Search Bounds

- Live codepath audit: complete (full bodies of `uncommittedFiles`,
  `detectDrift`, `runDrift`/`formatDrift` read; first-order callers exhausted).
- Backlog codepath: complete (all 11 active issues scanned; only T5-5 cites
  these files).
- Subsystem: complete (no other items in `src/engine/state/git.ts` or
  `src/engine/ops/detect_drift.ts` family).
- Archive: complete (5 archived issues — none touch drift/git subsystem).
- Implementation: complete (5 implemented items — none touch drift/git).
- Contract drift: complete (0 findings; `uncommittedFiles` and
  `uncommitted-state-mismatch` are not referenced in docs, README, or
  user-facing prose beyond the issue file itself and `docs/dogfood-log.md`,
  which records the original finding and does not assert on shape).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* Only one related finding (T5-5) and it's already a filed Relay
issue with its own lifecycle. The dependency is build-time (T5-5 imports
`uncommittedSnapshot()`), not scope-coupling. Relay ordering treats them as
sequential, not grouped. Coupling them into one grouped run would not change
commit count, would inflate one PR, and would split T5-5's planning across
two phases. Keep them as two sequential Control steps in phase-11 — that's
the cleanest closure path.

### Approach

**Recommended approach:**

1. Introduce `UncommittedSnapshot` interface + `uncommittedSnapshot(repo)`
   in `src/engine/state/git.ts`. Map `simple-git` status fields → buckets:
   - **staged**: `status.staged ∪ status.renamed.map(r => r.to)` — rename
     detection requires the new path to be staged, so renames are always
     in the staged bucket.
   - **unstaged**: `status.modified ∪ status.created ∪ status.deleted ∪
     status.not_added`. (`created` here is simple-git's name for
     "added-but-tracked-via-index" — semantically unstaged working-tree
     side; `not_added` is untracked.)
   - **conflicted**: `status.conflicted`. Surfaced separately because
     conflicts block commits and are operationally distinct.
   - Dedup **within** each bucket only (`new Set(...)`). A file appearing
     in both `status.staged` and `status.modified` (the "staged then
     re-edited" partial-staging case) **appears in BOTH staged and
     unstaged** — the whole point of the refactor is to surface partial
     states; hiding them defeats the purpose. The drift `actual` count is
     the union cardinality after de-duping across buckets.
2. Redefine `uncommittedFiles()` as
   `(s => [...new Set([...s.staged, ...s.unstaged, ...s.conflicted])])(await uncommittedSnapshot(repo))`.
   External contract preserved; no caller migration needed.
3. Update `src/engine/ops/detect_drift.ts:93-103` to:
   - Call `uncommittedSnapshot(repo)`.
   - Filter each bucket through the existing `.conductor/`-ignore predicate.
   - Compute `totalCount = new Set([...staged, ...unstaged, ...conflicted]).size`.
   - Render `actual` as: `${totalCount} uncommitted file(s) (${staged.length} staged, ${unstaged.length} unstaged${conflicted.length > 0 ? `, ${conflicted.length} conflicted` : ''})`.
     Conditional conflicted clause keeps the common case clean.
   - `detail` preserves the current behavior for now: union order
     staged → unstaged → conflicted, sliced to 10, with trailing `, …` if
     truncated. Per-bucket truncation accounting is **T5-5's scope** (step
     11.2) — keep the diff focused.
4. Add tests:
   - `tests/engine/state/git.test.ts`: new `describe('uncommittedSnapshot')`
     with cases for (a) only-unstaged, (b) only-staged, (c) mixed staged+unstaged
     (different files), (d) partial-staging (same file in both buckets after
     staged+re-edit), (e) rename in staged bucket, (f) conflicted bucket
     (synthesizable via failed merge, or stub for v1 if too heavy).
   - `tests/engine/ops/detect_drift.test.ts`: extend the existing
     "uncommitted-state-mismatch" test to assert the new format string
     pattern (`(N staged, M unstaged)`); add one multi-bucket fixture
     covering staged + unstaged simultaneously.

**Alternatives considered:**
- *Add `staged: string[]` / `unstaged: string[]` fields directly to the
  `Drift` type* — rejected. `Drift` is a shape-neutral envelope `{kind,
  expected, actual, detail}`; adding kind-specific structured fields would
  fork the type and break the generic `formatDrift()` renderer.
- *Return a discriminated union from `uncommittedFiles()` and have the
  caller switch on it* — rejected. Heavier API surface for one consumer;
  the snapshot-object approach has the same expressiveness with less
  type plumbing.
- *Render staged/unstaged in `detail` instead of `actual`* — rejected.
  `actual` is what `formatDrift()` puts after `actual=` in the
  `[control:drift]` line; that's where the breakdown belongs for at-a-glance
  reading. `detail` remains the file-list preview.

**Open questions:** None blocking. The partial-staging dedup rule (include
in both buckets) and the conflicted-clause conditional rendering are both
decided above per the operator's "make the call inline" directive. Will be
captured as inline rationale comments in the snapshot helper for future
readers.

---

## Implementation Plan

*Generated: 2026-05-12*

> **Plan-time refinement over the original "Recommended shape" above.** The
> issue text proposes deriving buckets from `simple-git`'s high-level flat
> arrays (`status.staged`, `status.modified`, etc.). Verified against
> `node_modules/simple-git/dist/esm/index.js` (parse-status-summary): those
> flat arrays **conflate index-side and worktree-side states**. For
> example, a fully-staged modification (porcelain code `M `, clean
> worktree) lands in BOTH `status.modified` AND `status.staged`. Using the
> flat-array partition would cause `git add file` followed by `conductor
> drift` to still report `file` in BOTH `staged` and `unstaged` — defeating
> the refactor's purpose. The plan instead reads `status.files[].index` /
> `.working_dir` (the canonical per-file XY characters from `git status
> --porcelain`) and buckets from those. This is the only correctness-safe
> way to realize the issue's intent.

### Step 1: Add `UncommittedSnapshot` + `uncommittedSnapshot()` to git.ts; redefine `uncommittedFiles()` over it

**File**: `src/engine/state/git.ts` (lines 90–102 replaced; result spans ~lines 90–150)

**Before** (current code):
```ts
export async function uncommittedFiles(repo: string): Promise<string[]> {  // ← current: returns one flat deduped array
  const status = await git(repo).status();                                 // ← calls simple-git status
  const all = [                                                            // ← unions all status fields
    ...status.modified,                                                    // ← worktree-side mods (BUT also includes some index-side per simple-git parser)
    ...status.created,                                                     // ← X='A' files (always staged) — surprising
    ...status.deleted,                                                     // ← deletions (either side)
    ...status.not_added,                                                   // ← untracked (X='?' Y='?')
    ...status.staged,                                                      // ← X != ' ' && X != '?' — index changes
    ...status.conflicted,                                                  // ← merge conflicts
    ...status.renamed.map((r) => r.to),                                    // ← rename new path
  ];
  return [...new Set(all)];                                                // ← dedup; caller loses all bucketing info
}
```

**After** (proposed change):
```ts
/** Categorized snapshot of working-tree paths reported by `git status`,    // ← rationale block for future readers
 *  derived from per-file `(index, working_dir)` XY codes — see              // ← cites the source of truth
 *  https://git-scm.com/docs/git-status#_short_format. Buckets are NOT      // ← key contract: not mutually exclusive
 *  mutually exclusive: a file that has been `git add`-ed AND then          // ← partial-staging case explained
 *  re-edited appears in BOTH `staged` AND `unstaged` so callers (drift)    // ← why: surface partial state, not hide it
 *  can surface the partial-staging state explicitly.                       // ← rationale
 *
 *  We read `status.files[].index` / `.working_dir` directly rather than     // ← deviation from simple-git high-level arrays
 *  the high-level `status.modified` / `status.staged` flat arrays           // ← reason: those conflate index + worktree
 *  because simple-git's flat arrays conflate index-side and worktree-side   // ← evidence below
 *  states (e.g. a fully-staged modification with a clean worktree lands     // ← concrete example
 *  in BOTH `status.modified` AND `status.staged`). Reading XY directly      // ← XY = porcelain short-format chars
 *  gives the precise index-vs-worktree partition required here. */         // ← summary of why
export interface UncommittedSnapshot {                                       // ← new public type
  staged: string[];      // ← X ∈ {A,M,D,R,C} — index has changes vs HEAD
  unstaged: string[];    // ← Y ∈ {A,M,D} — worktree has changes vs index — OR untracked (XY='??')
  conflicted: string[];  // ← U in X or Y; AA / DD pairs — merge unresolved
}

export async function uncommittedSnapshot(repo: string): Promise<UncommittedSnapshot> {  // ← new exported function
  const status = await git(repo).status();                                  // ← single status call
  const staged: string[] = [];                                              // ← bucket accumulator
  const unstaged: string[] = [];                                            // ← bucket accumulator
  const conflicted: string[] = [];                                          // ← bucket accumulator
  for (const f of status.files) {                                           // ← iterate canonical per-file XY entries
    const x = f.index;                                                      // ← index-side status char (X)
    const y = f.working_dir;                                                // ← worktree-side status char (Y)
    const isConflict =                                                      // ← classify conflicts FIRST (they short-circuit)
      x === 'U' || y === 'U' ||                                             // ← any 'U' is unmerged
      (x === 'A' && y === 'A') ||                                           // ← AA = both added — conflict
      (x === 'D' && y === 'D');                                             // ← DD = both deleted — conflict
    if (isConflict) {                                                       // ← conflicted files go ONLY in the conflicted bucket
      conflicted.push(f.path);                                              // ← record
      continue;                                                             // ← skip staged/unstaged classification for conflicts
    }
    if (x !== ' ' && x !== '?') staged.push(f.path);                        // ← any X other than space/'?' = staged
    if (y !== ' ') unstaged.push(f.path);                                   // ← any Y other than space = worktree-modified or untracked
  }                                                                          // ← end of per-file loop
  return {                                                                   // ← return deduped buckets
    staged: [...new Set(staged)],                                            // ← dedup within bucket
    unstaged: [...new Set(unstaged)],                                        // ← dedup within bucket
    conflicted: [...new Set(conflicted)],                                    // ← dedup within bucket
  };                                                                         // ← partial-staging files appear in BOTH staged and unstaged (intentional)
}

export async function uncommittedFiles(repo: string): Promise<string[]> {    // ← preserved for backward compat — same external contract
  const snap = await uncommittedSnapshot(repo);                              // ← delegate to the new helper
  return [...new Set([...snap.staged, ...snap.unstaged, ...snap.conflicted])];  // ← union of all buckets, deduped (file in both buckets shows up once)
}
```

**Why**: Introduces the bucketed snapshot the drift consumer needs to render
the staged/unstaged breakdown. Preserves `uncommittedFiles()` as a thin
union wrapper so the external contract is unchanged for any future caller
that doesn't care about the breakdown. The XY-based bucketing is the only
correctness-safe partition (see the comment block; the flat-array path the
issue originally proposed is semantically muddled by simple-git's parser).

**Risk**: The `status.files` field is documented in simple-git's typings
(`response.d.ts:348`) but is less commonly used than the flat arrays.
Mitigation: tests in Step 3 exercise the dominant XY codes (`??`, `A `,
`AM`, `M `, `MM`, `R`, `UU`-like via real merge conflict). If simple-git
ever stops populating `files[]` consistently, all tests fail loudly. The
`renamed`-from-`R` case is covered by `f.index === 'R'` → staged bucket;
no separate handling of `status.renamed` needed.

**Verify**: `npx vitest run tests/engine/state/git.test.ts` — the Step 3
tests pin every bucket transition.

**Rollback**: revert this single commit; `uncommittedFiles()` continues to
work either way because the wrapper preserves the external signature.

### Step 2: Thread snapshot through `detect_drift.ts`; render breakdown in `actual`

**File**: `src/engine/ops/detect_drift.ts` (line 8 import; lines 93–103 body)

**Before** (current code):
```ts
import { currentBranch, lastCommitSha, describeRef, uncommittedFiles } from '../state/git.js';  // ← imports flat-array helper
...
  const dirty = (await uncommittedFiles(repo)).filter(                       // ← flat list, then filter
    (f) => !f.startsWith('.conductor/') && !f.startsWith('.conductor\\'),    // ← drop conductor's own working files (drift's own footprint)
  );                                                                          // ← lost any bucket info before this point
  if (dirty.length > 0) {                                                    // ← only emit drift if anything remains
    drifts.push({                                                            // ← single drift entry
      kind: 'uncommitted-state-mismatch',                                    // ← envelope kind unchanged
      expected: 'clean working tree',                                        // ← unchanged
      actual: `${dirty.length} uncommitted file(s)`,                         // ← THE GAP: no staged/unstaged signal
      detail: dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? ', …' : ''),  // ← truncates silently at 10 (T5-5's gap)
    });
  }
```

**After** (proposed change):
```ts
import { currentBranch, lastCommitSha, describeRef, uncommittedSnapshot } from '../state/git.js';  // ← import snapshot helper instead of the flat one
...
  const snap = await uncommittedSnapshot(repo);                              // ← bucketed snapshot
  const notConductor = (f: string) =>                                        // ← extract predicate for reuse across three buckets
    !f.startsWith('.conductor/') && !f.startsWith('.conductor\\');           // ← same filter rule, three applications below
  const staged = snap.staged.filter(notConductor);                           // ← apply per-bucket
  const unstaged = snap.unstaged.filter(notConductor);                       // ← apply per-bucket
  const conflicted = snap.conflicted.filter(notConductor);                   // ← apply per-bucket
  const all = [...new Set([...staged, ...unstaged, ...conflicted])];         // ← union for total count + detail preview (dedups partial-staging files)
  if (all.length > 0) {                                                      // ← unchanged: emit drift only when there's something to report
    const conflictedClause = conflicted.length > 0                            // ← only add ", N conflicted" when relevant
      ? `, ${conflicted.length} conflicted`                                   // ← appended; otherwise empty string
      : '';                                                                   // ← clean output for the common no-conflict case
    drifts.push({                                                            // ← single drift entry, same envelope kind
      kind: 'uncommitted-state-mismatch',                                    // ← unchanged DriftKind
      expected: 'clean working tree',                                        // ← unchanged
      actual: `${all.length} uncommitted file(s) (${staged.length} staged, ${unstaged.length} unstaged${conflictedClause})`,  // ← NEW: bucket breakdown
      detail: all.slice(0, 10).join(', ') + (all.length > 10 ? ', …' : ''),  // ← preview unchanged in shape (per-bucket truncation is T5-5's scope)
    });
  }
```

**Why**: Realizes the issue's intent — operator now sees the staged/unstaged
split at the `actual=` line of the `[control:drift]` output. `detail`
preview is left unchanged on purpose: per-bucket truncation accounting and
`--verbose` are explicitly T5-5's (step 11.2) scope, and keeping `detail`
stable here lets that step layer cleanly on top without conflict.

**Risk**: Total count is now `new Set(...).size` instead of `dirty.length` —
a partial-staging file is counted ONCE in `all.length` but appears in BOTH
`staged.length` and `unstaged.length`. That means `staged + unstaged + conflicted
≥ all.length`. This is intentional and matches the rendering ("2 uncommitted
file(s) (1 staged, 1 unstaged)" reads correctly when the one staged and the
one unstaged are different files; the partial-staging case displays as "1
uncommitted file(s) (1 staged, 1 unstaged)" which is the operationally
correct surfacing of partial state). Document this with the inline `Set`
construction so a future reader can see the dedup is deliberate.

**Verify**: `npx vitest run tests/engine/ops/detect_drift.test.ts` — the Step
4 tests pin the new format string for the dominant cases.

**Rollback**: revert; the old import and call site come back. No other file
depends on the new format.

### Step 3: Add bucket regression tests for `uncommittedSnapshot` and `uncommittedFiles`

**File**: `tests/engine/state/git.test.ts` (append two new `describe` blocks after the existing `describe('git module', ...)`)

**Before** (current imports + module-only tests, ends at line 106):
```ts
import {                                                                     // ← imports
  isCleanTree,                                                               // ← used in module tests
  commitStep,                                                                // ← used in module tests
  createPhaseTag,                                                            // ← used
  currentBranch,                                                             // ← used
  lastCommitSha,                                                             // ← used
  describeRef,                                                               // ← used
  hasTag,                                                                    // ← used
} from '../../../src/engine/state/git.js';                                   // ← no uncommitted* tests today (the coverage gap)
...
describe('git module', () => { ... });                                       // ← existing block — unchanged
```

**After** (proposed change):
```ts
import {                                                                     // ← imports extended
  isCleanTree,                                                               // ← unchanged
  commitStep,                                                                // ← unchanged
  createPhaseTag,                                                            // ← unchanged
  currentBranch,                                                             // ← unchanged
  lastCommitSha,                                                             // ← unchanged
  describeRef,                                                               // ← unchanged
  hasTag,                                                                    // ← unchanged
  uncommittedFiles,                                                          // ← NEW: pulled in to exercise the wrapper
  uncommittedSnapshot,                                                       // ← NEW: pulled in to exercise the new helper
} from '../../../src/engine/state/git.js';                                   // ← same module
...
describe('git module', () => { ... });                                       // ← existing block — unchanged

describe('uncommittedSnapshot', () => {                                      // ← NEW: bucket coverage
  it('reports only unstaged for an untracked file', async () => {            // ← case A: ?? in XY
    await writeFile(join(tmp, 'a.txt'), 'a');                                // ← create untracked file
    const snap = await uncommittedSnapshot(tmp);                             // ← call new helper
    expect(snap.staged).toEqual([]);                                         // ← assert empty staged
    expect(snap.unstaged).toEqual(['a.txt']);                                // ← assert untracked landed in unstaged
    expect(snap.conflicted).toEqual([]);                                     // ← no conflicts
  });

  it('reports only staged after git add of a new file', async () => {       // ← case B: A_ in XY
    await writeFile(join(tmp, 'a.txt'), 'a');                                // ← create
    await simpleGit(tmp).add(['a.txt']);                                     // ← stage
    const snap = await uncommittedSnapshot(tmp);                             // ← call
    expect(snap.staged).toEqual(['a.txt']);                                  // ← only staged
    expect(snap.unstaged).toEqual([]);                                       // ← worktree clean post-add
    expect(snap.conflicted).toEqual([]);                                     // ← no conflicts
  });

  it('partial-staging: same file appears in BOTH staged and unstaged after stage-then-edit', async () => {  // ← case C: AM or MM
    await writeFile(join(tmp, 'a.txt'), 'a1');                               // ← create
    await simpleGit(tmp).add(['a.txt']);                                     // ← stage (X='A')
    await writeFile(join(tmp, 'a.txt'), 'a1\nmore');                         // ← re-edit (Y='M') — partial-staging state
    const snap = await uncommittedSnapshot(tmp);                             // ← call
    expect(snap.staged).toContain('a.txt');                                  // ← present in staged
    expect(snap.unstaged).toContain('a.txt');                                // ← also in unstaged — the key contract
    expect(snap.conflicted).toEqual([]);                                     // ← no conflicts
  });

  it('mixed staged + unstaged across different files', async () => {        // ← case D: two files, one staged one not
    await writeFile(join(tmp, 'staged.txt'), 's');                           // ← file 1
    await writeFile(join(tmp, 'wip.txt'), 'w');                              // ← file 2
    await simpleGit(tmp).add(['staged.txt']);                                // ← stage only file 1
    const snap = await uncommittedSnapshot(tmp);                             // ← call
    expect(snap.staged).toEqual(['staged.txt']);                             // ← file 1 staged
    expect(snap.unstaged).toEqual(['wip.txt']);                              // ← file 2 untracked → unstaged
  });

  it('renamed file lands in staged only', async () => {                     // ← case E: R_ in XY
    await writeFile(join(tmp, 'old.txt'), 'content');                        // ← create base
    await simpleGit(tmp).add(['old.txt']);                                   // ← stage
    await simpleGit(tmp).commit('add old');                                  // ← commit so rename detection has source
    await simpleGit(tmp).mv('old.txt', 'new.txt');                           // ← git mv → R in X
    const snap = await uncommittedSnapshot(tmp);                             // ← call
    expect(snap.staged).toContain('new.txt');                                // ← rename new path is staged
    expect(snap.unstaged).toEqual([]);                                       // ← not unstaged
    expect(snap.conflicted).toEqual([]);                                     // ← not conflicted
  });

  it('reports conflicts in a separate bucket after a merge collision', async () => {  // ← case F: U_ / _U / UU
    const g = simpleGit(tmp);                                                // ← convenience
    await writeFile(join(tmp, 'c.txt'), 'base\n');                           // ← base file
    await g.add(['c.txt']);                                                  // ← stage
    await g.commit('base');                                                  // ← commit base
    const baseBranch = (await g.status()).current ?? 'main';                 // ← capture default branch name (master OR main)
    await g.checkoutLocalBranch('feature');                                  // ← branch off
    await writeFile(join(tmp, 'c.txt'), 'feature\n');                        // ← diverge content
    await g.add(['c.txt']);                                                  // ← stage
    await g.commit('feat edit');                                             // ← commit feature side
    await g.checkout(baseBranch);                                            // ← back to base branch
    await writeFile(join(tmp, 'c.txt'), 'main\n');                           // ← diverge content other way
    await g.add(['c.txt']);                                                  // ← stage
    await g.commit('main edit');                                             // ← commit base side
    try { await g.merge(['feature']); } catch { /* merge throws on conflict — expected */ }  // ← trigger conflict
    const snap = await uncommittedSnapshot(tmp);                             // ← call
    expect(snap.conflicted).toContain('c.txt');                              // ← conflicted bucket populated
    expect(snap.staged).not.toContain('c.txt');                              // ← NOT staged
    expect(snap.unstaged).not.toContain('c.txt');                            // ← NOT unstaged — conflict short-circuits
  });
});

describe('uncommittedFiles (compatibility wrapper)', () => {                 // ← NEW: lock the external contract
  it('returns deduped union of all snapshot buckets', async () => {         // ← partial-staging dedup is the trickiest case
    await writeFile(join(tmp, 'a.txt'), 'a1');                               // ← create
    await simpleGit(tmp).add(['a.txt']);                                     // ← stage
    await writeFile(join(tmp, 'a.txt'), 'a1\nmore');                         // ← re-edit (partial-staging — in both buckets)
    await writeFile(join(tmp, 'b.txt'), 'b');                                // ← second file, only unstaged
    const files = await uncommittedFiles(tmp);                               // ← call wrapper
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);                        // ← a.txt deduped to one entry despite being in both buckets
  });
});
```

**Why**: Tests pin the bucket contract for every relevant `(X, Y)` pair the
helper handles: untracked (`??`), staged new (`A `), partial-staging (`AM`),
mixed across files, rename (`R `), and merge conflict (`UU` family). The
compatibility-wrapper test pins the external contract of `uncommittedFiles()`
so future refactors can't silently change it.

**Risk**: The conflict-synthesis test relies on `simpleGit.merge()` throwing
on conflict (it does) and on the default branch name detection (`(await
g.status()).current ?? 'main'`) — both established patterns in the existing
test file. Low risk. If `simple-git`'s default rename-detection threshold
changes and the rename test stops detecting the move, the test will fail
loudly and the fix is to use `g.raw(['mv', ...])` instead.

**Verify**: `npx vitest run tests/engine/state/git.test.ts`.

**Rollback**: revert just these test additions; production code unaffected.

### Step 4: Update existing drift test + add multi-bucket assertion

**File**: `tests/engine/ops/detect_drift.test.ts` (replace existing test at lines 70–75; add 2 new tests after it)

**Before** (current test):
```ts
it('returns uncommitted-state-mismatch when there are dirty files', async () => {  // ← only checks the kind exists
  await init('# State\n');                                                         // ← fixture: minimal state.md
  await writeFile(join(tmp, 'dirty.txt'), 'x');                                    // ← one untracked file
  const drifts = await detectDrift({ repo: tmp });                                 // ← run drift
  expect(drifts.some((d) => d.kind === 'uncommitted-state-mismatch')).toBe(true);  // ← weak assertion: shape not checked
});
```

**After** (proposed change):
```ts
it('returns uncommitted-state-mismatch with staged/unstaged breakdown', async () => {  // ← retitled to reflect the new contract
  await init('# State\n');                                                         // ← same fixture
  await writeFile(join(tmp, 'dirty.txt'), 'x');                                    // ← same one untracked file
  const drifts = await detectDrift({ repo: tmp });                                 // ← same call
  const d = drifts.find((x) => x.kind === 'uncommitted-state-mismatch');           // ← capture the specific entry
  expect(d).toBeDefined();                                                         // ← envelope present
  expect(d!.actual).toBe('1 uncommitted file(s) (0 staged, 1 unstaged)');          // ← pin the new format string exactly
});

it('reports both staged and unstaged counts in the breakdown', async () => {     // ← NEW: multi-bucket
  await init('# State\n');                                                         // ← same fixture pattern
  await writeFile(join(tmp, 'staged.txt'), 's');                                   // ← file 1
  await writeFile(join(tmp, 'wip.txt'), 'w');                                      // ← file 2
  await simpleGit(tmp).add(['staged.txt']);                                        // ← stage only file 1
  const drifts = await detectDrift({ repo: tmp });                                 // ← run drift
  const d = drifts.find((x) => x.kind === 'uncommitted-state-mismatch');           // ← capture
  expect(d?.actual).toBe('2 uncommitted file(s) (1 staged, 1 unstaged)');          // ← pin exact format
});

it('appends conflicted count only when a conflict exists', async () => {         // ← NEW: conflicted clause is conditional
  await init('# State\n');                                                         // ← same fixture
  const g = simpleGit(tmp);                                                        // ← convenience
  await writeFile(join(tmp, 'c.txt'), 'base\n');                                   // ← base content
  await g.add(['c.txt']);                                                          // ← stage
  await g.commit('base');                                                          // ← commit base
  const baseBranch = (await g.status()).current ?? 'main';                         // ← capture branch
  await g.checkoutLocalBranch('feature');                                          // ← branch off
  await writeFile(join(tmp, 'c.txt'), 'feature\n');                                // ← diverge
  await g.add(['c.txt']);                                                          // ← stage
  await g.commit('feat edit');                                                     // ← commit feature
  await g.checkout(baseBranch);                                                    // ← back
  await writeFile(join(tmp, 'c.txt'), 'main\n');                                   // ← diverge other way
  await g.add(['c.txt']);                                                          // ← stage
  await g.commit('main edit');                                                     // ← commit base side
  try { await g.merge(['feature']); } catch { /* expected */ }                     // ← trigger conflict
  const drifts = await detectDrift({ repo: tmp });                                 // ← run drift
  const d = drifts.find((x) => x.kind === 'uncommitted-state-mismatch');           // ← capture
  expect(d?.actual).toMatch(/, 1 conflicted/);                                     // ← conflicted clause appears
  expect(d?.actual).toMatch(/^1 uncommitted file\(s\)/);                           // ← count is the unioned cardinality (1, not 2)
});
```

(`simpleGit` is already imported at line 5 of the existing test file; no new
import needed.)

**Why**: Pins the exact format string at the contract boundary the operator
sees. The "kind exists" assertion alone was too weak — any future refactor
could silently change the format. The conflict test asserts that the
conditional clause appears only when relevant.

**Risk**: Format strings are now load-bearing assertions; if the format ever
needs to change (e.g., T5-5's `--verbose` work), these tests need a deliberate
update. That's the correct ergonomic — invisible format drift is exactly
what the original issue is about.

**Verify**: `npx vitest run tests/engine/ops/detect_drift.test.ts`.

**Rollback**: revert the test changes; the looser assertion comes back.

## Test Changes

- **Modified**: `tests/engine/ops/detect_drift.test.ts:70-75` — existing
  `'returns uncommitted-state-mismatch when there are dirty files'` test
  rewritten as `'returns uncommitted-state-mismatch with staged/unstaged
  breakdown'` with a precise format-string assertion.
- **Added**: 6 new tests in `tests/engine/state/git.test.ts`:
  `'uncommittedSnapshot'` describe block (5 tests covering untracked,
  staged-new, partial-staging, mixed, rename, conflict) +
  `'uncommittedFiles (compatibility wrapper)'` describe block (1 dedup test).
- **Added**: 2 new tests in `tests/engine/ops/detect_drift.test.ts`:
  `'reports both staged and unstaged counts in the breakdown'` (2-file
  multi-bucket assertion) and `'appends conflicted count only when a
  conflict exists'` (merge-conflict fixture, conditional clause assertion).
- **Net suite delta**: +8 test entries (5 + 1 + 2). Existing assertions
  preserved or strengthened.

## Post-Implementation Checks

1. `npx vitest run tests/engine/state/git.test.ts` — bucket tests pass.
2. `npx vitest run tests/engine/ops/detect_drift.test.ts` — drift tests pass.
3. `npx vitest run tests/cli/drift.test.ts` — CLI rendering still passes
   (it only asserts on `kind`, so it should be unaffected; verifies the
   integration end-to-end).
4. `npm run typecheck` — new `UncommittedSnapshot` interface compiles; new
   exports are consumed correctly by `detect_drift.ts`.
5. `npm test` — full suite, confirm zero regressions; target 507/507
   (current 499 + 8 new entries).

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| simple-git's `status.files[].index/.working_dir` shape changes in a future minor | Low | simple-git's `FileStatusResult` typing is stable; pinned at `9.0.x` in `package.json`. Tests fail loudly if it changes. |
| Rename detection threshold causes the rename test to flake | Low | If observed, replace `g.mv()` with `g.raw(['mv', '-f', 'old.txt', 'new.txt'])` for deterministic behavior. |
| Conflict fixture is slow (creates branches + merges) | Low | One test only; runs in <1s on a tmp repo. Within the 5000ms vitest timeout. |
| `detail` field's truncation behavior unchanged but ordering is now `[staged, unstaged, conflicted]` flattened | Low | Order is deterministic (same as the bucket order); test 4 doesn't pin `detail`. If T5-5 wants different ordering, it owns the change. |
| Operator scripts parsing the `actual=N uncommitted file(s)` line break | Negligible | No known external consumer; the change is additive (extra parenthetical clause); regex parsers on the existing prefix still match. No RPC/UI consumers identified in landscape scan. |

## Rollback Plan

If this commit causes problems after merge:
```
git revert <commit-sha>
```
(Pure code change. No DB, no config, no persisted-data shape. The
`uncommittedFiles()` external contract is preserved; reverting the helper
introduction is straightforward.)
The actual commit SHA will be filled in by `/relay-resolve` after the
commit lands.

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source verification (re-read against plan's BEFORE blocks)

- `src/engine/state/git.ts:90-102` — matches plan's Step 1 BEFORE block
  exactly. No drift between plan and current code.
- `src/engine/ops/detect_drift.ts:8` (import line) and `:93-103` (uncommitted
  block) — match plan's Step 2 BEFORE block exactly.
- `tests/engine/state/git.test.ts:1-106` — confirmed end-of-file at line
  106; no existing `uncommittedSnapshot` / `uncommittedFiles` describe
  blocks; imports list confirmed at lines 6–14 (the plan's Step 3 import
  additions are clean inserts).
- `tests/engine/ops/detect_drift.test.ts:70-75` — confirmed the existing
  `'returns uncommitted-state-mismatch when there are dirty files'` test
  matches the plan's Step 4 BEFORE block exactly. `simpleGit` is imported
  at line 5 (plan's "no new import needed" claim verified).
- `src/engine/types.ts:113-126` — `DriftKind` union is shape-neutral; my
  change to `actual` does not require a type update.

### Consumer fan-out (re-verified at review time)

- Grep for `uncommittedFiles|uncommittedSnapshot|UncommittedSnapshot` across
  the repo: 11 hits, of which exactly **one** is a production consumer
  (`src/engine/ops/detect_drift.ts`). All others are documentation /
  Relay / Control tracking files. Confirms the analysis's "single production
  caller" claim.
- Grep for `uncommitted-state-mismatch` across the repo: 12 hits — one in
  `src/engine/types.ts` (enum), one in `src/engine/ops/detect_drift.ts`
  (emit site), one in `tests/engine/ops/detect_drift.test.ts` (asserts
  `kind ===`). No RPC handler, no UI surface, no docs that pin the
  `actual=` format string. The plan's change is genuinely additive at the
  contract boundary.

### Edge Cases Tested

Applied every relevant scenario from `relay-config.md § Edge Cases` plus
drift-specific edges:

| Scenario | Result against the plan |
|----------|------------------------|
| **Detached HEAD** (existing detect_drift test at line 77–87 does this) | `simpleGit.status()` returns `files: []` when working tree is clean post-checkout. `uncommittedSnapshot` returns three empty arrays. `all.length === 0` → no drift entry. Existing branch-mismatch assertion still finds its entry. **PASS.** |
| **Empty repo / pre-initial-commit** | Not exercised by any existing test or production call site (commitStep always runs against an inited repo with the README seed). `simpleGit.status()` on a fresh-init unindexed repo populates `not_added` with anything written; XY = `??`. Lands in unstaged. No production consumer would hit this without an initial commit. **PASS.** |
| **Ignored files (`!!`)** | simple-git's parser `parser3("!", "!", (_result, _file) => {})` is a no-op (verified at `node_modules/simple-git/dist/esm/index.js:2740`). Ignored files never appear in `status.files`. The plan does not accidentally count them. **PASS.** |
| **Unicode / quoted paths** | simple-git decodes the `git status --porcelain` quoted-path format before exposing in `files[].path`. No special handling needed on our side. **PASS.** |
| **`.conductor/`-only changes** | All three filtered buckets become empty → `all.length === 0` → no drift entry. Same behavior as before the refactor (preserved invariant). **PASS.** |
| **Rename with worktree edit** (`RM` in XY: rename staged, then re-edit the new path) | simple-git's parser puts the new path into `status.renamed` AND `status.modified`. In our new XY-based bucketing, `x === 'R'` → staged; `y === 'M'` → unstaged. File appears in BOTH buckets — the "partial-staging" semantics extend correctly to renames. The rename-only test in Step 3 case E exercises `R ` (clean worktree); the `RM` variant is implicitly correct via the same XY logic but not explicitly tested. Acceptable: an exhaustive XY matrix would be 30+ tests, and the simple-git library's per-XY parsing is itself well-tested. |
| **Submodules** | Status code `S` is emitted for submodule state. Falls through our classification (not space, not `?`, not `U`, not in conflict pairs) → goes in staged. Operationally correct: a modified submodule is an index-side change. **PASS.** |
| **Concurrent file edits during drift** | `git status` is a point-in-time snapshot; race irrelevant. **PASS.** |
| **Project-specific: ProjectConfigSchema strict** | Not relevant; no schema change. **PASS.** |
| **Project-specific: `commitStep` requires explicit file list** | Not relevant; drift doesn't commit. **PASS.** |
| **Project-specific: `tracker.kind: 'none'`** | Not relevant; drift doesn't poll trackers. **PASS.** |
| **Project-specific: MOCK provider in tests** | Not relevant; drift is deterministic, no LLM call. **PASS.** |
| **Format string consumer concern: external scripts parsing `"N uncommitted file(s)"`** | The new format starts with the same `"N uncommitted file(s)"` prefix and ADDS a parenthetical clause. Any regex matching `/^\d+ uncommitted file\(s\)/` continues to match. The change is additive. **PASS.** |
| **Format string semantic concern: partial-staging count appears to "not add up"** | For a partial-staged file, `actual` reads `"1 uncommitted file(s) (1 staged, 1 unstaged)"`. The leading 1 is the unioned cardinality; the parenthetical is per-state counts. `staged.length + unstaged.length + conflicted.length ≥ all.length` is the documented invariant. **Decision: keep as-is.** Adding partial-staging up to 2 in the leading count would itself be misleading; the current rendering truthfully says "1 file in a partial-staging state." This is **documented in code via an inline comment near the `new Set(...).size` computation** (per the plan's Step 2 AFTER block — the `// dedups partial-staging files` comment captures this). |

### Issues Found

**LOW** — partial-staging format-string assertion is not explicitly pinned
at the `detect_drift` test layer. The plan covers partial-staging at the
snapshot layer (Step 3 case C asserts `snap.staged.toContain('a.txt')` AND
`snap.unstaged.toContain('a.txt')`), and the format string is deterministic
given the snapshot (Step 2's `actual=` template), so the partial-staging
rendering is **implicitly** covered by the combination of `(snapshot-test)
∘ (deterministic format template)`. An explicit `detect_drift` test would
be defense-in-depth — it would catch a future refactor that decouples
rendering from the snapshot. **Not blocking**; flagged for awareness.
Reasoning: the multi-bucket test (Step 4 test #2) already pins the
`"N uncommitted file(s) (S staged, U unstaged)"` template; the partial-
staging case differs only in arithmetic, not in template shape.

**No CRITICAL / HIGH / MEDIUM issues found.**

### Regression Risk

Walked every existing test against the planned changes:

- `tests/engine/state/git.test.ts § 'reports a clean tree after a fresh commit'` — uses `isCleanTree`, not touched. **PASS.**
- `tests/engine/state/git.test.ts § 'reports a dirty tree after an uncommitted edit'` — uses `isCleanTree`, not touched. **PASS.**
- `tests/engine/state/git.test.ts § 'commitStep ...'` (3 tests) — unrelated subsystem. **PASS.**
- `tests/engine/state/git.test.ts § 'createPhaseTag ...' / 'currentBranch / lastCommitSha / describeRef ...'` — unrelated. **PASS.**
- `tests/engine/ops/detect_drift.test.ts § 'returns state-md-missing ...' / 'returns state-md-template ...' / 'returns no drift when markers match git'` — repo is clean in these fixtures; new code returns three empty buckets; `all.length === 0` → no drift entry added. Existing assertions stand. **PASS.**
- `tests/engine/ops/detect_drift.test.ts § 'returns last-commit-mismatch ...' / 'returns branch-mismatch ...'` — both fixtures write `state.md` but otherwise leave the repo clean; new uncommitted code is unchanged in observable behavior (no drift entry). **PASS.**
- `tests/engine/ops/detect_drift.test.ts § 'flags branch-mismatch when git reports no current branch (detached HEAD)'` — checks out an existing sha (clean tree post-checkout). No uncommitted drift added by my code path. Test still finds branch-mismatch. **PASS.**
- `tests/engine/ops/detect_drift.test.ts § 'flags tag-mismatch when no tags exist ...' / 'trims surrounding whitespace ...'` — repo clean; same as above. **PASS.**
- `tests/cli/drift.test.ts § 'returns drifts and formats them as control:drift block'` — only asserts the `kind === 'state-md-missing'` entry and the `[control:drift]` wrapper. Format-string changes in `actual=` for `uncommitted-state-mismatch` do not affect this assertion. **PASS.**

No existing test will break. No previously-resolved item is at risk. The
analysis confirmed `.relay/implemented/` and `.relay/archive/` contain no
drift-subsystem siblings.

### Cross-item interaction check

- **`drift-truncates-file-list-at-10.md` (T5-5, step 11.2)** — depends on
  `uncommittedSnapshot()`. The plan preserves `detail` field's current
  shape (top-10 union slice with `, …` suffix) precisely so T5-5 has a
  clean canvas to add per-bucket truncation and `--verbose`. **PASS.**

### Verdict

**APPROVED.**

The plan is implementable as-written. The XY-based bucketing is the
correctness-safe partition for this refactor (verified against simple-git
source); the external `uncommittedFiles()` contract is preserved; tests
pin every bucket transition. Format-string changes are additive at the
operator's `[control:drift]` line and break no existing assertion.

The one LOW-severity finding (partial-staging detect_drift format-string
assertion) is not a blocker — it's belt-and-suspenders coverage that can
be added during implementation if the implementer wants to harden the
test layer further, OR deferred entirely. Recording it here as a note
rather than escalating to APPROVED-WITH-CHANGES because (a) the existing
plan's tests + the deterministic format template already cover this
implicitly, and (b) the operator's session directive favors keeping
verdicts unambiguous when no must-fix issue exists.

---

## Implementation Guidelines

*Date: 2026-05-12*

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

*Verified: 2026-05-12*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Add `UncommittedSnapshot` interface + `uncommittedSnapshot()` to `src/engine/state/git.ts`; redefine `uncommittedFiles()` over it | YES | YES |
| 2 | Thread snapshot through `src/engine/ops/detect_drift.ts`; render `(N staged, M unstaged[, K conflicted])` in `actual` | YES | YES |
| 3 | Add 6 bucket regression tests + 1 wrapper-dedup test in `tests/engine/state/git.test.ts` | YES | YES |
| 4 | Rewrite existing drift test to pin exact format + add 2 new tests (multi-bucket, conditional conflicted) in `tests/engine/ops/detect_drift.test.ts` | YES | YES |

### Test Results

- **Targeted run** (`npx vitest run tests/engine/state/git.test.ts tests/engine/ops/detect_drift.test.ts tests/cli/drift.test.ts`): **26/26 passing** in 9.92s. Every new test for `uncommittedSnapshot` (untracked, staged-new, partial-staging, mixed, rename, merge-conflict), `uncommittedFiles` (dedup wrapper), and `detectDrift` (multi-bucket format, conditional conflicted clause) passes on the first run.
- **Full suite** (`npm test`): **508/508 passing across 96 test files** in 16.76s. Baseline was 499/499; net +9 (snapshot describe: +6, wrapper describe: +1, drift describe: +2). The plan estimated +8; the off-by-one is from the snapshot block having 6 tests rather than 5 — accounting refinement, no correctness impact.
- **Typecheck** (`npm run typecheck` — both `tsc --noEmit` for engine and `tsc --noEmit -p tsconfig.ui.json` for UI): clean exit. The new `UncommittedSnapshot` export is consumed correctly by `detect_drift.ts` and the test file.

### Issues Found

None.

- Re-read `src/engine/state/git.ts:90-145` (the new `uncommittedSnapshot` body) end-to-end: XY classification correct, conflict short-circuit ordered correctly (before staged/unstaged tests), `[...new Set(...)]` dedup applied per bucket. `uncommittedFiles()` external contract preserved (returns flat deduped union of all three buckets).
- Re-read `src/engine/ops/detect_drift.ts:93-114` (the new uncommitted block) end-to-end: filter applied per bucket via the `notConductor` predicate, total cardinality via `new Set` (partial-staging dedups to 1 in the total), conditional conflicted clause inserts only when `conflicted.length > 0`, `detail` shape preserved for T5-5's downstream consumption.
- The LOW-severity finding from the adversarial review (no explicit partial-staging detect_drift format test) remains as flagged. The snapshot helper test pins the partial-staging behavior at the data layer; the format template is deterministic given the snapshot; the partial-staging RENDER path is implicitly covered. No fix applied — deferred per review.
- No undocumented deviations from the plan.
- No scope creep — diff is precisely the four planned step targets, no drive-by edits.

### Verdict

**COMPLETE.** All changes verified, all targeted + full-suite tests pass, no regressions, typecheck clean, no issues.


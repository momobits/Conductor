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

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/drift-truncates-file-list-at-10.md)

# `conductor drift` truncates uncommitted file list at 10 — targeted changes may be invisible

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T5-5*
*Severity: P2 — quality*

## Problem statement

The `uncommitted-state-mismatch` drift detail line lists the first 10
files and then truncates with `, …`. There is no way to see the full
list and no signal about how many files were dropped from the display.

A developer making a targeted change in a dirty working tree (e.g.,
"I'm editing only README.md") and running `conductor drift` to confirm
their change is reflected has no way to verify — the count changes
(18 → 19) but README.md may not be in the visible portion.

## Current state

- `src/engine/ops/detect_drift.ts:101`:
  ```ts
  detail: dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? ', …' : ''),
  ```
  The slice is unconditional; there's no flag, no env override, no
  "showing N of M" hint. Files are listed in whatever order `simple-git`'s
  `status` returns them — typically not modification-time order, so a
  freshly-touched file is not guaranteed to be in the first 10.
- T5.8 dogfood confirmed: adding README.md changed the count 18 → 19, but
  README.md was not visible in the truncated list. The user could not
  confirm their change was detected by drift.

## Impact

- **Targeted-change verification is broken**: the most common drift use
  case ("did my change get picked up?") is exactly the case the truncation
  defeats.
- **No escape hatch**: there is no `--verbose`, no env var, no way to see
  the rest of the list short of running `git status` separately.
- **Misleading "…"**: the user has no quantitative sense of how many files
  are hidden. "5 more" and "500 more" both display the same.
- **Minor friction in busy repos**: in repos with many dependencies / build
  artifacts, the count is routinely >10, so every drift call is partially
  hidden.

## Proposed fix

Three independent improvements; ship at least 1 and 2.

### 1. Quantify the truncation

```ts
const HEAD = 10;
const shown = dirty.slice(0, HEAD);
const hidden = dirty.length - shown.length;
const detail = shown.join(', ') + (hidden > 0 ? ` (… ${hidden} more)` : '');
```

So the user sees `, … 9 more` instead of `, …`.

### 2. Add `--verbose` to `conductor drift`

`src/cli/commands/drift.ts` should accept `--verbose` and render the full
file list when set. The structured Drift entries returned by `detectDrift`
can carry the full list; the CLI decides whether to truncate at render
time.

```ts
// Pseudocode in detect_drift.ts:
drifts.push({
  kind: 'uncommitted-state-mismatch',
  ...,
  detail: dirty.join(', '),       // store the full list
  preview: dirty.slice(0, HEAD),  // optional convenience field
});
```

Then in `src/cli/commands/drift.ts`, render `preview` or `detail` based on
the verbose flag.

### 3. Sort by recency

Pass `--sort=modification-time` to git status (or use `simple-git`'s
status output to sort by `mtime` post-hoc) so the truncated head shows the
files the user most recently touched. This makes the default 10-line
preview much more useful in practice — the file the user just edited is
guaranteed to be visible.

### Verification

- Add a regression test in `tests/engine/ops/detect_drift.test.ts` for
  the truncation format (assert the "N more" suffix appears when the count
  exceeds the head limit).
- Add a CLI test in `tests/cli/drift.test.ts` for the `--verbose` flag.

## Affected files

- `src/engine/ops/detect_drift.ts` — quantify truncation, optionally
  carry full list in the entry.
- `src/cli/commands/drift.ts` — accept `--verbose`; render accordingly.
- `src/engine/state/git.ts` — optionally extend `uncommittedFiles` /
  `uncommittedSnapshot` with mtime ordering (depends on whether T5-4 lands
  with the snapshot refactor).
- `src/engine/types.ts` — if a `preview` field is added to `Drift`, update
  the type.
- `tests/engine/ops/detect_drift.test.ts`, `tests/cli/drift.test.ts` —
  regression coverage.

---

## Analysis

*Analyzed: 2026-05-12*

### Validation
- **Problem still exists:** YES. At HEAD `d833cc0` (step 11.1's commit),
  `src/engine/ops/detect_drift.ts:111` still renders
  `detail: all.slice(0, 10).join(', ') + (all.length > 10 ? ', …' : '')`.
  Step 11.1 explicitly preserved this shape for 11.2 to extend.
- **`uncommittedSnapshot()` helper is now available** at
  `src/engine/state/git.ts:90-145` (post-11.1), returning
  `{staged, unstaged, conflicted}` — the dependency this issue cited as
  "depends on whether T5-4 lands" is resolved.
- **`src/cli/commands/drift.ts` has no Commander options yet** (verified
  by Explore landscape scan). `attachDrift()` is bare — adding
  `.option('--verbose', ...)` is a clean insert.
- **Proposed approach still valid**, with one scope refinement: drop
  proposal #3 (mtime sort) from this commit. simple-git's `status()` does
  not expose mtime; sort-by-recency would require per-file `fs.stat()`
  calls. No project mtime utility exists. Defer to a follow-up if dogfood
  re-flags it.

### Root Cause
- The original truncation at `detect_drift.ts:101` was a defensive cap
  written before the bucket structure existed, with no operator escape
  hatch and no count of hidden files. Now that 11.1 has buckets, the
  preview can be made bucket-aware: operators looking for "did my staged
  edit show up?" can read the `staged:` section directly, and
  `--verbose` lifts the cap.
- Not a symptom of a deeper issue — purely a UX layer fix.
- Sibling-root-cause: the original 11.1 (drift-doesnt-distinguish-...)
  shared the same architectural opportunity (bucket-aware drift). 11.1
  established the bucket data; 11.2 extends the bucket presentation.

### What This Means (User Impact)

**In plain terms:** Today, when `conductor drift` reports an uncommitted
state, the user sees the first 10 files and `, …` — no count of how
many more are hidden, no way to see the rest, and no bucket labels to
quickly find a file they care about. After the fix, operators see a
bucket-labeled preview with each bucket truncated at 10 and an explicit
`(… N more)` suffix, plus a `--verbose` flag that lifts the cap entirely.

**Scenario:** Alex makes a targeted edit to `README.md` in a working
tree that already has 18 dirty files. They run `conductor drift` to
confirm `README.md` is on the list.

**Before (current behavior, post-11.1):**
1. `[control:drift]` shows: `uncommitted-state-mismatch: ... actual=19
   uncommitted file(s) (5 staged, 14 unstaged) — detail: a.ts, b.ts,
   c.ts, d.ts, e.ts, f.ts, g.ts, h.ts, i.ts, j.ts, …`
2. `README.md` is not in the first 10; Alex can't tell from drift
   output whether it was picked up. The `actual` count went from 18 to
   19, so something changed — but Alex has no way to confirm it's
   their file without running `git status` separately.

**After (with fix):**
1. `[control:drift]` shows: `... detail: staged: a.ts, b.ts, c.ts, d.ts,
   e.ts (… 0 more) | unstaged: f.ts, g.ts, h.ts, i.ts, j.ts, k.ts, l.ts,
   m.ts, n.ts, README.md (… 4 more)`
2. The `staged` / `unstaged` labels let Alex jump straight to the
   bucket they expect `README.md` to be in.
3. If `README.md` is still in the hidden tail, Alex runs `conductor
   drift --verbose` and gets the full list.
4. The `(… N more)` suffix is now quantified per bucket — operators
   can size up "5 hidden" vs "500 hidden" at a glance.

### Blast Radius
- **Files modified:**
  - `src/engine/ops/detect_drift.ts` — extend `DetectDriftArgs` with
    `verbose?: boolean`; replace the flat-slice `detail` rendering with
    a bucket-labeled preview helper that respects `verbose`.
  - `src/cli/commands/drift.ts` — extend `DriftCliArgs` with
    `verbose?: boolean`; thread to `detectDrift`; add Commander
    `.option('--verbose', ...)` to `attachDrift`.
  - `tests/engine/ops/detect_drift.test.ts` — add bucket-prefix /
    per-bucket truncation / verbose-lifts-cap tests.
  - `tests/cli/drift.test.ts` — add a `--verbose` CLI test that drives
    the Commander program end-to-end.
- **Direct callers of `detectDrift`:**
  - `src/cli/commands/drift.ts:10` — `runDrift({ repo: args.cwd })`.
    Will be updated.
  - `tests/engine/ops/detect_drift.test.ts` (multiple sites) — direct
    fixtures. `verbose` is optional with default `false`, so existing
    callers unaffected.
- **Direct callers of `runDrift` / `formatDrift`:**
  - Only `attachDrift` and `tests/cli/drift.test.ts`. Confirmed by Explore.
  - No RPC handler exposes drift (Explore confirmed no `src/rpc/methods.ts`
    drift method).
  - No UI consumer.
- **`Drift` type shape unchanged:** no `preview` field added. The
  `detail` field continues to be a single string; bucket structure is
  encoded in the rendered prose, not in additional type fields. This
  keeps the diff scope minimal and the `Drift` envelope generic.
- **Format-string back-compat:** existing 11.1 tests assert on `actual`,
  not on `detail`. The new `detail` format (`"staged: ... | unstaged:
  ... | conflicted: ..."`) is a deliberate break of the prior flat list
  — but nobody asserts on it. Safe.
- **Past work regression risk:** None. 11.1 just shipped and is
  internally consistent with this plan.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for prose + symbol queries (Serena not declared in `relay-config.md`); main-session source reads.*

#### Findings

- **Target:** `.relay/implemented/drift-doesnt-distinguish-staged-vs-unstaged.md`
  - **Kind:** existing item (just resolved as 11.1)
  - **Evidence:** strong
  - **Why related:** 11.1 introduced `uncommittedSnapshot()` and
    deliberately preserved the `detail` field's shape so that 11.2 (this
    item) could extend it. 11.1's implementation doc § Caveats explicitly
    calls out: "`detail` field shape unchanged on purpose. Per-bucket
    truncation accounting and `--verbose` belong to step 11.2."
  - **Suggested handling:** keep narrow — 11.1 is closed; this is the
    follow-on commit it deliberately set up. No scope coupling needed.

#### Search Bounds

- Live codepath audit: complete (full `detectDrift`, `runDrift`,
  `formatDrift`, `attachDrift` bodies read; `DetectDriftArgs` interface
  read; CLI flag convention sampled via 3 sibling commands per Explore).
- Backlog codepath: complete (no other active item cites drift / `--verbose`
  / `Drift.detail`).
- Subsystem: complete (drift subsystem swept on 11.1; only 11.2 remains).
- Archive: complete (drift subsystem has no archived siblings other than 11.1).
- Implementation: complete (only `.relay/implemented/drift-doesnt-distinguish-staged-vs-unstaged.md`).
- Contract drift: complete (0 docs references to drift `detail` format
  beyond `docs/quickstart.md:160` one-liner; no RPC/UI consumer).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* The only strong-related finding is 11.1, which is already
resolved. 11.2's scope is precisely the follow-on that 11.1 set up.
mtime-sort proposal (#3) is dropped from this commit per feasibility
analysis — would require `fs.stat()` per file and adds IO surface
without clear dogfood evidence the simple-bucketed preview is
insufficient. Defer to future issue if needed.

### Approach

**Recommended approach:**

1. **`src/engine/ops/detect_drift.ts`:**
   - Extend `DetectDriftArgs` with `verbose?: boolean` (optional, default
     `false` via `??`).
   - Define a local helper `formatBucket(label, files, verbose)`:
     - Returns `null` when `files.length === 0` (caller filters empty
       buckets out of the join).
     - When `verbose`: returns `"${label}: ${files.join(', ')}"`.
     - Otherwise: slice at limit 10; suffix `" (… N more)"` only when
       `files.length > 10`.
   - Replace the flat `detail: all.slice(0, 10)...` line with a
     bucket-prefixed assembly: `[formatBucket('staged', staged, verbose),
     formatBucket('unstaged', unstaged, verbose), formatBucket('conflicted',
     conflicted, verbose)].filter(s => s !== null).join(' | ')`.
   - `actual` field unchanged from 11.1.

2. **`src/cli/commands/drift.ts`:**
   - Extend `DriftCliArgs` with `verbose?: boolean`.
   - `runDrift` passes `verbose` into `detectDrift`.
   - `attachDrift` gains `.option('--verbose', 'Show the full uncommitted
     file list (no per-bucket truncation)', false)` and the action
     receives `opts` with `verbose`.

3. **Tests:**
   - `tests/engine/ops/detect_drift.test.ts`: three new tests:
     a. `'detail prefixes each bucket and quantifies truncation per bucket'`
        — 12 unstaged files → assert `detail` starts with `unstaged:`,
        contains `(… 2 more)`, omits `staged:` and `conflicted:`.
     b. `'detail labels each non-empty bucket separately'` — 1 staged +
        2 unstaged → assert detail contains `staged: ...` AND `unstaged:
        ...` separated by ` | `.
     c. `'verbose=true lifts the per-bucket cap'` — 15 unstaged files,
        `detectDrift({repo, verbose: true})` → assert all 15 names present
        in `detail`; assert no `(… N more)` suffix.
   - `tests/cli/drift.test.ts`: extend to drive the Commander program
     with `--verbose`. Use `runDrift({cwd, verbose: true})` (the simplest
     plumbing path — the Commander `.action()` is thin and tests its
     thread-through via direct call rather than spawning a subprocess).
     Pattern mirrors the existing `'returns drifts and formats them as
     control:drift block'` test which uses `runDrift({cwd})` directly.

**Alternatives considered:**
- *Add a `preview?: string[]` field to the `Drift` type; CLI truncates
  at render time.* Rejected — bigger type-surface change for the same
  user-visible result. Per-bucket prefix in `detail` is sufficient.
- *Keep `detail` flat (one comma-separated list) but with the `(… N
  more)` suffix.* Rejected — phase-11 steps.md explicitly asks for
  "bucket-aware preview with per-bucket truncation accounting." Flat
  truncation loses the bucket-finding value (Alex's `README.md`
  scenario).
- *Use newline-separated `detail` for bucket clarity instead of `|`.*
  Rejected — `formatDrift` renders `detail` on a single line; newlines
  would break the `[control:drift]` envelope shape. `|` separator keeps
  it on one line.
- *Sort each bucket by mtime (proposal #3).* Rejected — out of scope.
  Requires per-file `fs.stat()` calls; no existing mtime utilities in
  the project; no dogfood evidence the bucket-labeled preview is
  insufficient on its own.

**Open questions:** None blocking. mtime-sort deferral, `|` vs newline
separator, `Drift` type stability all decided inline above.

---

## Implementation Plan

*Generated: 2026-05-12*

### Step 1: Extend `DetectDriftArgs` with `verbose?: boolean`; render bucket-prefixed `detail` with per-bucket truncation

**File**: `src/engine/ops/detect_drift.ts` (lines 10–12 interface; lines 93–116 uncommitted block)

**Before** (current code at HEAD `d833cc0`):
```ts
export interface DetectDriftArgs {            // ← interface declaration
  repo: string;                                // ← only field today
}                                              // ← no verbose option yet
...
  const snap = await uncommittedSnapshot(repo);  // ← 11.1: pull bucketed snapshot
  const notConductor = (f: string) =>           // ← reusable predicate
    !f.startsWith('.conductor/') && !f.startsWith('.conductor\\');  // ← drop conductor's own working files
  const staged = snap.staged.filter(notConductor);     // ← per-bucket filter
  const unstaged = snap.unstaged.filter(notConductor);  // ← per-bucket filter
  const conflicted = snap.conflicted.filter(notConductor);  // ← per-bucket filter
  // Use Set cardinality for the total: a partial-staged file (present in
  // both `staged` and `unstaged`) is one file, even though it contributes
  // to both per-state counts. `staged.length + unstaged.length + conflicted.length`
  // can exceed `all.length` by design — the parenthetical describes states,
  // not file counts.
  const all = [...new Set([...staged, ...unstaged, ...conflicted])];  // ← unioned set for total count
  if (all.length > 0) {                                                // ← only emit drift when something to report
    const conflictedClause = conflicted.length > 0 ? `, ${conflicted.length} conflicted` : '';  // ← conditional clause
    drifts.push({                                                       // ← emit drift entry
      kind: 'uncommitted-state-mismatch',                              // ← unchanged
      expected: 'clean working tree',                                  // ← unchanged
      actual: `${all.length} uncommitted file(s) (${staged.length} staged, ${unstaged.length} unstaged${conflictedClause})`,  // ← bucket counts in headline
      detail: all.slice(0, 10).join(', ') + (all.length > 10 ? ', …' : ''),  // ← THE GAP: flat truncation at 10, no quantification, no bucket labels, no escape hatch
    });
  }
```

**After** (proposed change):
```ts
export interface DetectDriftArgs {            // ← interface gains a verbose option
  repo: string;                                // ← unchanged
  /** When true, lift the per-bucket preview truncation in
   *  `uncommitted-state-mismatch` detail; the CLI's `--verbose` flag
   *  threads through to this. Default behavior (false) caps each
   *  bucket at 10 with a `(… N more)` suffix. */
  verbose?: boolean;                           // ← NEW optional flag
}                                              // ← end interface
...
  const snap = await uncommittedSnapshot(repo);   // ← unchanged
  const notConductor = (f: string) =>             // ← unchanged predicate
    !f.startsWith('.conductor/') && !f.startsWith('.conductor\\');  // ← unchanged
  const staged = snap.staged.filter(notConductor);     // ← unchanged
  const unstaged = snap.unstaged.filter(notConductor);  // ← unchanged
  const conflicted = snap.conflicted.filter(notConductor);  // ← unchanged
  // Use Set cardinality for the total: a partial-staged file (present in
  // both `staged` and `unstaged`) is one file, even though it contributes
  // to both per-state counts. `staged.length + unstaged.length + conflicted.length`
  // can exceed `all.length` by design — the parenthetical describes states,
  // not file counts.
  const all = [...new Set([...staged, ...unstaged, ...conflicted])];  // ← unchanged
  if (all.length > 0) {                                                // ← unchanged guard
    const conflictedClause = conflicted.length > 0 ? `, ${conflicted.length} conflicted` : '';  // ← unchanged
    // 11.2: render per-bucket preview with quantified truncation.       // ← rationale comment for future readers
    // Each non-empty bucket is labeled and capped at LIMIT files, with   // ← describes new behavior
    // a `(… N more)` suffix when more are hidden. `verbose` lifts the   // ← describes verbose mode
    // cap entirely. Empty buckets are omitted (no `staged:` prefix      // ← describes empty-bucket behavior
    // when staged is empty).                                            // ← end rationale
    const LIMIT = 10;                                                   // ← named constant; per-bucket cap
    const verbose = args.verbose ?? false;                              // ← read flag with default
    const formatBucket = (label: string, files: string[]): string | null => {  // ← per-bucket renderer
      if (files.length === 0) return null;                              // ← empty bucket → omitted from output
      const shown = verbose ? files : files.slice(0, LIMIT);            // ← verbose shows all; default slices at LIMIT
      const hidden = files.length - shown.length;                       // ← count of files not shown
      const suffix = hidden > 0 ? ` (… ${hidden} more)` : '';           // ← quantified suffix only when hiding
      return `${label}: ${shown.join(', ')}${suffix}`;                  // ← assemble per-bucket prose
    };                                                                   // ← end helper
    const detailParts = [                                                // ← assemble in bucket order
      formatBucket('staged', staged),                                    // ← staged first (matches `actual` clause order)
      formatBucket('unstaged', unstaged),                                // ← unstaged second
      formatBucket('conflicted', conflicted),                            // ← conflicted last
    ].filter((s): s is string => s !== null);                            // ← drop empty-bucket nulls
    drifts.push({                                                        // ← emit drift entry (envelope unchanged)
      kind: 'uncommitted-state-mismatch',                                // ← unchanged
      expected: 'clean working tree',                                    // ← unchanged
      actual: `${all.length} uncommitted file(s) (${staged.length} staged, ${unstaged.length} unstaged${conflictedClause})`,  // ← unchanged
      detail: detailParts.join(' | '),                                   // ← bucket-prefixed, `|`-separated
    });                                                                   // ← end emit
  }                                                                       // ← end guard
```

**Why**: Realizes the issue's three core asks (quantify hidden count;
allow escape hatch; bucket-aware preview) in one pass. The `verbose`
flag is plumbed through `DetectDriftArgs` so the engine controls the
rendering — consistent with 11.1's pattern of pre-formatting `detail` /
`actual` in the engine. The `|` separator keeps `detail` on one line
so `formatDrift`'s envelope remains a single-line `[control:drift]`
entry.

**Risk**: `detail` format is a deliberate break of the post-11.1 flat
shape. No existing test asserts on `detail` for `uncommitted-state-mismatch`
(11.1 only pinned `actual`; the pre-11.1 test was rewritten to pin
`actual` too). Confirmed by `grep "detail" tests/engine/ops/detect_drift.test.ts`
having no hits on uncommitted-state-mismatch context.

**Verify**: `npx vitest run tests/engine/ops/detect_drift.test.ts`.

**Rollback**: revert this commit; `detail` returns to flat slice.

### Step 2: Add `--verbose` flag to `conductor drift`; thread through to `detectDrift`

**File**: `src/cli/commands/drift.ts` (lines 5–11 interface + runDrift; lines 24–34 attachDrift)

**Before** (current code at HEAD `d833cc0`):
```ts
export interface DriftCliArgs {              // ← interface
  cwd: string;                                // ← only field
}                                              // ← no verbose option

export async function runDrift(args: DriftCliArgs): Promise<Drift[]> {  // ← single-pass invocation
  return detectDrift({ repo: args.cwd });    // ← only repo is forwarded
}                                              // ← end runDrift
...
export function attachDrift(program: Command): void {                 // ← Commander wiring
  program                                                              // ← top-level program
    .command('drift')                                                 // ← subcommand name
    .description('Print drift between .conductor/state.md and git')   // ← help text
    .action(async () => {                                             // ← no options today; bare action
      const drifts = await runDrift({ cwd: process.cwd() });          // ← run without flags
      // eslint-disable-next-line no-console
      console.log(formatDrift(drifts));                               // ← print to stdout
      if (drifts.length > 0) process.exitCode = 1;                    // ← non-zero exit when drift detected
    });
}
```

**After** (proposed change):
```ts
export interface DriftCliArgs {              // ← interface gains verbose
  cwd: string;                                // ← unchanged
  /** When true, lift the per-bucket truncation in the
   *  `uncommitted-state-mismatch` drift entry's `detail`. */
  verbose?: boolean;                           // ← NEW optional flag
}                                              // ← end interface

export async function runDrift(args: DriftCliArgs): Promise<Drift[]> {  // ← signature unchanged
  return detectDrift({ repo: args.cwd, verbose: args.verbose });  // ← thread verbose to engine
}                                              // ← end runDrift
...
export function attachDrift(program: Command): void {                 // ← Commander wiring
  program                                                              // ← top-level program
    .command('drift')                                                 // ← subcommand name
    .description('Print drift between .conductor/state.md and git')   // ← help text
    .option('--verbose', 'Show the full uncommitted file list (no per-bucket truncation)', false)  // ← NEW flag; default false
    .action(async (opts: { verbose?: boolean }) => {                  // ← action receives opts from Commander
      const drifts = await runDrift({ cwd: process.cwd(), verbose: opts.verbose });  // ← pass through
      // eslint-disable-next-line no-console
      console.log(formatDrift(drifts));                               // ← unchanged
      if (drifts.length > 0) process.exitCode = 1;                    // ← unchanged
    });
}
```

**Why**: Operator escape hatch for the truncation. Default `false`
preserves the bucketed-truncation default; `--verbose` flips it off.
Mirrors the established Commander pattern observed in `daemon.ts`
(`.option('--detach', '...', false)`) and `import.ts` (`.option('--dry-run', '...', false)`).

**Risk**: None meaningful. Adds a new CLI flag with a safe default;
no caller is forced to update.

**Verify**: `npx vitest run tests/cli/drift.test.ts`.

**Rollback**: revert this commit; flag and threading disappear.

### Step 3: Add per-bucket truncation + verbose tests in `detect_drift.test.ts`

**File**: `tests/engine/ops/detect_drift.test.ts` (append three new tests after the existing `'appends conflicted count only when a conflict exists'` test)

**Before** (current end of file post-11.1, around line 115):
```ts
  it('appends conflicted count only when a conflict exists', async () => {  // ← 11.1's last drift test
    ...                                                                       // ← merge-conflict fixture body
    expect(d?.actual).toMatch(/, 1 conflicted/);                            // ← conflicted clause assertion
    expect(d?.actual).toMatch(/^1 uncommitted file\(s\)/);                  // ← count assertion
  });                                                                         // ← end of test body
});                                                                          // ← describe block closer
```

**After** (proposed change — add three new `it` blocks before the closing `});`):
```ts
  it('appends conflicted count only when a conflict exists', async () => {  // ← 11.1's test, unchanged
    ...                                                                       // ← unchanged
    expect(d?.actual).toMatch(/, 1 conflicted/);                            // ← unchanged
    expect(d?.actual).toMatch(/^1 uncommitted file\(s\)/);                  // ← unchanged
  });                                                                         // ← end 11.1's test

  it('detail prefixes each bucket and quantifies per-bucket truncation', async () => {  // ← NEW
    await init('# State\n');                                                 // ← fixture
    for (let i = 0; i < 12; i++) await writeFile(join(tmp, `f${i}.txt`), 'x');  // ← create 12 untracked files
    const drifts = await detectDrift({ repo: tmp });                         // ← no verbose; default truncation
    const d = drifts.find((x) => x.kind === 'uncommitted-state-mismatch');   // ← grab drift
    expect(d?.detail).toMatch(/^unstaged: /);                                // ← bucket prefix present
    expect(d?.detail).toMatch(/\(… 2 more\)/);                               // ← quantified suffix (12 - 10 = 2)
    expect(d?.detail).not.toMatch(/staged: /);                               // ← empty staged bucket omitted
    expect(d?.detail).not.toMatch(/conflicted: /);                           // ← empty conflicted bucket omitted
  });

  it('detail labels each non-empty bucket separately, joined by `|`', async () => {  // ← NEW
    await init('# State\n');                                                 // ← fixture
    await writeFile(join(tmp, 'staged.txt'), 's');                           // ← one staged
    await writeFile(join(tmp, 'wip.txt'), 'w');                              // ← one unstaged
    await simpleGit(tmp).add(['staged.txt']);                                // ← stage one
    const drifts = await detectDrift({ repo: tmp });                         // ← run
    const d = drifts.find((x) => x.kind === 'uncommitted-state-mismatch');   // ← grab
    expect(d?.detail).toBe('staged: staged.txt | unstaged: wip.txt');        // ← exact format
  });

  it('verbose=true lifts the per-bucket truncation cap', async () => {       // ← NEW
    await init('# State\n');                                                 // ← fixture
    for (let i = 0; i < 15; i++) await writeFile(join(tmp, `f${i.toString().padStart(2, '0')}.txt`), 'x');  // ← 15 padded names (deterministic sort within bucket)
    const drifts = await detectDrift({ repo: tmp, verbose: true });          // ← verbose true
    const d = drifts.find((x) => x.kind === 'uncommitted-state-mismatch');   // ← grab
    expect(d?.detail).not.toMatch(/more\)/);                                 // ← no truncation suffix
    expect(d?.detail).toMatch(/f00\.txt/);                                   // ← first file present
    expect(d?.detail).toMatch(/f14\.txt/);                                   // ← last file present (would be hidden in non-verbose)
  });
});
```

**Why**: Pins the three contract changes — bucket prefix presence,
per-bucket quantified truncation, empty-bucket omission, exact
multi-bucket join shape, and verbose-lifts-cap. Padded filenames in the
verbose test give deterministic ordering for the `f00` / `f14`
assertions (simple-git returns paths from porcelain output;
lexicographic on the padded names puts them at the boundary positions).

**Risk**: The "first file / last file" assertions in the verbose test
rely on `status.files[]` ordering being lexicographic. simple-git's
parser preserves the order from `git status --porcelain`, which for
untracked files is typically lexicographic via the working directory's
default scan order — but not guaranteed by any contract. **Mitigation**:
assert on file *presence* (`toMatch`), not position. The presence of
`f14.txt` proves it wasn't truncated regardless of position.

**Verify**: `npx vitest run tests/engine/ops/detect_drift.test.ts`.

**Rollback**: revert just these test additions; production code unaffected.

### Step 4: Add a CLI test for `--verbose` plumbing

**File**: `tests/cli/drift.test.ts` (append one new test to the existing describe block)

**Before** (current single-test file at HEAD `d833cc0`):
```ts
describe('conductor drift', () => {                                          // ← single existing test
  it('returns drifts and formats them as control:drift block', async () => {  // ← unchanged
    ...                                                                       // ← body
  });                                                                         // ← end test
});                                                                          // ← describe closer
```

**After** (proposed change):
```ts
describe('conductor drift', () => {                                          // ← unchanged
  it('returns drifts and formats them as control:drift block', async () => {  // ← unchanged
    ...                                                                       // ← unchanged body
  });                                                                         // ← end existing test

  it('runDrift threads --verbose through to detectDrift', async () => {     // ← NEW
    // Create 12 untracked files so non-verbose would truncate at 10.        // ← justify file count
    for (let i = 0; i < 12; i++) await writeFile(join(tmp, `g${i.toString().padStart(2, '0')}.txt`), 'x');  // ← seed
    const driftsNonVerbose = await runDrift({ cwd: tmp });                   // ← call without flag
    const dNon = driftsNonVerbose.find((x) => x.kind === 'uncommitted-state-mismatch');  // ← grab
    expect(dNon?.detail).toMatch(/\(… 2 more\)/);                            // ← default: 2 hidden
    const driftsVerbose = await runDrift({ cwd: tmp, verbose: true });       // ← call WITH flag
    const dVerbose = driftsVerbose.find((x) => x.kind === 'uncommitted-state-mismatch');  // ← grab
    expect(dVerbose?.detail).not.toMatch(/more\)/);                          // ← verbose: no truncation
    expect(dVerbose?.detail).toMatch(/g11\.txt/);                            // ← last file present (would be hidden in non-verbose)
  });
});
```

**Why**: Drives the CLI surface (`runDrift({...verbose})`) end-to-end.
Doesn't spawn a Commander subprocess — Commander's `.action()` is a
thin closure over `runDrift`, and testing the closure isn't valuable
relative to testing the function it calls. The existing CLI test uses
the same pattern (`runDrift({cwd})`), so this mirrors the established
convention.

**Risk**: Same lexicographic-ordering caveat as Step 3. Same mitigation:
assert on presence, not position.

**Verify**: `npx vitest run tests/cli/drift.test.ts`.

**Rollback**: revert this test addition; CLI plumbing test disappears.

## Test Changes

- **Added**: 3 new tests in `tests/engine/ops/detect_drift.test.ts`:
  bucket-prefix-quantified-truncation, multi-bucket-joined-by-pipe,
  verbose-lifts-cap.
- **Added**: 1 new test in `tests/cli/drift.test.ts`:
  runDrift-threads-verbose.
- **Net suite delta**: +4 test entries. Existing 11.1 assertions
  preserved.

## Post-Implementation Checks

1. `npx vitest run tests/engine/ops/detect_drift.test.ts` — drift op tests pass.
2. `npx vitest run tests/cli/drift.test.ts` — CLI tests pass.
3. `npx vitest run tests/engine/state/git.test.ts` — 11.1 snapshot tests untouched, still pass.
4. `npm run typecheck` — new `verbose?: boolean` field on both interfaces compiles; CLI option type matches Commander expectation.
5. `npm test` — full suite, confirm zero regressions; target 512/512 (current 508 + 4 new).

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Operator scripts parse the post-11.1 flat `detail` format | Very low | No known external consumer; `detail` was a free-form string. New format is also free-form, just bucket-prefixed. |
| `simple-git` `status.files[]` ordering changes across versions | Low | Tests assert on file *presence* (`toMatch` patterns), not array position. Lexicographic-padded names give deterministic test behavior in practice. |
| Commander treats `--verbose` differently from other flags (e.g., counts occurrences) | Negligible | `.option('--verbose', '...', false)` is the standard boolean-flag form; identical to existing `.option('--detach', '...', false)` in `daemon.ts`. |
| `detail` line gets long with many bucket labels | Low | At most three bucket prefixes (`staged: ... | unstaged: ... | conflicted: ...`), each capped at 10 in default mode (~12 chars + 10 filenames ≈ 150 chars). Acceptable on standard terminals; `--verbose` is the escape hatch for full output. |

## Rollback Plan

If this commit causes problems after merge:
```
git revert <commit-sha>
```
Pure code change. No DB, no config, no persisted-data shape. The new
`detail` format is presentation-only; the previous post-11.1 format is
restored on revert. The `--verbose` flag is additive; reverting removes it.

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source verification (re-read at review time against plan BEFORE blocks)

- `src/engine/ops/detect_drift.ts:10-12` (interface) and `:93-113`
  (uncommitted block) — match the plan's Step 1 BEFORE block exactly.
- `src/cli/commands/drift.ts:5-11` (interface + `runDrift`) and `:24-34`
  (`attachDrift`) — match the plan's Step 2 BEFORE block exactly.
- `tests/cli/drift.test.ts:1-29` — confirmed setup uses `beforeEach`
  with `mkdtemp` + `simpleGit().init()` + `.conductor/` mkdir + `--allow-empty`
  initial commit; `afterEach` rms tmp. **Plan-time omission noted**:
  the existing CLI test file does NOT import `writeFile` from
  `node:fs/promises`. The plan's Step 4 test writes files into `tmp`,
  so the import line needs to be added. Treating this as a known
  implementation detail (one-line import); not a plan defect.

### Edge cases tested

| Scenario | Result against the plan |
|----------|-------------------------|
| **Empty working tree** | `all.length === 0` (post-`notConductor` filter), drift entry not emitted (`if (all.length > 0)` guard intact). `formatBucket` never invoked. **PASS.** |
| **Only one non-empty bucket** | e.g. unstaged-only: `formatBucket('staged', [])` returns null, filtered out; `detail = "unstaged: ..."`. No leading or trailing `|`. **PASS.** |
| **All buckets empty after `.conductor/` filter** | Same as empty working tree — `all.length === 0`, no drift. **PASS.** |
| **`.conductor/` files mixed with regular files** | Filter applied per bucket before `formatBucket`; only non-`.conductor/` files counted and rendered. Preserves the 11.1 invariant. **PASS.** |
| **Partial-staging file (in both `staged` and `unstaged`)** | Appears in BOTH bucket previews — exactly the intent (surface the partial state). Operator sees `"staged: a.txt | unstaged: a.txt"`. **PASS.** |
| **Verbose + 0 files** | Same as empty: no drift emitted. **PASS.** |
| **Verbose + 1 file in 1 bucket** | `formatBucket` slices nothing (`files.length <= LIMIT`), no `(… N more)` suffix; `detail = "unstaged: a.txt"`. **PASS.** |
| **Exactly 10 files in one bucket (boundary)** | `shown.length === files.length`, `hidden === 0`, suffix empty. No `(… 0 more)` noise. **PASS.** |
| **11 files in one bucket (boundary +1)** | `shown.length === 10`, `hidden === 1`, suffix `" (… 1 more)"`. **PASS.** |
| **Conflict + staged + unstaged simultaneously** | All three buckets non-empty → `detail = "staged: ... | unstaged: ... | conflicted: ..."`. Conflict short-circuit in `uncommittedSnapshot` ensures the same file doesn't appear in multiple buckets simultaneously (conflict takes precedence). **PASS.** |
| **`|` character in file names** | Filenames containing `|` would make `detail` ambiguous to a hypothetical downstream parser. No `Drift.detail` consumer parses for structure — only `formatDrift` interpolates it as opaque text. Not a regression; flag as a future caveat if a downstream parser is ever introduced. **PASS (acceptable).** |
| **Long lines** | 3 buckets × (10 filenames + label + " (… N more)") ≈ 200–300 chars typical, up to ~600 chars on long paths. `formatDrift` puts this on one line of `[control:drift]` output. Acceptable on standard terminals; `--verbose` is the escape hatch (and its long output is exactly what the user asked for). **PASS.** |
| **`--verbose=false` Commander default** | `.option('--verbose', '...', false)` — Commander treats this as a boolean flag with default `false`. `opts.verbose` is `undefined` when not passed, `true` when passed. `args.verbose ?? false` in `detectDrift` normalizes both `undefined` and `false` to `false`. **PASS.** |
| **`runDrift({cwd})` (existing 11.1 callers)** | `verbose` defaults to `undefined` → `args.verbose ?? false` → `false` in `detectDrift` → bucket-prefixed default-truncated detail. Existing test fixtures still emit drift entries with the new shape, but they assert on `kind` only (not `detail`). **PASS.** |
| **Project-specific: ProjectConfigSchema strict** | No schema change. **PASS.** |
| **Project-specific: `tracker.kind: 'none'`** | Drift doesn't poll trackers. **PASS.** |
| **Project-specific: MOCK provider for tests** | Drift is deterministic; no LLM. **PASS.** |

### Issues Found

**LOW** — CLI Commander layer is not exercised end-to-end. The Step 4
test calls `runDrift({cwd, verbose: true})` directly, mirroring the
existing `'returns drifts and formats them as control:drift block'`
test. This tests the `runDrift` → `detectDrift` thread-through but
does NOT test the `.option('--verbose', ...)` → `opts.verbose`
parsing inside Commander's `.action()`. **Trade-off accepted**: the
existing CLI test pattern in this repo (verified by Explore against
3 sibling commands and confirmed here) consistently treats Commander
as a trusted library layer; tests target the underlying functions.
A bug in `.option(...)` syntax would surface on the first operator
invocation (`conductor drift --verbose`). Not blocking; flagged for
awareness.

**LOW** — Plan-time omission: `tests/cli/drift.test.ts` does not
import `writeFile` from `node:fs/promises`. The plan's Step 4 test
needs to seed 12 untracked files. Add `writeFile` to the imports
line during implementation. One-line fix; not a plan defect.

**No CRITICAL / HIGH / MEDIUM issues found.**

### Regression Risk

Walked every existing test against the planned changes:

- 11.1's `uncommittedSnapshot` describe block (7 tests) — touches
  `git.ts` only. Untouched by 11.2. **PASS.**
- 11.1's `uncommittedFiles (compatibility wrapper)` test — touches
  `git.ts` only. **PASS.**
- 11.1's `detect_drift` tests:
  - `'returns uncommitted-state-mismatch with staged/unstaged breakdown'` —
    asserts `actual: '1 uncommitted file(s) (0 staged, 1 unstaged)'`.
    My change only modifies `detail`. `actual` unchanged. **PASS.**
  - `'reports both staged and unstaged counts in the breakdown'` —
    asserts on `actual`. **PASS.**
  - `'appends conflicted count only when a conflict exists'` —
    asserts on `actual`. **PASS.**
- All `state-md-*` / `branch-mismatch` / `last-commit-mismatch` /
  `tag-mismatch` tests in `detect_drift.test.ts` — drift entries
  emitted by separate code paths in `detectDrift`; my change is
  scoped to the uncommitted-state-mismatch block. **PASS.**
- `tests/cli/drift.test.ts § 'returns drifts and formats them as
  control:drift block'` — asserts on `kind === 'state-md-missing'`
  and the `[control:drift]` wrapper. Uncommitted-state-mismatch
  format change doesn't affect this fixture (clean working tree
  pre-`.conductor/` mkdir means no uncommitted-state-mismatch
  drift entry is even produced). **PASS.**

No existing test will break.

### Cross-item interaction check

- **Step 11.1 (`drift-doesnt-distinguish-staged-vs-unstaged.md`)** —
  resolved; my code consumes `uncommittedSnapshot()` and preserves
  `actual` field shape. No risk to 11.1's invariants. **PASS.**

### Verdict

**APPROVED.**

The plan is implementable as-written. The `verbose` plumbing is minimal
and additive (one optional bool on each interface); the `detail`
format change is presentation-only with no downstream consumer; the
Commander pattern mirrors existing CLI commands. The two LOW-severity
findings (untested Commander layer + missing `writeFile` import) are
known-acceptable and one-line respectively, surfaced for the
implementer to address inline. No blockers.

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
| 1 | Extend `DetectDriftArgs` with `verbose?`; render bucket-prefixed `detail` with per-bucket truncation | YES | YES |
| 2 | Add `--verbose` flag to `conductor drift`; thread through `DriftCliArgs` to `detectDrift` | YES | YES |
| 3 | 3 new tests in `tests/engine/ops/detect_drift.test.ts` | YES | YES (after one regex fix) |
| 4 | 1 new test in `tests/cli/drift.test.ts` | YES | YES (after one fixture fix) |

### Test Results

- **First targeted run:** 28/30 — two test-only failures (both my-test bugs, not implementation defects). See Verification Fixes below.
- **Targeted run after fixes** (`npx vitest run tests/engine/ops/detect_drift.test.ts tests/cli/drift.test.ts tests/engine/state/git.test.ts`): **30/30 passing** in 9.96s.
- **Full suite** (`npm test`): **512/512 passing across 96 test files** in 15.80s. Baseline was 508/508; net +4 — matches the plan estimate exactly.
- **Typecheck** (`npm run typecheck`): clean exit for both engine (`tsc --noEmit`) and UI (`tsc --noEmit -p tsconfig.ui.json`).

### Issues Found

Both caught on first run, both test-side fixes (no production code change required). Documented as Verification Fixes below.

### Verification Fixes

**Fix 1 — Regex precision in bucket-prefix omission assertion**

- **Problem:** Test `'detail prefixes each bucket and quantifies per-bucket truncation'` used `not.toMatch(/staged: /)` to assert the empty `staged` bucket is omitted. Actual `detail` was `"unstaged: f00.txt, ..."` — which CONTAINS the substring `staged: ` (inside `unstaged: `), so the negation failed.
- **Fix:** Anchored the regex to bucket-prefix positions only: `/(?:^|\| )staged: /` — matches the literal `staged: ` only at start-of-string or immediately after the bucket separator `| `. Same fix for the `conflicted` check. Added inline comment explaining the anchor.
- **Files modified:** `tests/engine/ops/detect_drift.test.ts` only.
- **Risk:** None — the new regex is stricter and more semantically correct.
- **Rollback:** revert this fix; the test would over-trigger on the `unstaged` substring.

**Fix 2 — CLI test fixture missing `state.md`**

- **Problem:** Test `'runDrift threads --verbose through to detectDrift'` called `runDrift({cwd: tmp})` against a fixture that creates `.conductor/` but no `state.md`. `detectDrift` early-returns on missing state.md (`detect_drift.ts:35-43`), so the `uncommitted-state-mismatch` entry was never emitted; `dNon?.detail` was undefined.
- **Fix:** Added `await writeFile(join(tmp, '.conductor', 'state.md'), '# State\n')` at the top of the test, before seeding the 12 files. Mirrors the pattern used in `detect_drift.test.ts`'s uncommitted-state-mismatch tests (`await init('# State\n')`).
- **Files modified:** `tests/cli/drift.test.ts` only.
- **Risk:** None — the existing `'returns drifts and formats them as control:drift block'` test in the same file intentionally omits state.md to exercise the `state-md-missing` path. The two tests now exercise distinct branches; no fixture conflict.
- **Rollback:** revert this fix; the test would fail with `dNon?.detail` undefined.

### Verdict

**COMPLETE.** All four planned steps implemented; both verification-time test bugs fixed inline; 512/512 passing; typecheck clean. Plan's net-+4 test estimate matches exactly. No production code defects surfaced — both issues were in the new test cases themselves.



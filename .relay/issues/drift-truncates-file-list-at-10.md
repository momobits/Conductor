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

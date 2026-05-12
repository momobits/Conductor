# `conductor drift` quantifies truncation and supports `--verbose`

## Summary

*Resolved: 2026-05-12*

- **Problem:** `conductor drift`'s `uncommitted-state-mismatch` `detail`
  field truncated at 10 files with `, …` — no count of hidden files, no
  escape hatch to see the rest, and no bucket labels to find a specific
  file quickly. Targeted-change verification ("did my edit show up in
  drift?") could fail silently when the relevant file fell into the
  truncated tail.
- **Resolution:** built on 11.1's `uncommittedSnapshot()`. The `detail`
  field is now bucket-prefixed (`staged: ... | unstaged: ... (… N more) |
  conflicted: ...`) with per-bucket truncation accounting and empty
  buckets omitted. Added `--verbose` flag to `conductor drift` that lifts
  the truncation cap entirely. The `verbose?: boolean` flag plumbs from
  `DriftCliArgs` → `DetectDriftArgs` → the engine's bucket renderer.

## Files Modified

- `src/engine/ops/detect_drift.ts:10-15,93-128` — `DetectDriftArgs`
  gains optional `verbose?: boolean`; rewrote the `detail` rendering as
  a `formatBucket(label, files)` helper that returns `null` for empty
  buckets, slices at LIMIT=10 in default mode with `(… N more)` suffix,
  and shows all files when verbose. `actual` field unchanged from 11.1.
- `src/cli/commands/drift.ts:5-13,24-37` — `DriftCliArgs` gains
  `verbose?: boolean`; `runDrift` threads it to `detectDrift`;
  `attachDrift` adds `.option('--verbose', ...)` following the
  established Commander pattern (mirrors `daemon.ts --detach` and
  `import.ts --dry-run`).
- `tests/engine/ops/detect_drift.test.ts:150-186` — 3 new tests:
  bucket-prefix-quantified-truncation, multi-bucket-joined-by-pipe,
  verbose-lifts-cap.
- `tests/cli/drift.test.ts:2,32-44` — extended `node:fs/promises`
  imports to include `writeFile`; added one CLI test driving
  `runDrift({verbose: true})` end-to-end.

## Verification

- Targeted: `npx vitest run tests/engine/ops/detect_drift.test.ts
  tests/cli/drift.test.ts tests/engine/state/git.test.ts` — **30/30
  passing**.
- Full suite: `npm test` — **512/512 across 96 test files** (baseline
  508 → 512, net +4 — exact plan match).
- Typecheck: `npm run typecheck` — clean for both engine and UI.

## Caveats

- **Two verification-time test fixes** (production code shipped clean
  first pass; the fixes were in the new test cases themselves):
  1. Regex `/staged: /` in the empty-bucket omission test was
     over-matching the substring inside `unstaged: `. Anchored to
     `/(?:^|\| )staged: /` to match only bucket-prefix positions.
  2. CLI test omitted `state.md` from its fixture; `detectDrift`
     early-returns on missing state.md so the uncommitted block was
     never reached. Added an explicit `writeFile` of a minimal state.md
     before seeding the 12-file fixture.
- **`detail` format is a presentation contract change.** The post-11.1
  flat slice (`"a.txt, b.txt, ..., …"`) is replaced with
  `"staged: ... | unstaged: ... | conflicted: ..."`. No downstream
  consumer parses `detail` for structure; only `formatDrift` interpolates
  it as opaque text. Existing test assertions were all on `actual`
  (preserved by 11.1) — none broken.
- **`|` separator instead of newlines** keeps `detail` on a single line
  inside the `[control:drift]` envelope. Filenames containing `|` would
  be ambiguous to a hypothetical structured parser; not a concern today
  (no consumer) but flag if a parser is ever introduced.
- **mtime sorting (T5-5 proposal #3) deferred.** simple-git doesn't
  expose mtime; would require per-file `fs.stat()` calls without
  existing utilities. Bucket labels make this less necessary in
  practice — operators can jump straight to the right bucket. File a
  follow-up if dogfood re-flags the truncation as still problematic
  with bucket labels in place.
- **No `Drift` type change.** Considered adding a `preview?: string[]`
  field per the issue's pseudocode; rejected — bigger surface change
  for the same user value (bucket-prefixed `detail` in the engine is
  sufficient).
- **Commander layer not exercised end-to-end in tests.** The CLI test
  calls `runDrift` directly, mirroring this repo's established CLI
  test pattern (3 sibling commands verified). A typo in `.option(...)`
  syntax would surface immediately on first operator invocation; the
  risk is small enough to accept.
- **Closes T5-5** (dogfood-log.md 2026-05-12).
- **Phase 11 closure:** with this commit, both items in phase-11
  (`drift-doesnt-distinguish-staged-vs-unstaged` and
  `drift-truncates-file-list-at-10`) are resolved. Run `/phase-close`
  next to tag `phase-11-drift-cluster-closed`.

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/init-emits-no-gitignore-template.md)

# `conductor init` emits no `.gitignore` template for `.conductor/` artifacts

*Created: 2026-05-14*
*Source: Phase 15.1 adversarial-review LOW-1 (`auth-token-persists-on-disk-after-daemon-stop.md` analysis)*
*Severity: P3 — code follow-up (small)*

## Problem statement

`src/cli/commands/init.ts` scaffolds `.conductor/` with `cards/`,
`archive/`, `decisions/`, `phases/`, `runs/`, `state.md`, `ordering.md`,
`journal.md`, and `config.yaml` — but does **not** write or update a
`.gitignore` in the user's project. The 2026-05-12 dogfood T4-2 noted
the gap on the `auth.token` path; the Phase 15.1 docs sweep documented
the requirement in `docs/operations.md § Auth token lifecycle` as a
hand-add step. That's a workable docs-only mitigation but the runtime
hygiene is still on the user — a `conductor init` flow that scaffolds
the directory should arguably also scaffold the corresponding
`.gitignore` lines so committed-secret accidents don't happen on first
run.

This is the deferred follow-up flagged in Phase 15.1's adversarial
review LOW-1.

## Current state

- `src/cli/commands/init.ts:164-195` — `runInit()` calls
  `mkdir(.conductor/<subdir>)` for each `SUBDIRS` entry and
  `writeIfMissing(<file>)` for `config.yaml`, `state.md`, `ordering.md`,
  `journal.md`. No `.gitignore` interaction at any point.
- `docs/operations.md § Auth token lifecycle` (Phase 15.1, commit
  `340775d`) — tells users to add the gitignore lines by hand:

  ```
  .conductor/auth.token
  .conductor/auth.endpoint
  .conductor/mcp.endpoint
  .conductor/mcp.sock
  .conductor/runs/
  .conductor/snapshots/
  ```

- The Conductor repo's **own** `.gitignore` line 41 already includes
  `.conductor/auth.token` — the gap is for **downstream user
  projects** that adopt Conductor via `conductor init`.

## Impact

- A first-run user who follows the quickstart but skips the gitignore
  paragraph commits `.conductor/auth.token` (and possibly the entire
  `.conductor/runs/` directory) into their repo. The token rotates on
  next daemon start so the leaked token is short-lived, but the
  precedent of committing daemon-managed state files is bad hygiene
  and run logs may contain sensitive content (prompts, code
  fragments) that should not be committed.
- The docs note in `operations.md` is correct but easy to miss — a
  user who runs `conductor init` and immediately commits all changes
  ships the daemon artifacts before reading the docs.

## Proposed fix

Two paths:

### Option A (preferred) — write/extend `.gitignore` in `runInit`

Add a `.gitignore` handling step to `runInit()`:

1. If `<repo>/.gitignore` does not exist, write it with the
   conductor-managed-artifacts block (the same 6 lines from
   `operations.md`).
2. If it exists, read and check whether each conductor line is
   already present (substring or line match against `.conductor/`).
   - If all present, no change.
   - If absent, append a sentinel-fenced block:

     ```
     # --- conductor managed artifacts (added by `conductor init`) ---
     .conductor/auth.token
     .conductor/auth.endpoint
     .conductor/mcp.endpoint
     .conductor/mcp.sock
     .conductor/runs/
     .conductor/snapshots/
     # --- /conductor ---
     ```

3. Idempotent: re-running `conductor init` never duplicates the
   block. The sentinel comments make it easy to detect already-added
   blocks and to allow users to delete or edit individual lines
   without breaking idempotency (check for the sentinel header
   only).

This mirrors the existing `writeIfMissing()` pattern for the other
scaffolded files.

### Option B — show a post-init reminder

`runInit` prints a one-line reminder after success: *"Add
.conductor/auth.token (and a few others — see docs/operations.md) to
your project's .gitignore."* Cheaper than Option A but trusts the
user to follow up.

### Verification

If Option A:
- Add `tests/cli/init.test.ts` (extend if exists) with cases:
  (1) no existing `.gitignore` → `runInit` writes one with the
  conductor block.
  (2) existing `.gitignore` without conductor lines → block appended
  with sentinels.
  (3) existing `.gitignore` already containing the conductor block →
  no change (idempotent).
  (4) existing `.gitignore` with some-but-not-all conductor lines →
  appends the missing lines or the full block under sentinels
  (decide during planning).

If Option B:
- A one-line stdout assertion in the existing `init` test.

## Affected files

For Option A:
- `src/cli/commands/init.ts` — add `.gitignore` handling in
  `runInit`.
- `tests/cli/init.test.ts` — coverage for the four cases above
  (create file or extend if exists).

For Option B:
- `src/cli/commands/init.ts` — append a `console.log` after success.
- `tests/cli/init.test.ts` — stdout assertion.

---

## Analysis

*Analyzed: 2026-05-14*

### Validation

- Problem still exists: **YES**. Verified at `src/cli/commands/init.ts:164-195` (`runInit`). The function calls `mkdir(.conductor/<subdir>)` for each `SUBDIRS` entry and `writeIfMissing(<file>)` for `config.yaml`, `state.md`, `ordering.md`, `journal.md`. No `.gitignore` interaction at any point.
- Proposed approach still valid: **NEEDS ADJUSTMENT**. Option A is the right shape (idempotent sentinel-fenced block via read-then-modify), but the 6-line content cited in the issue body — taken verbatim from `docs/operations.md § Auth token lifecycle` lines 164-170 — contains **two contract-drift entries** that do not match what the daemon actually writes (see Related Work). Adopting the documented template verbatim would propagate the existing bug into every user project that runs `conductor init`. The plan must use the **corrected** 6-line set; see Approach.

### Root Cause

The bug is procedural rather than algorithmic: `conductor init` was authored to scaffold the `.conductor/` directory tree and config files, and the gitignore-emission step was never written. The 2026-05-12 dogfood (T4-2) surfaced the gap for `auth.token`; Phase 15.1's docs sweep mitigated it by documenting the requirement in `docs/operations.md`, with the code-side fix explicitly deferred ("`init.ts` gitignore-template emission deferred to a future code-side issue if needed — the doc tells users to add the gitignore lines by hand"). This is that follow-up.

**The same root cause produced a secondary drift**: when Phase 15.1 hand-wrote the 6-line template in `docs/operations.md` lines 164-170, two of the entries referenced artifact names that the daemon does not actually create — see Related Work finding 1. The runtime-artifact contract has only one canonical source (the daemon source files), and it has drifted from the documented template. This means the binding contract for the `.gitignore` content must be derived from daemon source code, not from the existing docs.

### What This Means (User Impact)

**In plain terms:** A user who runs `conductor init` to set up a new Conductor project, then commits their changes, will commit `.conductor/auth.token` (a bearer credential), `.conductor/runs/` (run logs that may contain prompt text and code snippets), and other ephemeral daemon state into their repository. The docs tell them to add the gitignore lines by hand, but a user who follows the quickstart linearly won't read the operations.md section until later — by which time the artifacts are already committed.

**Scenario:** Alice has a TypeScript project at `~/projects/payment-api`. She runs `conductor init --provider subscription` to try Conductor. The command scaffolds `.conductor/`, installs the example config, and detects `npm test` as her verify command. Alice runs `conductor daemon start` to test the dogfood loop — the daemon writes `.conductor/auth.token` (a fresh UUIDv4), `.conductor/daemon.pid`, `.conductor/daemon.endpoint`, and `.conductor/mcp.endpoint`. She runs `git status`, sees the new `.conductor/` files, runs `git add . && git commit -m "Adopt Conductor"`, and pushes. Her repo's commit history now permanently contains `auth.token` (rotated next start, but committed); on subsequent daemon starts Conductor regenerates the token but the git history forever shows the leaked one.

**Before (current behavior):**
- `conductor init` writes `.conductor/config.yaml`, `state.md`, `ordering.md`, `journal.md`, and the directory layout. It does NOT write or update `.gitignore`.
- User runs `git status` → sees `.conductor/` untracked.
- User runs `git add . && git commit` → daemon artifacts (including `auth.token`) land in the commit.
- The docs in `operations.md` tell the user to add gitignore lines by hand, but only if they read that section before committing.

**After (with fix):**
- `conductor init` writes `.conductor/<subdirs>+files>` AND adds/updates `.gitignore` with a sentinel-fenced block listing the runtime-artifact paths.
- Idempotent: re-running `conductor init` on a project that already has the block leaves it unchanged. Re-running on a project whose `.gitignore` is missing the block but has other entries appends the block without disturbing existing rules.
- User runs `git status` → daemon artifacts are properly ignored from the moment `init` completes.
- User commits → only the intentional Conductor scaffold files (config.yaml, state.md, ordering.md, journal.md, subdirectories) land in the repo.

### Blast Radius

**Files affected:**
- `src/cli/commands/init.ts` — add `.gitignore` handling to `runInit()` (~30 lines). Uses an inline read-then-modify pattern (no existing helper; `writeIfMissing()` is write-if-absent only, not extend-if-block-missing).
- `tests/cli/init.test.ts` — add 4 new test cases (no existing `.gitignore`, existing without block, existing with block, partial overlap). The file already exists (13 tests, all using `mkdtemp` tmpdir fixtures).
- `docs/operations.md` lines 161-175 — update the documented template to match daemon reality and update the "`conductor init` does NOT currently write a `.gitignore`" paragraph to describe the new behavior.
- `.gitignore` (this repo's own) lines 41-47 — align with the corrected runtime-artifact list.

**Callers and consumers:**
- `runInit()` is called by the CLI `init` action (`src/cli/commands/init.ts:217-241`) and directly by every test in `tests/cli/init.test.ts`. No other callers in `src/`. No downstream impact on examples — `examples/*/` contain no `.gitignore` files.
- The `.gitignore` write is a side effect on the user's project root; it does not interact with any other engine surface.

**Test coverage status:**
- `tests/cli/init.test.ts` has 13 tests covering directory layout, config write, idempotency, provider switching, and verify-command detection. None currently exercise `.gitignore` — net new test surface for this work.
- The existing tests use `mkdtemp` fixtures with isolated tmpdirs; adding `.gitignore` cases follows the same pattern (no fixture rework needed).

**Config interactions:**
- None. The gitignore block is fixed content; no config knobs gate it. (A future iteration could expose `init.gitignore: false` in `ProjectConfigSchema` to suppress, but that's out of scope for this fix.)

**Cross-item interactions (active issues/features):**
- None. The Phase 9 backlog has only one active item.

**Past work regression risk:**
- The `docs/operations.md § Auth token lifecycle` section was authored by Phase 15.1 (commit `340775d`). Correcting the template inside this section is the intended follow-through, not a regression — the section's "`conductor init` does NOT currently write a `.gitignore` template. Add the lines above by hand after running `init`" paragraph (lines 172-175) becomes inverted by this fix and must be rewritten.
- The 2026-05-12 dogfood T4-2 finding (parent issue) is **already resolved** in archive. No archive-side regression risk.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena MCP not available in this environment) for prose and symbols*

#### Findings

1. **Target:** `unfiled: docs/operations.md:164-170 + repo .gitignore:41-47 - runtime-artifact template references files daemon does not write`
   **Kind:** unfiled candidate
   **Evidence:** **strong** (live source contradicts documented contract; two of six listed paths do not exist as daemon-written files)
   **Why related:**
     - `docs/operations.md:165` lists `.conductor/auth.endpoint` — but `src/daemon/pidfile.ts:13` defines `ENDPOINT_FILE = 'daemon.endpoint'` and `auth.endpoint` is never written by any daemon module (grep confirms 0 hits in `src/daemon/`).
     - `docs/operations.md:167` lists `.conductor/mcp.sock` — but `src/daemon/index.ts:3201` (per Phase 4 plan) writes `.conductor/mcp.endpoint` as an HTTP URL; `mcp.sock` is a Phase 4 design-spec artifact for a Unix-socket transport that was never implemented (current transport is Streamable HTTP per `docs/superpowers/specs/2026-05-06-conductor-design1.md:701`).
     - Repo's own `.gitignore:41-47` mirrors the same two incorrect entries. `README.md:124` correctly uses `daemon.endpoint`, so the canonical name was understood at the time the README was written; the drift is localized to `operations.md` and the repo gitignore.
     - Net effect: implementing Option A using the documented template verbatim would propagate the drift into every user project. The implementation must use the corrected list, AND the docs/repo-gitignore should be corrected to match.
   **Suggested handling:** group into current run

2. **Target:** `unfiled: src/cli/commands/init.ts::SUBDIRS - 'archive/notebooks' in SUBDIRS but no notebook subsystem ships`
   **Kind:** unfiled candidate
   **Evidence:** **weak** (lexical only; `archive/notebooks/` is the placeholder for the notebook export path used by `/relay-notebook`, which the Relay config explicitly opts out of for TypeScript projects — so the directory is harmless but unused). Not relevant to this change.
   **Suggested handling:** keep narrow (do not address here)

3. **Target:** `.relay/archive/issues/auth-token-persists-on-disk-after-daemon-stop.md`
   **Kind:** existing item (archived)
   **Evidence:** **strong** (direct parent issue — this issue was filed as its deferred LOW-1 follow-up)
   **Why related:** The Phase 15.1 docs sweep on `auth-token-persists-on-disk-after-daemon-stop` documented the gitignore lines in `operations.md` and explicitly deferred the code-side `init.ts` emission ("If post-merge dogfood shows users still commit `.conductor/auth.token`, file a follow-up code-side issue to add gitignore emission to `init.ts`. Documented as a deferred follow-up."). This issue IS the deferred follow-up.
   **Suggested handling:** keep narrow (parent is already resolved; back-update unnecessary because the parent's archive doc already names this follow-up by description)

4. **Target:** `.relay/implemented/auth-token-persists-on-disk-after-daemon-stop.md`
   **Kind:** existing item (implemented record)
   **Evidence:** **medium** (cites this gap as the explicit deferred follow-up)
   **Why related:** The implementation doc records the same template content that we now know contains drift. When this work resolves, the implemented doc should not need amendment (it correctly describes what Phase 15.1 shipped); the corrections happen in the live `operations.md`, not in the historical implementation record.
   **Suggested handling:** keep narrow (no amendment needed)

5. **Target:** `unfiled: docs/operations.md:172-175 - prose paragraph 'init does NOT currently write .gitignore' is invalidated by this fix`
   **Kind:** unfiled candidate
   **Evidence:** **strong** (direct contradiction once init emits gitignore)
   **Why related:** The paragraph telling users to add gitignore lines by hand becomes a lie once `runInit` writes them. It must be rewritten in the same change as the template correction.
   **Suggested handling:** group into current run (same docs/operations.md surface as finding 1)

#### Search Bounds

- Live codepath audit: complete (`runInit` containing function read; SUBDIRS array audited; `writeIfMissing` helper audited; no first-order callers beyond the CLI action and tests).
- Backlog codepath: complete (only 1 active issue; no overlap).
- Subsystem: complete (CLI commands subsystem — 16 files in `src/cli/commands/`; `init.ts` is the only one that scaffolds, the rest are runtime ops; no parallel scaffolders).
- Archive: complete (16 archived issues scanned; 4 cite `init.ts` line numbers but only `auth-token-persists-on-disk-after-daemon-stop` is topically related; others reference SUBDIRS and exit codes for unrelated reasons).
- Implementation: complete (`.relay/implemented/auth-token-persists-on-disk-after-daemon-stop.md` reviewed end-to-end; no other implemented docs reference init.ts gitignore handling).
- Contract drift: complete (grepped `auth.endpoint`, `mcp.sock`, `daemon.endpoint`, `mcp.endpoint` across `docs/`, `README.md`, `examples/`; findings consolidated above).

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-14
*Rationale:* Per the /relay-analyze rubric's "medium/strong findings sharing target's root cause → grouped run" row. The strong findings #1 and #5 share the target's root cause (runtime-artifact contract documented in `docs/operations.md` and propagated to repo `.gitignore` is wrong relative to daemon source). Shipping the bare init.ts generator without correcting the documented template would propagate the drift into every downstream `conductor init` invocation. Bundling all three corrections in one change keeps the contract single-sourced (daemon code) and prevents a follow-up issue from being filed for the docs/.gitignore drift the moment this lands.

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | `init-emits-no-gitignore-template.md` (this issue) | run leader | n/a | full — implement Option A's idempotent sentinel-fenced gitignore generator in `runInit()` using the corrected 6-line template |
| 2 | `unfiled: docs/operations.md:161-175 - § Auth token lifecycle gitignore template drift + invalidated "init does NOT write .gitignore" paragraph` | unfiled candidate | strong | full — replace template entries to match daemon reality (`auth.endpoint` → `daemon.endpoint`; drop `mcp.sock`; add `daemon.pid`) AND rewrite the trailing paragraph to describe the new init behavior |
| 3 | `unfiled: .gitignore:41-47 - repo's own gitignore contract drift` | unfiled candidate | strong | full — same template corrections as entry #2, preserving the surrounding context (the repo gitignore already includes `runtime.sqlite` which is in-memory-only per Phase 4; leave that line untouched as forward-looking) |

#### Planner Contract

- `/relay-plan` must emit a `### Grouped Run Coverage` section.
- The coverage section must map every grouped entry to at least one concrete plan step.
- Entry #1 (full): explicit file or symbol coverage in `src/cli/commands/init.ts` and `tests/cli/init.test.ts`.
- Entry #2 (full): explicit edit to `docs/operations.md § Auth token lifecycle` (lines 161-175) covering both the template content AND the trailing paragraph.
- Entry #3 (full): explicit edit to `.gitignore` (this repo's own) lines 41-47.
- If the planner cannot cover a grouped entry cleanly, stop and route back to scope reduction.

#### Closure Contract

- `/relay-review` must verify each grouped entry's cited evidence is addressed in the plan at the obligation's granularity.
- `/relay-verify` must verify the diff touched the files or symbols promised by the plan's `Grouped Run Coverage` section.
- `/relay-resolve` must record per-entry closure status; partial or unclosed entries must be re-opened, superseded, or have a follow-up issue filed.

### Approach

**Recommended approach:** Implement Option A (idempotent sentinel-fenced block in `runInit`) using the **corrected** 6-line template derived from current daemon source, and concurrently correct `docs/operations.md` and repo `.gitignore` to match. Specifically:

**Corrected runtime-artifact template (6 entries, matches daemon reality):**
```
.conductor/auth.token
.conductor/daemon.pid
.conductor/daemon.endpoint
.conductor/mcp.endpoint
.conductor/runs/
.conductor/snapshots/
```

Rationale for each entry:
- `auth.token` — written by `src/daemon/auth.ts:17` on every daemon start; NOT cleared on stop; rotated next start. Bearer credential.
- `daemon.pid` — written by `src/daemon/pidfile.ts:19` on start; cleared on stop. Process id.
- `daemon.endpoint` — written by `src/daemon/pidfile.ts:44` on start; cleared on stop. RPC HTTP URL.
- `mcp.endpoint` — written by `src/daemon/pidfile.ts:68` on start; cleared on stop. MCP HTTP URL.
- `runs/` — scaffolded by `runInit` itself (`SUBDIRS` includes `runs`); populated by `RunLogWriter` per-card. Contains prompt text, code fragments, recommendation rationale — sensitive.
- `snapshots/` — scaffolded by `runInit`; populated by snapshot ops.

**Sentinel-fenced block shape** (lifted from the issue body):
```
# --- conductor managed artifacts (added by `conductor init`) ---
.conductor/auth.token
.conductor/daemon.pid
.conductor/daemon.endpoint
.conductor/mcp.endpoint
.conductor/runs/
.conductor/snapshots/
# --- /conductor ---
```

**Idempotency mechanism:** Detect the sentinel header line (literal match on `# --- conductor managed artifacts`). If present, no change. If absent, append the block with a leading blank line (or write the file with the block if absent). This sentinel-based detection lets users edit individual lines inside the block without breaking re-run idempotency — only the header is the gate.

**Why Option B was rejected:** the issue marks Option A as preferred; the dogfood evidence (T4-2 parent finding) shows users don't reliably read docs before committing, and the cost differential is minimal (~30 lines of code + 4 test cases vs. a one-line console.log that adds no enforcement). Option B is documented in the archive paragraph already; adding the runtime enforcement is the natural complement.

**Open questions for the planner:**
- Should the implementation include `daemon.pid` and `daemon.endpoint`? **Lean: yes** — they're daemon-written ephemeral state, parallel to `mcp.endpoint`. The 6-line shape preserves the documented template's line count while correcting the names.
- Should the block include `runtime.sqlite` (currently in repo `.gitignore` only)? **Lean: no** — Phase 4 ships in-memory SQLite per `src/daemon/runtime.ts:4`; the file is forward-looking. Add it when the SQLite implementation actually writes to disk.
- Should the implementation include a sentinel-format ADR? **Lean: no** at this scope — the sentinel format is small and self-explanatory in source. Promote to ADR if a future change touches `.gitignore` semantics non-trivially.

---

## Implementation Plan

*Generated: 2026-05-14*

### Step 1: Add gitignore template constants and `ensureGitignoreBlock` helper to `src/cli/commands/init.ts`

**File**: `src/cli/commands/init.ts` (top-level constants and a new module-private async function, inserted between the existing `DEFAULT_JOURNAL` constant and the `KNOWN_PROVIDERS` export, lines ~88-95)

**Before** (current code, lines 84-96 region — no gitignore constants or helper exists):
```typescript
const DEFAULT_JOURNAL = `# Journal             // ← embedded default for .conductor/journal.md

(One line per session, appended at session end.)
`;

export const KNOWN_PROVIDERS = [   // ← list of recognized --provider values
  'minimal',
  'subscription',
  'openrouter',
  'lmstudio',
  'tracker',
] as const;
```

**After** (proposed change — adds two top-level constants and one helper between `DEFAULT_JOURNAL` and `KNOWN_PROVIDERS`):
```typescript
const DEFAULT_JOURNAL = `# Journal             // ← unchanged: embedded default for journal.md

(One line per session, appended at session end.)
`;

// Sentinel-fenced block written to the user's project .gitignore so daemon-     // ← NEW: explanatory comment
// written runtime artifacts (auth bearer token, ephemeral endpoint URLs, run    // ← NEW
// logs) are ignored from the moment `conductor init` completes. The sentinel    // ← NEW
// header is the idempotency gate — re-running init detects this line and       // ← NEW
// skips re-adding the block. Users can edit/remove individual entries inside    // ← NEW
// the block without breaking idempotency. List derived from daemon source:     // ← NEW
// auth.ts:11 (auth.token), pidfile.ts:12-14 (daemon.pid, daemon.endpoint,      // ← NEW
// mcp.endpoint); runs/ and snapshots/ are scaffolded by SUBDIRS above.         // ← NEW
const GITIGNORE_SENTINEL_HEADER =                                                // ← NEW: header sentinel literal
  '# --- conductor managed artifacts (added by `conductor init`) ---';           // ← NEW
const GITIGNORE_SENTINEL_FOOTER = '# --- /conductor ---';                        // ← NEW: footer sentinel
const GITIGNORE_BLOCK = [                                                        // ← NEW: full block content
  GITIGNORE_SENTINEL_HEADER,                                                     // ← header
  '.conductor/auth.token',                                                       // ← UUIDv4 bearer (daemon/auth.ts:17)
  '.conductor/daemon.pid',                                                       // ← daemon PID (daemon/pidfile.ts:19)
  '.conductor/daemon.endpoint',                                                  // ← RPC URL (daemon/pidfile.ts:44)
  '.conductor/mcp.endpoint',                                                     // ← MCP URL (daemon/pidfile.ts:68)
  '.conductor/runs/',                                                            // ← per-card run logs
  '.conductor/snapshots/',                                                       // ← snapshot dir
  GITIGNORE_SENTINEL_FOOTER,                                                     // ← footer
].join('\n');                                                                    // ← joined with LF

async function ensureGitignoreBlock(                                             // ← NEW: helper
  repo: string,                                                                  // ← project root (args.cwd)
): Promise<'created' | 'appended' | 'unchanged'> {                               // ← return discriminates outcome
  const path = join(repo, '.gitignore');                                         // ← target file path
  let existed = true;                                                            // ← did .gitignore pre-exist?
  let existing = '';                                                             // ← current content (empty on ENOENT)
  try {                                                                          // ← try read
    existing = await readFile(path, 'utf8');                                     // ← read existing content
  } catch (e) {                                                                  // ← catch read error
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;                 // ← propagate non-ENOENT (EACCES, EISDIR, ...)
    existed = false;                                                             // ← ENOENT: file absent, will create
  }
  if (existing.includes(GITIGNORE_SENTINEL_HEADER)) {                            // ← sentinel header is the idempotency gate
    return 'unchanged';                                                          // ← block already present — no-op
  }
  const trimmedEnd = existing.replace(/\s+$/, '');                               // ← normalize trailing whitespace
  const merged = trimmedEnd === ''                                               // ← empty / whitespace-only file branch
    ? GITIGNORE_BLOCK + '\n'                                                     // ← just block + trailing newline
    : trimmedEnd + '\n\n' + GITIGNORE_BLOCK + '\n';                              // ← existing + blank line + block + newline
  await writeFile(path, merged, 'utf8');                                         // ← write atomically (Node fs.writeFile)
  return existed ? 'appended' : 'created';                                       // ← discriminate first-write vs. extend
}

export const KNOWN_PROVIDERS = [   // ← unchanged: --provider value list
  'minimal',
  'subscription',
  'openrouter',
  'lmstudio',
  'tracker',
] as const;
```

**Why**: Introduces the canonical 6-line runtime-artifact list (derived from daemon source, not from the drifted docs) and a self-contained idempotent helper. The sentinel-header-based detection lets users hand-edit individual lines inside the block without re-triggering insertion. Empty/whitespace-only existing content is handled distinctly from absent-file so the discriminator return value is meaningful for stdout messaging.

**Risk**: A user who has hand-pasted the operations.md template (with the now-corrected entries) before this fix ships will end up with the sentinel-fenced block AND the legacy hand-pasted lines side-by-side. This is harmless — duplicate gitignore entries are no-ops to git itself — but the visual is busy. Acceptable: the docs in step 3 explain the migration ("If you ran init on a Conductor version before this behavior shipped, the hand-added lines remain valid; you may remove them if you prefer the block-only shape").

**Verify**: After step 2's tests are written, run `npx vitest run tests/cli/init.test.ts` and confirm all gitignore cases pass. Manual check: `cd /tmp/scratch && node dist/cli/index.js init` then `cat .gitignore` should show the block.

**Rollback**: `git revert <commit-sha>` reverts the whole change (no DB, no config schema change, no stored format change). Helper deletion is mechanical.

---

### Step 2: Call `ensureGitignoreBlock` from `runInit` and surface the result

**File**: `src/cli/commands/init.ts` (`InitResult` interface and `runInit` function body, lines 158-195)

**Before** (current `InitResult` and `runInit`):
```typescript
export interface InitResult {                                                    // ← return shape for programmatic callers + tests
  configWritten: boolean;                                                        // ← did config.yaml get written?
  configSource: 'embedded-default' | KnownProvider;                              // ← which template
  verifyCommand: string | null;                                                  // ← detected verify_command
}

export async function runInit(args: InitArgs): Promise<InitResult> {             // ← entry point for the init action + tests
  const root = join(args.cwd, '.conductor');                                     // ← .conductor/ root
  await mkdir(root, { recursive: true });                                        // ← ensure root exists
  for (const sub of SUBDIRS) {                                                   // ← each scaffold subdir
    await mkdir(join(root, sub), { recursive: true });                           // ← create idempotently
  }

  const detectVerify = args.detectVerify !== false;                              // ← detect verify_command unless disabled
  const verifyCmd = detectVerify ? await detectVerifyCommand(args.cwd) : null;   // ← sniff project type

  let config: string;                                                            // ← config.yaml content
  let source: 'embedded-default' | KnownProvider;                                // ← provenance
  if (args.provider) {                                                           // ← branch: provider-supplied
    config = await readExampleConfig(args.provider);                             // ← read examples/with-<provider>/.conductor/config.yaml
    source = args.provider;                                                      // ← record provenance
  } else {                                                                       // ← branch: no --provider flag
    config = DEFAULT_CONFIG;                                                     // ← embedded default
    source = 'embedded-default';                                                 // ← record provenance
  }
  if (verifyCmd) {                                                               // ← if a verify cmd was detected
    config = applyVerifyCommand(config, verifyCmd);                              // ← patch the config string
  }

  const configPath = join(root, 'config.yaml');                                  // ← config.yaml path
  const configWritten = await writeIfMissing(configPath, config);                // ← write iff absent

  await writeIfMissing(join(root, 'state.md'), DEFAULT_STATE);                   // ← scaffold state.md if absent
  await writeIfMissing(join(root, 'ordering.md'), DEFAULT_ORDERING);             // ← scaffold ordering.md if absent
  await writeIfMissing(join(root, 'journal.md'), DEFAULT_JOURNAL);               // ← scaffold journal.md if absent

  return { configWritten, configSource: source, verifyCommand: verifyCmd };      // ← report result to caller
}
```

**After** (proposed change — adds `gitignore` field to InitResult and a single call to `ensureGitignoreBlock` after the existing scaffold writes):
```typescript
export interface InitResult {                                                    // ← unchanged shape, one new field
  configWritten: boolean;                                                        // ← unchanged
  configSource: 'embedded-default' | KnownProvider;                              // ← unchanged
  verifyCommand: string | null;                                                  // ← unchanged
  gitignore: 'created' | 'appended' | 'unchanged';                               // ← NEW: discriminate gitignore outcome
}

export async function runInit(args: InitArgs): Promise<InitResult> {             // ← unchanged signature
  const root = join(args.cwd, '.conductor');                                     // ← unchanged
  await mkdir(root, { recursive: true });                                        // ← unchanged
  for (const sub of SUBDIRS) {                                                   // ← unchanged
    await mkdir(join(root, sub), { recursive: true });                           // ← unchanged
  }

  const detectVerify = args.detectVerify !== false;                              // ← unchanged
  const verifyCmd = detectVerify ? await detectVerifyCommand(args.cwd) : null;   // ← unchanged

  let config: string;                                                            // ← unchanged
  let source: 'embedded-default' | KnownProvider;                                // ← unchanged
  if (args.provider) {                                                           // ← unchanged
    config = await readExampleConfig(args.provider);                             // ← unchanged
    source = args.provider;                                                      // ← unchanged
  } else {                                                                       // ← unchanged
    config = DEFAULT_CONFIG;                                                     // ← unchanged
    source = 'embedded-default';                                                 // ← unchanged
  }
  if (verifyCmd) {                                                               // ← unchanged
    config = applyVerifyCommand(config, verifyCmd);                              // ← unchanged
  }

  const configPath = join(root, 'config.yaml');                                  // ← unchanged
  const configWritten = await writeIfMissing(configPath, config);                // ← unchanged

  await writeIfMissing(join(root, 'state.md'), DEFAULT_STATE);                   // ← unchanged
  await writeIfMissing(join(root, 'ordering.md'), DEFAULT_ORDERING);             // ← unchanged
  await writeIfMissing(join(root, 'journal.md'), DEFAULT_JOURNAL);               // ← unchanged

  const gitignore = await ensureGitignoreBlock(args.cwd);                        // ← NEW: write/extend .gitignore at project root

  return { configWritten, configSource: source, verifyCommand: verifyCmd, gitignore }; // ← include gitignore in result
}
```

**Why**: Wires the helper into the scaffold flow at the natural point — after all `.conductor/<file>` writes have settled, before returning to the caller. The gitignore write targets `args.cwd` (the user's project root), not `root` (the `.conductor/` subdirectory) — git only honors `.gitignore` files within a tracked tree, and the user's project root is the right anchor.

**Risk**: Tests that depend on the exact shape of `InitResult` will need a `gitignore: 'created' | 'appended' | 'unchanged'` field. Step 4's test rework covers this — existing tests that don't assert on `gitignore` are unaffected since they only spot-check specific fields.

**Verify**: Run `npx vitest run tests/cli/init.test.ts` after step 4's tests are added; all green. `tsc --noEmit -p tsconfig.json` typechecks the new field.

**Rollback**: Revert step 2 (and step 1's helper) together; mechanical.

---

### Step 3: Update CLI action stdout to mention the gitignore outcome

**File**: `src/cli/commands/init.ts` (`attachInit` action body, lines 230-240)

**Before** (current stdout):
```typescript
const result = await runInit({                                                   // ← entry call, takes provider + detectVerify
  cwd: process.cwd(),                                                            // ← user's project root
  provider,                                                                      // ← optional --provider
  detectVerify: opts.detectVerify,                                               // ← optional --no-detect-verify
});
// eslint-disable-next-line no-console
console.log(                                                                     // ← single-line summary
  result.configWritten                                                           // ← branch on config write status
    ? `Conductor initialized. .conductor/ scaffold ready (config source: ${result.configSource}${result.verifyCommand ? `, verify_command: ${result.verifyCommand}` : ''}).` // ← first-init message
    : `Conductor scaffold present; .conductor/config.yaml left untouched.`,     // ← re-run message
);
```

**After** (proposed change — append a gitignore note when the file changed):
```typescript
const result = await runInit({                                                   // ← unchanged
  cwd: process.cwd(),                                                            // ← unchanged
  provider,                                                                      // ← unchanged
  detectVerify: opts.detectVerify,                                               // ← unchanged
});
const firstLine = result.configWritten                                           // ← extracted to a local for readability
  ? `Conductor initialized. .conductor/ scaffold ready (config source: ${result.configSource}${result.verifyCommand ? `, verify_command: ${result.verifyCommand}` : ''}).` // ← unchanged content
  : `Conductor scaffold present; .conductor/config.yaml left untouched.`;       // ← unchanged content
const gitignoreLine =                                                            // ← NEW: appended when the file changed
  result.gitignore === 'created'                                                 // ← branch: brand-new .gitignore
    ? ' Wrote .gitignore with Conductor runtime-artifact entries.'              // ← new file
    : result.gitignore === 'appended'                                            // ← branch: extended existing
      ? ' Appended Conductor runtime-artifact entries to .gitignore.'           // ← block added under sentinels
      : '';                                                                     // ← unchanged: empty (no-op on re-run)
// eslint-disable-next-line no-console
console.log(firstLine + gitignoreLine);                                          // ← single-line output, gitignore note when relevant
```

**Why**: Surfaces the new side effect to the operator without changing the existing stdout shape on no-op re-runs. The first-init experience now reads: *"Conductor initialized. .conductor/ scaffold ready (config source: subscription, verify_command: npm test). Wrote .gitignore with Conductor runtime-artifact entries."* — a single line, two clauses, no clutter on re-run.

**Risk**: None — the existing tests assert on stdout via `result.configSource` / `result.verifyCommand`, not on console output. No test asserts on the exact CLI stdout shape today (verified by reading `tests/cli/init.test.ts`).

**Verify**: Visual inspection during dogfood after implementation.

**Rollback**: Revert; mechanical.

---

### Step 4: Add four test cases to `tests/cli/init.test.ts` covering the gitignore matrix

**File**: `tests/cli/init.test.ts` (append to the existing `describe('runInit')` block, after the last `it('returns configWritten: false on second run')` case at line 102-107)

**Before** (current last test case, line 102-107):
```typescript
  it('returns configWritten: false on second run', async () => {                 // ← idempotency check for config.yaml
    const first = await runInit({ cwd: tmp });                                   // ← first init
    expect(first.configWritten).toBe(true);                                      // ← first run wrote config
    const second = await runInit({ cwd: tmp });                                  // ← second init on same dir
    expect(second.configWritten).toBe(false);                                    // ← second run no-op for config
  });
});                                                                              // ← close describe block
```

**After** (proposed change — append 4 new tests inside the same `describe`):
```typescript
  it('returns configWritten: false on second run', async () => {                 // ← unchanged: existing test
    const first = await runInit({ cwd: tmp });                                   // ← unchanged
    expect(first.configWritten).toBe(true);                                      // ← unchanged
    const second = await runInit({ cwd: tmp });                                  // ← unchanged
    expect(second.configWritten).toBe(false);                                    // ← unchanged
  });

  it('creates .gitignore with sentinel-fenced conductor block when absent', async () => { // ← NEW: case 1 — file didn't exist
    const result = await runInit({ cwd: tmp });                                  // ← run init on empty tmpdir
    expect(result.gitignore).toBe('created');                                    // ← discriminator should say created
    const content = await readFile(join(tmp, '.gitignore'), 'utf8');             // ← read the new file
    expect(content).toContain('# --- conductor managed artifacts (added by `conductor init`) ---'); // ← sentinel header present
    expect(content).toContain('.conductor/auth.token');                          // ← all six entries present
    expect(content).toContain('.conductor/daemon.pid');
    expect(content).toContain('.conductor/daemon.endpoint');
    expect(content).toContain('.conductor/mcp.endpoint');
    expect(content).toContain('.conductor/runs/');
    expect(content).toContain('.conductor/snapshots/');
    expect(content).toContain('# --- /conductor ---');                           // ← footer sentinel present
    expect(content).not.toContain('.conductor/auth.endpoint');                   // ← regression guard: drifted name absent
    expect(content).not.toContain('.conductor/mcp.sock');                        // ← regression guard: legacy artifact absent
  });

  it('appends the conductor block to an existing .gitignore without the block', async () => { // ← NEW: case 2 — extends
    await writeFile(join(tmp, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');  // ← pre-seed unrelated entries
    const result = await runInit({ cwd: tmp });                                  // ← run init
    expect(result.gitignore).toBe('appended');                                   // ← discriminator should say appended
    const content = await readFile(join(tmp, '.gitignore'), 'utf8');             // ← read result
    expect(content.startsWith('node_modules/\ndist/\n')).toBe(true);             // ← existing content preserved at top
    expect(content).toContain('# --- conductor managed artifacts (added by `conductor init`) ---'); // ← block appended
    expect(content).toContain('.conductor/auth.token');                          // ← block content present
  });

  it('leaves .gitignore unchanged when the conductor block is already present', async () => { // ← NEW: case 3 — idempotent re-run
    await runInit({ cwd: tmp });                                                 // ← first init writes the block
    const before = await readFile(join(tmp, '.gitignore'), 'utf8');              // ← capture full content
    const result = await runInit({ cwd: tmp });                                  // ← second init
    expect(result.gitignore).toBe('unchanged');                                  // ← discriminator should say unchanged
    const after = await readFile(join(tmp, '.gitignore'), 'utf8');               // ← re-read
    expect(after).toBe(before);                                                  // ← byte-identical to first-init output
  });

  it('does not re-add lines a user has removed from inside the block', async () => { // ← NEW: case 4 — partial-overlap / user edit
    await runInit({ cwd: tmp });                                                 // ← first init writes the full block
    // User edits the block: removes one line they don't want gitignored        // ← simulates real user mutation
    const initial = await readFile(join(tmp, '.gitignore'), 'utf8');             // ← capture full content
    const edited = initial.replace('.conductor/snapshots/\n', '');               // ← drop snapshots/ entry
    await writeFile(join(tmp, '.gitignore'), edited, 'utf8');                    // ← write user edit
    const result = await runInit({ cwd: tmp });                                  // ← re-run init
    expect(result.gitignore).toBe('unchanged');                                  // ← sentinel header gate is the idempotency check
    const after = await readFile(join(tmp, '.gitignore'), 'utf8');               // ← re-read
    expect(after).toBe(edited);                                                  // ← user edit preserved
    expect(after).not.toContain('.conductor/snapshots/');                        // ← removed line stays removed
  });
});                                                                              // ← close describe block
```

**Why**: The four cases form a complete decision-tree for `ensureGitignoreBlock`: (file absent → created), (file present, block absent → appended), (file present, block present → unchanged), and the trickiest corner (file present, block present but user has hand-edited inside → still unchanged). Case 4 codifies the user-friendly invariant: the sentinel header is the only idempotency check; users have the freedom to mutate inside the block. The regression guards (lines 18-19 of the case-1 test, `not.toContain('.conductor/auth.endpoint')` and `not.toContain('.conductor/mcp.sock')`) lock in the contract-drift correction so a future revert/typo can't reintroduce the wrong names.

**Risk**: None — these are net-new tests in net-new territory. Existing 13 tests use the same `mkdtemp` fixture; no harness rework.

**Verify**: `npx vitest run tests/cli/init.test.ts 2>&1 | tail -50`. Expected: 13 → 17 tests, all green.

**Rollback**: Delete the 4 new `it()` blocks; mechanical.

---

### Step 5: Correct `docs/operations.md § Auth token lifecycle` template + paragraph

**File**: `docs/operations.md` (lines 161-175)

**Before** (current docs):
```markdown
**Gitignore your auth token.** Add to your project's `.gitignore`:                ← prose imperative

```                                                                              ← fenced block opens
.conductor/auth.token                                                            ← correct
.conductor/auth.endpoint                                                         ← WRONG: daemon writes daemon.endpoint, not auth.endpoint
.conductor/mcp.endpoint                                                          ← correct
.conductor/mcp.sock                                                              ← WRONG: legacy Phase-4 spec artifact; never written
.conductor/runs/                                                                 ← correct
.conductor/snapshots/                                                            ← correct
```                                                                              ← fenced block closes

`conductor init` does NOT currently write a `.gitignore` template. Add           ← paragraph invalidated by this fix
the lines above by hand after running `init`. (If your project's
`.gitignore` is missing these and the daemon has started, run
`git status` to confirm `.conductor/auth.token` is not staged.)
```

**After** (proposed change — corrected entries + rewritten paragraph):
```markdown
**Gitignore your auth token.** `conductor init` writes/extends your              ← unchanged opening, content rewritten
project's `.gitignore` with the Conductor runtime-artifact entries under
a sentinel-fenced block. The block looks like:

```                                                                              ← fenced block opens
# --- conductor managed artifacts (added by `conductor init`) ---                ← sentinel header (idempotency gate)
.conductor/auth.token                                                            ← UUIDv4 bearer (src/daemon/auth.ts)
.conductor/daemon.pid                                                            ← daemon PID (src/daemon/pidfile.ts)
.conductor/daemon.endpoint                                                       ← FIXED: was auth.endpoint; daemon writes daemon.endpoint
.conductor/mcp.endpoint                                                          ← MCP HTTP URL (src/daemon/pidfile.ts)
.conductor/runs/                                                                 ← per-card run logs
.conductor/snapshots/                                                            ← snapshot dir
# --- /conductor ---                                                             ← sentinel footer
```                                                                              ← fenced block closes
                                                                                 ← (`mcp.sock` removed: legacy Phase-4 spec artifact)
Re-running `init` is idempotent — the sentinel header line is the                ← paragraph rewrite: new behavior description
detection gate, so the block is never duplicated. You can edit or
remove individual lines inside the block without breaking idempotency
(`init` keys only on the header). If you ran `init` on a Conductor
version before this behavior shipped, add the lines above by hand;
they remain valid and you may delete them once you re-run `init` on a
current version to install the block-shape version.
```

**Why**: Aligns the user-facing docs with the implementation that ships in steps 1-3. Eliminates the contract drift (`auth.endpoint` → `daemon.endpoint`; `mcp.sock` removed; `daemon.pid` added). Replaces the now-inverted "init does NOT write .gitignore" paragraph with a behavior description that matches the implementation. The migration note for users on older versions preserves the prior advice without overemphasizing it.

**Risk**: A user reading this doc immediately after the change ships, on a Conductor version that pre-dates the change, will see docs that don't match runtime behavior. Acceptable: docs always describe the current code; the migration sentence is the bridge.

**Verify**: After edit, `grep -n 'auth.endpoint\|mcp.sock' docs/operations.md` should return zero matches.

**Rollback**: Revert with git; mechanical.

---

### Step 6: Correct repo's own `.gitignore` runtime-artifact list

**File**: `.gitignore` (lines 40-47)

**Before** (current repo gitignore):
```                                                                              ← bare gitignore syntax
# Conductor runtime artifacts (when dogfooding)                                  ← unchanged comment
.conductor/auth.token                                                            ← correct
.conductor/auth.endpoint                                                         ← WRONG: should be daemon.endpoint
.conductor/mcp.endpoint                                                          ← correct
.conductor/mcp.sock                                                              ← WRONG: legacy
.conductor/runtime.sqlite                                                        ← forward-looking (Phase 4 in-memory; future-shipped)
.conductor/snapshots/                                                            ← correct
.conductor/runs/                                                                 ← correct
```

**After** (proposed change):
```                                                                              ← bare gitignore syntax
# Conductor runtime artifacts (when dogfooding)                                  ← unchanged comment
.conductor/auth.token                                                            ← unchanged
.conductor/daemon.pid                                                            ← NEW: daemon-written PID (added for completeness)
.conductor/daemon.endpoint                                                       ← FIXED: was auth.endpoint
.conductor/mcp.endpoint                                                          ← unchanged
.conductor/runtime.sqlite                                                        ← unchanged (kept as forward-looking)
.conductor/snapshots/                                                            ← unchanged
.conductor/runs/                                                                 ← unchanged
```

**Why**: Aligns this repo's own gitignore (which the project dogfoods against itself) with the daemon-source contract. Adding `daemon.pid` matches the corrected user-project template. Keeping `runtime.sqlite` is intentional — Phase 4 ships in-memory SQLite per `src/daemon/runtime.ts:4` but that's forward-looking; when the SQLite implementation eventually writes to disk, this line is already in place.

**Risk**: None on its own — this is the repo's own gitignore, not the user-project template. Any developer dogfooding Conductor on this repo benefits from the corrected list.

**Verify**: `grep -n 'auth.endpoint\|mcp.sock' .gitignore` should return zero matches.

**Rollback**: Revert; mechanical.

---

### Grouped Run Coverage

| Target | Kind | Obligation | Plan Step(s) | Files / Symbols | Notes |
|--------|------|------------|--------------|-----------------|-------|
| `init-emits-no-gitignore-template.md` (this issue) | run leader | full | 1, 2, 3, 4 | `src/cli/commands/init.ts::GITIGNORE_BLOCK`, `src/cli/commands/init.ts::ensureGitignoreBlock`, `src/cli/commands/init.ts::runInit`, `src/cli/commands/init.ts::attachInit`, `tests/cli/init.test.ts` (+4 cases) | run leader; implementation + test coverage |
| `unfiled: docs/operations.md:161-175 - § Auth token lifecycle gitignore template drift + invalidated paragraph` | unfiled candidate | full | 5 | `docs/operations.md:161-175` | template entries corrected to match daemon source; trailing paragraph rewritten to describe new init behavior |
| `unfiled: .gitignore:40-47 - repo's own gitignore contract drift` | unfiled candidate | full | 6 | `.gitignore:40-47` | template entries corrected to match daemon source; `runtime.sqlite` preserved as forward-looking |

Every grouped entry has a plan-step mapping. Each obligation is `full`; each is covered by explicit file/symbol changes.

---

## Test Changes

- `tests/cli/init.test.ts` — 4 new `it()` cases inside the existing `describe('runInit')` block. Net: 13 → 17 tests.
- No changes to other test files. `tests/integration/` is unaffected (the daemon and engine surfaces are untouched).
- No new test fixture utilities needed — `mkdtemp` tmpdir pattern already exists.

## Post-Implementation Checks

1. `tsc --noEmit -p tsconfig.json` — typecheck the InitResult shape change.
2. `npx vitest run tests/cli/init.test.ts 2>&1 | tail -50` — narrow scope: confirm 17/17 init tests pass.
3. `npm test 2>&1 | tail -50` — full suite: confirm no regression (expected 538 → 542 with +4 init cases).
4. `grep -n 'auth\.endpoint\|mcp\.sock' docs/operations.md .gitignore src/cli/commands/init.ts` — confirm zero matches (contract drift eliminated).
5. Visual check: `cat docs/operations.md | sed -n '160,180p'` confirms paragraph rewrite landed.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| User with hand-pasted operations.md template (old shape) sees both their hand-pasted entries AND the sentinel-fenced block after upgrade | Medium | Low (git no-ops duplicate ignore entries) | Step 5's docs migration note explains the situation |
| Sentinel header text is changed in a future edit without updating the idempotency check | Low | Medium (future re-runs would duplicate the block) | Step 1's helper uses the `GITIGNORE_SENTINEL_HEADER` constant directly; any change to the literal would be caught by case-3 idempotency test |
| `daemon.pid` addition to the template is unwelcome (some users may want PID committed for some reason) | Very low | Low (user can hand-edit per case-4 invariant) | Sentinel design lets users remove individual lines without triggering re-add |
| Tests on Windows path separators | Low | Medium (CI/local divergence) | `tests/cli/init.test.ts` already uses `join()` from `node:path` and `mkdtemp(tmpdir())`; new cases follow the same convention |
| 12 test files beyond `init.test.ts` call `runInit({ cwd: tmp })`; each will now also write `tmp/.gitignore` (added at review per Adversarial Review LOW finding) | High (sure to fire) | None | Verified by grep at review time: no test reads `tmp/.gitignore`; no test asserts on top-level `tmp` contents; tests using `simpleGit(tmp).add('.')` after `runInit` harmlessly include the new file in the seed commit; tests using `isCleanTree(tmp)` / `uncommittedSnapshot(tmp)` write fixtures outside `.conductor/` and are unaffected by the new ignore block |

## Rollback Plan

Code-only change; no DB migrations, no config schema changes (`InitResult` shape changes but is internal — no persisted format), no stored data changes. Single rollback step: `git revert <commit-sha>` once the change is committed and `<commit-sha>` is known.

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
| 1    | Add gitignore constants + `ensureGitignoreBlock` helper in `src/cli/commands/init.ts` | YES | YES — header constant, footer constant, 6-line block, idempotent helper with ENOENT-only catch, trailing-whitespace normalization, discriminated return |
| 2    | Wire `ensureGitignoreBlock` into `runInit` + extend `InitResult` | YES | YES — single call after the existing `writeIfMissing` block, targeting `args.cwd` (project root); `gitignore` field added to `InitResult` |
| 3    | Update CLI action stdout to mention gitignore outcome | YES | YES — `firstLine` extracted to local; `gitignoreLine` appended conditionally; silent on no-op re-runs |
| 4    | Add 4 test cases to `tests/cli/init.test.ts` | YES | YES — created/appended/unchanged/user-edit-preserved + regression guards for `auth.endpoint` and `mcp.sock` |
| 5    | Correct `docs/operations.md § Auth token lifecycle` template + paragraph | YES | YES — corrected 6-line template with sentinel fences; rewritten paragraph describing new init behavior + migration note |
| 6    | Correct repo's own `.gitignore:40-47` | YES | YES — `auth.endpoint` → `daemon.endpoint`; `mcp.sock` removed; `daemon.pid` added; `runtime.sqlite` preserved |

### Grouped Run Coverage Check

| Entry | Closure obligation | Files / Symbols touched | Verdict |
|---|---|---|---|
| Run leader (init-emits-no-gitignore-template) | full | `src/cli/commands/init.ts` (constants, helper, runInit, attachInit), `tests/cli/init.test.ts` (+4 cases) | ✓ |
| docs/operations.md:161-175 template + paragraph drift | full | `docs/operations.md` (lines 161-180 corresponding to revised section) | ✓ |
| .gitignore:40-47 repo gitignore drift | full | `.gitignore` (lines 40-47) | ✓ |

All three grouped entries closed at `full` granularity. No untouched entries; no verification objections raised.

### Test Results

- **Typecheck**: `npm run typecheck` → clean (zero errors, zero warnings).
- **Targeted CLI init**: `npx vitest run tests/cli/init.test.ts` → 17/17 pass (~288ms). The 4 new cases (created / appended / unchanged / user-edit-preserved) all green; regression guards for `auth.endpoint` and `mcp.sock` absence both fire.
- **Full CLI directory**: `npx vitest run tests/cli/` → 18 files / 68 tests pass (~5.4s). None of the 12 other `runInit`-calling test files (work, work-phase2, work-phase3, transition, discover, card-new, exercise, order, drift, daemon, etc.) regressed — confirming the Adversarial Review LOW finding (cross-test side effect verified benign).
- **Full suite**: `npm test` → 98 files / 542 tests pass (~15.4s). Suite size 538 → 542 (+4 init cases, exactly as planned). No regressions anywhere — including the integration tests at `tests/integration/end-to-end.test.ts`, `phase2-end-to-end.test.ts`, `phase3-end-to-end.test.ts` that scaffold with `runInit({ cwd: tmp })` and commit with `simpleGit(tmp).add('.')`.
- **Residue scan**: `grep -n 'auth\.endpoint\|mcp\.sock' --exclude-dir=.relay` → 2 expected hits in `tests/cli/init.test.ts:122-123` (the by-design regression guards) + 3 hits in `docs/superpowers/specs/2026-05-06-conductor-design1.md` (Phase 4 historical design spec — archival, not a live doc). No residue in live surfaces.

### Issues Found

None. The implementation matches the plan exactly. No deviations recorded.

### Verdict

**COMPLETE** — all 6 plan steps implemented; all 3 grouped entries closed at `full` granularity; 542/542 tests pass with +4 net delta as planned; typecheck clean; no live-doc residue of the corrected contract-drift names. Ready for `/relay-resolve`.

---

## Adversarial Review

*Reviewed: 2026-05-14*

### Source verification (re-read at review time)

- `src/cli/commands/init.ts:1-242` re-read. Matches plan's BEFORE blocks for steps 1, 2, 3 exactly. `SUBDIRS` includes `archive/notebooks` (irrelevant to this work). `writeIfMissing` helper is unchanged at lines 197-206 (write-if-absent — does NOT cover read-then-modify, so the new `ensureGitignoreBlock` helper is correctly introduced as a separate function).
- `tests/cli/init.test.ts:1-109` re-read. Matches plan's BEFORE block for step 4 exactly. 13 existing tests, all using `mkdtemp` tmpdir; the last test ends at line 107 with `expect(second.configWritten).toBe(false)`. Append site at line 108 (before closing `});`) is correct.
- `docs/operations.md:161-175` re-read. Matches plan's BEFORE block for step 5 exactly (template at 163-170, paragraph at 172-175). One nit: in step 5's after-block I wrote that the closing fence after `# --- /conductor ---` precedes a line "(`mcp.sock` removed: legacy Phase-4 spec artifact)" — that line is the inline comment annotation, not literal doc content. The actual doc edit should have the fenced code block followed directly by the paragraph rewrite, with no marginalia line. Acknowledged.
- `.gitignore:40-47` re-read. Matches plan's BEFORE block for step 6 exactly: `auth.token`, `auth.endpoint`, `mcp.endpoint`, `mcp.sock`, `runtime.sqlite`, `snapshots/`, `runs/`.

No drift between plan and source. No mid-plan code commits intervened.

### Issues Found

**Severity: LOW — Cross-test side effect from new `.gitignore` write at `args.cwd`**

The plan correctly notes (step 1 Risk) that hand-pasted operations.md templates could end up duplicated alongside the sentinel block. A broader scan surfaces a related concern not raised in the plan: **`runInit({ cwd: tmp })` is called from 12 test files beyond `tests/cli/init.test.ts`**, including `tests/cli/work-phase2.test.ts`, `work-phase3.test.ts`, `transition.test.ts`, `discover.test.ts`, `card-new.test.ts`, `exercise.test.ts`, `order.test.ts`, `work.test.ts`, plus integration tests at `tests/integration/end-to-end.test.ts`, `phase2-end-to-end.test.ts`, `phase3-end-to-end.test.ts`. Each will now also write `tmp/.gitignore`.

Assessment: no test reads `tmp/.gitignore` (grep confirms zero matches for `\.gitignore` in `tests/`); no test does `readdir(tmp)` and asserts on top-level contents (the 4 grep hits for `readdir.*tmp` all narrow to subpaths like `.conductor/cards/`, `.conductor/runs/`, or use `simpleGit(tmp).status()` which returns the git view, unaffected by an unstaged `.gitignore`). The `tests/cli/work-phase2.test.ts` and `work-phase3.test.ts` bootstrap pattern (`git init` → `runInit` → `g.add('.') && g.commit('seed')`) means the new `.gitignore` is included in the seed commit alongside `config.yaml`, `state.md`, etc. — that's a benign expansion of the seed commit contents, not a regression. No test asserts on the seed commit's tracked-file count.

The one watch-out: any test that creates files in `.conductor/runs/` or `.conductor/snapshots/` and THEN calls `isCleanTree(tmp)` or `uncommittedSnapshot(tmp)` expecting to see those files would now see them filtered (the new `.gitignore` excludes them). Grep across `tests/engine/state/git.test.ts` and `tests/engine/ops/detect_drift.test.ts` confirms these tests use their own fixtures (`a.txt`, `b.txt`, `c.txt`) and don't write to `.conductor/runs/` — safe.

**Plan has** (Step 1 Risk register, addresses ONLY the docs-paste duplicate-entry case):
```
| User with hand-pasted operations.md template (old shape) sees both their | Medium | Low | Step 5's docs migration note explains the situation |
| hand-pasted entries AND the sentinel-fenced block after upgrade           |        |     |                                                     |
```

**Should be** (extend the Risk register with the test-fixture side effect):
```
| User with hand-pasted operations.md template (old shape) sees both their | Medium | Low | Step 5's docs migration note explains the situation |
| hand-pasted entries AND the sentinel-fenced block after upgrade           |        |     |                                                     |
| 12 test files beyond init.test.ts call runInit({ cwd: tmp }); each will   | High   | None| Verified by grep: no test reads tmp/.gitignore;     |
| now also write tmp/.gitignore                                              | (sure  |     | no test asserts on top-level tmp contents; seed     |
|                                                                            |  to    |     | commits in work-phase2/3 tests harmlessly absorb    |
|                                                                            |  fire) |     | the extra file                                      |
```

This is a documentation correction in the Risks & Mitigations section, not a code change. Severity LOW because impact is None (verified empirically by reading affected tests).

### Edge Cases to Handle

| Edge case | Plan handles? | Notes |
|---|---|---|
| `.gitignore` absent → create | ✓ | Step 1 case 1; tested in step 4 case 1 |
| `.gitignore` present, block absent → append with blank-line separator | ✓ | Step 1 case 2; tested in step 4 case 2 |
| `.gitignore` present, block present → no-op | ✓ | Step 1 case 3; tested in step 4 case 3 |
| `.gitignore` present, block present but user has deleted a line inside → no-op (user edit preserved) | ✓ | Step 1 case 4 (sentinel-header-only gate); tested in step 4 case 4 |
| `.gitignore` is empty (zero bytes) | ✓ | `trimmedEnd === ''` branch writes just the block + newline |
| `.gitignore` is whitespace-only | ✓ | Same `trimmedEnd === ''` branch; the regex `/\s+$/` strips all-whitespace down to empty |
| `.gitignore` ends with `\n\n` (trailing blank line) | ✓ | `trimmedEnd` strips it; block written with `\n\n` separator (one blank line above the sentinel header) |
| `.gitignore` does not end with newline | ✓ | `trimmedEnd` ignores trailing-whitespace state; output always ends with `\n` |
| `.gitignore` has UTF-8 BOM | ✓ (benign) | `includes()` substring check works regardless; BOM preserved in output (not stripped); harmless |
| `.gitignore` has CRLF line endings | ✓ (benign) | `existing.includes(GITIGNORE_SENTINEL_HEADER)` is a literal substring match (no newline in header); block appended uses LF; mixed line endings work in git |
| `.gitignore` is a directory not a file (EISDIR) | ✓ | `readFile` throws non-ENOENT; helper propagates; user sees the error |
| `.gitignore` parent dir lacks write permission (EACCES on write) | ✓ | `writeFile` throws; user sees the error (same as existing scaffold-write errors) |
| Sentinel header literal changed without updating idempotency check | N/A | Single source: `GITIGNORE_SENTINEL_HEADER` constant referenced once in the literal and once in `existing.includes()` — no drift possible without simultaneous edit |
| User has only the FOOTER sentinel but not the HEADER (somehow) | ✓ (benign) | Helper sees no header → appends full block (with the new header). Result: stray footer above + correct block below. Implausible and harmless |
| User has the HEADER but not the FOOTER (somehow) | ✓ (treated as "block present") | Helper returns `unchanged`. User's malformed block is preserved as-is (their choice) |
| `args.cwd` is read-only filesystem | ✓ | All writes throw; user sees the error; same failure mode as existing init writes |

Edge cases from `.relay/relay-config.md § Edge Cases`: none apply to `init.ts` directly. The init scaffolder runs before daemon/agent/LLM surfaces are exercised; no provider adapter, tracker, autonomy policy, MOCK adapter, chokidar watcher, SSE bus, or card-frontmatter schema interaction. The `ProjectConfigSchema is strict` invariant is preserved (no schema change). The `verify_command` default is unchanged.

### Regression Risk

| Resolved item | Could this plan re-introduce it? | Evidence |
|---|---|---|
| `auth-token-persists-on-disk-after-daemon-stop` (Phase 15.1) | No | This work is the deferred follow-up; doesn't change daemon auth behavior, only adds gitignore emission |
| `discover-original-issue-uses-h1-not-h2` (Phase 2) | No | Touches different surface entirely |
| `scan-bails-entirely-on-one-malformed-card` (Phase 1) | No | Touches `readCard`/`listCards`; no overlap with init |
| `plan-op-leaves-need-placeholders-resolved-in-analysis` (Phase 5) | No | Touches `plan.ts` SYSTEM_PROMPT; no overlap |
| `brain-events-not-persisted-across-daemon-restarts` (Phase 6) | No | Adds new module; no overlap with init |
| 11 docs-bundle items | No (this work supersedes one paragraph of operations.md but corrects, not regresses) | The paragraph being rewritten was correct relative to the code state at Phase 15.1; this work updates it to match the new code state in Phase 9 |

**Test-suite regression check:** read 4 of the 12 `runInit`-calling test files (init.test.ts, work.test.ts, work-phase2.test.ts, work-phase3.test.ts, end-to-end.test.ts) plus the relevant git-test surface (engine/state/git.test.ts, engine/ops/detect_drift.test.ts). No test asserts on top-level `tmp/` contents or top-level `.gitignore`. Tests that do `simpleGit(tmp).add('.')` after `runInit` will harmlessly include the new `.gitignore` in their seed commit. Tests that use `isCleanTree(tmp)` / `uncommittedSnapshot(tmp)` write their own fixtures (`a.txt`, `b.txt`) outside `.conductor/`, unaffected by the new ignore block.

### Sibling-Survival (Grouped Run)

Walked the `#### Grouped Entries` table against the plan's `### Grouped Run Coverage`:

| Entry | Closure obligation | Plan coverage | Verdict |
|---|---|---|---|
| Run leader (init-emits-no-gitignore-template) | full | Steps 1, 2, 3, 4 — code + tests | ✓ Covered |
| docs/operations.md:161-175 template + paragraph drift | full | Step 5 — explicit doc edit | ✓ Covered |
| .gitignore:40-47 repo gitignore drift | full | Step 6 — explicit gitignore edit | ✓ Covered |

All entries covered at the required granularity. No drops required.

### Verdict

**APPROVED** — no holes in the plan. One context note added to the Risks & Mitigations table below (cross-test side effect, verified benign by review-time grep). No code or plan-step changes required.

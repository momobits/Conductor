# `conductor init` emits bare `pytest` for Python projects, ignoring `.venv` / `venv` / poetry / pdm / uv conventions

> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/init-verify-command-not-venv-aware-for-python.md)

*Created: 2026-05-15*
*Source: 2026-05-15 omniforge dogfood — card stalled in `building` column because the verify op could not find `pytest`*
*Severity: P2 — quality (verify op breaks default-config Python loop; not data loss but stalls every Python card in `building`)*

## Problem statement

`src/cli/commands/init.ts:164-182` (`detectVerifyCommand`) sniffs the user's project root for marker files and returns a verify command. For Python projects it returns the bare token `'pytest'`:

```typescript
const markers: Array<[string, string]> = [
  ['package.json', 'npm test'],
  ['pyproject.toml', 'pytest'],
  ['setup.py', 'pytest'],
  // ...
];
```

`src/engine/ops/verify.ts:117-118` runs this command via `execa(command, { shell: true, reject: false })` — a raw shell invocation that inherits the daemon process's PATH. **No virtualenv detection, no `python -m pytest` fallback, no tool-runner awareness.**

In practice, the daemon is started by the user in a shell session that hasn't `Activate.ps1`/`source .venv/bin/activate`'d the project's venv. `pytest` therefore resolves against the system PATH — which on Windows defaults often have no Python at all (`python3` is the Microsoft Store placeholder shim) and on macOS/Linux typically have the system `python3` but no `pytest`. The verify op fails with:

> Outcome: FAIL  Command: pytest  Exit code: 1
> Summary: The verification command failed with exit code 1. pytest is not installed or not available in the system PATH...
> Failures: pytest command not found or not installed in the Python environment

A card sitting in `building` cannot auto-transition past verify, so the conductor loop stalls. The user has no in-product signal that the cause is "your verify_command doesn't activate your venv" — the chat agent in the UI correctly diagnosed it post-hoc, but that's because chat is an LLM, not because conductor introspected.

This is the **default behavior on every Python project with a venv**, which is the dominant convention since `python -m venv` was standardized in 3.3. Poetry, pdm, and uv users (a growing fraction) hit the same wall — `pyproject.toml` matches before any of those lockfiles are checked.

## Current state

- `src/cli/commands/init.ts:164-182` — `detectVerifyCommand`. Marker list is a flat array with first-match-wins iteration. `pyproject.toml` matches at index 1 (before any Python-tool-runner lockfile would be checked, since none are checked). Returns the literal `'pytest'`.
- `src/engine/ops/verify.ts:117-118` — `execa(command, { shell: true, reject: false })`. Runs the command via shell; inherits parent process PATH; no venv discovery; no env mutation.
- `docs/quickstart.md § 3` (verify_command sniff table) — documents `pyproject.toml | setup.py → pytest` as the detected default. Doesn't mention that this only works if pytest is on PATH (i.e., venv is activated in the daemon's shell).
- `.conductor/config.yaml` (post-init) — the `verify_command: pytest` line is the surface the user has to edit to fix it. No comment or example showing the venv-aware shape.

**Marker ordering nit also worth recording**: when a project has both `pyproject.toml` AND `Makefile` (common in monorepos and modern Python projects), `pyproject.toml` wins because it's earlier in the array. A Makefile with a `test` target that knows the venv-aware invocation would be the correct choice but is never tried. Recording this for the planner to decide whether to address; the venv-direct fix is the higher-leverage path.

## Impact

**User-facing:** Every fresh Python project hits this on the first `conductor work <card-id>` cycle that reaches the `building → verifying` transition. The card stalls with a FAIL verify report. The user has no way to know from the product surface alone that the fix is "edit `.conductor/config.yaml verify_command:`"; the chat agent inside the UI can analyze the failure (since it's an LLM with access to the project) but that's a coincidence of the chat surface existing, not a designed recovery path. New users on Windows are especially affected because system PATH commonly has zero Python at all (Microsoft Store `python3` placeholder, no `pytest`).

**Loop-facing:** Verify is on the critical path of the autonomous loop (`approved → building → verifying → shipped`). A failing verify halts the loop. If `autonomy.transitions.building_to_verifying: auto` and verify always fails, the brain (when enabled) will halt cards repeatedly. Idle detection ("same card halts twice without progress") will quarantine every Python card.

**Project-facing:** Conductor advertises Python support via the `pyproject.toml` / `setup.py` markers in init. Today that support is effectively broken on first use for ~the majority of Python projects (anyone using `python -m venv`, poetry, pdm, or uv — i.e., anyone who isn't installing pytest system-wide, which is itself unusual).

**Severity calibration:** Not P1 because (a) the workaround is a one-line config edit, (b) no data loss, (c) the daemon/MCP/CLI/UI continue to work, only the loop's verify step stalls. Not P3 because the friction fires on the first Python card every time, and the workaround is non-obvious without reading the source.

### Concrete scenario

User Alice runs `conductor init --provider subscription` in `~/projects/payment-api` (a Python project using `python -m venv .venv` + `requirements.txt` + `pyproject.toml`). She does not activate the venv before starting the daemon — she's a Conductor user, not a Python developer, and her muscle memory says daemons just run.

```powershell
conductor daemon start
# Daemon up at http://127.0.0.1:7180/?token=<uuid> (pid=12345)
```

She files a card via the UI (`conductor card new fix-the-auth-bug`), works it through `discovered → planned → approved → building`. At `building → verifying`, conductor runs `pytest` via `execa shell: true`. The daemon's PATH has no `pytest` — venv is dormant. Verify writes the FAIL report onto the card. The card is stuck in `building`; the brain idle-detects and halts; Alice sees a vague "verify failed" red badge.

She opens the card in the UI, reads the FAIL report, scratches her head, asks the chat: "which python environment are you using?" The chat (an LLM in-product, not the verify op itself) reads her project structure, finds `.venv/Scripts/python.exe`, and explains the fix. Alice edits `.conductor/config.yaml`:

```yaml
verify_command: .venv\Scripts\python.exe -m pytest
```

Reruns `conductor work fix-the-auth-bug`. Verify passes. Card advances.

Alice had to:
1. Manually diagnose a generic "command not found" failure
2. Know that conductor's verify command lives in `.conductor/config.yaml`
3. Know her project's venv path conventions (`.venv\Scripts\` vs `.venv/bin/`)
4. Know that `-m pytest` is needed (not `\Scripts\pytest.exe` directly)

None of these are baseline Conductor-user knowledge.

## Proposed fix

Extend `detectVerifyCommand` to be **venv-aware and tool-runner-aware** for Python projects. Several layers, ordered most-specific to least-specific (the function returns the first that matches):

### Detection layers (Python branch, in priority order)

1. **`uv.lock` present** → `uv run pytest`. uv is the fastest-growing modern tool; lockfile presence is the canonical "this is a uv project" signal. `uv run` activates the project env automatically.
2. **`pdm.lock` present** → `pdm run pytest`. Same shape as uv.
3. **`poetry.lock` present** → `poetry run pytest`. Same shape; widest-deployed pre-uv tool.
4. **`.venv/Scripts/python.exe` present (win32) OR `.venv/bin/python` present (posix)** → emit the explicit venv-Python invocation: `.venv\\Scripts\\python.exe -m pytest` on win32 / `.venv/bin/python -m pytest` on posix. Detect platform via `process.platform === 'win32'`.
5. **`venv/Scripts/python.exe` (win32) OR `venv/bin/python` (posix)** → same shape with `venv/` (some projects use the unprefixed convention).
6. **`pyproject.toml` or `setup.py` present, but none of the above** → fall back to `python -m pytest` (still better than bare `pytest` — at least it works when `python` is on PATH and pytest is installed in the system Python, which is common in CI / Docker contexts). **Or** keep the existing `pytest` literal as a last resort and add a doc note. **Lean:** `python -m pytest` is the safer fallback; `pytest` was wrong-by-default and there's no reason to keep it.

### Marker ordering for the broader array

Once the Python branch detects multiple candidates, the precedence above resolves it. The outer marker array (`package.json` vs `pyproject.toml` vs `Makefile` vs ...) is unchanged.

**Marker-ordering nit**: orthogonal. A `Makefile` with a `test` target is a stronger signal than `pyproject.toml` alone (the maintainer explicitly opted into make-based testing), but addressing this is a separate concern. Out of scope for this issue unless the analysis pass surfaces it.

### Optional UX nicety: warn at init when no venv is detected

If `pyproject.toml` matches but no `.venv` / `venv` / poetry / pdm / uv marker is present, `conductor init` prints a one-line note to stdout:

> No Python virtualenv detected. Using `python -m pytest` as the default; edit `.conductor/config.yaml verify_command:` if pytest isn't on your Python path.

Cheap, friction-reducing, and signals to the user that they're on the "least preferred" detection branch.

### Optional: emit a comment-prefaced config block

When init writes `verify_command:` to `config.yaml`, prepend a comment that names the detection branch:

```yaml
# Detected: .venv/ + Python 3 project (using project venv's python -m pytest).
# To switch: edit this line. See docs/quickstart.md § 3 for full list.
verify_command: .venv\Scripts\python.exe -m pytest
```

The comment makes the workaround discoverable from the config alone.

## Affected files

- `src/cli/commands/init.ts` — `detectVerifyCommand`: extend with the Python-branch ladder above. Add `process.platform` checks for win32/posix split. Optionally emit a stdout note when on the fallback `python -m pytest` branch.
- `tests/cli/init.test.ts` — extend with cases for each detection layer: `.venv-win32`, `.venv-posix`, `venv-win32`, `venv-posix`, `poetry.lock`, `pdm.lock`, `uv.lock`, fallback `python -m pytest`. Existing 2-3 Python-detection tests need updating to expect the new defaults (no longer bare `pytest`).
- `docs/quickstart.md § 3` — verify_command sniff table: replace the single `pyproject.toml | setup.py → pytest` row with the layered detection ladder. Note the platform split.
- `docs/operations.md § verify` (if not already documented) — note that verify inherits the daemon's PATH; venv activation is the user's responsibility unless `verify_command` is venv-explicit.
- (Optional) `examples/with-*/.conductor/config.yaml` — add a commented-out `# verify_command: .venv\Scripts\python.exe -m pytest  # Python venv example` line so Python users have a copy-paste reference.

## Notes / open questions for the planner

- **Platform detection**: `process.platform` is the canonical Node way. Test runners (vitest) honor it; mocking is straightforward with `vi.stubGlobal` or `vi.spyOn(process, 'platform', 'get')`. The platform-specific path joins (`'\\'` vs `'/'`) should use `node:path` `join`/`sep`, not be hard-coded.
- **Should the helper also handle Conda environments?** Conda envs aren't co-located with the project; detection requires `conda env list` introspection plus a `meta.yaml` / `environment.yml` marker. Higher cost, lower value (Conda users tend to be ML researchers who'd customize `verify_command` regardless). **Lean:** out of scope; defer to a follow-up issue if dogfood signals it.
- **Tool-runner output stability**: `poetry run` / `pdm run` / `uv run` all have evolving CLIs. If any of them changes the way `run <cmd>` resolves, the detected command stops working. **Mitigation:** these commands are stable on their stable versions; pin via the user's lockfile, not via our detection.
- **Test coverage on Windows**: omniforge dogfood was on Windows; this is the primary affected platform. CI should run on win32 AND posix to catch the path-separator branches. (Conductor's existing CI / vitest setup may need a Windows job if not already present.)
- **Marker ordering for Makefile + pyproject.toml**: filed for awareness here; not in scope for this issue. Worth a separate issue if the analysis pass agrees.
- **Workaround for users on the current version**: edit `.conductor\config.yaml verify_command:` to the venv-aware shape. Same workaround pattern as the `daemon start --browser` issue — discoverable only by reading source or asking chat.

---

## Analysis

*Analyzed: 2026-05-15*

### Validation
- **Problem still exists:** YES at `src/cli/commands/init.ts:164-182` exactly as described. The `markers` array still maps both `'pyproject.toml'` and `'setup.py'` to the bare literal `'pytest'`. No `process.platform` branch. No venv lockfile checks. No `python -m pytest` fallback.
- **Proposed approach still valid:** YES. The six-rung ladder (uv → pdm → poetry → `.venv` platform-split → `venv` platform-split → `python -m pytest` fallback) integrates cleanly into the existing first-match-wins iteration. Two design choices to surface to `/relay-plan` (see Approach below): helper-extraction vs inline; stdout fallback note vs omit.

### Root Cause
The `markers` flat-array first-match-wins design works for static one-to-one mappings (`package.json → npm test`; `Cargo.toml → cargo test`). It breaks for Python because **the runtime resolvability of `pytest` depends on PATH state at daemon-start time, not on the existence of a marker file**. The detection is purely marker-based; runtime PATH is opaque to init.

This is a category/symptom split: marker-detection answers "which language toolchain is this?" correctly; it answers "which command can the daemon actually execute?" wrongly. The proposed fix collapses both concerns at init-time by reading the venv/lockfile state and **baking the explicit binary path into the command string** so verify-time PATH state is irrelevant.

No related Relay item shares this root cause. The closest analog is Phase 17's `ensureGitignoreBlock` (`src/cli/commands/init.ts:109-131`), which similarly reads project state at init-time, but for a different concern (managed-content-block idempotency, not toolchain detection).

### What This Means (User Impact)

**In plain terms:** Every fresh Python project that uses `python -m venv .venv` (or poetry / pdm / uv) hits a dead-end on its first card. `conductor init` writes a verify command (`pytest`) that the daemon's shell can't find because the venv isn't activated in the daemon's environment. The card stalls in `building` with a "pytest not found" error, and the user has no in-product signal that the cause is "your verify_command needs the venv path." Windows users get a worse failure because system PATH often has no Python at all (Microsoft Store python3 placeholder).

**Scenario:** Alice runs `conductor init --provider subscription` in `~/projects/payment-api`. Her project has `pyproject.toml` + `.venv\Scripts\python.exe` (Windows). She does NOT run `.venv\Scripts\Activate.ps1` before `conductor daemon start` — her muscle memory says daemons just run. She files `fix-the-auth-bug`, works it through `discovered → planned → approved → building`. At `building → verifying`, conductor invokes `pytest` via `execa(command, { shell: true })`. The daemon's PATH has no `pytest`. Verify writes a FAIL report. Card stuck. Brain idle-detects; quarantines the card. Alice opens the card, reads the report, asks the UI chat which Python environment it's using; the LLM analyzes her project layout and explains the fix. She edits `.conductor/config.yaml` to `verify_command: .venv\Scripts\python.exe -m pytest`. Reruns. Verify passes.

**Before (current behavior):**
1. User runs `conductor init` in a Python project with `.venv/` present.
2. `init` writes `verify_command: pytest` (bare literal).
3. User starts the daemon outside the venv.
4. First card reaches `building → verifying`; verify fails (`pytest: command not found`).
5. Card stalls; brain quarantines; user must self-diagnose + hand-edit `.conductor/config.yaml`.

**After (with fix):**
1. User runs `conductor init` in a Python project with `.venv/` present.
2. `init` detects `.venv/Scripts/python.exe` (win32) or `.venv/bin/python` (posix) and writes `verify_command: .venv\Scripts\python.exe -m pytest` (or the posix equivalent).
3. User starts the daemon outside the venv (no need to activate).
4. First card reaches `building → verifying`; verify invokes the explicit venv-Python `-m pytest`. PASS.
5. Card advances normally.

For uv / pdm / poetry projects: the `*.lock` markers are detected and `uv run pytest` / `pdm run pytest` / `poetry run pytest` is written — these tool runners activate the project env internally, so the daemon doesn't need an active venv.

For bare `pyproject.toml` / `setup.py` projects (no venv, no lockfile): `init` writes `python -m pytest` (still safer than bare `pytest` — works whenever `python` is on PATH and pytest is installed in the system Python, which is the common CI / Docker shape), and emits a one-line stdout note so the user knows they're on the least-specific branch and may need to edit `.conductor/config.yaml`.

### Blast Radius

**Files affected (with function names):**
- `src/cli/commands/init.ts` — extend `detectVerifyCommand` (lines 164-182) with the Python ladder; add private helper `detectPythonVerifyCommand(cwd, platform): Promise<string | null>` for testability (lean per Approach). Extend `attachInit` action callback (lines 255-294) to print the fallback-branch stdout note. **No `InitResult` shape change required** — `verifyCommand: string | null` already exists.
- `tests/cli/init.test.ts` — update the existing assertion at line 79 (`expect(result.verifyCommand).toBe('pytest')`) to match the new platform-aware default; add 7-8 new cases for each ladder rung. Stub `process.platform` via `vi.spyOn(process, 'platform', 'get').mockReturnValue(...)` — **this pattern is not yet in the repo** (Explore grep confirmed), so it's a new test-fixture convention.
- `docs/quickstart.md` — line 48-54 table: replace the single `pyproject.toml | setup.py → pytest` row with a multi-row block for the ladder, noting the platform split.

**Callers and consumers:**
- `runInit()` (`src/cli/commands/init.ts:209-242`) is the sole caller of `detectVerifyCommand`. The returned string is passed to `applyVerifyCommand(config, verifyCmd)` (lines 184-192) which writes it verbatim into `.conductor/config.yaml`'s `verify_command:` line.
- `src/engine/ops/verify.ts:117-118` (`defaultRunner`) is the eventual consumer: `execa(command, { shell: true, reject: false })`. **Shell-quote-safe for any string init emits** — `execa shell: true` defers parsing to the platform shell (Windows `cmd.exe` handles backslash paths; POSIX `sh` handles forward-slash paths). **No change to verify.ts required.**
- `tests/cli/init.test.ts` has 13+ cases that call `runInit({ cwd: tmp, provider: 'subscription' })` in their beforeEach. None currently assert on `verifyCommand` except the L76-82 Python case; the new value flows through harmlessly elsewhere.

**Test coverage status:** The L76-82 case is the SOLE Python-detection test. Post-change, expect ~7-8 new cases (4 platform-split × 2 venv-prefix-variants + 3 lockfile cases + 1 fallback case) plus the assertion update on the existing case. Total `init.test.ts` count expected: ~17 + 7 = ~24.

**Config interactions:** `.conductor/config.yaml`'s `verify_command:` field is the only config touchpoint. No `ProjectConfigSchema` change needed; the field is already a free-form string per `src/config/schema.ts`. Aligns with `relay-config.md § Edge Cases > Config Boundaries`: "Verify command default `verify_command: 'npm test'`. Project-type-detected defaults are written by `cli/commands/init.ts --provider`; do not hardcode `npm test` in new ops." This change extends the project-type-detection logic; doesn't introduce a new hardcode site.

**Cross-item interactions:** None. The other active Relay item (`daemon-start-missing-browser-flag.md`) was closed WONT-DO earlier this session. No active features. The autonomous-loop `verify` op (`src/conductor/loop.ts`) consumes verify's output but doesn't care about the command shape — it only reads the exit code and the FAIL report.

**Past work regression risk:**
- Phase 17 `ensureGitignoreBlock` (`init.ts:109-131`) — different function in same file; this change doesn't touch its scope. Low risk.
- Phase 18 `formatDaemonStartedMessage` (`daemon.ts`) — different file; no shared symbol. Zero risk.
- All 13 existing init tests will get an improved `verifyCommand` value flowing through their `runInit` calls; none read or assert on the value (except the Python case being updated). Benign side effect.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (serena unavailable)*

#### Findings

- **Target:** `.relay/archive/issues/init-emits-no-gitignore-template.md` (Phase 17)
  - **Kind:** existing item (archived)
  - **Evidence:** medium
  - **Why related:** Shares the file `src/cli/commands/init.ts` (different function — `ensureGitignoreBlock` at L109-131 vs. `detectVerifyCommand` at L164-182). Establishes reusable pattern precedents: (a) `InitResult` shape extension with a discriminator field; (b) test-cases-as-state-transitions; (c) stdout signal pattern in the CLI action callback. The venv ladder reuses (b) and (c) directly; (a) is not needed because `InitResult.verifyCommand: string | null` already exists.
  - **Suggested handling:** keep narrow (pattern borrow only; no code overlap).

- **Target:** `.relay/archive/issues/daemon-start-first-visit-ui-token-ux-broken.md` (Phase 18)
  - **Kind:** existing item (archived)
  - **Evidence:** weak
  - **Why related:** Subsystem sibling — both items are CLI command surfaces that scaffold state on first run and signal outcomes via stdout. The Phase 18 helper-extraction pattern (`formatDaemonStartedMessage` exported pure helper unit-tested with exact-string assertions; action callback delegates) is a direct candidate for the proposed `detectPythonVerifyCommand` helper here. **n=1 precedent for the pure-helper pattern was Phase 18; this would be n=2, which per STATE.md "Recent decisions" elevates the pattern to ADR-worthy.**
  - **Suggested handling:** keep narrow (pattern borrow; no code overlap).

- **Target:** `unfiled: src/cli/commands/init.ts::detectVerifyCommand - Makefile row matches before pyproject.toml in same-project case`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** In a Python monorepo with BOTH `pyproject.toml` AND a `Makefile` with a venv-aware `test:` target, the Makefile shape is the maintainer's correct choice but is never tried (pyproject wins at array index 1). The issue body acknowledges this nit (line 91-95 "Marker-ordering nit") and explicitly defers it. Recording so the planner doesn't surprise-fix it.
  - **Suggested handling:** keep narrow (deferred by the issue body itself; file a fresh issue only if dogfood signals it).

- **Target:** `unfiled: docs/quickstart.md::§ 3 verify_command table`
  - **Kind:** unfiled candidate (contract drift)
  - **Evidence:** strong
  - **Why related:** Lines 48-54 contain a 5-row table that currently advertises `pyproject.toml | setup.py → pytest`. The ladder lands; the row needs replacement. Already enumerated in the issue's "Affected files" list (line 121); calling out so the plan emits an explicit coverage step.
  - **Suggested handling:** keep narrow (covered by the planned changes; not a companion).

- **Target:** `unfiled: docs/operations.md::§ verify`
  - **Kind:** unfiled candidate (contract drift, low)
  - **Evidence:** weak
  - **Why related:** Per the Explore agent's grep, `docs/operations.md` mentions `verify_command` as a config read but doesn't assert on its shape. Not breaking drift; nice-to-have prose clarification ("Conductor detects venv layout at init time; you rarely need to edit `verify_command:` for Python projects with `.venv`, poetry, pdm, or uv").
  - **Suggested handling:** keep narrow (optional polish — let the planner decide to absorb or skip).

- **Target:** `unfiled: tests/cli/init.test.ts::process.platform stubbing convention not yet present`
  - **Kind:** unfiled candidate (test infra)
  - **Evidence:** medium
  - **Why related:** Explore agent's grep confirmed no existing `vi.spyOn(process, 'platform', 'get')` pattern in the suite. The platform-split test cases here will establish this convention. Worth a one-line note in the impl doc so future cross-platform tests can find the recipe.
  - **Suggested handling:** keep narrow (record the new convention inline; no separate issue needed).

#### Search Bounds

- Live codepath audit: complete (`detectVerifyCommand` is monolithic; `runInit` is the only caller; `defaultRunner` in `verify.ts:116-124` is the eventual consumer)
- Backlog codepath: complete (1 active issue scanned — the target; `.relay/features/` empty)
- Subsystem: complete (all `src/cli/commands/*.ts` files plus `src/engine/ops/verify.ts` examined; ~30-file cap not hit)
- Archive: complete (19 archived issues scanned by Explore agent)
- Implementation: complete (18 impl docs scanned by Explore agent)
- Contract drift: complete (`docs/quickstart.md`, `docs/operations.md`, `.relay/relay-config.md`, README confirmed via Explore agent grep; no hallucinated-symbol risk)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-15
*Rationale:* Findings are weak-to-medium and orthogonal to the target's root cause. The two strong/medium candidates (`init-emits-no-gitignore-template.md` and the `docs/quickstart.md § 3` table) are pattern-borrow-only and coverage-already-planned, not sibling bugs requiring grouped closure. The Makefile-ordering nit is explicitly deferred by the issue body; the `process.platform` stubbing convention is a fixture-establishment to record in the impl doc rather than a separate issue; the `docs/operations.md` polish is optional absorption by the planner. No promotion candidate (single subsystem, no architectural deepening required).

### Approach

**Recommended:** Adopt the six-rung ladder as proposed in the issue body. Implementation in `src/cli/commands/init.ts:164-182` (`detectVerifyCommand`). Two design choices flagged for `/relay-plan`:

1. **Hoist the Python branch into a helper, or keep inline?** The issue's "Affected files" suggests inline extension of the existing `markers` array; but the platform-split + lockfile-check logic doesn't fit the flat-array `[marker, cmd]` shape — platform-split requires a conditional, not a static row. **Lean: extract `detectPythonVerifyCommand(cwd: string, platform?: NodeJS.Platform): Promise<string | null>` as a small private helper** (~25-30 lines) called from `detectVerifyCommand` when an early-rung lockfile or venv marker matches; falls back through the cascade. Makes the platform-split unit-testable in isolation via `vi.spyOn(process, 'platform', 'get')`. Mirrors the Phase 18 pure-helper extraction pattern (`formatDaemonStartedMessage` → action callback delegates) — **n=2 of the pure-helper pattern; promote to ADR.**

2. **Stdout fallback note — emit, or omit?** **Lean: emit.** Cheap (one `console.log`), discoverable, aligns with the issue's "Optional UX nicety". Print only on the bare-`python -m pytest` branch (least-specific). Shape mirroring Phase 17's gitignore-block signal:
   `No Python venv detected; using "python -m pytest". Edit .conductor/config.yaml verify_command: if pytest isn't on the system Python's PATH.`

**Alternatives considered:**
- **Keep the current marker-array structure; add Python-specific rows inline** (e.g., `['uv.lock', 'uv run pytest']`). **Rejected:** the `.venv/Scripts/python.exe` vs `.venv/bin/python` platform-split doesn't fit the flat-array shape. Trying to force it (conditional row generation) is less readable than a small helper.
- **Defer the stdout note.** **Rejected:** one-line cost; substantial discoverability win. Issue body itself recommends it.
- **Add Conda env detection.** **Rejected (per issue's open questions):** Conda envs not co-located with project; detection cost > value. Defer to a follow-up if dogfood signals it.
- **Fix the Makefile-vs-pyproject ordering nit inline.** **Rejected (per issue's note):** orthogonal; correct fix probably requires Makefile-target parsing, not just existence-check. Out of scope.

**Open questions / decisions needed before implementation:**
- None blocking. The two design questions above are framed as leans with clear rationale; `/relay-plan` adopts them unless `/relay-review` surfaces a defect.

---

## Implementation Plan

*Generated: 2026-05-15*

### Step 1: Add `detectPythonVerifyCommand` helper + extend `InitResult` shape
**File**: `src/cli/commands/init.ts` (new exported helper + `InitResult` interface)
**File**: `tests/cli/init.test.ts` (new `describe('detectPythonVerifyCommand')` block with platform-stubbing unit tests)

**Before** (current `InitResult` interface, lines 202-207):
```typescript
export interface InitResult {                                    // ← exported shape returned by runInit
  configWritten: boolean;                                        // ← whether config.yaml was newly written
  configSource: 'embedded-default' | KnownProvider;              // ← which config source was used
  verifyCommand: string | null;                                  // ← detected verify_command, or null when nothing matched / detection skipped
  gitignore: 'created' | 'appended' | 'unchanged';               // ← gitignore-block transition from Phase 17
}                                                                // ← no Python-branch discriminator yet
```

**After** (extended `InitResult` interface):
```typescript
export interface InitResult {                                    // ← exported shape; unchanged consumers continue reading the same fields
  configWritten: boolean;                                        // ← unchanged
  configSource: 'embedded-default' | KnownProvider;              // ← unchanged
  verifyCommand: string | null;                                  // ← unchanged: returns whatever detectVerifyCommand chose, or null
  verifyCommandFallback: boolean;                                // ← NEW: true only when on bare-`python -m pytest` Python fallback rung; false for any other branch (Node, Rust, Go, Makefile, uv/pdm/poetry, .venv, venv) or when no detection happened. Used by attachInit (Step 3) to emit the stdout note. Default false to keep non-Python paths unaffected.
  gitignore: 'created' | 'appended' | 'unchanged';               // ← unchanged: gitignore-block transition from Phase 17
}                                                                // ← shape extended additively; no removed/renamed fields, no consumer breakage
```

**Before** (no `detectPythonVerifyCommand` helper exists yet; section after the `markers` array at L182):
```typescript
  for (const [marker, cmd] of markers) {                         // ← iterates markers in fixed order; first-match-wins
    try {                                                        // ← guard around access() — throws on ENOENT
      await access(join(cwd, marker));                           // ← checks marker existence; throws if missing
      return cmd;                                                // ← bare string return; for Python this is the buggy bare `pytest`
    } catch {                                                    // ← swallow ENOENT; try next marker
      /* not present, try next */                                // ← intentional empty body
    }                                                            // ← continue loop
  }                                                              // ← exhausted; no match
  return null;                                                   // ← signal "no detection"; caller writes nothing to verify_command
}                                                                // ← end detectVerifyCommand
```

**After** (new exported helper inserted between `detectVerifyCommand` and `applyVerifyCommand`, at L183):
```typescript
  for (const [marker, cmd] of markers) {                         // ← unchanged outer loop
    try {                                                        // ← unchanged ENOENT guard
      await access(join(cwd, marker));                           // ← unchanged marker check
      return cmd;                                                // ← unchanged for non-Python markers (Node/Rust/Go/Makefile); Python markers will be intercepted in Step 2
    } catch {                                                    // ← unchanged
      /* not present, try next */                                // ← unchanged
    }                                                            // ← unchanged
  }                                                              // ← unchanged
  return null;                                                   // ← unchanged exhaustion path
}                                                                // ← end detectVerifyCommand (wiring change comes in Step 2)

/** Detect the right verify_command for a Python project, given the project
 *  has either `pyproject.toml` or `setup.py` present. Returns a venv-aware
 *  / tool-runner-aware command string; never returns the bare `pytest`
 *  literal. The cascade is most-specific → least-specific:                            // ← function-level docstring; ladder enumerated
 *
 *    1. uv.lock           → `uv run pytest`                                          // ← uv is fastest-growing; lockfile presence is canonical signal
 *    2. pdm.lock          → `pdm run pytest`                                         // ← pdm same shape
 *    3. poetry.lock       → `poetry run pytest`                                      // ← poetry widest-deployed
 *    4. .venv/<python>    → `<explicit-venv-python> -m pytest` (platform-split)      // ← explicit binary path; daemon needs no activated venv
 *    5. venv/<python>     → same shape with unprefixed `venv/`                       // ← some projects use the unprefixed convention
 *    6. fallback          → `python -m pytest`                                       // ← still safer than bare `pytest` (works whenever `python` is on PATH and pytest is installed in the system Python — common in CI / Docker)
 *
 *  Platform: pass `platform` to override `process.platform` for tests; defaults
 *  to the runtime value. */                                                          // ← `platform` parameter is the test seam; vi.spyOn(process,'platform','get') would also work but explicit parameter is simpler
export async function detectPythonVerifyCommand(                                      // ← exported (mirrors Phase 18's exported `formatDaemonStartedMessage` for testability)
  cwd: string,                                                                        // ← project root
  platform: NodeJS.Platform = process.platform,                                       // ← optional override; defaults to runtime
): Promise<string> {                                                                  // ← always returns a string (never null); caller decides when to invoke this helper
  // Tool-runner lockfiles (most-specific). Iterate in priority order.
  const lockfiles: Array<[string, string]> = [                                        // ← parallel structure to the marker array; (lockfile, command) pairs
    ['uv.lock', 'uv run pytest'],                                                     // ← rung 1: uv
    ['pdm.lock', 'pdm run pytest'],                                                   // ← rung 2: pdm
    ['poetry.lock', 'poetry run pytest'],                                             // ← rung 3: poetry
  ];                                                                                  // ← list complete
  for (const [lockfile, cmd] of lockfiles) {                                          // ← first-match-wins iteration
    try {                                                                             // ← ENOENT guard
      await access(join(cwd, lockfile));                                              // ← uses node:path join (already imported); platform-safe
      return cmd;                                                                     // ← rung matched
    } catch {                                                                         // ← lockfile not present; continue
      /* not present, try next */                                                     // ← intentional
    }
  }
  // Explicit venv directories. Split the platform-aware concerns:
  //   - existence check: uses node:path `join` (host-platform aware) so `access()`
  //     finds the actual file on disk regardless of which `platform` arg we got.
  //   - returned command string: composed with explicit `sep` derived from the
  //     `platform` PARAMETER so unit tests can deterministically assert win32
  //     and posix output shapes on the same runner. (node:path.join uses
  //     process.platform, NOT our parameter; using it for the returned string
  //     would couple test results to the runner's OS — adversarial review
  //     Issue 1.)
  const scriptsOrBin = platform === 'win32' ? 'Scripts' : 'bin';                      // ← directory name (target-platform aware)
  const pythonExe = platform === 'win32' ? 'python.exe' : 'python';                   // ← binary name (target-platform aware)
  const sep = platform === 'win32' ? '\\' : '/';                                      // ← separator for the COMMAND STRING (target-platform aware)
  const venvDirs = ['.venv', 'venv'];                                                 // ← rung 4 + 5: prefixed (modern) and unprefixed (legacy) convention
  for (const dir of venvDirs) {                                                       // ← iterate; `.venv` before `venv`
    try {                                                                             // ← ENOENT guard
      // Existence check: host-aware join. Node's fs API accepts the host's
      // native separator (and on Windows, also accepts forward-slash). On a
      // POSIX runner with `platform: 'win32'`, the test seeded `.venv/Scripts/python.exe`
      // using POSIX paths, and `join(cwd, dir, scriptsOrBin, pythonExe)` produces
      // `.../.venv/Scripts/python.exe` (POSIX) — access() finds it. On Windows,
      // the test seeded `.venv\Scripts\python.exe` and join produces the same
      // backslash form — access finds it. Either way, the EXISTENCE check works.
      await access(join(cwd, dir, scriptsOrBin, pythonExe));                          // ← host-platform path; finds the file regardless of target platform
      // Returned command: target-platform-aware separator. The daemon's shell
      // on the target platform will interpret the path correctly (Windows
      // cmd.exe handles backslash; POSIX sh handles forward-slash).
      return `${dir}${sep}${scriptsOrBin}${sep}${pythonExe} -m pytest`;               // ← composed with explicit `sep`; test-deterministic across runners
    } catch {                                                                         // ← venv binary not present; continue
      /* not present, try next */                                                     // ← intentional
    }
  }
  // Fallback: `python -m pytest` (still better than bare `pytest`).
  return 'python -m pytest';                                                          // ← rung 6: least-specific; caller sets InitResult.verifyCommandFallback = true based on this exact return value
}
```

**Test additions** (`tests/cli/init.test.ts`, append a new `describe` block before `}); // describe('runInit')` close at L157):
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';                 // ← existing import unchanged (adversarial review confirmed Step 1's helper takes explicit `platform` param; no vi.spyOn needed)
import { mkdir, ... } from 'node:fs/promises';                                        // ← extend existing import with `mkdir` (currently absent)
import { runInit, detectPythonVerifyCommand } from '../../src/cli/commands/init.js';   // ← add `detectPythonVerifyCommand` to the existing named import line

describe('detectPythonVerifyCommand', () => {                                         // ← new test block, separate from describe('runInit')
  let cwd: string;                                                                    // ← per-test tmp dir
  beforeEach(async () => {                                                            // ← isolate filesystem state per case
    cwd = await mkdtemp(join(tmpdir(), 'conductor-detectpy-'));                       // ← parallel to existing init.test.ts beforeEach
  });
  afterEach(async () => {                                                             // ← cleanup
    await rm(cwd, { recursive: true, force: true });                                  // ← same shape as existing afterEach
  });

  // Rung 1-3: tool-runner lockfiles
  it('returns "uv run pytest" when uv.lock is present', async () => {
    await writeFile(join(cwd, 'uv.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');                     // ← platform doesn't matter for lockfile rungs; pass explicit value to keep tests deterministic
    expect(result).toBe('uv run pytest');
  });
  it('returns "pdm run pytest" when pdm.lock is present (and no uv.lock)', async () => {
    await writeFile(join(cwd, 'pdm.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('pdm run pytest');
  });
  it('returns "poetry run pytest" when poetry.lock is present (and no uv/pdm lock)', async () => {
    await writeFile(join(cwd, 'poetry.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('poetry run pytest');
  });
  it('prefers uv.lock over pdm.lock and poetry.lock', async () => {
    await writeFile(join(cwd, 'uv.lock'), '', 'utf8');
    await writeFile(join(cwd, 'pdm.lock'), '', 'utf8');
    await writeFile(join(cwd, 'poetry.lock'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('uv run pytest');                                             // ← cascade ordering invariant
  });

  // Rung 4: .venv platform-split
  it('returns explicit venv-python -m pytest on win32 when .venv/Scripts/python.exe exists', async () => {
    await mkdir(join(cwd, '.venv', 'Scripts'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'Scripts', 'python.exe'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'win32');
    expect(result).toBe(`.venv\\Scripts\\python.exe -m pytest`);                      // ← join() on win32 emits backslash separator
  });
  it('returns explicit venv-python -m pytest on posix when .venv/bin/python exists', async () => {
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('.venv/bin/python -m pytest');                                // ← posix forward-slash
  });

  // Rung 5: venv (unprefixed) platform-split
  it('returns explicit venv-python -m pytest on win32 when venv/Scripts/python.exe exists (no .venv/)', async () => {
    await mkdir(join(cwd, 'venv', 'Scripts'), { recursive: true });
    await writeFile(join(cwd, 'venv', 'Scripts', 'python.exe'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'win32');
    expect(result).toBe(`venv\\Scripts\\python.exe -m pytest`);
  });
  it('returns explicit venv-python -m pytest on posix when venv/bin/python exists (no .venv/)', async () => {
    await mkdir(join(cwd, 'venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, 'venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('venv/bin/python -m pytest');
  });
  it('prefers .venv/ over venv/ when both exist (posix)', async () => {
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'bin', 'python'), '', 'utf8');
    await mkdir(join(cwd, 'venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, 'venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('.venv/bin/python -m pytest');                                // ← cascade ordering invariant: prefixed beats unprefixed
  });

  // Rung 6: fallback
  it('returns "python -m pytest" when no lockfile or venv directory is present', async () => {
    const result = await detectPythonVerifyCommand(cwd, 'linux');                     // ← cwd is bare; only pyproject.toml/setup.py would have been the caller's gate
    expect(result).toBe('python -m pytest');                                          // ← exact string is the discriminator attachInit reads
  });

  // Lockfile beats venv (verify ordering)
  it('prefers uv.lock over .venv/', async () => {
    await writeFile(join(cwd, 'uv.lock'), '', 'utf8');
    await mkdir(join(cwd, '.venv', 'bin'), { recursive: true });
    await writeFile(join(cwd, '.venv', 'bin', 'python'), '', 'utf8');
    const result = await detectPythonVerifyCommand(cwd, 'linux');
    expect(result).toBe('uv run pytest');                                             // ← cascade: tool-runner beats explicit venv-python; the tool-runner manages its own env
  });
});
```

**Why**: Establishes the venv-aware detection helper as an isolated, unit-tested unit with no caller wiring yet. The `verifyCommandFallback` field is added to `InitResult` so Step 3 can read it without coupling the print site to the literal string. Step 1 leaves all existing behavior intact (`detectVerifyCommand` still returns bare `'pytest'`).

**Risk**:
- The new `mkdir` import in test file: pure addition; no conflict.
- The cascade ordering tests (`prefers X over Y`) lock in the priority order at the test level — if a future revision reorders rungs, these tests break first. **Intended:** ordering is a contract, not an implementation detail.
- Helper returns string (never null). Caller is expected to gate the call on `pyproject.toml || setup.py` presence; if called otherwise, returns the fallback unconditionally. Documented in the helper's docstring.
- **Platform-determinism (adversarial review Issue 1, now fixed)**: the returned command string uses an explicit `sep` derived from the `platform` parameter, NOT `node:path.join`. The `access()` existence check still uses `join()` (host-platform aware) so the test can seed the file with the host's separator and `access` finds it regardless of which `platform` argument was passed.

**Verify**:
```powershell
npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50
```
Expect: existing 17 tests pass unchanged; +11 new tests for `detectPythonVerifyCommand` all green. Total init.test.ts count: 28. Suite-wide: 544 + 11 = 555.

**Rollback**: `git revert <step-1-commit-sha>`. Helper deletion has no consumers at this point (Step 2 wires it; Step 1 is dormant). `InitResult` shape extension is additive — reverting strips the field cleanly.

---

### Step 2: Wire `detectPythonVerifyCommand` into `detectVerifyCommand`; populate `verifyCommandFallback`; update existing pyproject test
**File**: `src/cli/commands/init.ts` (modify `detectVerifyCommand` + `runInit`)
**File**: `tests/cli/init.test.ts` (update existing L76-82 assertion + add 2 integration tests)

**Before** (current `detectVerifyCommand`, lines 164-182):
```typescript
export async function detectVerifyCommand(cwd: string): Promise<string | null> {     // ← exported; returns command string or null
  const markers: Array<[string, string]> = [                                          // ← flat array of (marker, command)
    ['package.json', 'npm test'],                                                     // ← Node
    ['pyproject.toml', 'pytest'],                                                     // ← Python — BUG: bare literal, ignores venv/poetry/pdm/uv
    ['setup.py', 'pytest'],                                                           // ← Python — same bug
    ['Cargo.toml', 'cargo test'],                                                     // ← Rust
    ['go.mod', 'go test ./...'],                                                      // ← Go
    ['Makefile', 'make test'],                                                        // ← Make
  ];
  for (const [marker, cmd] of markers) {                                              // ← first-match-wins iteration
    try {
      await access(join(cwd, marker));
      return cmd;                                                                     // ← returns the bare cmd for ALL matched markers
    } catch {
      /* not present, try next */
    }
  }
  return null;
}
```

**After** (Python markers delegate to helper inline, preserving array order):
```typescript
export async function detectVerifyCommand(cwd: string): Promise<string | null> {     // ← unchanged signature
  const markers: Array<[string, string]> = [                                          // ← UNCHANGED array order — adversarial review Issue 2 forced this; reordering would have changed Makefile-vs-pyproject precedence, which the issue body explicitly defers as orthogonal scope
    ['package.json', 'npm test'],                                                     // ← unchanged
    ['pyproject.toml', 'pytest'],                                                     // ← marker stays at index 1; `cmd` value is now the legacy default — never returned for this row (intercepted below)
    ['setup.py', 'pytest'],                                                           // ← marker stays at index 2; same intercept
    ['Cargo.toml', 'cargo test'],                                                     // ← unchanged
    ['go.mod', 'go test ./...'],                                                      // ← unchanged
    ['Makefile', 'make test'],                                                        // ← unchanged — relative position to pyproject.toml preserved (Makefile still loses in mixed projects, per issue body's deferral)
  ];
  for (const [marker, cmd] of markers) {                                              // ← unchanged outer loop
    try {
      await access(join(cwd, marker));                                                // ← unchanged presence check
      // Python markers delegate to the venv-aware helper INLINE — preserves the
      // array's marker precedence (Makefile still loses to pyproject.toml in a
      // mixed Makefile+Python project, matching the issue body's "out of scope"
      // ruling on the Marker-ordering nit at L91-95).
      if (marker === 'pyproject.toml' || marker === 'setup.py') {                     // ← NEW: in-loop delegation gate
        return await detectPythonVerifyCommand(cwd);                                  // ← NEW: invokes the ladder; defaults `platform` to runtime
      }
      return cmd;                                                                     // ← unchanged for non-Python markers (Node/Rust/Go/Make)
    } catch {
      /* not present, try next */
    }
  }
  return null;                                                                        // ← unchanged exhaustion path
}
```

**Before** (current `runInit` return, lines 216-217 and 241):
```typescript
  const detectVerify = args.detectVerify !== false;                                   // ← unchanged
  const verifyCmd = detectVerify ? await detectVerifyCommand(args.cwd) : null;        // ← single call; returns string or null
  // ...
  return { configWritten, configSource: source, verifyCommand: verifyCmd, gitignore };  // ← original shape — no verifyCommandFallback
```

**After** (compute fallback flag based on chosen value):
```typescript
  const detectVerify = args.detectVerify !== false;                                   // ← unchanged
  const verifyCmd = detectVerify ? await detectVerifyCommand(args.cwd) : null;        // ← unchanged call
  const verifyCommandFallback = verifyCmd === 'python -m pytest';                     // ← NEW: exact-string discriminator. True ONLY on the bare-fallback Python branch (rung 6). The string is the contract — if detectPythonVerifyCommand's fallback ever changes, this comparison MUST be updated. Documented as a coupling in the impl doc.
  // ...
  return { configWritten, configSource: source, verifyCommand: verifyCmd, verifyCommandFallback, gitignore };  // ← shape includes the new field
```

**Before** (existing test at L76-82):
```typescript
  it('detects pytest when pyproject.toml is present', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[tool.poetry]\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('pytest');                                      // ← OLD: asserted bare literal
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toMatch(/^verify_command:\s*pytest$/m);                             // ← OLD: asserted bare literal in config
  });
```

**After** (assertion updated to reflect the fallback rung — tmp has only `pyproject.toml`, no venv, no lockfile):
```typescript
  it('detects python -m pytest fallback when pyproject.toml is present without venv/lockfile', async () => {  // ← test name updated to describe the new shape
    await writeFile(join(tmp, 'pyproject.toml'), '[tool.poetry]\n', 'utf8');           // ← unchanged: seed pyproject only
    const result = await runInit({ cwd: tmp, provider: 'subscription' });              // ← unchanged
    expect(result.verifyCommand).toBe('python -m pytest');                             // ← NEW: assert the safer fallback (rung 6)
    expect(result.verifyCommandFallback).toBe(true);                                   // ← NEW: confirm the discriminator fires
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toMatch(/^verify_command:\s*python -m pytest$/m);                   // ← NEW: assert config carries the safer fallback verbatim
  });
```

**Test additions** (append inside `describe('runInit')` block, before the gitignore tests):
```typescript
  it('detects uv run pytest when pyproject.toml + uv.lock are present', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    await writeFile(join(tmp, 'uv.lock'), '', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('uv run pytest');                                 // ← integration: helper invoked via the wired path
    expect(result.verifyCommandFallback).toBe(false);                                   // ← discriminator false for non-fallback rungs
  });

  it('detects explicit venv-python -m pytest when pyproject.toml + .venv/ are present (host platform)', async () => {
    // Note: this test runs on the host's process.platform. We seed BOTH the
    // platform-correct binary (so the test passes on the actual host) — the
    // helper's pure-function platform-split is covered exhaustively in the
    // describe('detectPythonVerifyCommand') block; this is the integration smoke.
    await writeFile(join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    const isWin = process.platform === 'win32';                                         // ← host-aware seeding
    await mkdir(join(tmp, '.venv', isWin ? 'Scripts' : 'bin'), { recursive: true });
    await writeFile(join(tmp, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'), '', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    const expected = isWin ? `.venv\\Scripts\\python.exe -m pytest` : '.venv/bin/python -m pytest';
    expect(result.verifyCommand).toBe(expected);                                        // ← exact match per host platform
    expect(result.verifyCommandFallback).toBe(false);                                   // ← venv rung, not fallback
  });

  // Adversarial review Issue 3: setup.py-as-gate coverage (parallel to the pyproject.toml gate)
  it('detects python -m pytest fallback when setup.py is present without venv/lockfile', async () => {
    await writeFile(join(tmp, 'setup.py'), 'from setuptools import setup\nsetup(name="x")\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommand).toBe('python -m pytest');                              // ← setup.py gate fires helper just like pyproject.toml
    expect(result.verifyCommandFallback).toBe(true);                                    // ← fallback rung
  });
```

**Why**: Wires the helper into the public detection path so user-visible behavior changes. Updating the existing pyproject test in the SAME step prevents the tree from going red between steps (atomic guarantee). The `verifyCommandFallback` discriminator is computed exactly once in `runInit` from the chosen command string; the print-site reads the boolean (Step 3) without re-deriving from the string.

**Risk**:
- **Marker precedence PRESERVED**: per adversarial review Issue 2, the markers array order is unchanged. A project with BOTH `package.json` AND `pyproject.toml` still gets `npm test` (Node at index 0 wins). A project with BOTH `Makefile` AND `pyproject.toml` still gets `pytest`-via-helper (pyproject at index 1 still beats Makefile at index 5) — matching the issue body's L91-95 deferral of the Makefile-ordering nit.
- **The `verifyCommandFallback` string-comparison coupling**: if `detectPythonVerifyCommand`'s fallback literal is ever changed without updating this comparison, the discriminator silently desyncs. **Mitigation:** the impl doc records the coupling; the Step 1 helper docstring names the exact literal; the Step 1 fallback test pins the string. Acceptable for n=1; if the discriminator pattern recurs, promote to a structured return type.
- **Existing `tests/cli/init.test.ts:96-100` (`'skips detection with detectVerify: false'`)**: returns `null` for `verifyCommand`. The `verifyCommandFallback` will be `false` (null !== 'python -m pytest'). Should add an explicit assertion if review wants it; baseline: false-by-default is the natural result.

**Verify**:
```powershell
npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50
npm test 2>&1 | Select-Object -Last 50
npm run typecheck 2>&1 | Select-Object -Last 30
```
Expect: 28 (from Step 1) → 31 init tests (+3 integration: uv.lock, host-aware `.venv/`, setup.py-as-gate), full suite 555 → 558. Typecheck clean (new `verifyCommandFallback: boolean` field is required on all consumers — all in-tree consumers go through the `runInit` return site, which is the single producer of `InitResult` objects).

**Rollback**: `git revert <step-2-commit-sha>`. Helper from Step 1 becomes dormant again (no caller); existing pyproject test reverts to expecting bare `'pytest'` — temporarily false, but the revert reverts the test along with the wiring, so net-neutral.

---

### Step 3: Emit stdout fallback note in `attachInit` action callback
**File**: `src/cli/commands/init.ts` (modify `attachInit`'s `.action()` body)
**File**: `tests/cli/init.test.ts` (add stdout-capture test — uses `vi.spyOn(console, 'log')`)

**Before** (current `attachInit` action callback, lines 282-292):
```typescript
      const firstLine = result.configWritten
        ? `Conductor initialized. .conductor/ scaffold ready (config source: ${result.configSource}${result.verifyCommand ? `, verify_command: ${result.verifyCommand}` : ''}).`
        : `Conductor scaffold present; .conductor/config.yaml left untouched.`;
      const gitignoreLine =
        result.gitignore === 'created'
          ? ' Wrote .gitignore with Conductor runtime-artifact entries.'
          : result.gitignore === 'appended'
            ? ' Appended Conductor runtime-artifact entries to .gitignore.'
            : '';
      // eslint-disable-next-line no-console
      console.log(firstLine + gitignoreLine);                                          // ← single log line; no fallback signal
    });
```

**After** (conditional stdout note when on the fallback branch):
```typescript
      const firstLine = result.configWritten
        ? `Conductor initialized. .conductor/ scaffold ready (config source: ${result.configSource}${result.verifyCommand ? `, verify_command: ${result.verifyCommand}` : ''}).`
        : `Conductor scaffold present; .conductor/config.yaml left untouched.`;
      const gitignoreLine =
        result.gitignore === 'created'
          ? ' Wrote .gitignore with Conductor runtime-artifact entries.'
          : result.gitignore === 'appended'
            ? ' Appended Conductor runtime-artifact entries to .gitignore.'
            : '';
      // eslint-disable-next-line no-console
      console.log(firstLine + gitignoreLine);                                          // ← unchanged primary log
      if (result.verifyCommandFallback) {                                              // ← NEW: only on bare-`python -m pytest` Python fallback rung
        // eslint-disable-next-line no-console
        console.log(
          `Note: No Python venv detected (no .venv/, venv/, uv.lock, pdm.lock, or poetry.lock). Using "python -m pytest" as verify_command. Edit .conductor/config.yaml if pytest isn't on the system Python's PATH.`
        );                                                                             // ← NEW: single-line stdout signal; mirrors Phase 17's gitignore-block signal pattern (one line, names the chosen branch, points to the workaround)
      }
    });
```

**Test addition** (append inside `describe('runInit')`):
```typescript
  // Adversarial review Issue 4: test name accurately describes what's asserted
  // (the boolean discriminator). The print site itself is a 3-line conditional
  // in attachInit's action callback — verified by manual smoke (see Post-Implementation
  // Checks step 4); the boolean is the contract the print site reads.
  it('sets verifyCommandFallback=true exactly when verifyCommand is "python -m pytest"', async () => {
    await writeFile(join(tmp, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    const result = await runInit({ cwd: tmp, provider: 'subscription' });
    expect(result.verifyCommandFallback).toBe(true);                                  // ← discriminator fires on fallback rung
    expect(result.verifyCommand).toBe('python -m pytest');                            // ← command literal matches discriminator's reference
  });
```

(The action-callback log itself is a 3-line conditional; the contract test above + manual smoke is sufficient. If reviewers want stdout-capture: add a `vi.spyOn(console, 'log')` test that invokes `attachInit` against a fresh `Command()` and dispatches it — feasible but heavyweight; recommend deferring unless review asks.)

**Why**: Surfaces the fallback condition to the user without forcing them to read docs or source. Print-site reads the boolean discriminator from Step 2; no string-comparison at the print site. One additional `console.log` call; ~5 lines added.

**Risk**:
- The stdout note adds a second `console.log` invocation. Snapshot-style tests in the wider suite that count `console.log` calls would break — **none exist** (grep confirmed no `toHaveBeenCalledTimes` assertions on `console.log` in `tests/`).
- The note's exact wording is locked into the action callback. If wording changes, the contract test above remains green (it tests the boolean, not the message). The message wording can drift; that's intentional (UX copy is not a contract).

**Verify**:
```powershell
npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50
npm test 2>&1 | Select-Object -Last 50
```
Expect: 31 init tests → 32 (+1 contract test for the discriminator). Suite-wide 558 → 559.

**Manual smoke**: in a fresh tmp dir with only `pyproject.toml`:
```
$ conductor init --provider subscription
Conductor initialized. .conductor/ scaffold ready (config source: subscription, verify_command: python -m pytest). Wrote .gitignore with Conductor runtime-artifact entries.
Note: No Python venv detected (no .venv/, venv/, uv.lock, pdm.lock, or poetry.lock). Using "python -m pytest" as verify_command. Edit .conductor/config.yaml if pytest isn't on the system Python's PATH.
```

**Rollback**: `git revert <step-3-commit-sha>`. Removes the 3-line conditional + the contract test; baseline behavior (no fallback note) restored.

---

### Step 4: Update `docs/quickstart.md § 3` verify_command sniff table
**File**: `docs/quickstart.md` (lines 46-56)

**Before** (current table):
```markdown
`init` also sniffs your project type and sets `verify_command`:

| If your project has... | `verify_command` becomes |
|---|---|
| `package.json` | `npm test` |
| `pyproject.toml` or `setup.py` | `pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `Makefile` | `make test` |

Pass `--no-detect-verify` to skip the sniff and keep the example's default.
```

**After** (multi-row Python detection ladder; platform-split note):
```markdown
`init` also sniffs your project type and sets `verify_command`. For Python projects, init walks a venv-aware / tool-runner-aware ladder:

| If your project has... | `verify_command` becomes |
|---|---|
| `package.json` | `npm test` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `Makefile` | `make test` |
| `pyproject.toml` or `setup.py` + `uv.lock` | `uv run pytest` |
| `pyproject.toml` or `setup.py` + `pdm.lock` | `pdm run pytest` |
| `pyproject.toml` or `setup.py` + `poetry.lock` | `poetry run pytest` |
| `pyproject.toml` or `setup.py` + `.venv/` with python (win32) | `.venv\Scripts\python.exe -m pytest` |
| `pyproject.toml` or `setup.py` + `.venv/` with python (posix) | `.venv/bin/python -m pytest` |
| `pyproject.toml` or `setup.py` + `venv/` with python (win32) | `venv\Scripts\python.exe -m pytest` |
| `pyproject.toml` or `setup.py` + `venv/` with python (posix) | `venv/bin/python -m pytest` |
| `pyproject.toml` or `setup.py` (no venv, no lockfile) | `python -m pytest` (with stdout note) |

The Python ladder is checked in the order above — most-specific (tool-runner lockfile) → least-specific (bare `python -m pytest`). The `.venv/` and `venv/` rungs use `process.platform` to pick the correct Python binary path (`Scripts\python.exe` on Windows, `bin/python` on POSIX). When the bare-fallback rung fires, init emits a one-line stdout note so you know to edit `verify_command:` if pytest isn't on the system Python's PATH.

Pass `--no-detect-verify` to skip the sniff and keep the example's default.
```

**Why**: The pre-existing table advertised `pytest` as the Python default, which is now stale. The new table is the single source of truth users reach when reading quickstart. Lists every rung so users can predict the detected command for their project shape.

**Risk**: None — docs-only.

**Verify**: read the updated table; render in a markdown viewer to confirm the table renders correctly (no broken pipes). Cross-check the strings against Step 1's helper and Step 2's wiring.

**Rollback**: `git revert <step-4-commit-sha>`.

## Test Changes

- **`tests/cli/init.test.ts`**:
  - Add `mkdir` to the `node:fs/promises` import (note: `vi` import not strictly needed — adversarial review confirmed Step 1's helper takes an explicit `platform` parameter, no `vi.spyOn` required).
  - Add named import: `import { detectPythonVerifyCommand } from '../../src/cli/commands/init.js';`.
  - Add new `describe('detectPythonVerifyCommand', ...)` block with **11 unit tests** covering each ladder rung + cascade ordering invariants (Step 1).
  - **Update** the existing `'detects pytest when pyproject.toml is present'` test at L76-82: rename to describe the new shape, change assertions to `'python -m pytest'` + `verifyCommandFallback: true` (Step 2).
  - Add **3 integration tests** inside `describe('runInit', ...)` covering the wired path: `uv.lock` rung + host-aware `.venv/` rung + `setup.py`-as-gate (Step 2).
  - Add **1 contract test** confirming `verifyCommandFallback` is true exactly when `verifyCommand === 'python -m pytest'` (Step 3).
- **Total test delta:** +15 new tests, 1 modified assertion. Init test count: 17 → 32. Suite-wide: 544 → 559.

## Post-Implementation Checks

1. `npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50` — 31/31 green; no skips.
2. `npm test 2>&1 | Select-Object -Last 50` — 558/558 green; no regressions.
3. `npm run typecheck 2>&1 | Select-Object -Last 30` — clean (engine + UI configs).
4. **Manual smoke** (in a tmpdir with only `pyproject.toml`):
   - Run `conductor init --provider subscription`.
   - Verify stdout shows two lines: the standard "Conductor initialized..." line WITH `verify_command: python -m pytest`, then the "Note: No Python venv detected..." line.
   - Verify `.conductor/config.yaml` contains `verify_command: python -m pytest`.
5. **Manual smoke** (in a tmpdir with `pyproject.toml` + `.venv/bin/python` on posix OR `.venv/Scripts/python.exe` on win32):
   - Run `conductor init`.
   - Verify the explicit venv-Python invocation lands in config.yaml.
   - Verify NO "Note: No Python venv detected..." line is printed.
6. **Regression spot-check**: run `npx vitest run tests/cli/` and confirm all CLI command tests stay green (init siblings: daemon, work, transition, etc.).

## Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Marker-precedence change inadvertently changes detected command for a Node+pyproject project | Low | Medium | Step 2's non-Python loop runs FIRST, preserving Node-wins precedence. Verified in plan; tested implicitly by existing Node tests (which still seed `package.json` only). Could add explicit `package.json + pyproject.toml` test if review asks. |
| `verifyCommandFallback` string-comparison silently desyncs from helper's fallback literal | Low | Low | Fallback string is named in helper docstring, asserted in Step 1 unit test, and asserted in Step 3 contract test. Impl doc records the coupling. n=1; if the pattern recurs, promote to structured return type. |
| New stdout note breaks snapshot tests | Zero | n/a | Grep confirmed no `toHaveBeenCalledTimes` on `console.log` in suite. |
| Path-separator mismatch on Windows tests run on POSIX CI (or vice versa) | Low | Medium | Helper accepts explicit `platform` parameter; Step 1 unit tests pass platform literal. Integration tests in Step 2 are host-aware. Currently no Windows CI; vitest covers the branch logic without a Windows runner. Filed as known limitation. |
| Existing `'skips detection with detectVerify: false'` test now needs to assert `verifyCommandFallback: false` | Low | Low | Optional belt-and-suspenders assertion; baseline is naturally `false` (null !== 'python -m pytest'). Won't break anything by absence. Add if review requests. |
| Helper invokes `access()` for many files (up to 5 lockfiles + 2 venv dirs × 1 python binary = 5 + 2 = 7 stat calls in the worst case) on every Python init | Zero | Low | One-time cost at init only (not on the hot autonomy-loop path). Existing `detectVerifyCommand` already does 6 `access` calls. Net +5 stat calls at init time. Imperceptible. |

## Rollback Plan

Pure code + test + docs change. No DB migrations, no config-file shape changes (the `verify_command:` field already exists), no stored-data format changes. Rollback per step: `git revert <step-N-commit-sha>`. Reverting the full feature: `git revert <step-1-sha>..<step-4-sha>` (or the merge commit if shipped as one PR).

---

## Adversarial Review

*Reviewed: 2026-05-15*

### Issues Found

#### Issue 1 (MEDIUM) — Platform-separator drift in Step 1 helper

**What's wrong:** the helper's `pythonBin` computation used `node:path.join`, which is **host-platform-dependent** at runtime, not `platform`-parameter-dependent. On a POSIX runner with `platform: 'win32'`, `join('Scripts', 'python.exe')` returned `'Scripts/python.exe'` (POSIX forward-slash), not `'Scripts\\python.exe'`. The Step 1 unit tests assert backslash output on win32; they'd have failed on POSIX CI, and the posix tests would have failed on Windows. The entire `platform` parameter is undone.

**Plan had:**
```typescript
const pythonBin = platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python');  // ← join uses process.platform, not our parameter
const pyPath = join(dir, pythonBin);                                                              // ← inherits the bug
return `${pyPath} -m pytest`;                                                                     // ← returns host-platform separators, not target-platform
```

**Should be (now in plan):**
```typescript
const scriptsOrBin = platform === 'win32' ? 'Scripts' : 'bin';                                    // ← target-platform aware directory name
const pythonExe = platform === 'win32' ? 'python.exe' : 'python';                                 // ← target-platform aware binary name
const sep = platform === 'win32' ? '\\' : '/';                                                    // ← target-platform aware separator
const venvDirs = ['.venv', 'venv'];                                                               // ← unchanged
for (const dir of venvDirs) {
  try {
    // Existence check: host-platform aware (uses node:path.join). The test seeded the
    // file with the host's separator; access() finds it regardless of which `platform`
    // argument the caller passed.
    await access(join(cwd, dir, scriptsOrBin, pythonExe));                                        // ← host-aware path resolution
    // Returned command string: target-platform aware (uses explicit `sep`).
    return `${dir}${sep}${scriptsOrBin}${sep}${pythonExe} -m pytest`;                             // ← deterministic per `platform` arg
  } catch { /* try next */ }
}
```

Now the existence check and the returned-command-string composition are decoupled. The Step 1 win32 tests pass on POSIX runners and vice versa.

#### Issue 2 (MEDIUM) — Markers-array reorder accidentally fixed an out-of-scope concern

**What's wrong:** Step 2 split the markers array into non-Python (iterated first) and Python (iterated second). This had the unintended side-effect of letting `Makefile` win over `pyproject.toml` in a project that has both. The issue body at L91-95 explicitly defers fixing this: "Marker-ordering nit: orthogonal. ... out of scope for this issue." The plan's reorder accidentally addressed it — scope creep.

**Plan had:**
```typescript
const markers: Array<[string, string]> = [
  ['package.json', 'npm test'],
  ['Cargo.toml', 'cargo test'],                                                                   // ← reordered up from index 3
  ['go.mod', 'go test ./...'],                                                                    // ← reordered up
  ['Makefile', 'make test'],                                                                      // ← Makefile now ahead of pyproject.toml in effective precedence
];
// ...
for (const marker of ['pyproject.toml', 'setup.py']) { /* Python branch checked LAST */ }
```

**Should be (now in plan):**
```typescript
const markers: Array<[string, string]> = [
  ['package.json', 'npm test'],
  ['pyproject.toml', 'pytest'],                                                                   // ← UNCHANGED at index 1; cmd literal stays as visible legacy default but is never returned (intercepted below)
  ['setup.py', 'pytest'],                                                                         // ← UNCHANGED at index 2; same intercept
  ['Cargo.toml', 'cargo test'],                                                                   // ← UNCHANGED at index 3
  ['go.mod', 'go test ./...'],                                                                    // ← UNCHANGED at index 4
  ['Makefile', 'make test'],                                                                      // ← UNCHANGED at index 5; still loses to pyproject.toml (issue body's deferral preserved)
];
for (const [marker, cmd] of markers) {
  try {
    await access(join(cwd, marker));
    if (marker === 'pyproject.toml' || marker === 'setup.py') {                                   // ← in-loop delegation gate, NEW
      return await detectPythonVerifyCommand(cwd);                                                // ← invokes ladder
    }
    return cmd;                                                                                   // ← non-Python rows fall through to return bare cmd as before
  } catch { /* try next */ }
}
```

This preserves the issue body's "Makefile-vs-pyproject is orthogonal scope" deferral. Whoever picks up the Makefile-nit later can file a fresh issue with its own analysis + plan.

#### Issue 3 (LOW) — No `setup.py`-as-gate test

**What's wrong:** the plan asserts both `pyproject.toml` and `setup.py` trigger the helper, but only adds tests for the `pyproject.toml` path. A regression that broke the `setup.py` gate would slip past tests.

**Fix:** added a single integration test in Step 2:
```typescript
it('detects python -m pytest fallback when setup.py is present without venv/lockfile', async () => {
  await writeFile(join(tmp, 'setup.py'), 'from setuptools import setup\nsetup(name="x")\n', 'utf8');
  const result = await runInit({ cwd: tmp, provider: 'subscription' });
  expect(result.verifyCommand).toBe('python -m pytest');
  expect(result.verifyCommandFallback).toBe(true);
});
```

#### Issue 4 (LOW) — Misleading Step 3 test name

**What's wrong:** the contract test was named `'attachInit logs a fallback note when verifyCommandFallback is true'`, but the actual assertion was on the boolean, not the log call. Reads like a stdout-capture test but isn't.

**Plan had:**
```typescript
it('attachInit logs a fallback note when verifyCommandFallback is true', async () => {
  // ... assertion is on result.verifyCommandFallback, not on console.log calls
});
```

**Should be (now in plan):**
```typescript
it('sets verifyCommandFallback=true exactly when verifyCommand is "python -m pytest"', async () => {
  // ... name accurately reflects the contract being tested
});
```

The action callback's actual `console.log` line is verified by manual smoke (see Post-Implementation Checks step 4). Stdout-capture via `vi.spyOn(console, 'log')` + commander.parseAsync(...) was considered and rejected as heavyweight for a 3-line conditional. If a future revision wants stronger lock-in, extract a `formatInitInitializedMessages` helper (mirror Phase 18's `formatDaemonStartedMessage`); not warranted at n=1.

### Edge Cases to Handle

The following edge cases were specifically evaluated against the revised plan and confirmed to behave correctly. None require additional plan steps:

- **`pyproject.toml` + `setup.py` both present** — markers loop hits `pyproject.toml` first (index 1), invokes helper, returns. `setup.py` never reached. Output identical regardless of which gate fires; helper is gate-agnostic.
- **`.venv/` exists but `Scripts/python.exe` is missing (half-initialized venv)** — `access()` on the specific binary fails; cascade continues to `venv/` rung, then `python -m pytest` fallback. Correct.
- **`pyproject.toml` + `.venv/` + `uv.lock` all present** — uv rung wins (rung 1 beats rung 4). Step 1 test `'prefers uv.lock over .venv/'` locks this in.
- **`package.json` + `pyproject.toml` (Node + Python mixed)** — Node wins (index 0 beats index 1 in the unchanged markers array). Preserved.
- **`Makefile` + `pyproject.toml` (mixed)** — pyproject wins via helper (index 1 beats index 5). **Preserved** per Issue 2 fix.
- **Daemon's `verify` op consuming the new command** — `execa(cmd, { shell: true })` defers parsing to the host shell. Windows `cmd.exe` handles backslash; POSIX `sh` handles forward-slash. No `verify.ts` change.
- **`detectVerify: false` (existing test L96-100)** — `verifyCommand` is null; `verifyCommandFallback` is false (null !== 'python -m pytest'). Existing test stays green without modification.
- **`relay-config.md § Edge Cases` walked** — only one item is relevant ("Verify command default — Project-type-detected defaults are written by cli/commands/init.ts --provider; do not hardcode npm test in new ops"). The plan extends this detector; doesn't add a new hardcode site. ✓ No other listed edge case applies (no schema change, no concurrency, no LLM interaction, no card semantics, no shared event-bus surface).

### Regression Risk

Scanned `.relay/issues/` (1 active — the target itself), `.relay/features/` (empty), `.relay/archive/issues/` (19), `.relay/implemented/` (18) for items that depend on the bare-`pytest` behavior or the markers-array order. **None found.** Closest items are pattern-borrows only:

- `init-emits-no-gitignore-template.md` (Phase 17) — different function in same file; no shared symbol. Pattern precedent for `InitResult` shape extension + stdout signaling. Borrowed, not regressed.
- `daemon-start-first-visit-ui-token-ux-broken.md` (Phase 18) — different file. Pure-helper extraction pattern; borrowed conceptually (n=2 of the pattern lands when `detectPythonVerifyCommand` is exported as the helper).

Test files reviewed for breakage potential:
- `tests/cli/init.test.ts` — only the L76-82 assertion needs updating (planned in Step 2). The other 16 init tests don't touch `verifyCommand` or assert on its value (except the `detectVerify: false` test at L96-100, which asserts `null` and remains valid since null !== 'python -m pytest').
- `tests/cli/` siblings (daemon, work, transition, etc.) — none import from `init.ts` or assert on `InitResult`. Safe.
- Engine tests (`tests/engine/`, `tests/integration/`) — none import from `cli/commands/init.ts`. Safe.
- `tests/agent/` and `tests/conductor/` — autonomy loop consumes `verify_command` via the config, not via init's detection. Safe.

### Verdict

**APPROVED WITH CHANGES**

The plan is now ready for implementation. Four changes were applied in-place:

1. **(MEDIUM) Step 1 helper:** separated host-aware existence check from target-aware command-string composition; uses explicit `sep` derived from the `platform` parameter for the returned string.
2. **(MEDIUM) Step 2 detectVerifyCommand:** preserved markers-array order; added in-loop delegation gate (`if (marker === 'pyproject.toml' || marker === 'setup.py') return helper(cwd)`) instead of splitting the array.
3. **(LOW) Step 2 tests:** added one `setup.py`-as-gate integration test.
4. **(LOW) Step 3 test:** renamed `'attachInit logs a fallback note when verifyCommandFallback is true'` → `'sets verifyCommandFallback=true exactly when verifyCommand is "python -m pytest"'`.

Test delta updated: +15 new tests (was +14), 1 modified assertion. Init test count 17 → 32. Suite-wide 544 → 559.

---

## Implementation Guidelines

*Date: 2026-05-15*

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

*Verified: 2026-05-15*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1    | Add `detectPythonVerifyCommand` helper (six-rung ladder, platform-aware) + extend `InitResult.verifyCommandFallback` + 11 unit tests | YES (`src/cli/commands/init.ts:207-236` + `tests/cli/init.test.ts:194-294` block) | YES |
| 2    | Wire helper into `detectVerifyCommand`'s Python markers (preserve array order, in-loop delegation gate); update L76-82 test; add uv.lock / `.venv/`-host-aware / setup.py-gate integration tests | YES (`init.ts:176-178` gate; `init.ts:303` fallback computation; updated test at L76-83; 3 new integration tests at L85-110) | YES |
| 3    | Emit stdout fallback note in `attachInit` action callback; add `verifyCommandFallback` contract test (renamed per review Issue 4) | YES (`init.ts:357-362` conditional; contract test at L112-117) | YES |
| 4    | Update `docs/quickstart.md § 3` table with multi-row ladder + platform-split paragraph | YES (`docs/quickstart.md:46-62`) | YES |

No undocumented deviations. No `## Implementation Deviations` section needed.

### Test Results

- **Targeted** (`npx vitest run tests/cli/init.test.ts`): **32/32 pass** in ~284ms. Planned count: 32 (17 baseline + 15 new). Exact match.
  - 17 pre-existing runInit tests: all green; the bare-`'pytest'` assertion at the former L79 was correctly updated to `'python -m pytest'` per Step 2.
  - 4 new integration tests inside `describe('runInit')`: `setup.py`-gate (Issue 3 fix), `uv.lock`, host-aware `.venv/`, `verifyCommandFallback` contract.
  - 11 new helper unit tests inside `describe('detectPythonVerifyCommand')`: each ladder rung (rungs 1, 2, 3, 4-win32, 4-posix, 5-win32, 5-posix, 6 fallback) + 3 cascade-ordering invariants (`prefers uv.lock over pdm/poetry`, `prefers .venv/ over venv/`, `prefers uv.lock over .venv/`).
- **Full suite** (`npm test`): **559/559 pass across 98 test files** in ~16.9s. Planned count: 559 (544 baseline + 15 new). Exact match.
- **Typecheck** (`npm run typecheck`): clean — `tsc --noEmit` and `tsc --noEmit -p tsconfig.ui.json` both completed with zero errors.

### Issues Found

None. All four review-applied changes are present in the implementation:

1. (MEDIUM, fixed) **Platform-separator drift in Step 1** — verified: `detectPythonVerifyCommand` uses `join` for the host-aware `access()` check (`init.ts:218`, `init.ts:229`) and explicit `sep` for the returned command string (`init.ts:230`). The win32 unit tests pass on this POSIX-equivalent runner (`return result === '.venv\\Scripts\\python.exe -m pytest'` matches because the helper computes the literal `\\` from the `platform === 'win32'` branch, not from `node:path.join`).
2. (MEDIUM, fixed) **Marker-array order preserved** — verified: `detectVerifyCommand`'s `markers` array at `init.ts:165-172` keeps the original order. The in-loop delegation gate at L176-178 intercepts Python markers without reordering. Makefile-vs-pyproject precedence preserved (pyproject still wins).
3. (LOW, fixed) **`setup.py`-as-gate test** added at `init.test.ts:85-90`: `'detects python -m pytest fallback when setup.py is present without venv/lockfile'`. Green.
4. (LOW, fixed) **Step 3 test rename** — the contract test at `init.test.ts:112-117` is named `'sets verifyCommandFallback=true exactly when verifyCommand is "python -m pytest"'`, accurately describing what's asserted (boolean discriminator, not the print call).

### Verification Fixes

None — first verification pass succeeded without modifications. No verification-fix loop iterations needed (per the user's session opening rule, an Agent-dispatch threshold of 3 iterations is unused here).

### Verdict

**COMPLETE** — all changes verified, tests pass, no issues, typecheck clean. Ready for `/relay-resolve`.

# `conductor init` emits bare `pytest` for Python projects, ignoring `.venv` / `venv` / poetry / pdm / uv conventions

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

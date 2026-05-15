# `conductor init` emits venv-aware `verify_command` for Python projects

## Summary

*Resolved: 2026-05-15*

`conductor init`'s `detectVerifyCommand` was returning the bare literal `'pytest'` for any project with `pyproject.toml` or `setup.py`, ignoring `.venv` / `venv` / poetry / pdm / uv conventions. Every fresh Python project hit a verify failure on the first card because the daemon's PATH typically had no `pytest` (the daemon usually starts in a shell where the project venv hasn't been `Activate.ps1`/`source`-d).

Resolved by extending init with an exported `detectPythonVerifyCommand(cwd, platform?)` helper that walks a six-rung most-specific → least-specific cascade:

1. `uv.lock` → `uv run pytest`
2. `pdm.lock` → `pdm run pytest`
3. `poetry.lock` → `poetry run pytest`
4. `.venv/<python>` → explicit venv-Python `-m pytest` (win32: `.venv\Scripts\python.exe -m pytest`; posix: `.venv/bin/python -m pytest`)
5. `venv/<python>` → same shape with unprefixed `venv/`
6. fallback → `python -m pytest` (still safer than bare `pytest` — works whenever `python` is on PATH)

`detectVerifyCommand` keeps its existing markers-array order and delegates to the helper inline within the loop when the matched marker is `pyproject.toml` or `setup.py`. The Makefile-vs-pyproject precedence nit acknowledged in the issue body is preserved (out of scope per the issue's L91-95 deferral). `InitResult` gained one additive field `verifyCommandFallback: boolean` set by exact-string compare on rung 6's output; the CLI's `attachInit` action callback reads this and prints a one-line stdout note so users on the least-specific branch know to edit `.conductor/config.yaml` if `pytest` isn't on the system Python's PATH. `docs/quickstart.md § 3`'s verify_command sniff table got a multi-row replacement enumerating each ladder rung with the platform split.

## Files Modified

- `src/cli/commands/init.ts` — added exported `detectPythonVerifyCommand` helper (L207-236) with split host-aware existence check (`access(join(cwd, dir, scriptsOrBin, pythonExe))`) and target-aware command-string composition (explicit `sep` derived from the `platform` parameter, NOT `node:path.join`). Wired the helper into `detectVerifyCommand` via an in-loop delegation gate at L176-178 (`if (marker === 'pyproject.toml' || marker === 'setup.py') return await detectPythonVerifyCommand(cwd)`). Extended `InitResult` interface at L256-269 with `verifyCommandFallback: boolean`. Computed the flag at L303 in `runInit` via exact string compare to `'python -m pytest'`. Added conditional `console.log` in `attachInit`'s action callback at L357-362 to print the fallback note when `verifyCommandFallback === true`.
- `tests/cli/init.test.ts` — added `mkdir` to the `node:fs/promises` import; added named import for `detectPythonVerifyCommand`. Updated the existing pyproject.toml detection test at L76-83 to expect the new `'python -m pytest'` default + `verifyCommandFallback: true`. Added 4 new integration tests inside `describe('runInit')`: `setup.py`-as-gate (fallback rung), uv.lock rung, host-aware `.venv/` rung, and `verifyCommandFallback` boolean-discriminator contract. Added a new `describe('detectPythonVerifyCommand')` block with 11 unit tests covering every ladder rung + cascade-ordering invariants (uv beats pdm/poetry, `.venv/` beats `venv/`, uv.lock beats `.venv/`). Test count: 17 → 32 (+15).
- `docs/quickstart.md` — replaced the single Python row in the § 3 verify_command sniff table with a multi-row block enumerating each ladder rung (4 lockfile + 4 platform-split venv + 1 fallback) and added a paragraph naming the most-specific → least-specific ordering and the fallback-stdout-note behavior.

## Verification

- Targeted: `npx vitest run tests/cli/init.test.ts` → **32/32 pass** in ~284ms.
- Full suite: `npm test` → **559/559 pass across 98 test files** in ~16.9s.
- Typecheck: `npm run typecheck` → clean (engine `tsconfig.json` + UI `tsconfig.ui.json`).
- Adversarial review verdict: **APPROVED WITH CHANGES** — four changes applied in-place (2 MEDIUM + 2 LOW) covering a platform-separator drift in the helper, a marker-array-reorder scope-creep guard, a missing `setup.py`-as-gate test, and a misleading test name on the boolean-discriminator contract.

## Caveats

- **Pattern precedent — pure-helper extraction for testable CLI contracts (n=2)**: this work establishes n=2 of the pattern (n=1 was Phase 18's `formatDaemonStartedMessage` extraction). STATE.md's "Recent decisions" criterion for promoting the pattern to a formal ADR has fired. Operator decision (2026-05-15): defer ADR filing as a separate work-item rather than bundle into Phase 20's scope. The pattern is now: **exported pure helper carved out of a CLI action callback when the helper's behavior is a contract worth pinning with exact-string assertions; the action callback delegates and the helper takes an explicit test seam (parameter override for runtime state)**. Watch for n=3 — at that point, file an ADR.
- **`verifyCommandFallback` string-comparison coupling**: `runInit` at `src/cli/commands/init.ts:303` performs `verifyCmd === 'python -m pytest'` to set the discriminator. The literal must stay in lockstep with `detectPythonVerifyCommand`'s rung-6 return (`init.ts:235`). The Step 1 helper docstring at L196-199 names this exact literal; the Step 1 unit test at the helper's `'returns "python -m pytest" when no lockfile or venv directory is present'` case and the runInit contract test at the boolean-discriminator test together fail loudly if the coupling desyncs. Acceptable for n=1; if a second discriminator pattern arises in this file, refactor to a structured return type (`{ command: string, branch: 'uv' | 'pdm' | 'poetry' | 'venv' | 'fallback' }`).
- **Platform-split tests cover branch logic, not real Windows fs**: the helper's `platform` parameter unlocks deterministic win32 / posix unit tests on a single CI runner. The existence-check fs ops still use `node:path.join` which is host-aware — tests seed files with host separators and `access()` finds them regardless of `platform`. This means the branch LOGIC is verified cross-runner but **actual Windows filesystem semantics** (path-length limits, symbolic-link traversal, case-insensitive lookups) are not exercised. If a future dogfood surfaces a Windows-specific path bug, file a follow-up issue with a real Windows CI job.
- **Makefile-vs-pyproject ordering nit unchanged**: the issue body at L91-95 noted that a Python monorepo with both `pyproject.toml` AND a Makefile-with-test-target gets `pytest`-via-helper (now venv-aware) rather than `make test`. The plan explicitly preserved this precedence per the adversarial review's Issue 2 fix. If `make test` is preferable in some project layouts, file a fresh issue with concrete dogfood evidence.
- **Conda env detection deferred**: not in scope per the issue body's open questions. Conda envs aren't co-located with the project; detection cost > value. File a follow-up issue if dogfood signals it.
- **Implementation matched plan exactly**: no `## Implementation Deviations` section needed in the source issue file. Adversarial review's four applied changes (Steps 1, 2, 3 of the plan revised in-place; Test Changes section's counts updated) all landed verbatim.

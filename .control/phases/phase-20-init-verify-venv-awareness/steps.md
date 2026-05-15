# Phase 20 Steps

- [x] 20.1 — Make `detectVerifyCommand` venv-aware for Python (uv / pdm / poetry / `.venv` / `venv` / `python -m pytest` fallback)

## Step detail

### 20.1 — Make `detectVerifyCommand` venv-aware for Python

Drive `.relay/issues/init-verify-command-not-venv-aware-for-python.md` through the full Relay pipeline: `/relay-analyze` → `/relay-plan` → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`. The issue's "Proposed fix" section already lays out the six-rung detection ladder and the optional UX nicety; the plan should adopt that shape unless the adversarial review surfaces a defect.

**Files expected to touch:**
- `src/cli/commands/init.ts` — `detectVerifyCommand`: extend Python branch with the ladder (uv / pdm / poetry / `.venv` / `venv` / `python -m pytest`); use `process.platform === 'win32'` to choose between `Scripts/python.exe` and `bin/python`; use `node:path` `join`/`sep` (not hard-coded separators); optional stdout note when on the bare-`python -m pytest` fallback branch.
- `tests/cli/init.test.ts` — extend with cases for each detection layer: `.venv`-win32, `.venv`-posix, `venv`-win32, `venv`-posix, `poetry.lock`, `pdm.lock`, `uv.lock`, fallback `python -m pytest`. Existing 2-3 Python-detection tests need their assertions updated (no longer bare `pytest`). Stub `process.platform` via `vi.spyOn(process, 'platform', 'get')`.
- `docs/quickstart.md § 3` — replace the single `pyproject.toml | setup.py → pytest` row with the layered detection ladder; note the platform split.
- (Optional) `examples/with-*/.conductor/config.yaml` — add a commented-out venv-aware example line so Python users have a copy-paste reference. Skip if no examples directory exists or if the addition would be low-value churn.

**What to verify:**
- `npx vitest run tests/cli/init.test.ts 2>&1 | Select-Object -Last 50` green; each ladder rung covered.
- `npm test` green (baseline 544/544 + new ladder cases; no regressions in the broader suite).
- `npm run typecheck` clean.
- Targeted smoke: in a tmp project with `.venv/` present (or a `pyproject.toml` only), `conductor init` writes a `verify_command:` whose detection branch matches the project's markers.

**Out-of-scope for this step (per issue's "Notes / open questions for the planner"):**
- Conda env detection — deferred to a follow-up issue if dogfood signals it (Conda envs aren't co-located with the project; detection requires `conda env list` introspection plus a `meta.yaml` / `environment.yml` marker; higher cost, lower value).
- `Makefile + pyproject.toml` marker-ordering nit — orthogonal; file a separate issue if confirmed during analysis.
- Windows CI job — out of scope (`process.platform` stubbing in vitest covers the branch logic without requiring an actual Windows runner).

**Commit message template:**
`feat(20.1): detectVerifyCommand venv-aware for Python (uv/pdm/poetry/.venv/venv/python -m pytest)`

# Phase 20 — `init` verify_command Python venv awareness

**Dependencies:** Phase 19 closed (`phase-19-control-room-ui-closed`)
**Estimated duration:** 1 session (single-item Relay phase)

## Goal
Make `conductor init`'s `detectVerifyCommand` venv-aware and tool-runner-aware for Python projects so the default `verify_command:` actually works on first run for the majority of Python repos (those using `python -m venv .venv`, poetry, pdm, or uv).

## Outcome
After `conductor init` in a Python project root:
- If `uv.lock` / `pdm.lock` / `poetry.lock` is present → `verify_command:` is `uv run pytest` / `pdm run pytest` / `poetry run pytest`.
- Else if a `.venv/` (or `venv/`) directory with the platform-correct python binary is present → `verify_command:` is the explicit venv-Python `-m pytest` invocation (win32 `.venv\Scripts\python.exe -m pytest`; posix `.venv/bin/python -m pytest`).
- Else (`pyproject.toml` or `setup.py` only, no venv markers) → `verify_command:` is `python -m pytest` (safer fallback than bare `pytest`; works whenever `python` is on PATH and pytest is installed in the system Python).
- An optional stdout note fires on the bare-fallback branch so the user knows their `verify_command:` was synthesized from least-specific signal and the workaround is one config edit away.

`docs/quickstart.md § 3`'s verify_command sniff table replaces the single Python row with the new ladder, noting the platform split. Test coverage exercises all rungs with `process.platform` stubbed for both win32 and posix.

## Where we were, end of Phase 19

Phase 19 (`phase-19-control-room-ui-closed`) shipped a visual redesign of the daemon UI — masthead, design tokens, structured headers, drag-target highlights. The UI surface is presentable. The engine surface remains stable since Phase 18 (token-bearing URL print, brain log persistence, plan SYSTEM_PROMPT preamble, init `.gitignore` block). Suite baseline is 544/544.

## Why this phase exists

Carried forward from Phase 19:
- **`init detectVerifyCommand` venv-aware for Python** — active issue at `.relay/issues/init-verify-command-not-venv-aware-for-python.md` (P2). Unrelated to UI; the natural next Phase 20 work — every fresh Python project hits the bare-`pytest` literal on first verify.

Surfaced by the 2026-05-15 omniforge dogfood: a card stalled in `building` because `verify` invoked the bare `'pytest'` literal `detectVerifyCommand` emits for `pyproject.toml` / `setup.py`, and the daemon was started in a shell where the project venv was not activated. The same trap fires on every fresh Python project that uses `python -m venv` (the dominant convention since 3.3), poetry, pdm, or uv. Verify is on the autonomous-loop critical path (`approved → building → verifying → shipped`), so a stalled verify halts the loop and the brain quarantines the card. The workaround (edit `.conductor/config.yaml verify_command:` to the venv-aware shape) is non-obvious without reading source or asking the in-UI chat agent.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] Step 20.1 checked off with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:20-blocker`
- [ ] Automated tests pass: `npm test` (baseline 544/544 from Phase 19; expect +N for new detection-ladder cases)
- [ ] Targeted: `npx vitest run tests/cli/init.test.ts` green
- [ ] `npm run typecheck` clean
- [ ] Smoke test: in a tmp project with `.venv/` present, `conductor init` writes a `verify_command:` of the explicit venv-Python `-m pytest` shape (win32 or posix as appropriate); in a tmp project with only `pyproject.toml`, `conductor init` writes `python -m pytest` and emits the stdout note
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-20-init-verify-venv-awareness-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-19-control-room-ui-closed` then force-push if applicable. No state outside git (no migrations, no external resources created). Existing projects' `.conductor/config.yaml` files are not rewritten by this change — only fresh `conductor init` runs see the new ladder.

## ADRs decided in this phase
- None filed, but the pure-helper-extraction pattern for testable CLI contracts reached **n=2** here (Phase 18's `formatDaemonStartedMessage` = n=1; this phase's `detectPythonVerifyCommand` = n=2). STATE.md's "Recent decisions" criterion for ADR promotion has fired. Operator decision (2026-05-15): defer ADR filing as a separate work-item rather than bundle into Phase 20's scope. Pattern + n-count recorded durably in `.relay/implemented/init-verify-command-not-venv-aware-for-python.md` § Caveats. Re-evaluate at n=3.
- The platform-switch helper (`process.platform`-driven `.venv` path resolution) remains a one-helper-one-call-site pattern; not ADR-worthy unless a second site adopts it.

## Deferred to Phase 21 (or later)

<!-- Items that surface during this phase's work but exceed scope.
One-line reason per item. Carried into the next phase's
"Why this phase exists" section automatically by /phase-close. -->

- <item> — <one-line reason for deferral>

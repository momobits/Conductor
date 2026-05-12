---
description: Sanity-check the Control protocol files for consistency
---

Verify the protocol scaffolding is coherent. Report any issues; do NOT fix silently.

## Checks

1. **STATE.md completeness**
   - File exists at `.control/progress/STATE.md`
   - All required sections present: Last updated, Current phase/step/status, Next action, Git state, Open blockers, In-flight work, Test/eval status, Recent decisions, Recently completed, Attempts that didn't work, Environment snapshot, Notes for next session
   - **Git state parser contract**: the `## Git state` section contains the four bullet lines `- **Branch:** <value>`, `- **Last commit:** <value>`, `- **Uncommitted changes:** <value>`, `- **Last phase tag:** <value>`. The SessionStart hook parses these — renaming or removing any of them silently breaks mechanical drift detection. See `.control/PROJECT_PROTOCOL.md` § "Drift detection contract".
   - No fields contain literal placeholder text (e.g. `<short-sha>`, `<YYYY-MM-DD>`, `<sha>` — these are the same sentinels the SessionStart hook treats as "STATE.md is in template form")

2. **Phase references exist**
   - STATE.md's current-phase path resolves to a real `.control/phases/phase-<N>-<name>/` directory
   - That directory has `README.md` and `steps.md`

3. **Phase plan is readable**
   - `.control/architecture/phase-plan.md` exists and enumerates phases with goals

4. **Issue files well-formed**
   - Every file in `.control/issues/OPEN/` has Severity (blocker|major), Status, Symptom, Repro, Hypothesis sections
   - Every file in `.control/issues/RESOLVED/` has a filled-in Resolution section (fix commit, regression test, diff summary)

5. **ADR numbering sequential**
   - `.control/architecture/decisions/*.md` filenames are `NNNN-*.md` with no gaps
   - Every ADR has Status (proposed|accepted|superseded) and Date

6. **Git tags present**
   - `protocol-initialised` tag exists
   - For each closed phase per STATE.md's "Last phase tag" and journal entries, the corresponding `phase-<N>-<name>-closed` tag exists

7. **Hooks installed**
   - `.claude/settings.json` references `.claude/hooks/pre-compact-dump.sh`, `session-start-load.sh`, `session-end-commit.sh`, `stop-snapshot.sh`
   - Each referenced script file exists and is executable (or runnable via `bash`)

8. **Git state matches STATE.md**
   - STATE.md's Git state section matches actual `git status`, `git log -1`, `git describe --tags --abbrev=0`

## Output shape (v2.0)

**Default — narrative.** Lead with the summary count + the worst issue if any. One or two sentences.

Examples:
> Control protocol validation: all 8 checks pass.

> Control protocol validation: 6 OK, 1 warning, 1 error. Error: ISSUE-2026-04-19-themes-parse missing Hypothesis section. Run /validate --verbose for the full report.

**Verbose (on request, or `--verbose`, OR forced when any error present).** Full structured report:

```
Control validation report
=========================
[✓] STATE.md — all fields present
[✓] Phase references resolve
[⚠] Phase plan — missing phases 5-8 in phase-plan.md
[✗] Issue files — ISSUE-2026-04-19-themes-parse missing Hypothesis section
[✓] ADR numbering — sequential, 0001-0004
...

Summary: <N> OK, <N> warnings, <N> errors
```

**Errors are blocking.** If errors exist, do NOT advance work — stop and ask the operator how to resolve.

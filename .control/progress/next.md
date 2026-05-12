# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-01T12:11:59Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read `.control/progress/STATE.md` -- the single source of truth.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. Check `.control/issues/OPEN/` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured `[control:state]` block instead of doing them by hand.

## Next action
Run `/bootstrap <path-to-your-spec-file.md>` if you have a spec, OR `/bootstrap` (no args) to let Claude scan the codebase and produce a starter `.control/SPEC.md` through a guided questionnaire.

After bootstrap populates everything, run `/session-start` to begin Phase 1.

## Notes for next session
Project just scaffolded with Control. Priority is running `/bootstrap` to populate the canonical spec at `.control/SPEC.md` plus all derived docs. Read `.control/PROJECT_PROTOCOL.md` at the root for the full framework reference.

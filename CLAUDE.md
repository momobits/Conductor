<!-- control:managed -->
<!-- Remove the marker above to protect this CLAUDE.md from `npx control-workflow uninstall` auto-deletion. -->

# Project: <PROJECT_NAME>

This project uses the **Control framework** for phased session management — see `.control/PROJECT_PROTOCOL.md` (reference) and `.control/config.sh` (tunables).

## At session start
1. Read `.control/progress/STATE.md`
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md)
3. Check `.control/issues/OPEN/` for blockers
4. Verify git state matches STATE.md (run `/session-start` for the full check)
5. Report: phase, step, blockers, proposed next action
6. **Wait for user confirmation before editing code**

If `SessionStart` hook is installed, steps 1–5 run automatically on session start.

After running `/clear` mid-session, the `SessionStart` hook does not re-fire — run `/session-start` manually to re-bootstrap (idempotent in v2.0+).

## Invariants
- **Git is not optional.** Every step closes with a commit. Every phase closes with a tag (`phase-<N>-<name>-closed`). Never advance a step with uncommitted work unless STATE.md's "In-flight work" section explains why.
- **Commit message shape:** `<type>(<phase>.<step>): <subject>` — see `.control/config.sh` for allowed types.
- **Flip the checkbox in the same commit that closes the step.** In the commit that lands step `<N>.<M>`, also change `- [ ]` → `- [x]` on the matching line in `.control/phases/phase-<N>-<name>/steps.md`. The commit remains the authoritative signal; the checkbox is a one-glance cursor so resumed sessions (and second operators) see current progress without scanning the log.
- **After any commit, tag, step-close, or phase/addendum close, state the next Control command explicitly** (e.g. "Run `/session-end` next.", "Continue with the next step.", "Run `/phase-close` when all step checkboxes are flipped."). The user should never have to infer which command fits the current state — that's the assistant's job to surface at every transition.
- Never edit accepted ADRs in `.control/architecture/decisions/` — they're immutable. New decisions supersede old ones.
- Never close a phase without running `/phase-close` (done-criteria verification + tag).
- Regression test required before any blocker/major issue moves to `RESOLVED/`.
- Prefer STATE.md over memory for operational decisions; memory is for durable user/project preferences.
- <project-specific invariants — add here>

## Autonomous operation
- `/work-next` — picks and executes the next item per protocol priority
- `/loop /work-next` — autonomous loop within session, halts on pause-for-human conditions (see `.control/PROJECT_PROTOCOL.md` Autonomy model)

Start at stage 0 (manual) until the protocol is validated; graduate to stage 2 (`/loop`) once the priority logic feels right.

## Key references
- Full protocol: `.control/PROJECT_PROTOCOL.md`
- Current state: `.control/progress/STATE.md`
- Phase plan: `.control/architecture/phase-plan.md`
- Config: `.control/config.sh`
- Documentation layers (operational vs long-form): `.control/PROJECT_PROTOCOL.md` § "Documentation layers"
- Next-step helper: run `/session-start` to print the canonical command for current state (idempotent — re-runnable mid-session)

# Session end protocol

Trigger: phase boundary, context getting heavy, or user says wrap up.

1. **Check git.** Run `git status --porcelain`. If dirty, either commit now (propose a message following `<type>(<phase>.<step>): <subject>`) or record the reason in STATE.md's In-flight work section. Uncommitted-without-explanation is a protocol violation.

2. **Update `.control/progress/STATE.md`** — overwrite every section:
   - Last updated (UTC timestamp + session id)
   - Current phase / step / status
   - Next action (concrete and actionable)
   - Git state (branch, last commit, uncommitted, last phase tag)
   - Open blockers (with issue IDs)
   - In-flight work (files mid-edit with what's left)
   - Test / eval status (last run, score)
   - Recent decisions (last 3 ADRs)
   - Recently completed (last 5 steps with commit shas)
   - Attempts that didn't work (current step's dead-ends)
   - Environment snapshot (if changed)
   - Notes for next session

2b. **Long-form progress log (if the project keeps one).** If the project maintains a narrative progress log (commonly `docs/PROGRESS.md` or similar), append a session entry there BEFORE the one-line journal entry below. Control's `journal.md` is a cursor — one line per session, scannable; the long-form log carries decision rationale and is worth keeping for projects expected to last more than ~5 sessions. See `.control/PROJECT_PROTOCOL.md` "Documentation layers" for the operational vs long-form split. Skip if the project doesn't keep a long-form log.

3. **Append to `.control/progress/journal.md`** (newest on top):
   - Date + session id
   - Phase / step range (with commit sha range)
   - Decisions made (with ADR refs)
   - Issues opened / closed
   - Minor fixes (severity-gated — inline per the Issue flow section)
   - Significant blockers hit

4. **Regenerate `.control/progress/next.md`** from STATE.md by running `bash .claude/hooks/regenerate-next-md.sh` (or `powershell -NoProfile -File .claude/hooks/regenerate-next-md.ps1` on Windows). v2.0+ auto-generates next.md as a derived view — operators never write it by hand. The script extracts "Next action" + "Notes for next session" from STATE.md and prepends a bootstrap-prompt boilerplate. The SessionEnd hook (`.claude/hooks/session-end-commit.{sh,ps1}`) also calls this regenerator as a safety net so next.md never falls out of sync.

5. **Commit the docs updates** — `docs(state): session end for step <N.M>`.

6. **Closing report.** Default is narrative; verbose on request. Operator sees the narrative unless they ask for the full breakdown.

   **Narrative (default).** 1–3 plain-English sentences naming what landed, what's parked, and the kickoff for next session.

   Example:
   > **Session closed.** Steps 2.2 and 2.3 shipped (`abc123..def456`). STATE.md, journal, and next.md updated; commit `<sha>`.
   >
   > **Next session:** paste `.control/progress/next.md` to bootstrap.

   **Verbose (on request).** List every update made: STATE.md sections rewritten, journal entry summary, next.md content, commit sha, any in-flight items recorded.

7. **Print the kickoff prompt.** Output the contents of `.control/progress/next.md` so the operator can paste it into a fresh session.

The `SessionEnd` hook is a safety net — it snapshots state on actual session shutdown but does NOT replace running `/session-end` in the active session. The hook only captures what's already on disk.

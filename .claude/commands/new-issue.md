---
description: Open a new issue — severity-gated (minor = journal line, major/blocker = file)
argument-hint: <slug>
---

Before creating anything, ask the user two questions:

1. **Symptom** — one-line description of what's wrong.
2. **Severity** — blocker | major | minor.
   - *blocker*: prevents phase advancement
   - *major*: needs tracking + regression test, but not blocking
   - *minor*: typo / obvious fix / cosmetic — no file, no regression test required

**If minor:**
- Do NOT create a file.
- Fix it inline in this session.
- Commit the fix.
- Append a journal line: `- Minor fix: <symptom> in <file> — commit <short-sha>`.
- Done.

**If major or blocker:**
- Create `.control/issues/OPEN/<today>-$ARGUMENTS.md` from `.control/templates/issue.md`. For incident-grade depth (concrete log snippet, repro citing a specific run, hypothesis with ruled-out alternatives, Resolution triple contract), read `.control/templates/issue-example.md` — use it as a shape reference, not a content source.
- Fill: Discovered (today), Phase/step (from STATE.md), Symptom, Severity, Tags (`phase:<N>-blocker` if blocker).
- Append journal: `- Opened ISSUE-<today>-$ARGUMENTS (severity:<sev>) — <symptom>`.
- If blocker, update `.control/progress/STATE.md` open blockers list.
- Commit: `docs(issues): open ISSUE-<today>-$ARGUMENTS`.

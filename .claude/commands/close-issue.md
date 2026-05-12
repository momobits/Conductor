---
description: Close a major/blocker issue after verifying a regression test exists
argument-hint: <issue-id>
---

This command is for **blocker and major** issues only. Minor bugs are fixed inline via `/new-issue` and never create a file — nothing to close.

Given issue ID `$ARGUMENTS`:

1. Read `.control/issues/OPEN/$ARGUMENTS.md`.
2. **Verify a regression test exists** that would have caught this bug — grep tests for the issue ID or the specific failure mode. If none, stop and ask the user to add one before closing. Do not proceed without it.
3. Verify the fix and test have been committed. Record the fix commit sha.
4. Fill in the Resolution section of the issue file: commit refs (fix + regression test), diff summary, regression test path.
5. Move the file from `.control/issues/OPEN/` to `.control/issues/RESOLVED/`.
6. Commit the move: `docs(issues): resolve $ARGUMENTS`.
7. If this was a blocker, update `.control/progress/STATE.md` to remove it from the open blockers list.
8. Append a journal entry: "Closed $ARGUMENTS — fix `<sha>`, regression test at `<path>`".

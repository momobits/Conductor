# Phase 17 Kickoff

Phase 17 picks up the deferred Phase 15.1 LOW-1 follow-up: `conductor init` writes/extends `.gitignore` with a sentinel-fenced block of daemon-written runtime artifacts. Pre-analysis surfaced contract drift in the documented 6-line template that motivated expanding scope to a grouped run.

**Single Relay item** (grouped run, 3 entries, all `full` closure):
1. Run leader: implement `ensureGitignoreBlock()` in `src/cli/commands/init.ts`; add 4 test cases.
2. Unfiled candidate: correct `docs/operations.md § Auth token lifecycle` template + paragraph.
3. Unfiled candidate: correct repo's own `.gitignore:40-47`.

**Open at session start:** `.relay/issues/init-emits-no-gitignore-template.md`. Ships as one commit `feat(17.1): init writes idempotent .gitignore block; correct contract drift`.

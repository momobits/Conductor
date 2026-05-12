# Phase 9 Kickoff Prompt

> This file is what you'd paste into a fresh Claude Code session to resume
> Phase 9 cold. The harness `/session-start` reads `STATE.md` for the same
> info — this is the human-readable mirror.

You are resuming **Phase 9 — Malformed-YAML error surface** of the Conductor project. The phase derives from `.relay/relay-ordering.md § Phase 1` and bundles three issues that share the `readCard` error surface.

## Read first
- `.control/progress/STATE.md` — current cursor (phase, step, blockers)
- `.control/phases/phase-9-malformed-yaml-error-surface/README.md` — phase goal, done criteria, rollback
- `.control/phases/phase-9-malformed-yaml-error-surface/steps.md` — three steps with detail blocks
- `.relay/relay-config.md § Test Commands` — verification commands for this project
- `.relay/relay-config.md § Edge Cases` — foot-guns specific to this codebase (LLM JSON parsing, `commitStep` file lists, strict frontmatter schema)

## The three steps (sequential, one branch)
1. **9.1** — Differentiate ENOENT from parse-failure in `readCard` callers (`misleading-card-not-found-for-malformed-yaml.md`, P1)
2. **9.2** — `scan` continues on per-card YAML failure (`scan-bails-entirely-on-one-malformed-card.md`, P1) — depends on 9.1
3. **9.3** — `work` validates card before creating run dir (`work-creates-run-dir-before-validating-card.md`, P2) — depends on 9.1

## Pipeline per step
```
/relay-analyze → /relay-superplan → /relay-review → implement → /relay-verify → /relay-resolve
```
Skip `/relay-notebook` — `relay-config.md § Notebook Setup` says this project is TypeScript-only; `npm test` + `npm run typecheck` are the canonical verification path.

## Commit discipline (Control invariants)
- Every step closes with a commit `fix(9.<N>): <subject>` (the commit-msg hook will reject anything else).
- Flip the matching `- [ ]` → `- [x]` in `steps.md` **in the same commit** that lands the step.
- Never `git push` until the phase closes (no PR flow for this phase — local-only until `/phase-close`).
- Never `--no-verify`. If pre-commit or commit-msg hooks fail, fix the underlying issue.

## First action
Run `/relay-analyze .relay/issues/misleading-card-not-found-for-malformed-yaml.md` to begin step 9.1.

## Rollback target
`git reset --hard phase-8-provider-expansion-closed` (effectively reverts the Control framework install too; phase 9 is the first Control-framework phase).

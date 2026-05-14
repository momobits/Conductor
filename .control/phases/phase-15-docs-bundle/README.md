# Phase 15 — Documentation bundle

**Dependencies:** Phase 14 closed at tag `phase-14-brain-log-closed`.
**Estimated duration:** ~1 session (5 XS-complexity items, bundled into one PR per `relay-ordering.md § Phase 7`).

## Goal
Close the five docs-only items deferred from the 2026-05-12 dogfood
session — every code surface they describe is now stable post-Phases
9-14, so the docs can finally anchor to behaviors that won't keep
shifting.

## Outcome

After this phase, the following documentation gaps are closed:

- **Quickstart latency estimate** corrected by model class (Opus
  subscription analyze alone hit 151s in dogfood; the current "60-120s
  per `conductor work` cycle" estimate in `docs/quickstart.md`
  understates reality).
- **`conductor transition` semantics** documented in `docs/operations.md`
  and the `--help` text: adjacency-only (per `canTransition()`) — spec
  language that suggested transition was a human-override is clarified.
- **`.conductor/auth.token` lifecycle** documented: regenerated on each
  daemon start, NOT cleared by `daemon stop`. Verify the `.gitignore`
  template includes `.conductor/auth.token`.
- **MCP `tools/list` session handshake** documented with a curl
  example (`initialize` → `notifications/initialized` → `tools/list`
  with the captured session ID per MCP 2025-03-26).
- **`conductor.recommend` RPC method semantics** tightened in the
  tool list + `docs/rpc.md`: it FILES a recommendation; it does NOT
  return one. Public-facing description is currently ambiguous.

Net effect: a fresh user reading `docs/` after this phase encounters
no contradiction with observed system behavior. The dogfood-log items
T1-2, T3-1, T4-2, T4-3, and T4-4 are closed.

## Where we were, end of Phase 14

Phase 14 (tag `phase-14-brain-log-closed`) shipped one L-complexity
item in commit `68e6d14` (14.1: `BrainLogWriter` subscribes to the
EventBus, filters `conductor-*` events, appends JSONL rows to
`.conductor/brain.log.jsonl`; daemon-wired with `try/finally`
shutdown-ordering enforcement; dedicated `brain_log` config block in
`ProjectConfigSchema` parallel to `run_log`; `event_bus.ts:5` doc
comment updated; +19 tests across unit, schema, e2e). 5-agent
`/relay-superplan` synthesis; adversarial review caught two MEDIUM
defects (`pruneBrainLog` cutoff semantic flipped, `appendLine`
close-drain bug). Suite 519 → 538.

## Why this phase exists

The docs items have been deliberately deferred to last because each
of them anchors to a behavior that other phases may have changed.
With the malformed-YAML surface stable (Phase 9), the quick-wins
shipped (Phase 10), the drift refactor done (Phase 11), the discover
dedup live (Phase 12), the plan op restructured (Phase 13), and the
brain log persisted (Phase 14), the docs can finally anchor to a
codebase that's settled. Five docs-only items + the small
description-string updates ship together as one PR — minimal review
surface, no integration risk.

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:15-blocker`
- [ ] Automated tests pass: `npm test`
- [ ] `npm run typecheck` passes (no behavior change expected; typecheck
  exists to catch accidental code drift if a docs edit touches an inline
  code example)
- [ ] Each of the five docs items has its target docs change visible in
  the diff (no commit lands without all 5 files touched, or each item
  is committed separately if split into sub-steps 15.1a-15.1e)
- [ ] No code regression: docs-only commits do not introduce code drift
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(15.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-15-docs-bundle-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-14-brain-log-closed`. Pure docs change with possibly a one-line `--help` string or one entry in `.gitignore.template`. Trivial revert.

## ADRs decided in this phase
- *(filled in as decisions are made — unlikely to surface ADR-worthy
  decisions in a docs-only phase, but possible if the documented
  semantics turn out to be load-bearing for a future feature.)*

## Deferred to Phase 16 (or later)

<!-- Items that surface during phase 15 work but exceed scope. -->

- *(empty until phase-15 work surfaces overflow items)*

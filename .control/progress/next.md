# Next session kickoff

> Auto-generated from `.control/progress/STATE.md` at 2026-05-23T10:00:00Z by
> `.claude/hooks/regenerate-next-md.sh`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> this file directly** (the hook overwrites it on session start).

---

## Resume Phase 29 step 29.1

Phase 28 (`engine-ops-body-sunset`) closed cleanly at tag `phase-28-engine-ops-body-sunset-closed`. The full engine-ops substrate migration shipped across 3 sub-steps (review + plan-op shim sunset in 28.1; verify + notebook in 28.2; implement + RPC/UI widening + bundled latent-bug fix in 28.3). Card body for the entire `discovered → archived` lifecycle is byte-identical to user-authored state. Suite at 764/764. Manual smoke verified 2026-05-23.

**Phase 29 active — UI markdown render fix.** Single P2 dogfood bug at `.relay/issues/ui-markdown-render-breaks-partway-through-content.md`. Card-detail markdown rendering breaks partway through content — first portion renders as styled markup, later portion appears as raw text. Five candidate root-cause hypotheses (marked tokenization, DOMPurify strip, line-ending mismatch, partial markdown construct — option c "op writer malformation" is N/A post-Phase-28 since body is user-only).

**Step 29.1 (current):** `/relay-analyze ui-markdown-render-breaks-partway-through-content.md`. Bisect-driven analysis — needs a dogfood instance where the bug fires to capture the minimal triggering substring. Match the minimal repro against the 5 candidate hypotheses; pin the root cause; determine fix layer + complexity (S = single-config-line fix; M = allowlist refactor or line-ending normalization).

**Pipeline**: `/relay-analyze` (29.1 IS the analyze step) → `/relay-plan` (29.2) → `/relay-review` → implement → `/relay-verify` → `/relay-resolve`.

**Phase 29 scaffold**: `.control/phases/phase-29-ui-markdown-render-fix/{README,steps}.md`. The README's `## Why this phase exists` section has its `<Fill in during phase kickoff.>` placeholder — author during kickoff (no carry-forward bullets seeded; Phase 28's Deferred section had only template placeholders).

**After Phase 29**: 0 active items remain in `.relay/issues/`. Frame B card-pipeline UI cluster (6 designed features at `.relay/features/`) becomes the strategic Phase 30+ target. Each Frame B child declared Phase 28's body-sunset as Prerequisite #0 — now satisfied. Ships in 3 PR cohorts: Cohort A ([#47 multi-surface, #48 op-controls] parallel) → Cohort B ([#49 chat-driven description authoring; L-complexity]) → Cohort C ([#50 column-transition, #51 brain-halt, #52 run-history]).

**Smoke harness tooling** at `scripts/smoke-phase28*.mjs` retained for future similar phases (notably Frame B cohorts which will need UI verification).

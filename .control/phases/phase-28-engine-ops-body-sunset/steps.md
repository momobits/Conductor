# Phase 28 Steps

- [x] 28.1 — Migrate `review` op to RunArtifactWriter + sunset the plan-op dual-write shim. `review.ts` reads `Implementation Plan` from `.conductor/runs/<runId>/plan.md` via `readRunArtifact` (find the runId from the latest run for this card; see Phase 21 precedent). Writes `## Adversarial Review` to `<runId>/review.md` via `RunArtifactWriter`. Drops `appendSection(card.path, 'Adversarial Review', ...)` from `src/engine/ops/review.ts:90`. Once review reads from substrate, **remove the plan-op dual-write shim**: drop `appendSection(card.path, 'Implementation Plan', resp.text)` from `src/engine/ops/plan.ts:84` AND drop the `appendSection` import. Update test fixtures (plan-op tests + review-op tests) for the new substrate read path. Card body byte-identity for `discovered → planned` becomes complete.
- [x] 28.2 — Migrate `verify` + `notebook` ops to RunArtifactWriter. `verify.ts` writes `<runId>/verify.md`; drops body append at line 110. `notebook.ts` reads `<runId>/verify.md` via `readRunArtifact`; writes `<runId>/notebook.md`; drops body append at line 80. Update test fixtures.
- [ ] 28.3 — Migrate `implement` op to RunArtifactWriter. `implement.ts` writes `<runId>/implement.md`; drops body append at line 137. No downstream op reads `## Implementation Guidelines` (terminal artifact). Update test fixtures. Verify Card Detail view's artifact panel renders all four new artifact kinds (review, verify, notebook, implement) alongside the existing analyze + plan.

## Step detail

### 28.1 — Migrate `review` + sunset plan-op compat shim

The strategic step. `review.ts` currently calls `extractSection(card.body, 'Implementation Plan')` to read the plan output for adversarial review. The Phase 21 plan-op dual-write compat shim exists specifically to keep this working — without it, the `planned → approved` transition breaks for every card.

Migration: change `review.ts` to call `readRunArtifact(runId, 'plan')` instead of `extractSection`. Finding the runId requires looking up the latest run record for the card (Phase 21 precedent — see how `chat.ts` resolves runId from the runlog store). Once review reads from runs/, the plan-op shim can be deleted in the same commit, completing the byte-identity guarantee for the `discovered → planned` transition.

**Verify command:** `npm test` + targeted `tests/engine/ops/review.test.ts` + `tests/engine/ops/plan.test.ts` + manual smoke: run analyze → plan → review on a fresh card; confirm card body has NO `## Implementation Plan` OR `## Adversarial Review` sections; `.conductor/runs/<runId>/plan.md` AND `<runId>/review.md` both exist with expected content.

**Step-close commit:** `feat(28.1): review op consumes run-artifact substrate; sunset plan-op compat shim` followed by `docs(28.1): /relay-resolve close out plan compat shim`.

### 28.2 — Migrate `verify` + `notebook`

Similar substrate pattern. `verify.ts` writes verify output to `<runId>/verify.md`. `notebook.ts` reads verify output from `<runId>/verify.md` via `readRunArtifact` and writes notebook output to `<runId>/notebook.md`. Both ops drop their body appends.

**Verify command:** `npm test` + targeted `tests/engine/ops/verify.test.ts` + `tests/engine/ops/notebook.test.ts` + manual smoke: run a card through verify + notebook; confirm card body has no new sections; `<runId>/verify.md` + `<runId>/notebook.md` both present.

**Step-close commit:** `feat(28.2): verify + notebook ops consume run-artifact substrate` followed by `docs(28.2): /relay-resolve close out verify+notebook migration`.

### 28.3 — Migrate `implement` op

Terminal artifact migration. `implement.ts` writes its `## Implementation Guidelines` output to `<runId>/implement.md` instead of appending to card body. No downstream op reads `## Implementation Guidelines`, so this is a one-way migration with no read-site coordination needed.

Also verify the UI Card Detail view's artifact panel (wired in Phase 21 for analyze + plan) correctly renders the four new artifact kinds (review, verify, notebook, implement). May need a small extension to the artifact-render logic in `src/ui/views/card_detail.ts` to list and render the new artifacts alongside the existing two.

**Verify command:** `npm test` + targeted `tests/engine/ops/implement.test.ts` + manual smoke: full lifecycle run on a card (discovered → archived) via brain or manual transitions; confirm card body is byte-clean (only user-authored content + original-issue section); Card Detail view shows all 6 per-op artifacts (analyze, plan, review, verify, notebook, implement) rendered correctly.

**Step-close commit:** `feat(28.3): implement op consumes run-artifact substrate; UI artifact panel renders all 6 ops` followed by `docs(28.3): /relay-resolve close out engine-ops body sunset`.

Commit message template per Control protocol: `<type>(28.<step>): <subject>`.

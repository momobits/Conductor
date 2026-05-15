# `review`, `verify`, `notebook`, `implement` ops still append output to card body; `plan` op carries a dual-write compat shim that should sunset

*Created: 2026-05-16*
*Source: Phase 21 Relay Phase 12 grouped-run closure (`/relay-resolve` on `ui-work-card-output-persisted-into-card-body`). Filed as the documented follow-up obligation surfaced by `/relay-analyze`'s unfiled-candidate finding and confirmed by `/relay-review`'s dual-write fix.*
*Severity: P2 — slow accumulation; lower user impact than Phase 12 (gated by human lifecycle transitions) but completes the structural refactor and unblocks the plan-op compat-shim sunset.*

## Problem statement

Phase 21 closed Relay Phase 12 (`#20`-`#23`) by decoupling `analyze`, `plan`, and `chat` op output from the card body — moving them to per-run artifacts at `.conductor/runs/<runId>/<op>.md` and a per-card sidecar at `.conductor/cards/<id>.chat.jsonl`. Four ops were deliberately deferred from that scope and still call `appendSection(card.path, ...)` to write into the card body:

- `src/engine/ops/review.ts:90` — appends `## Adversarial Review`
- `src/engine/ops/verify.ts:110` — appends `## Verification Report`
- `src/engine/ops/notebook.ts:80` — appends `## Notebook`
- `src/engine/ops/implement.ts:137` — appends `## Implementation Guidelines`

Plus one **dual-write compat shim** that Phase 21 retained for backward compatibility:

- `src/engine/ops/plan.ts:84` — appends `## Implementation Plan` to body (in addition to writing `.conductor/runs/<runId>/plan.md`). The shim exists because `review.ts:41` reads `extractSection(card.body, 'Implementation Plan')` and throws if missing. Without dual-write, the `planned → approved` transition breaks for every card.

The shim is technical debt with an explicit sunset path: when this issue ships, plan-body dual-write can be removed.

## Why this was deferred from Phase 21

`/relay-analyze` on `ui-work-card-output-persisted-into-card-body` (2026-05-16) found the same anti-pattern in 6 ops (analyze, plan, chat, review, verify, notebook, implement). Scope Decision bound the run to `analyze + plan + chat + card_detail` as a grouped run; the other 4 ops were filed as a `linked companion` follow-up because:

1. Per-click body bloat from review/verify/notebook/implement is much slower than analyze/plan/chat — gated by human transition approvals between `planned → approved → building → verifying → shipped`, not by a single UI click.
2. Phase 21's L-complexity scope (3 commits, 11 steps, ~24 new tests) was already at the ceiling for a single coherent shippable phase.
3. The dual-write compat shim in Phase 21 plan op cleanly carries cards across the boundary; no review-op regression while this issue remains open.

`/relay-review` upgraded the operator decision into a closure obligation: this follow-up issue **must** include the dual-write sunset path.

## Impact

- **Compounding body bloat** at slower rate. A card that runs the full lifecycle (`discovered → planned → approved → building → verifying → shipped → archived`) accumulates `## Implementation Plan`, `## Adversarial Review`, `## Verification Report`, `## Notebook`, `## Implementation Guidelines` sections. Each ~30-80 lines. Total per full lifecycle: ~250-400 lines of generated content stuck in the card body.
- **Plan-op compat shim retains 1/4 of the original #20 bloat**. Pre-Phase-21: ~114 lines/click. Post-Phase-21: ~50 lines/click (plan body section). Phase 22 fix: ~0 lines/click for the discovered → planned path.
- **`extractSection` regex remains the inter-op exchange substrate for 3 op pairs**: plan → review (Implementation Plan), verify → notebook (Verification Report). Same fragility class as the Phase 21 #21 root cause; just hasn't manifested in dogfood for these ops yet (or hasn't been reported because the lifecycle stages are less frequently exercised in UI).

## Reproduction

1. Pick a card and run it through the full lifecycle (`conductor work` repeatedly with manual transitions, or `conductor.start` brain).
2. Read the card file at each transition. Body grows by `## <Section>` block per op.
3. Open the card in the UI's Card Detail view. The rendered body shows every accumulated section in chronological order, conflating user-authored dossier content with generated artifacts.

## Proposed direction

Adopt the same substrate pattern Phase 21 introduced. Three commits in one branch (per Phase 21 ordering convention):

1. **Migrate `review` op** — read `Implementation Plan` from `.conductor/runs/<runId>/plan.md` via `readRunArtifact` (need to find the runId — see "Open Questions" below). Write `## Adversarial Review` to `<runId>/review.md` via `RunArtifactWriter`. Once review reads from substrate, **remove the plan-op dual-write shim** (`src/engine/ops/plan.ts:84` `appendSection(card.path, 'Implementation Plan', resp.text)` line and its retained `appendSection` import). Card body byte-identity for the `discovered → planned` transition becomes complete. Update test fixtures.

2. **Migrate `verify` + `notebook`** — verify writes `<runId>/verify.md`; notebook reads `<runId>/verify.md` via `readRunArtifact`. Drop body appends.

3. **Migrate `implement`** — write `<runId>/implement.md`. Drop body append.

After all 4 migrations: `extractSection` and `appendSection` can be **deprecated** (kept exported with `@deprecated` JSDoc) or **removed entirely** depending on whether any user-facing tooling still consumes them. Card body becomes user-owned single-writer once again.

## Open Questions

1. **Cross-run runId lookup**. `review` runs in a separate TaskAgent instance (`planned → approved`) than `plan` (`discovered → planned`). In-memory hand-off doesn't bridge the gap. Options:
   - Frontmatter `latest_run_id` field (requires strict-schema migration + tests).
   - Scan `.conductor/runs/<runId>/` for `<stamp>-<cardId>` pattern, pick latest by mtime (brittle; fragile under pruning).
   - Use `listRuns(repo)` from `runlog_store.ts` filtered by cardId in runId suffix; sort by mtime. (Most aligned with existing infra.)
2. **`notebook.ts` retention** — notebook bundles `## Verification Report` into a Jupyter notebook output. After substrate migration, notebook reads from `<runId>/verify.md`. Same runId-lookup question applies.
3. **Whether to deprecate or remove `appendSection`/`extractSection`** — depends on whether `card_update` RPC (`src/rpc/methods.ts:card_update` with `bodyAppend` param) is the only remaining consumer. Grep at Phase 22 start.

## Related

- `[[ui-work-card-output-persisted-into-card-body]]` (archived) — Phase 21 closure that deferred this work.
- Phase 6 `BrainLogWriter` and Phase 21 `RunArtifactWriter` + `ChatLogWriter` are the substrate-pattern precedents (n=3 of the JSONL/markdown writer family — ADR-worthy; deferred per operator decision).
- Phase 5 `plan-op-leaves-need-placeholders-resolved-in-analysis` — preserves Phase 5 H3 preamble invariant; relevant if plan-op test fixtures change.

## Severity rationale

P2, not P1: the user-visible failure mode is slower accumulation than Phase 12 (gated by lifecycle transitions, not single UI clicks). However, the **structural sunset of the plan-op dual-write shim** is what makes this a real closure obligation rather than a nice-to-have refactor.

> **ARCHIVED** — All features resolved.

# Feature Brainstorm: Post-Phase-30 Polish Bundle

*Created: 2026-05-24*
*Status: DESIGN COMPLETE*
(Lifecycle: BRAINSTORMING → READY FOR DESIGN → DESIGN COMPLETE → COMPLETE)
*Source: 2026-05-24 operator request after Phase 30 close — consolidate impl-doc Caveats into a single brainstorm for design ordering.*

## Goal

Ship the two polish items from Phase 30's impl-doc Caveats that address real operator friction — daemon-restart state loss and invisible brain-loop events. Everything else from the original 16-item sweep was assessed as speculative polish for v1 trade-offs that haven't bitten yet; those items are deferred indefinitely and only resurface if dogfood proves they matter.

## Context

Phase 30 shipped 14 features end-to-end via `/relay-auto` sweeps (suite 784 → 1123, +339 net tests; tag `phase-30-frame-b-and-dual-driver-closed`). Several deferred items were tagged into impl-doc Caveats sections. An initial brainstorm pass enumerated 16 concrete items across 11 design units — but most were theoretical polish ("acceptable for v1" per their own impl docs) with no observed dogfood pain. Operator cut scope to the 2 items with the strongest case.

## Decisions Made

1. **#8 enumerated into 8a–8i** (settled 2026-05-24): read `chat-driven-description-authoring.md` Caveats; expanded TBD bucket into 8 concrete sub-items.

2. **8h routed to Frame C** (settled 2026-05-24): cross-card chat history folded into Frame C #1 (cross-card memory) — shared archive/search/UI sub-problems.

3. **Items #1 + 8d paired** (settled 2026-05-24): both are "in-memory ephemeral state lost on daemon restart" at different surfaces (pending-decisions vs. proposed-edits). Same persistence story.

4. **Scope cut to 2 active items** (settled 2026-05-24): after assessing "are these really needed?", operator kept only #1+8d (persistence) and #5 (brain-loop UI rendering). All other items deferred — v1 trade-offs that haven't bitten in practice. Deferred items only resurface if dogfood proves they matter.

## Feature Breakdown

| # | Feature File | Items | Description | Dependencies | Status |
|---|---|---|---|---|---|
| 1 | [`ephemeral-state-persistence.md`](ephemeral-state-persistence.md) | 1 + 8d | Persist in-memory pending-decisions + proposed-edits across daemon restart (on-disk durable store) | None | DESIGNED |
| 2 | [`brain-loop-ui-rendering.md`](brain-loop-ui-rendering.md) | 5 | Render `conductor-pending-decision`, `conductor-pending-decision-resolved`, `conductor-halt-loop-detected` SSE events in card_detail.ts and monitor.ts | None | DESIGNED |

## Development Order

1. **#1 ephemeral-state-persistence** — persistence gap is the higher-friction item (daemon restart loses both pending-decisions and proposed-edits).
2. **#2 brain-loop-ui-rendering** — operator can work around this by tailing `brain.log.jsonl`; lower urgency but still real.

No dependency between them; order is by friction priority.

## Deferred Items

The following were enumerated during the brainstorm but deferred as speculative polish — v1 trade-offs explicitly marked "acceptable" in their impl docs with no observed dogfood pain. Resurface only if dogfood proves they matter.

| Item | Description | Why deferred |
|---|---|---|
| 2 | Amend payload plumb-through | v1 dispatches original on amend; no operator friction reported |
| 3 | `bridgeSpectrumToConductMode` dead-code cleanup | No functional impact; pure code health |
| 4 | `step_resolver.ts` orphaned-helper retention | No functional impact; pure code health |
| 6 | Halt-loop reset semantics review | Audit that may produce zero changes |
| 7 + 8g | Cost-ceiling tunability (reconciliation + chat) | No operator pain with current defaults |
| 8a | Multi-round tool-call cap raise | 1-round sufficient for v1; no pain reported |
| 8b | Apply-failure rollback/recovery | Edge case (commit fails after write); no incidents |
| 8c | Cross-tab supersede broadcast | Minor UX gap; "expired" message is understandable |
| 8e | Optional autonomy-gate on chat_apply_edit | Operator-click approval is fine |
| 8f | Tunable tool sandbox bounds | v1 caps haven't bitten |
| 8i | Diff-preview UI affordances | Side-by-side `<pre>` is functional enough |
| 9 | appendSection/extractSection deprecation | Zero call sites; no urgency |

## Open Questions

None — scope is settled. Phase number assignment depends on 31.1 dogfood outcome.

## Out of scope

- Frame C territory (`.relay/features/frame-c-strategic-direction_brainstorm.md`).
- 8h cross-card chat history — routed to Frame C #1 per Decision #2.
- All deferred items above unless dogfood resurfaces them.

## Next

Run **`/relay-design`** to expand the 2 feature rows into individual feature files.

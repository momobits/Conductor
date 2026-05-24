# Feature Brainstorm: Post-Phase-30 Polish Bundle

*Created: 2026-05-24*
*Status: BRAINSTORMING*
(Lifecycle: BRAINSTORMING → READY FOR DESIGN → DESIGN COMPLETE → COMPLETE)
*Source: 2026-05-24 operator request after Phase 30 close — consolidate impl-doc Caveats into a single brainstorm for design ordering.*

## Goal

Bundle the v1 caveats and deferred-polish items that surfaced during the Phase 30 dual-driver + Frame B sweep but were intentionally deferred to a follow-up phase. None are P1/P2; all are documented in their respective impl docs' Caveats sections. This brainstorm frames them as a coherent polish bundle rather than scattered individual issues — likely shippable as Phase 31 (if 31.1 dogfood doesn't surface anything bigger) or Phase 32+.

## Context

Phase 30 shipped 14 features end-to-end via `/relay-auto` sweeps (suite 784 → 1123, +339 net tests; tag `phase-30-frame-b-and-dual-driver-closed`). To preserve sweep momentum, several deferred items were tagged into impl-doc Caveats sections rather than filed as standalone Relay issues. This brainstorm consolidates them so a single design pass can decide grouping, ordering, and which items pair naturally.

**Why now**: Phase 31 step 31.1 is a dogfood + discover pass. If `/relay-discover` doesn't surface P1/P2 work, this polish bundle is the natural Phase 31 scope. Authoring the brainstorm seed before 31.1 lets 31.1 close cleanly with a "polish bundle is the direction" decision rather than starting brainstorm work mid-31.1.

## Seed Items (awaiting brainstorm exploration)

### From `dual-driver-brain-loop-replacement.md` (Phase 22 #59 / Control step 30.13) — 6 items

1. **Pending-decision persistence across daemon restart.** Per OQ #4 of the spec — the executor's `awaitResolution` promise lives in-memory; daemon restart while a pending-decision is in flight loses the wait state. Acceptable for v1 (the next iter re-decides). Worth promoting if dogfood surfaces friction.

2. **Amend payload plumb-through.** The `resolution: 'amend'` value is honored by the executor (proceeds with dispatch) but the amended decision payload isn't yet plumbed through. v1 dispatches the ORIGINAL decision on amend. Richer amend semantics belong here (or roll into Frame B chat surface follow-up).

3. **`bridgeSpectrumToConductMode` dead-code cleanup.** The helper at `src/conductor/autonomy.ts` has its own test coverage but is no longer called by `loop.ts` after #59. Left in place because TaskAgent's `transitionWithGate` may still consume it via legacy autonomy path. Decide: remove, or keep for the TaskAgent CLI path.

4. **`step_resolver.ts` orphaned-helper retention decision.** Phase 29.3 module's sole brain consumer (`defaultAgentFactory`) is gone. KEEP for v1; flag for cleanup if no consumer materializes within 1-2 phases. This polish phase is the natural decision point.

5. **Brain-loop UI rendering of new SSE events.** `conductor-pending-decision`, `conductor-pending-decision-resolved`, `conductor-halt-loop-detected` events flow through SSE (DaemonEventKind extended in `src/ui/events.ts`) but no card_detail.ts or monitor.ts handlers render them yet. Deferred per #57 + #58 polish-ticket precedent. Operator can `tail .conductor/brain.log.jsonl` to inspect; UI rendering is the polish.

6. **Halt-loop reset semantics review.** The counter increments only when `outcome.kind === 'halt-published'` AND same card as last iter AND last iter also halted; resets to 1 on different-card halt; resets to 0 on any non-halt outcome. Wedge-detector-friendly pattern but worth review for edge cases.

### From `dual-driver-lead-handoff-reconciliation.md` (Phase 22 #57 / Control step 30.8) — 1 item

7. **Event persistence + reconciliation cost-ceiling tuning.** Reconciliation events flow through SSE; persistence to brain.log.jsonl works via the `conductor-reconciliation-summary` event name (per the deviation note in the impl doc). Cost-ceiling tuning is the open item — `max-reconciliation-llm-calls-per-handoff` default is ~10; dogfood may want per-mode tunability or per-card override.

### From `chat-driven-description-authoring.md` (Phase 20 #49 / Control step 30.15) — TBD count

8. **v1 → v2 evolution items.** Per the impl doc's Caveats. Read at brainstorm-time. Likely includes: richer amend semantics; cross-card chat history; multi-round tool-call cap raise from v1's 1-round limit; differential diff-preview UI affordances.

### Phase 28.3 leftover — 1 item

9. **`appendSection` / `extractSection` deprecation pass.** `appendSection` retained as an export for the `card_update` RPC's `bodyAppend` param; `extractSection` has zero remaining call sites in `src/`. Either could be deprecated/removed if operator decides. Low priority — clean-up only, no functional change.

## Open Questions

(Will be settled during `/relay-brainstorm post-phase-30-polish`.)

1. **Grouping shape**: do items 1+2 (executor-related) pair naturally as a grouped run? Do items 3+4 (cleanup-decisions) pair? Or ship each independently?
2. **Priority order**: which items unblock dogfood vs. which are pure cleanup?
3. **Scope of #8 v1→v2**: read `chat-driven-description-authoring.md` Caveats and enumerate the concrete items; some may be Frame B-cluster follow-ups rather than polish-cluster items.
4. **One phase or multiple?** 9 items at S complexity each could fit in one phase via `/relay-auto --sweep`. Or split into a "must-have polish" Phase X + "nice-to-have polish" Phase Y.
5. **Brain-loop UI rendering (#5) interaction with Frame C**: if Frame C's "Session-start narration" item ships, the SSE-event rendering becomes part of a broader narration surface. Worth coordinating brainstorm timing.

## Out of scope

- Anything from `.relay/features/frame-c-strategic-direction_brainstorm.md` (Frame C territory).
- New feature work surfaced via /relay-discover that's NOT from impl-doc Caveats — those are new issues/features, not polish.

## Next

Run **`/relay-brainstorm post-phase-30-polish`** to explore the items, settle grouping + ordering, and produce a READY FOR DESIGN brainstorm. Then `/relay-design` to expand into individual feature files. Alternatively: if Phase 31.1 dogfood surfaces a P1/P2 item that subsumes one of these, file the subsuming issue and drop the polish item from this bundle.

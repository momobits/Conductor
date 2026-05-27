> **ARCHIVED** — Abandoned. Brainstorming was not completed.

# Feature Brainstorm: Frame C — Strategic Direction (Cross-Card / Product Layer)

*Created: 2026-05-24*
*Status: BRAINSTORMING*
(Lifecycle: BRAINSTORMING → READY FOR DESIGN → DESIGN COMPLETE → COMPLETE)
*Source: 2026-05-24 operator request — formalize the "Frame C territory" items explicitly deferred from Frame B brainstorm (`.relay/features/card-pipeline-ui_brainstorm.md` § "Out of scope").*

## Goal

Sketch the next architectural layer — explicitly marked "Frame C territory" in the Frame B brainstorm and explicitly deferred from Phase 30's scope. These items share a theme: extending Conductor's per-card model to **cross-card / project-wide / drift-aware surfaces**. Each item is meaty enough to warrant its own brainstorm session; this aggregator is the seed list + cross-item relationship sketch.

## Context

Frame B (Phase 30) shipped the per-card UI surfaces — multi-surface card detail, per-op controls, chat-driven description authoring, column-transition op-triggering, run-history. Frame B's brainstorm (`.relay/features/card-pipeline-ui_brainstorm.md` § "Out of scope") explicitly deferred several directions to Frame C: they were on the table during Frame B brainstorming but needed bigger framings + their own brainstorm sessions. Now that Frame B is complete, those deferred directions are unblocked.

**Strategic positioning**: Frame B was about making the Relay pipeline a first-class user-facing experience PER CARD. Frame C is about making the project-wide layer first-class — cross-card search/memory, project cursor state, drift between UI and disk, cost gating at product layer, expanded halt taxonomy, session-aware UI. Frame B = card; Frame C = project. Frame B treated cards as independent; Frame C is where they get connected.

**Why now**: Phase 30 drained the active feature backlog. If Phase 31.1's dogfood pass surfaces no urgent issues, Frame C is the natural next strategic direction. Authoring this seed brainstorm now lets 31.1 close with "Frame C brainstorming is the direction" rather than starting brainstorm work mid-31.1.

**Critical sequencing note**: each Frame C item is potentially a multi-phase undertaking on its own (cross-card memory alone has archive-layout + retention + search-ranking + UI design as sub-problems). Frame C should NOT ship as a single sweep; bias is "brainstorm one at a time, prioritize by operator pain, ship items as standalone clusters."

## Seed Items (each needs its own brainstorm session before any can ship)

### 1. Cross-card memory

**Sketch**: search past resolved cards. Today the agent investigates the current card's body + artifacts + the live codebase. It does NOT search past resolved cards in v1. When operator dogfoods a card that's similar to a prior-archived card, there's no way for the agent to surface the prior context.

**Sub-problems**: archive layout (`.conductor/archive/cards/` is flat; needs structure for search?); retention policy; search ranking (keyword? embedding? hybrid?); UI surface design (in-chat suggestion? sidebar? dedicated search view?); cost-control (embedding generation = LLM call per archived card).

**Why most-requested**: explicitly cited in Frame B brainstorm as the operator's top Frame-C-territory item.

**Folded-in sub-item (added 2026-05-24)**: **Cross-card chat history surface** (originally item 8h in `.relay/features/post-phase-30-polish_brainstorm.md`, routed here during enumeration pass). Today chat history is per-card; operator can't see "what did I tell the agent about card X last Tuesday" while looking at card Y. Same archive-layout / retention / search-ranking / UI-surface sub-problems as agent-side cross-card memory — the consumer differs (operator browsing vs. agent investigating) but the underlying cross-card index is shared. Brainstorm together.

### 2. Project-wide cursor file

**Sketch**: Control's `STATE.md` analog at Conductor's product layer — a top-level "here's where the project is" view distinct from per-card state. Per-card state shows "what's this card about + what's the latest run"; project cursor shows "what's the current strategic direction + which cards are in flight + recent decisions + next milestone."

**Sub-problems**: data model (frontmatter + body? structured fields?); update protocol (manual? auto-derived from card state + git? hybrid?); UI surface (new view in the navigation? top-of-board?); cross-pollination with Control's STATE.md when Conductor is used inside a Control-managed project.

**Operator pain**: Conductor users dogfooding multi-card sessions currently have no high-level "where are we" surface; they have to mentally aggregate per-card state.

### 3. Drift detection between UI and disk

**Sketch**: Control's hook-based drift check (SessionStart hook flags commit-mismatch when STATE.md's recorded cursor diverges from actual HEAD) ported to a daemon-level guard for Conductor. Detect when the UI's in-memory card state diverges from disk (e.g., external edit during a brain run; manual file edit between two UI sessions; concurrent multi-operator divergence).

**Sub-problems**: drift event taxonomy (file-vs-RAM diff classes); operator surface (notification banner? confirm-and-reconcile dialog?); reconciliation strategy (reload? merge? prompt operator?); coexistence with the existing chokidar file-watcher.

**Frame B precedent**: `lead-handoff-reconciliation` (#57) is a special case of drift detection — the brain reclaiming lead diffs board state since handoff. Frame C generalizes the drift-detection mechanism to the operator's UI surface, not just the brain.

### 4. Severity-gated cost at card level

**Sketch**: Control's minor=journal-line / major=file model brought to the card level. Today every card is a full file with frontmatter + body; small notes get the same shape as multi-day cards. Severity-gating would let minor observations land as cheaper artifacts (journal lines? lightweight one-liners?) while major cards keep the full shape.

**Sub-problems**: severity taxonomy (operator-tagged? auto-classified by content size + scope?); journal-line storage (where? `.conductor/journal.md`? per-day rotation?); promotion path (minor → major when scope grows); how lightweight cards interact with the brain's per-card lifecycle.

**Open question**: does severity-gating make sense for Conductor's card model, OR is it more naturally a Control-layer feature for projects that wrap Conductor? Decide during brainstorm.

### 5. Autonomy halt conditions beyond what dual-driver shipped

**Sketch**: Control's 8 halt conditions (need-ADR, ambiguous-failing-test, cost-ceiling-hit, unrecognized-pattern, missing-test-infra, schema-unclear, contradictory-spec, blocker-tag) brought into the brain. The dual-driver cluster (Phase 30) shipped halt taxonomy via #61 `halt-categories` and lead-transfer via #55 as the primary halt surface; Frame C systematizes the rest of Control's halt vocabulary into the orchestrator's `decide()` → `halt-with-handoff` decision space.

**Sub-problems**: which Control halt categories map cleanly to brain halts; which need new orchestrator-side detection logic (e.g., cost-ceiling-hit already partly handled by cost_guard.ts; ambiguous-failing-test needs verify-output classification); UI rendering of each category; per-category recovery affordances.

**Sequencing relationship to brain-loop UI rendering** (post-Phase-30 polish item #5): the polish item ships the rendering surface for the 3 new SSE events shipped in Phase 30; Frame C item #5 extends the halt vocabulary that uses that rendering surface. Polish item ships first; this Frame C item builds on it.

### 6. Session-start narration when UI opens

**Sketch**: Control's `/session-start` plain-English summary (which the SessionStart hook emits as a `[control:state]` block at conversation start), surfaced on first load of the Conductor UI. Today the Conductor UI just loads to the Board view with no orienting context; an operator returning to a paused project has to click-through to figure out where they left off.

**Sub-problems**: narration data source (project cursor file from item #2? auto-derived from card state + git log + recent events?); UI surface (modal? sidebar? in-line banner?); dismissal vs. always-on; multi-session continuity (does narration update mid-session?); coordination with Conductor's brain.log.jsonl (recent brain decisions could be part of the narration).

**Dependency on #2**: this item is much cleaner if the project cursor file (#2) lands first — narration becomes "render the cursor file as plain prose." Without #2, narration has to invent its own data aggregation.

## Cross-item dependency map

```
Foundation tier (potentially standalone):
  #1 Cross-card memory       — archive-layout work; no Frame C deps
  #3 Drift detection         — daemon-level guard; no Frame C deps
  #4 Severity-gating         — card model evolution; no Frame C deps

Coordination tier:
  #2 Project-wide cursor file — foundation for #6 narration

Polish-dependent tier (waits on post-Phase-30 polish):
  #5 Halt taxonomy expansion — needs polish item #5 (UI rendering of
                                Phase 30's new SSE events) to land first
  #6 Session-start narration — depends on #2 (cursor file); could ship
                                without it but data-aggregation work
                                would duplicate #2 effort
```

## Open Questions

(Will be settled during per-item `/relay-brainstorm` sessions.)

1. **Priority ordering**: which Frame C item is most operator-painful right now? Cross-card memory was cited as most-requested in Frame B brainstorm; verify this is still operator's lean.
2. **Multi-phase commitment**: each item is potentially a multi-phase undertaking. Operator needs to decide: ship one Frame C item completely (1-3 phases of focused work), or sample across multiple to validate direction?
3. **Frame C-as-cluster vs. Frame C-as-loose-bundle**: do these items share enough architecture (cross-card / project-layer) to warrant a unified Frame C cluster brainstorm, or do they each get their own standalone brainstorm? Lean: standalone each, with this aggregator as the cross-reference.
4. **Interaction with Frame B follow-ups**: some Frame C items (e.g., session-start narration) overlap with Frame B's polish surface. Coordinate brainstorm scoping to avoid double-work.
5. **External integrations**: cross-card memory could integrate with external search (e.g., a sidecar embedding store) or stay file-system-only. Decide per-item.

## Out of scope

- The post-Phase-30 polish bundle (separate brainstorm at `.relay/features/post-phase-30-polish_brainstorm.md`).
- Anything that's a continuation of Frame B per-card surfaces (those would be Frame B v2, not Frame C).
- Anything that's Conductor-engine-internal (orchestrator-core extensions, executor improvements, etc.) — those are dual-driver v2, not Frame C.

## Next

For each seed item, run **`/relay-brainstorm <item-slug>`** to explore in depth:

- `/relay-brainstorm cross-card-memory`
- `/relay-brainstorm project-wide-cursor-file`
- `/relay-brainstorm drift-detection-ui-vs-disk`
- `/relay-brainstorm severity-gated-cost-at-card-level`
- `/relay-brainstorm autonomy-halt-conditions-expansion`
- `/relay-brainstorm session-start-narration-on-ui-load`

**Bias**: brainstorm one at a time; each item is meaty enough that bundling brainstorms would muddy the design. Ship items in operator-priority order rather than as a forced cluster.

**Recommended starting point**: `cross-card-memory` (most-requested per Frame B context) OR `project-wide-cursor-file` (foundation for #6 narration; likely most-leveraged across the cluster).

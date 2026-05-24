# Feature: Dual-Driver Observer-Advisor

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

When LLM is not the lead, it runs in OBSERVER mode: watches the operator's actions via SSE + substrate-mtime polling, calls `decide()` in advisory-only mode when an action looks out-of-sequence, and publishes typed `advise`-action decisions to telemetry without executing. No side effects beyond the advisory event publish. Bounded LLM-call rate via heuristic pre-filter.

## Motivation

From the brainstorm's Approach C definition: "the non-lead WATCHES state transitions via SSE + substrate. When the lead does something out-of-sequence or surprising, the observer publishes an advisory event (typed; non-blocking; surfaced in telemetry)."

Without this, the dual-driver model collapses to "two siloed drivers" — operator drives blindly while brain sleeps. The observer makes the dual-driver model *symmetric*: the non-lead is always reasoning about state, ready to advise. Critical for the operator's framing of "the brain should be able to diff the changes the user made... and re-evaluate" — that's reconciliation (feature #4) which fires ON lead-handoff. The observer fires CONTINUOUSLY during the operator's session for in-the-moment advisories.

Cost concern from brainstorm Q5: "every state transition triggers an LLM call to check 'is this out-of-sequence?' That's expensive." This feature designs the heuristic pre-filter so most actions are cheap-rejected before any LLM call fires.

## Design

### Architecture

**New module**: `src/orchestrator/observer.ts`. Sibling to `core.ts`. Reuses `decide()` from feature #1; constraint: observer calls `decide()` with `lead: 'human'` (because the OPERATOR is the lead — the observer is the LLM in non-lead role). The decision is returned but the caller (observer dispatch) treats `advise`-action decisions specially: publishes as advisory event; ignores other action kinds (an observer doesn't `call-op` or `advance-column` — that would violate lead semantics).

**Heuristic pre-filter** (the rate-limit + cost-control): before calling `decide()` on any observed action, the observer runs a fast deterministic check: "does this action match any KNOWN out-of-sequence pattern?" If yes → call `decide()` for the advisory rationale. If no → no LLM call; observer stays silent.

```
src/orchestrator/
├── core.ts            # (existing from #1)
├── snapshot.ts        # (existing from #1)
├── prompt.ts          # (existing from #1)
├── types.ts           # (existing from #1)
├── observer.ts        # NEW: observer-mode dispatch + heuristic pre-filter
├── observer-rules.ts  # NEW: heuristic rule registry; pure functions over CardSnapshot
└── index.ts           # (re-exports updated)
```

**Why pre-filter as a separate module**: the rules are pure functions over `CardSnapshot` + the observed event; they're easy to test in isolation; adding a new rule doesn't touch the dispatch logic. The rules are the COST-CONTROL anchor — every rule that fires is one LLM call; we keep them tight and stable.

### Interfaces

#### Observer dispatch

```typescript
// src/orchestrator/observer.ts

import type { EventBus } from '../daemon/event_bus.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import type { ProjectConfig } from '../config/schema.js';
import type { ModelAdapter } from '../adapters/adapter.js';

export interface ObserverArgs {
  repo: string;
  runtime: RuntimeStore;
  bus: EventBus;
  config: ProjectConfig;
  adapter: ModelAdapter;
  /** Optional rate-limit override; default 1 advisory per card per 5 seconds. */
  rateLimitMs?: number;
}

export interface Observer {
  /** Starts watching; subscribes to bus events. Returns unsubscribe. */
  start(): () => void;
  /** Status snapshot for telemetry. */
  status(): { running: boolean; cardsObserved: number; advisoriesPublished: number; suppressed: number };
}

export function makeObserver(args: ObserverArgs): Observer;
```

**Behavior**:
- On `start()`: checks lead via `getLead(runtime)` (feature #2). If lead is `'llm'` → observer is a no-op (subscribes but never fires; the brain is leading, not the operator). If lead is `'human'` → observer is active.
- Observer subscribes to bus events: `transition`, `cards-changed`, `lead-handed-off` (to flip its active state when lead changes).
- On each observable event, observer:
  1. Calls the heuristic pre-filter (`observer-rules.ts:matchOutOfSequence`).
  2. If pre-filter returns a non-empty match list, calls `decide()` from feature #1 with `lead: 'human'` + the matched rules' context in `userMessage`.
  3. If `decide()` returns `action === 'advise'`, publishes an `observer-advisory` SSE event with the rationale + severity.
  4. Else (any other action kind): the observer SUPPRESSES the decision (logged at debug; not published). Observer doesn't execute anything other than advisories.

#### Pre-filter rules

```typescript
// src/orchestrator/observer-rules.ts

import type { CardSnapshot } from './snapshot.js';
import type { Column } from '../engine/types.js';

export interface ObservedEvent {
  kind: 'transition' | 'cards-changed' | 'card-body-edited' | 'substrate-written';
  cardId: string;
  /** For transitions. */
  from?: Column;
  to?: Column;
  /** For substrate writes (e.g. operator manually ran an op). */
  op?: string;
  /** For body edits (delta from previous). */
  bodyDeltaSize?: number;
}

export interface RuleMatch {
  ruleId: string;
  description: string;
  /** Severity hint for the advisory; orchestrator may override. */
  suggestedSeverity: 'info' | 'warn';
}

export type Rule = (snapshot: CardSnapshot, event: ObservedEvent) => RuleMatch | null;

export const OBSERVER_RULES: Rule[];
export function matchOutOfSequence(snapshot: CardSnapshot, event: ObservedEvent): RuleMatch[];
```

**Initial rule set (v1)** — each rule is a small pure function. The list is small and additive:

| Rule ID | Trigger | Description |
|---|---|---|
| `column-without-substrate` | `transition` event to a column that should have substrate from upstream ops, but that substrate is missing | e.g. `verifying` without any `verify.md`; `approved` without `review.md` |
| `body-edit-after-plan` | `card-body-edited` event on a card with `plan.md` substrate | "you edited the body; the plan may be stale" |
| `manual-substrate-bypass` | `substrate-written` event for an op that doesn't match the card's column | e.g. operator manually re-ran `analyze` on a card in `building` |
| `backward-transition-with-orphans` | `transition` event going backward (per feature #5's widened state machine) where forward substrate exists | e.g. `building → planned` with `implement.md` substrate present |
| `archived-touched` | any `transition` or `card-body-edited` event on a card in `archived` | "this card is archived; this edit will not flow through any op" |
| `idle-discovered` | card sits in `discovered` for > N hours (configurable; default 24h) | "this card hasn't moved; want me to start analyzing?" |

Rules are EXTENSIBLE — feature #5 (state-machine widen) may add rules; feature #9 (chat wire) may add UI-specific rules. Schema is open via the `OBSERVER_RULES` array; new rules go through code review like any other module.

#### SSE event shape

```typescript
// src/daemon/event_bus.ts: extend DaemonEvent union

| {
  kind: 'observer-advisory';
  cardId: string;
  rationale: string;
  severity: 'info' | 'warn';
  ruleId: string;          // Which heuristic rule fired
  decisionRunId?: string;   // If observer chose to persist via 'orchestrate' artifact, the runId
  ts: string;
}
```

UI subscribes; advisories surface in:
- Card Detail's "Advisor" badge/section (NEW; small addition to the side panel).
- Monitor view: scrolling advisory log alongside brain log.
- Optionally: toast notification on `severity: 'warn'`.

#### Rate limiting

Per-card rate limit: at most one observer advisory per card per `rateLimitMs` (default 5000ms). Implemented as a simple `Map<cardId, lastAdvisoryTs>` in the Observer instance. Prevents spam if operator rapidly edits or moves a card.

Plus a GLOBAL CALL CEILING: at most `config.orchestrator.observer_max_calls_per_minute` (default 30) — hard cap on LLM calls per minute across all cards. If hit, observer logs "ceiling reached; suppressing advisories for N seconds" and resumes after a cooldown.

### Data Flow

**Operator drags card 2026-05-23-X from `building` to `verifying` in the UI; brain is paused (lead is human).**

1. Board drag-drop handler calls `transition` RPC; daemon updates frontmatter; publishes `transition` event on bus.
2. Observer (active because lead is `'human'`) receives the event.
3. Observer checks rate-limit for card X: last advisory was 10 minutes ago → passes.
4. Observer calls `matchOutOfSequence(snapshotForX, {kind: 'transition', cardId: 'X', from: 'building', to: 'verifying'})`.
5. Rule `column-without-substrate` runs: checks if X has `verify.md` artifact. It doesn't (operator skipped the verify op). Rule matches with `{ruleId: 'column-without-substrate', description: 'verifying column without verify.md substrate', suggestedSeverity: 'warn'}`.
6. Observer calls `decide({repo, cardId: 'X', adapter, config, lead: 'human', userMessage: 'OPERATOR TRANSITIONED X: building → verifying. Rule fired: column-without-substrate. Generate advisory.'})`.
7. `decide()` returns `{action: 'advise', rationale: 'You moved X to verifying, but verify.md is missing — the build might not have been validated. Want me to run verify first?', confidence: 0.85, params: {severity: 'warn', message: 'You moved X to verifying, but verify.md is missing — the build might not have been validated. Want me to run verify first?'}}`.
8. Observer publishes `observer-advisory` SSE event with rationale + severity + ruleId.
9. UI surfaces the advisory in Card Detail's advisor section AND as a Monitor view log line AND (per severity warn) as a small toast.
10. Operator either: (a) ignores; (b) clicks "OK, run verify" → triggers the `verify` op manually; (c) clicks "I know, suppress" → suppresses this card's advisories for the session.

**Operator presses Enter rapidly on the board (10 transitions in 2 seconds).**

1-3. Same as above for first transition.
4. Observer publishes advisory if a rule matches.
5. Second transition arrives; observer checks rate-limit: last advisory was 0.2 seconds ago → SUPPRESSED. Status counter `suppressed += 1`. No LLM call.
6. ... continues for the remaining 8 transitions.
7. After 5 seconds, the rate-limit window opens; next rule-matching transition triggers a fresh LLM call.

**Brain takes lead (lead-handed-off event fires).**

1. Observer receives `lead-handed-off` event with `current: 'llm'`.
2. Observer immediately flips to inactive state. Stops subscribing to action-events (still listens for `lead-handed-off` to flip back).
3. Status counter `running: false`.

### Integration Points

- **`src/orchestrator/observer.ts`** — new module; main consumer.
- **`src/orchestrator/observer-rules.ts`** — new module; pure rule functions.
- **`src/orchestrator/core.ts`** (existing from feature #1) — `decide()` is called by observer with `lead: 'human'` and a synthetic `userMessage` describing the matched rule. The prompt's lead-aware framing produces advisory-shaped output (`action: 'advise'`).
- **`src/daemon/event_bus.ts`** (modified) — `observer-advisory` event kind added; observer publishes via bus.
- **`src/daemon/runtime.ts`** (modified) — observer reads lead via `getLead(runtime)` from feature #2.
- **`src/daemon/sse.ts`** (modified) — `observer-advisory` event passes through SSE fan-out (no special handling; standard kind).
- **`src/config/schema.ts`** (modified) — new `orchestrator.observer_max_calls_per_minute` config key (default 30).
- **`src/daemon/index.ts`** (or wherever daemon startup is) — instantiate `makeObserver(...)` and call `observer.start()` on daemon boot. Pass to RPC context for status access.
- **`src/ui/views/monitor.ts`** (modified) — advisory log section alongside brain log.
- **`src/ui/views/card_detail.ts`** (modified) — advisor section in the side panel (small addition; Frame B Feature #1's redesign may absorb).
- **`tests/orchestrator/observer.test.ts`** (new) — observer dispatch behavior; rate limiting; lead-state-aware activation.
- **`tests/orchestrator/observer-rules.test.ts`** (new) — each rule's match conditions; pure-function semantics.

## Affected Files

**New files:**
- `src/orchestrator/observer.ts`
- `src/orchestrator/observer-rules.ts`
- `tests/orchestrator/observer.test.ts`
- `tests/orchestrator/observer-rules.test.ts`

**Modified files:**
- `src/orchestrator/index.ts` — re-export observer surface.
- `src/daemon/event_bus.ts` — `observer-advisory` event kind.
- `src/daemon/runtime.ts` — observer instance lives alongside conductor.
- `src/config/schema.ts` — `orchestrator.observer_max_calls_per_minute` config key + defaults.
- `src/daemon/index.ts` (or daemon-startup wiring file) — instantiate + start observer.
- `src/ui/views/monitor.ts` — advisory log section.
- `src/ui/views/card_detail.ts` — advisor section in side panel.
- `tests/config/schema.test.ts` (if exists) — new config key default test.

## Dependencies

- **Feature #1** (`dual-driver-orchestrator-core.md`) — calls `decide()` for advisory generation; reuses `buildSnapshot`.
- **Feature #2** (`dual-driver-lead-follow-protocol.md`) — reads `getLead(runtime)`; subscribes to `lead-handed-off` to flip active/inactive.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #4 (`lead-handoff-reconciliation`) — complementary: observer fires DURING operator session; reconciliation fires ON lead-handoff. Same `decide()` engine; different invocation patterns.
  - #5 (`backward-transitions-and-substrate-advisory`) — feature #5 may add observer rules for backward-transition scenarios. Initial rule `backward-transition-with-orphans` is here; #5 may refine.
  - #6 (`brain-loop-replacement`) — observer only runs when brain isn't leading; the two mutually exclude (per lead state).

## Development Order

**3 of 9** — build third. Requires #1 (orchestrator-core) for `decide()`; requires #2 (lead-follow-protocol) to know when to activate. Can be designed in parallel with #2. Useful first product win for the dual-driver model: ships observer mode (advisories in UI) before the brain-loop replacement (feature #6) lands. Operators get value from "LLM is watching" before the full brain rewrite.

## Open Questions

1. **`card-body-edited` and `substrate-written` event sources**: the existing daemon publishes `cards-changed` (broad — fires when any card file mtime changes) and `task-event` (per-op SSE during a run). Neither directly emits a granular "body-edited" or "manual-substrate-written" event. Options: (a) extend the daemon to emit these (chokidar watcher already polls the cards dir; small extension to also poll `.conductor/runs/`); (b) observer subscribes to `cards-changed` and runs a heuristic diff to derive body-edited; (c) chokidar polling is too noisy — debounce. Lean: (a) with debouncing. Defer detail to /relay-plan.

2. **Rule extensibility**: should rules be declared in code (TypeScript modules) or in config (`.conductor/observer-rules.yaml`)? Config-based would let operators add project-specific rules without code changes; code-based is type-safe + testable. Lean: code-based for v1; config-based as a v2 extension if dogfood surfaces demand.

3. **Advisory persistence**: should advisories be persisted to substrate (`<runId>/observer-advisory.md`) or only published as transient SSE events? Persistence enables Card Detail to show "past advisories for this card" + supports a history surface (Frame B Feature #6 candidate). Lean: persist if the decision is non-trivial (cost > 0 — i.e. an LLM call fired). Skip persistence for pre-filter-only matches. Defer to /relay-plan.

4. **Pre-filter false-positive rate**: how often do rules fire on actions that are FINE? E.g., `column-without-substrate` fires on a card that's `verifying` without `verify.md` — but maybe the operator legitimately moved it there for triage, and verify.md will be written later. Lean: tune by dogfood; false-positives are cheap (one LLM call, one advisory the operator can dismiss); false-negatives are worse (we missed an important advisory). Initial rule set errs toward firing.

5. **Per-card advisory suppression UI**: "I know about this rule; stop advising on this card" — where does the suppression state live? Card frontmatter `observer_suppressions: ['column-without-substrate']`? Runtime store (per-session)? Or a project-config rule-disable mechanism? Lean: per-session in runtime store (operator clicks "suppress for now"; reset on daemon restart). Persistent suppression is a heavier feature; defer.

6. **Observer interaction with cost ceilings**: observer's LLM calls consume budget. Should observer calls hit the same per-card / per-project cost ceiling as the brain loop's orchestrator calls? Lean: yes, unified ceiling — cost is cost. Cost guard's existing per-card tracking extended to include observer calls. Feature #7 (autonomy-spectrum-config) is the natural home for the ceiling-vs-mode tuning.

7. **Brain-lead observer**: this design says observer is INACTIVE when brain leads. Should there be a SYMMETRIC observer when brain is leading — the human watches the brain's actions and the system prompts the human if the brain does something unexpected? Lean: NO for v1. The operator can always intervene via lead transfer; surfacing brain actions via the existing telemetry (Monitor view's brain log + per-card SSE) is enough. The reconciliation pass (feature #4) covers "operator catches up after brain ran." Adding a "human observer" surface is feature creep for v1.

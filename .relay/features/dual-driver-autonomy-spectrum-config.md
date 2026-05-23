# Feature: Dual-Driver Autonomy Spectrum Config

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)*
*Status: DESIGNED*

## Summary

Replace the existing `autonomy.transitions.*` per-edge config (each transition is `manual | assist | auto`) with a unified `autonomy: assist | hybrid | autonomous` spectrum (project default + per-card override). The orchestrator's executor (feature #6) reads the active mode to decide EXECUTE | SURFACE_TO_OPERATOR per decision. Provides a backward-compat migration path for existing dogfood configs (`autonomy.transitions.*` shape auto-maps to the new spectrum at config-load time, with a deprecation warning).

## Motivation

Per brainstorm Decision #4: "the system supports a SPECTRUM of autonomy not a single global setting. Three named modes (config-selectable per-card via `autonomy: assist | hybrid | autonomous`, with `default` in project config)." The existing config is too granular for the orchestrator-driven model — the orchestrator decides which op to call, when to advance, when to halt; tuning "the policy for the `discovered_to_planned` transition specifically" doesn't fit that decision model. The spectrum is the right shape: tunes the orchestrator's risk tolerance per card.

The executor in feature #6 reads this config to gate its dispatch decisions. Without this feature, the executor has no way to know whether to auto-execute or surface-to-operator — has to hardcode one mode.

## Design

### Architecture

**Modify the existing config schema** at `src/config/schema.ts`. Add a new `autonomy` shape; keep the OLD `autonomy.transitions.*` shape as a deprecated input format that auto-maps at load time.

```typescript
// src/config/schema.ts (modified)

// NEW canonical shape:
export const AutonomyModeSchema = z.enum(['assist', 'hybrid', 'autonomous']);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const AutonomyConfigSchema = z.object({
  /** Project default; per-card frontmatter `autonomy` can override. */
  default: AutonomyModeSchema.default('hybrid'),

  /** Auto-approve threshold for hybrid mode. Decisions with
   *  confidence >= threshold auto-execute; below threshold surface
   *  to operator. Default 0.7. */
  hybrid_confidence_threshold: z.number().min(0).max(1).default(0.7),

  /** Per-mode budgets (orchestrator decision calls per card per session). */
  budgets: z.object({
    assist: z.object({
      orchestrator_calls_per_card: z.number().int().positive().default(50),
      observer_calls_per_minute: z.number().int().positive().default(30),
    }).default({}),
    hybrid: z.object({
      orchestrator_calls_per_card: z.number().int().positive().default(30),
      observer_calls_per_minute: z.number().int().positive().default(20),
    }).default({}),
    autonomous: z.object({
      orchestrator_calls_per_card: z.number().int().positive().default(15),
      observer_calls_per_minute: z.number().int().positive().default(10),
    }).default({}),
  }).default({}),

  // DEPRECATED — backward-compat input. Detected at load; mapped to spectrum;
  // warning logged. Removed in a future major version.
  transitions: z.record(z.string(), z.enum(['manual', 'assist', 'auto'])).optional(),
});
```

**Per-card override** via card frontmatter (existing `CardFrontmatterSchema.autonomy` field; already `z.enum(['inherit', 'manual', 'assist', 'auto'])` per relay-config notes). Widen to include the new modes:

```typescript
// src/config/schema.ts (CardFrontmatter modification)

autonomy: z.enum(['inherit', 'assist', 'hybrid', 'autonomous',
                   // legacy values; auto-mapped at read time:
                   'manual', 'auto']).default('inherit'),
```

`'manual'` legacy → maps to `'assist'`. `'auto'` legacy → maps to `'autonomous'`. `'assist'` legacy = `'assist'` new (compatible). `'inherit'` = use project default.

### Interfaces

#### Mode resolution helper

```typescript
// src/conductor/lead.ts or src/conductor/autonomy.ts (new sibling module)

import type { ProjectConfig } from '../config/schema.js';
import type { Card } from '../engine/types.js';
import type { AutonomyMode } from '../config/schema.js';

/** Resolve the effective autonomy mode for a card: card override (if not
 *  'inherit') wins; otherwise project default. Maps legacy values to spectrum. */
export function effectiveAutonomy(card: Card, config: ProjectConfig): AutonomyMode;

/** Read the executor's gating threshold for a mode. */
export function autoExecuteThreshold(mode: AutonomyMode, config: ProjectConfig):
  | { kind: 'always-execute' }
  | { kind: 'threshold'; minConfidence: number }
  | { kind: 'always-surface' };
```

**Mode → executor gate**:
- `autonomous` → `'always-execute'` (executor never surfaces; just executes the orchestrator's decisions).
- `hybrid` → `'threshold'` with `minConfidence` from `config.autonomy.hybrid_confidence_threshold`. Decision with confidence >= threshold executes; below surfaces.
- `assist` → `'always-surface'` (every decision pauses for operator approval; the existing `pending-decision` event flow from feature #6).

#### Cost guard integration

`src/conductor/cost_guard.ts` (modified — was Phase pre-28 infrastructure) reads the per-mode budgets and enforces per-card ceilings. Existing per-card cost ceilings (the dollar/token ones) compose AND with the new orchestrator-call-count ceiling — both must pass for a decision to proceed.

```typescript
// src/conductor/cost_guard.ts (modified)

export function checkOrchestratorCallCeiling(
  config: ProjectConfig,
  runtime: RuntimeStore,
  cardId: string,
  mode: AutonomyMode,
): { ok: true } | { ok: false; reason: string };
```

#### Config migration

```typescript
// src/config/load.ts (modified)

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  const raw = await readFile(path);
  const parsed = parseYaml(raw);

  // Detect legacy shape:
  if (parsed.autonomy?.transitions && !parsed.autonomy?.default) {
    // Migrate legacy → spectrum
    const mappedMode = inferModeFromTransitions(parsed.autonomy.transitions);
    parsed.autonomy = {
      default: mappedMode,
      hybrid_confidence_threshold: 0.7,
      budgets: {},
      transitions: parsed.autonomy.transitions, // preserved for compat
    };
    console.warn(`[autonomy] DEPRECATED: autonomy.transitions config detected; mapped to autonomy.default = '${mappedMode}'. Update your config.yaml to use the new spectrum shape; see docs/autonomy.md.`);
  }

  return ProjectConfigSchema.parse(parsed);
}

/** If most transitions are 'auto', infer 'autonomous'; if mostly 'assist',
 *  infer 'hybrid'; if mostly 'manual', infer 'assist'. */
function inferModeFromTransitions(transitions: Record<string, string>): AutonomyMode;
```

### Data Flow

**Orchestrator iter on a card with `autonomy: hybrid` (default):**

1. Loop calls `decide()` → returns `{action: 'call-op', confidence: 0.85, ...}`.
2. Executor reads `effectiveAutonomy(card, config)` → `'hybrid'`.
3. Executor reads `autoExecuteThreshold('hybrid', config)` → `{kind: 'threshold', minConfidence: 0.7}`.
4. Decision confidence 0.85 >= threshold 0.7 → EXECUTE.
5. Op fires; substrate writes; column advances; event publishes.

**Orchestrator iter on a card with `autonomy: assist`:**

1. Loop calls `decide()` → returns `{action: 'call-op', confidence: 0.95, ...}`.
2. Executor reads `effectiveAutonomy(card, config)` → `'assist'`.
3. Executor reads `autoExecuteThreshold('assist', config)` → `{kind: 'always-surface'}`.
4. Executor publishes `pending-decision` event (per feature #6).
5. Operator sees decision in UI; approves → execution proceeds.
6. Operator rejects → loop's next iter re-decides; orchestrator sees the rejection in recent events; produces a different decision.

**Orchestrator iter on a card hitting the budget ceiling:**

1. Loop calls `checkOrchestratorCallCeiling(config, runtime, cardId, mode)` BEFORE `decide()`.
2. Returns `{ok: false, reason: 'orchestrator_calls_per_card budget exhausted (30/30) for hybrid mode'}`.
3. Loop publishes `conductor-halt` with reason; transfers lead to human; suggests operator extends budget or marks card complete.

### Integration Points

- **`src/config/schema.ts`** (modified) — new `AutonomyConfigSchema`; widened `CardFrontmatterSchema.autonomy`.
- **`src/config/load.ts`** (modified) — legacy-config migration at load time.
- **`src/conductor/autonomy.ts`** (new — or add to existing `lead.ts`) — `effectiveAutonomy` + `autoExecuteThreshold` helpers.
- **`src/conductor/cost_guard.ts`** (modified) — orchestrator-call-count ceiling check.
- **`src/conductor/loop.ts`** (modified — coordinated with feature #6) — calls `checkOrchestratorCallCeiling` before `decide()`.
- **`src/conductor/executor.ts`** (from feature #6) — reads autonomy mode + threshold to gate execute-vs-surface.
- **`src/orchestrator/core.ts`** (existing from #1) — `assemblePrompt` may include the active autonomy mode in the user prompt so the orchestrator's framing matches ("you can act directly" vs. "you should recommend"). Defer the prompt detail to /relay-plan.
- **`tests/config/schema.test.ts`** (modified) — new spectrum-config tests.
- **`tests/config/load.test.ts`** (or new) — legacy-config migration tests.
- **`tests/conductor/autonomy.test.ts`** (new) — `effectiveAutonomy` + threshold helpers.

## Affected Files

**New files:**
- `src/conductor/autonomy.ts` (or merge into `lead.ts` per layout preference)
- `tests/conductor/autonomy.test.ts`

**Modified files:**
- `src/config/schema.ts` — new shape + widened card frontmatter enum.
- `src/config/load.ts` — legacy migration.
- `src/conductor/cost_guard.ts` — orchestrator-call ceiling.
- `src/conductor/loop.ts` (coordinated with feature #6) — budget check pre-decide.
- `src/conductor/executor.ts` (coordinated with feature #6) — gating logic.
- `tests/config/schema.test.ts` — new test cases.
- `tests/config/load.test.ts` — migration test cases.

## Dependencies

- **Feature #1** (`orchestrator-core`) — informs the decision confidence value the threshold reads against.
- **Feature #6** (`brain-loop-replacement`) — executor consumes the mode + threshold to gate dispatch.
- **Brainstorm:** [dual-driver-orchestration_brainstorm.md](dual-driver-orchestration_brainstorm.md)
- **Related features (siblings from same brainstorm):**
  - #3 (observer) — observer budget (`observer_calls_per_minute`) comes from this feature's per-mode budgets.
  - #4 (reconciliation) — reconciliation budget (`max_reconciliation_calls_per_handoff`) sits alongside this feature's budgets; consider unifying into `config.autonomy.budgets.<mode>.reconciliation_calls_per_handoff` for symmetry.

## Development Order

**7 of 9** — independently shippable; can ship in parallel with #1-#6. Required before #6's executor can do anything other than always-execute. Backward-compat migration is a v1 concern (preserve existing dogfood configs); no breaking change to existing projects.

## Open Questions

1. **Default mode**: brainstorm Decision #4 recommends `hybrid` as the default. Confirm: a brand-new `conductor init` writes `autonomy.default: hybrid`. Existing projects with legacy `autonomy.transitions.*` shape get migrated to `hybrid` unless their transitions strongly suggest `autonomous` (all `auto`) or `assist` (mix of `manual`/`assist`).

2. **Confidence threshold tuning**: `hybrid_confidence_threshold: 0.7` is a guess. The orchestrator's confidence scoring needs calibration — what does 0.7 mean in practice? Defer to dogfood: operator tunes after seeing real decisions' confidences.

3. **Reconciliation budget placement**: feature #4 puts `max_reconciliation_calls_per_handoff` at `config.orchestrator.*`. This feature puts decision/observer budgets at `config.autonomy.budgets.<mode>.*`. For consistency, reconciliation budget should ALSO move to `config.autonomy.budgets.<mode>.reconciliation_calls_per_handoff`. Coordinate with feature #4 design at /relay-plan time.

4. **Per-card budget override**: card frontmatter `autonomy: assist` overrides the mode, but doesn't override the budgets. Should it? Per-card budget overrides feel rare-but-possible (e.g., "this is a big card; give me 50 orchestrator calls"). Lean: defer; project-level + mode-level budgets are sufficient for v1.

5. **Migration UX**: the load-time deprecation warning logs to console. Operators may miss it. Should `conductor` CLI surface the warning more prominently (e.g., on every command run, until config is migrated)? Lean: console warning at daemon start is enough; over-prompting is annoying.

6. **Schema versioning for autonomy config**: when the spectrum config evolves (new modes, new budgets), should we version the config? Lean: not yet; the existing `ProjectConfigSchema.strict()` enforces shape at parse time; backward-compat is handled by the load-time mapper.

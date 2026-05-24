# Feature: Dual-Driver Autonomy Spectrum Config

*Created: 2026-05-23*
*Brainstorm: [dual-driver-orchestration_brainstorm.md](../../features/dual-driver-orchestration_brainstorm.md)*
*Status: **RESOLVED 2026-05-24** — see [implementation doc](../../implemented/dual-driver-autonomy-spectrum-config.md)*

> **Resolution banner**: Shipped as commit `dc2dde2 feat(30.7): dual-driver autonomy spectrum config + legacy migration` in Control phase 30.7. Spectrum 3-mode enum (`assist | hybrid | autonomous`) at project default level + per-mode budgets + legacy migration via schema preprocess + new `src/conductor/autonomy.ts` helpers. Card-frontmatter `AUTONOMY_MODES` enum kept additive (legacy + spectrum). 945 → 966 tests (+21). Unblocks #62 frame-b-chat-wire (1 in-cluster dependent).

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

## Analysis

*Analyzed: 2026-05-24*

**Spec health**: applies cleanly with one major adaptation — the existing codebase's `AUTONOMY_MODES = ['inherit', 'escort', 'assist', 'auto', 'critical']` is consumed across `conduct.ts` (5 modes literal), `loop.ts:effectiveMode()`, `cli/autonomy.ts` (4 modes hard-coded), `mcp_server.ts` description string, `ui/views/routing.ts` (4 modes hard-coded), and 945 tests. The spec proposes a new project-level spectrum `['assist', 'hybrid', 'autonomous']` distinct from card-frontmatter autonomy (which keeps `'inherit'`). This is implemented as **two separate enums** — `AutonomyMode` (project spectrum) and `Autonomy` (card frontmatter, widened to include both legacy and new values) — with bridge mappers preserving existing dogfood configs.

### Related work findings (Explore-equivalent scan summary)

- **`src/engine/ops/conduct.ts`** (lines 13, 30-63): `ConductMode = 'escort' | 'assist' | 'auto' | 'critical'` is the actual decision engine, called from `loop.ts:163`. The new spectrum maps to ConductMode for backward-compat: `assist → 'assist'`, `hybrid → 'auto'` (with threshold), `autonomous → 'auto'` (always-execute via threshold=0). Keeps `conduct.ts` signature stable; the new helpers live in `src/conductor/autonomy.ts`.
- **`src/conductor/loop.ts:211-215`** (`effectiveMode`): currently does `if def === 'inherit' return 'assist'; return def as ConductMode`. Must change to call new spectrum-aware helper.
- **`src/conductor/cost_guard.ts`**: spec proposes adding `checkOrchestratorCallCeiling` here, but the runtime store has no per-card orchestrator-call counter yet (would require a new runtime API). Deferred per Implementation Deviation #4 below.
- **`src/cli/commands/autonomy.ts:16`**: hard-coded `['escort', 'assist', 'auto', 'critical']` validation list — must accept new spectrum + map legacy with deprecation warning.
- **`src/ui/views/routing.ts:117-121`**: dropdown options hard-coded for 4 legacy modes — must show 3 new spectrum modes (legacy accepted via paste-edit only).
- **`src/cli/commands/init.ts:59-67`**: default config template emits `autonomy.transitions.*` block — must emit new spectrum shape.
- **`src/daemon/mcp_server.ts:46`**: tool description string lists `(escort | assist | auto | critical)` — update.
- **`src/orchestrator/prompt.ts:102`**: serializes `Autonomy: ${snapshot.card.frontmatter.autonomy}` — passes through the card-level enum (still includes `'inherit'`); no change needed.
- **`src/importer/control.ts:79`** and **`src/importer/relay.ts:78`**: set card frontmatter `autonomy: 'inherit'` — unchanged.
- **`src/engine/lifecycle.ts:71-81`** (`transitionPolicy`): reads `config.autonomy.transitions[`from_to_to`]`. Kept around as a thin legacy-shim that returns `'auto'` for the new spectrum (orchestrator-driven dispatch obsoletes per-edge policy — see #58 widen). UI consumers `board.ts:50` and `board_dnd.ts:71` likewise return a flat fallback. The `TransitionPolicy = 'manual' | 'assist' | 'auto'` type remains since it's a UI/dialog contract.
- **Tests**: `tests/rpc/conductor_methods.test.ts:81-94` exercises `conductor_set_autonomy` with mode `'auto'` — must accept legacy with map or update to `'autonomous'`.

### Historical patterns / caveats

- **Phase 23 #24/#27 (`ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults`)**: deep-merge for `config_set` already lands at `rpc/methods.ts:302`. Spectrum-config patches via `conductor_set_autonomy` flow through this merge cleanly.
- **`replaceAutonomyDefault` pure helper** (`src/ui/views/routing.ts:25`): operates on whatever string the user types; widens transparently — no change required since the regex matches any non-whitespace value.
- **Phase 30.6 #58 widen** (`lifecycle.ts`): `BACKWARD` allowlist removed; `canTransition` simplified to `from !== to`. The `transitions.*` block in config no longer gates transitions; orchestrator decides via `decide()`. So `autonomy.transitions.*` is already vestigial — this feature's removal is consistent.
- **Phase 30.5 ADR scope discipline memory**: pure-helper extraction pattern advance recorded inline rather than as new ADR.

### Regression-risk flags

- **R1**: `conduct.ts` is called from `loop.ts:163`. Test surface ~16 cases across `tests/engine/ops/conduct.test.ts` and `tests/conductor/loop.test.ts`. Bridging the new spectrum → ConductMode must preserve all 4 existing semantic behaviors (escort → escalate-always; assist → blast-radius+threshold; auto → threshold; critical → halt-on-low-conf).
- **R2**: `cli/autonomy.ts` validation list breaks if a user runs `conductor autonomy set critical` after the change. Solution: accept legacy values with deprecation warning, map at write-time.
- **R3**: `conductor_set_autonomy` RPC handler — used by UI routing dropdown + MCP tool. Must accept legacy + new.
- **R4**: `init.ts` default template: changing the YAML shape means freshly-init'd projects look different. Existing init tests at `tests/cli/init.test.ts` may snapshot the template — verify and update.
- **R5**: `routing.ts` UI dropdown options hard-coded to legacy 4. Must show new 3 + add a "(legacy)" footnote or similar.
- **R6**: `replaceAutonomyDefault` regex assumes single-token values. Stays compatible since new modes are also single tokens.

### Scope Decision (Rubric)

Findings = MEDIUM (legacy-config migration is part of the design; CLI/UI/init updates are necessary collateral; no out-of-scope same-root-cause additions surfaced). Rubric → **keep narrow** (single root cause: spectrum-config introduction; legacy migration is explicit feature scope).

## Implementation Plan

*Planned: 2026-05-24*

**Approach**: introduce the new spectrum enum + per-mode budgets alongside the existing card-frontmatter enum (widened to include new spectrum values for symmetry). Schema preprocess detects legacy `autonomy.transitions.*` config at load and rewrites it to spectrum shape with a deprecation warning. New helpers in `src/conductor/autonomy.ts` resolve effective mode + executor threshold. Legacy mappers preserved at every boundary (CLI, RPC, UI dropdown) to keep dogfood configs working.

**Coordination with feature #6 (`brain-loop-replacement`)**: not yet shipped. This feature ships the autonomy.ts helpers + spectrum-config + threshold readers. The future executor will consume them; v1 has no live executor caller of `autoExecuteThreshold` — it's a typed helper ready for #6/#59 to wire. The existing `loop.ts → conduct.ts` path bridges via `bridgeSpectrumToConductMode()` so behavior is preserved for the brain-on-by-default path.

### Step 1 — Engine types: widen autonomy enums

**Files**: `src/engine/types.ts`

- Extend `AUTONOMY_MODES` from `['inherit', 'escort', 'assist', 'auto', 'critical']` → `['inherit', 'escort', 'assist', 'auto', 'critical', 'hybrid', 'autonomous']` (additive only; legacy values preserved so existing tests + card frontmatter readers still parse).
- Add new `AUTONOMY_SPECTRUM = ['assist', 'hybrid', 'autonomous'] as const` and `AutonomyMode` type for project-level spectrum.

### Step 2 — Config schema: spectrum + budgets + legacy migration

**Files**: `src/config/schema.ts`

- Add `AutonomyModeSchema = z.enum(AUTONOMY_SPECTRUM)` exported.
- Add `AutonomyBudgetSchema` with `orchestrator_calls_per_card` + `observer_calls_per_minute`.
- Restructure `autonomy` block: `default` becomes `AutonomyModeSchema`, plus `hybrid_confidence_threshold`, `budgets.{assist,hybrid,autonomous}`. Keep `transitions` optional + deprecated for backward-compat reads.
- Add `.preprocess()` on the autonomy block that detects legacy shape (`default ∈ legacy-values` OR `transitions` present without spectrum `default`) and re-maps:
  - `'escort'` → `'assist'`
  - `'assist'` → `'assist'` (unchanged)
  - `'auto'` → `'autonomous'`
  - `'critical'` → `'autonomous'` (with note: critical's halt-on-low-conf semantic preserved at conduct.ts via `hybrid_confidence_threshold`)
  - Legacy `transitions.*` block: infer mode from majority (most `'auto'` → `'autonomous'`; mix → `'hybrid'`; mostly `'manual'`/`'assist'` → `'assist'`).
- Widen `CardFrontmatterSchema.autonomy` to use the widened `AutonomySchema` (covers both legacy and new).

### Step 3 — Loader: emit deprecation warning

**Files**: `src/config/load.ts`

- After parse, if input contained legacy shape (`transitions` block OR legacy-value default), `console.warn` once per load with a one-line deprecation pointing at spectrum docs.
- Use a flag returned from a `wasLegacyShape(input)` helper so the preprocess can stay pure.

### Step 4 — New `src/conductor/autonomy.ts` module

**Files**: `src/conductor/autonomy.ts` (new), `tests/conductor/autonomy.test.ts` (new)

- `effectiveAutonomy(card, config): AutonomyMode` — card's `autonomy` field (mapped from legacy if needed) wins unless `'inherit'`, else config default.
- `autoExecuteThreshold(mode, config)` — returns discriminated union per spec.
- `bridgeSpectrumToConductMode(mode): ConductMode` — for the existing `conduct.ts` call path. `assist → 'assist'`, `hybrid → 'auto'`, `autonomous → 'auto'`.
- `mapLegacyAutonomy(value): AutonomyMode | 'inherit'` — used by helpers and by CLI.
- 6-8 unit tests covering all branches.

### Step 5 — Loop bridge

**Files**: `src/conductor/loop.ts`

- Replace `effectiveMode()` body with `bridgeSpectrumToConductMode(effectiveAutonomy(card, config))`. Read the active card by id to get the card frontmatter. (Wrap the readCard call defensively; on read failure, fall back to project default with no card override.)

### Step 6 — CLI: accept legacy + new

**Files**: `src/cli/commands/autonomy.ts`, `src/daemon/mcp_server.ts`

- `autonomySet` validation list: include both spectrum + legacy values. On legacy value, `console.warn` deprecation and rewrite to spectrum equivalent.
- Update MCP tool description string to list spectrum modes (mention legacy aliases accepted for backward compat).

### Step 7 — Init template

**Files**: `src/cli/commands/init.ts`

- Replace `autonomy:` block in template with spectrum shape: `default: hybrid`, `hybrid_confidence_threshold: 0.7`, omit `budgets` (defaults).
- Remove `transitions.*` block.

### Step 8 — UI routing dropdown

**Files**: `src/ui/views/routing.ts`

- Replace 4 `<option>` elements with 3 spectrum modes (`assist`, `hybrid`, `autonomous`) + brief descriptions.
- Keep `replaceAutonomyDefault` and YAML serializer as-is (they're shape-agnostic at the string level).
- Update `ProjectConfigShape.autonomy` to allow optional `transitions` (backward-compat for read).

### Step 9 — Test updates

**Files**: `tests/rpc/conductor_methods.test.ts`, `tests/config/load.test.ts` (new or extend), `tests/cli/init.test.ts`, `tests/conductor/loop.test.ts`

- `conductor_set_autonomy` test: add a parallel case for `'autonomous'` (new) alongside the existing `'auto'` case which now exercises the legacy mapper.
- Add migration test: parse legacy YAML config, assert spectrum shape emerges + warning is logged (via spying on `console.warn`).
- Update `init.test.ts` if it snapshots the YAML template (verify first).
- Verify loop tests still pass after `effectiveMode` swap.

### Risk register

- **Risk**: existing dogfood configs break parse. **Mitigation**: legacy preprocess handles all 4 legacy values + the `transitions` block; integration test covers this.
- **Risk**: card frontmatter with `'critical'` autonomy doesn't auto-map. **Mitigation**: card-level autonomy stays widened (additive `AUTONOMY_MODES`); `effectiveAutonomy` calls `mapLegacyAutonomy` before returning.
- **Risk**: `conduct.ts` halt-on-low-conf semantics from `'critical'` are lost. **Mitigation**: spec OQ accepts the loss as part of the spectrum simplification; documented in caveat.
- **Risk**: tests snapshot legacy YAML template literally. **Mitigation**: snapshot search before edit.
- **Risk**: brain-loop tests (`loop.test.ts`) flake on new effectiveMode path. **Mitigation**: keep the bridge function pure + test it in isolation.

### Rollback plan

- Single commit; `git revert` returns to the legacy enum + legacy-only schema. Card frontmatter with `'hybrid'` or `'autonomous'` would fail revalidation post-revert, so revert mid-dogfood requires manual frontmatter cleanup. Low risk pre-#62.

## Implementation Deviations

*Documented: 2026-05-24*

1. **Cost-guard `checkOrchestratorCallCeiling` deferred** — spec proposes adding this in `cost_guard.ts`, but the per-card orchestrator-call counter doesn't exist in `RuntimeStore` yet. Adding it cleanly requires extending the runtime interface (new `incrementOrchestratorCalls(cardId)` + `getOrchestratorCallCount(cardId)`) which is out of scope for this feature (the executor in #6/#59 will need to call it; without a live caller, dead-code introduction violates auto-mode's no-drive-by-changes rule). Per-mode budget values are still serialized in config; consumers (future #6/#59) will read them.
2. **`config.confidence.threshold` reuse** — spec specifies `autonomy.hybrid_confidence_threshold`. The codebase already has `config.confidence.threshold` (default 0.7) consumed by `conduct.ts`. Both kept: `confidence.threshold` for the existing `conduct.ts` path (preserved compat); `autonomy.hybrid_confidence_threshold` for the new `autoExecuteThreshold` helper. Comment notes the unification opportunity for v2.
3. **Card frontmatter enum kept widened, not narrowed** — spec says map legacy on read. We achieve the same effect by keeping `AUTONOMY_MODES` additive (includes both legacy and new), and applying `mapLegacyAutonomy` inside `effectiveAutonomy`. Avoids rewriting all card files (many existing dogfood cards have `autonomy: inherit` or unset; `'critical'` is rare but possible).
4. **`autonomy.transitions` block kept readable post-migration** — schema preserves `transitions` as optional after migration so a partially-migrated config doesn't fail strict-mode parse. The `transitionPolicy()` helper in `lifecycle.ts` continues to read it (returns `'auto'` default when absent); UI consumers (`board.ts`, `board_dnd.ts`) gracefully degrade.
5. **Migration warning emits via `console.warn` not via daemon event bus** — spec was ambiguous; chose console for simplicity (matches existing deprecation patterns). Daemon-startup log catches it; CLI users see it during command runs.


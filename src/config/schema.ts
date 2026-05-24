// src/config/schema.ts
//
// Zod schemas for runtime-validated parsing of:
//   - card frontmatter (.conductor/cards/<id>.md YAML head)
//   - project config (.conductor/config.yaml)
//
// Keep schema in sync with src/engine/types.ts. Schema is the parser at
// boundaries; types.ts is the type system used everywhere internal.

import { z } from 'zod';
import { COLUMNS, KINDS, AUTONOMY_MODES, AUTONOMY_SPECTRUM } from '../engine/types.js';

export const ColumnSchema = z.enum(COLUMNS);
export const KindSchema = z.enum(KINDS);
export const AutonomySchema = z.enum(AUTONOMY_MODES);

// Phase 30.7 / Relay #60: project-level spectrum (subset of AUTONOMY_MODES).
// The card-frontmatter-level enum (AutonomySchema above) stays widened to
// include legacy values ('escort' | 'auto' | 'critical') for backward-compat;
// the project-default-level enum is the canonical 3-mode spectrum that
// orchestrator-core's executor consumes to gate execute-vs-surface.
export const AutonomyModeSchema = z.enum(AUTONOMY_SPECTRUM);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

// Tracking flag for the legacy-config migration warning. Set by the
// preprocess below when a legacy shape is detected; consumed by load.ts to
// emit a one-line deprecation. Module-level (not per-call) is acceptable
// because the warning is intended to fire once per process boot during the
// first config_get / loadProjectConfig call, not on every re-parse.
let _lastParseSawLegacyAutonomy = false;
export function sawLegacyAutonomyShape(): boolean {
  return _lastParseSawLegacyAutonomy;
}
export function resetLegacyAutonomyFlag(): void {
  _lastParseSawLegacyAutonomy = false;
}
function markLegacyAutonomy(): void {
  _lastParseSawLegacyAutonomy = true;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]+[a-z0-9]$/;

export const CardFrontmatterSchema = z
  .object({
    id: z.string().regex(ID_PATTERN, 'id must be lowercase alphanumeric with dashes'),
    title: z.string().min(1),
    kind: KindSchema,
    column: ColumnSchema,
    phase: z.string().default('unassigned'),
    priority: z.number().int().nonnegative().default(1),
    autonomy: AutonomySchema.default('inherit'),
    model_overrides: z.record(z.string(), z.string()).default({}),
    created: z.string(),
    source: z.string(),
    labels: z.array(z.string()).default([]),
    blocked_by: z.array(z.string()).default([]),
    tracker_id: z.string().optional(),
    tracker_url: z.string().optional(),
  })
  .strict();

export const TransitionPolicy = z.enum(['manual', 'assist', 'auto']);

// Phase 30.7 / Relay #60: per-mode budgets for orchestrator-call ceilings.
// Consumed by the future executor in feature #6/#59. Default values per the
// spec's design table.
export const AutonomyBudgetSchema = z
  .object({
    orchestrator_calls_per_card: z.number().int().positive().default(30),
    observer_calls_per_minute: z.number().int().positive().default(20),
  })
  .default({});

// Phase 30.7 / Relay #60: legacy-config preprocess.
//
// Detects two legacy shapes and rewrites to the new spectrum:
//   (a) `autonomy.default` is one of escort/auto/critical (or omitted) AND
//       `autonomy.transitions.*` is present.
//   (b) `autonomy.default` is one of escort/auto/critical regardless of
//       transitions presence.
// In either case: maps the legacy default value to its spectrum equivalent,
// preserves transitions in place for any consumer still reading it (e.g.,
// transitionPolicy in lifecycle.ts), and sets the module-level flag so
// load.ts can emit a deprecation warning.
//
// Pass-through behavior: when the input is already spectrum-shaped (default
// ∈ assist/hybrid/autonomous), the preprocess is a no-op.
//
// Mapping:
//   escort | assist  → assist
//   auto             → autonomous
//   critical         → autonomous  (halt-on-low-conf relaxed; see spec OQ
//                                   + the deviation note in the spec file)
//   undefined + transitions present → infer from majority of transitions:
//     mostly 'auto'   → autonomous
//     mostly 'manual' → assist
//     otherwise       → hybrid
function preprocessAutonomyBlock(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const block = input as Record<string, unknown>;
  const defaultVal = block.default;
  const hasTransitions =
    block.transitions && typeof block.transitions === 'object' && !Array.isArray(block.transitions);

  const LEGACY_DEFAULTS: Record<string, AutonomyMode> = {
    escort: 'assist',
    assist: 'assist',
    auto: 'autonomous',
    critical: 'autonomous',
  };

  const isLegacyDefault =
    typeof defaultVal === 'string' && defaultVal in LEGACY_DEFAULTS && defaultVal !== 'assist';

  if (isLegacyDefault) {
    markLegacyAutonomy();
    return { ...block, default: LEGACY_DEFAULTS[defaultVal as string] };
  }

  // Default-missing + transitions-present → infer
  if (defaultVal === undefined && hasTransitions) {
    markLegacyAutonomy();
    const transitions = block.transitions as Record<string, string>;
    const values = Object.values(transitions).filter((v): v is string => typeof v === 'string');
    const counts = { auto: 0, assist: 0, manual: 0 };
    for (const v of values) {
      if (v === 'auto') counts.auto += 1;
      else if (v === 'assist') counts.assist += 1;
      else if (v === 'manual') counts.manual += 1;
    }
    let inferred: AutonomyMode = 'hybrid';
    if (counts.auto > counts.assist + counts.manual) inferred = 'autonomous';
    else if (counts.manual > counts.assist + counts.auto) inferred = 'assist';
    return { ...block, default: inferred };
  }

  // 'assist' is both legacy AND new — only mark legacy if transitions also
  // present (the unambiguous legacy-shape signal).
  if (defaultVal === 'assist' && hasTransitions) {
    markLegacyAutonomy();
  }

  return block;
}

export const ProjectConfigSchema = z
  .object({
    routing: z
      .object({
        default: z.string(),
        functions: z.record(z.string(), z.string()).default({}),
      })
      .default({ default: 'claude-sonnet-4-6', functions: {} }),
    autonomy: z
      .preprocess(
        preprocessAutonomyBlock,
        z.object({
          // Project-default spectrum mode. The narrow 3-mode enum is what
          // orchestrator-core's executor (#6/#59) reads to gate
          // execute-vs-surface. Legacy values are mapped to spectrum by the
          // preprocess above before zod validation runs.
          default: AutonomyModeSchema.default('hybrid'),
          // Threshold for hybrid mode. Decisions with confidence >= threshold
          // auto-execute; below threshold surface to operator. Default 0.7.
          // Note: config.confidence.threshold also exists (legacy conduct.ts
          // path); both kept for now to avoid breaking the current loop.
          hybrid_confidence_threshold: z.number().min(0).max(1).default(0.7),
          // Per-mode orchestrator-call + observer-call budgets.
          budgets: z
            .object({
              assist: AutonomyBudgetSchema,
              hybrid: AutonomyBudgetSchema,
              autonomous: AutonomyBudgetSchema,
            })
            .default({}),
          // DEPRECATED legacy per-edge transition policy block. Kept readable
          // post-migration for backward-compat with consumers that still walk
          // it (lifecycle.transitionPolicy, board.ts column-head badges).
          // New configs should omit it.
          transitions: z
            .object({
              discovered_to_planned: TransitionPolicy.default('auto'),
              planned_to_approved: TransitionPolicy.default('assist'),
              approved_to_building: TransitionPolicy.default('manual'),
              building_to_verifying: TransitionPolicy.default('auto'),
              verifying_to_shipped: TransitionPolicy.default('assist'),
              shipped_to_archived: TransitionPolicy.default('manual'),
            })
            .default({}),
        }),
      )
      .default({}),
    verify_command: z.string().default('npm test'),
    cost_ceilings: z
      .object({
        // Phase 22: accept `null` as a synonym for Infinity. JSON serialization
        // emits Infinity as `null`; this preprocess transforms it back at parse
        // time so config_get → JSON → config_set round-trips cleanly. Closes #26.
        per_card_dollars: z
          .preprocess((v) => (v === null ? Number.POSITIVE_INFINITY : v), z.number().positive())
          .default(Number.POSITIVE_INFINITY),
        per_day_dollars: z
          .preprocess((v) => (v === null ? Number.POSITIVE_INFINITY : v), z.number().positive())
          .default(Number.POSITIVE_INFINITY),
        halt_on_breach: z.boolean().default(false),
      })
      .default({}),
    confidence: z
      .object({
        threshold: z.number().min(0).max(1).default(0.7),
      })
      .default({}),
    run_log: z
      .object({
        keep_days: z.number().int().nonnegative().default(30),
        keep_last_n: z.number().int().positive().default(200),
      })
      .default({}),
    brain_log: z
      .object({
        keep_days: z.number().int().nonnegative().default(30),
        keep_last_n: z.number().int().positive().default(200),
      })
      .default({}),
    tracker: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('none'),
          poll_interval_ms: z.number().int().nonnegative().default(0),
        }),
        z.object({
          kind: z.literal('linear'),
          api_key_env: z.string().min(1).default('LINEAR_API_KEY'),
          endpoint: z.string().url().default('https://api.linear.app/graphql'),
          project_slug: z.string().min(1),
          active_states: z.array(z.string()).default(['Todo', 'In Progress']),
          poll_interval_ms: z.number().int().nonnegative().default(0),
        }),
        z.object({
          kind: z.literal('github'),
          api_key_env: z.string().min(1).default('GITHUB_TOKEN'),
          endpoint: z.string().url().default('https://api.github.com'),
          owner: z.string().min(1),
          repo: z.string().min(1),
          active_states: z.array(z.string()).default(['open']),
          poll_interval_ms: z.number().int().nonnegative().default(0),
        }),
      ])
      .default({ kind: 'none', poll_interval_ms: 0 }),
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

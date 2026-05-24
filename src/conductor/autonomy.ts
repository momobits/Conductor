// src/conductor/autonomy.ts
//
// Phase 30.7 / Relay #60 dual-driver-autonomy-spectrum-config.
//
// Helpers that resolve the effective project-level autonomy mode for a card,
// plus the executor's auto-execute-vs-surface gating threshold for a given
// mode. Wired into the brain-loop executor (feature #6/#59) once that lands;
// v1 is consumed by `src/conductor/loop.ts:effectiveMode()` via the bridge
// helper to preserve existing `conduct.ts` semantics.
//
// Sibling-module rationale: lives alongside `lead.ts`, `cost_guard.ts`,
// `halt.ts` per the protocol-extraction pattern (precedent n=2 from #58).
// Single mutation choke-point: NONE — this module is pure.

import type { Card, Autonomy, AutonomyMode } from '../engine/types.js';
import type { ProjectConfig } from '../config/schema.js';
import type { ConductMode } from '../engine/ops/conduct.js';

/** Map a card-frontmatter autonomy value (which may carry legacy values) onto
 *  the canonical spectrum, or 'inherit' (the only card-only value). The
 *  mapping mirrors the schema preprocess in `src/config/schema.ts`. */
export function mapLegacyAutonomy(value: Autonomy): AutonomyMode | 'inherit' {
  switch (value) {
    case 'inherit':
      return 'inherit';
    case 'escort':
    case 'assist':
      return 'assist';
    case 'auto':
    case 'autonomous':
      return 'autonomous';
    case 'critical':
      // Critical's halt-on-low-conf semantic relaxed in spectrum form.
      // Documented in the spec's Implementation Deviation #3.
      return 'autonomous';
    case 'hybrid':
      return 'hybrid';
  }
}

/** Resolve the effective autonomy mode for a card: the card's `autonomy`
 *  field (mapped from legacy if needed) wins unless `'inherit'`, in which
 *  case the project default (already a spectrum value post-schema-parse) is
 *  returned. */
export function effectiveAutonomy(card: Card, config: ProjectConfig): AutonomyMode {
  const cardLevel = mapLegacyAutonomy(card.frontmatter.autonomy);
  if (cardLevel === 'inherit') return config.autonomy.default;
  return cardLevel;
}

/** The executor's gating decision shape: either always execute (autonomous),
 *  threshold-gate by confidence (hybrid), or always surface to operator
 *  (assist). The future executor in feature #6/#59 reads this and either
 *  fires the op or publishes a pending-decision event. */
export type AutoExecuteGate =
  | { kind: 'always-execute' }
  | { kind: 'threshold'; minConfidence: number }
  | { kind: 'always-surface' };

/** Read the executor's gating threshold for a mode. */
export function autoExecuteThreshold(
  mode: AutonomyMode,
  config: ProjectConfig,
): AutoExecuteGate {
  switch (mode) {
    case 'autonomous':
      return { kind: 'always-execute' };
    case 'hybrid':
      return { kind: 'threshold', minConfidence: config.autonomy.hybrid_confidence_threshold };
    case 'assist':
      return { kind: 'always-surface' };
  }
}

/** Bridge the spectrum mode to the legacy ConductMode consumed by
 *  `src/engine/ops/conduct.ts`. Used by the existing `loop.ts` path so the
 *  pre-orchestrator (#6/#59) decision flow keeps working unchanged.
 *
 *  assist     → 'assist'  (existing assist semantics: blast-radius + threshold)
 *  hybrid     → 'auto'    (existing auto: threshold-gated; the spectrum's
 *                          hybrid_confidence_threshold and the legacy
 *                          confidence.threshold both apply through different
 *                          codepaths; conduct.ts uses the latter)
 *  autonomous → 'auto'    (executor never surfaces; conduct.ts's auto path
 *                          escalates on low confidence but the executor (#6)
 *                          will short-circuit this once it lands) */
export function bridgeSpectrumToConductMode(mode: AutonomyMode): ConductMode {
  switch (mode) {
    case 'assist':
      return 'assist';
    case 'hybrid':
      return 'auto';
    case 'autonomous':
      return 'auto';
  }
}

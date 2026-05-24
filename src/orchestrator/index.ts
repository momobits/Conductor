// src/orchestrator/index.ts
//
// Public surface for the orchestrator module. Sibling Phase 22 features
// import from this barrel rather than reaching into individual files.

export { decide, type DecideArgs } from './core.js';
export {
  buildSnapshot,
  SNAPSHOT_OPS,
  type CardSnapshot,
  type SubstrateArtifact,
  type RecentRunEvent,
} from './snapshot.js';
export { assemblePrompt, type AssembledPrompt } from './prompt.js';
export {
  OrchestratorActionSchema,
  OrchestratorDecisionSchema,
  CallOpParamsSchema,
  AdvanceColumnParamsSchema,
  HaltWithHandoffParamsSchema,
  AdviseParamsSchema,
  SubstrateOpParamsSchema,
  NoOpParamsSchema,
  narrowDecision,
  type OrchestratorAction,
  type OrchestratorDecision,
  type NarrowedDecision,
  type CallOpParams,
  type AdvanceColumnParams,
  type HaltWithHandoffParams,
  type AdviseParams,
  type SubstrateOpParams,
  type NoOpParams,
} from './types.js';
// Phase 22 / Control 30.8 (feature #57): dual-driver lead-handoff reconciliation.
export {
  reconcile,
  captureAndPersistHandoff,
  pruneHandoffsAtBoot,
  isReconciliationInFlight,
  type ReconcileArgs,
  type CardReconciliation,
  type ReconciliationResult,
} from './reconciliation.js';
export {
  captureSnapshot,
  diffSnapshots,
  persistHandoffSnapshot,
  loadLatestHandoffSnapshot,
  pruneHandoffSnapshots,
  type BoardSnapshot,
  type CardChangeKind,
  type CardDiff,
} from './reconciliation-diff.js';

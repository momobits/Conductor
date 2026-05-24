// src/engine/types.ts
//
// Core domain types for the Conductor engine. These types are the contract
// between operations, adapters, and the CLI; they should be minimal and
// stable.

export const COLUMNS = [
  'discovered',
  'planned',
  'approved',
  'building',
  'verifying',
  'shipped',
  'archived',
] as const;
export type Column = (typeof COLUMNS)[number];

export const KINDS = ['issue', 'feature', 'exercise-finding', 'imported'] as const;
export type Kind = (typeof KINDS)[number];

// Phase 30.7 / Relay #60 dual-driver-autonomy-spectrum-config:
//
// Two distinct enums now coexist:
//   - AUTONOMY_MODES: card-frontmatter-level (per-card override). Additive:
//     keeps legacy values ('escort' | 'auto' | 'critical') so existing card
//     files continue to parse; adds spectrum values ('hybrid' | 'autonomous')
//     so cards can opt into the new shape. 'inherit' (project-default
//     deferral) is card-only and stays here.
//   - AUTONOMY_SPECTRUM: project-default-level (config.autonomy.default). The
//     canonical 3-mode spectrum the orchestrator's executor (#6/#59) reads to
//     gate execute-vs-surface. Legacy project-default values are accepted at
//     load time via src/config/schema.ts preprocess + mapped onto spectrum.
//
// Mapping (applied by mapLegacyAutonomy in src/conductor/autonomy.ts):
//   escort/assist  → assist    (every decision surfaces; assist preserves)
//   auto           → autonomous (executor never surfaces; just executes)
//   critical       → autonomous (halt-on-low-conf semantic relaxed; see
//                                conduct.ts's threshold path for parity)
//   hybrid         → hybrid     (new; threshold-gated execute vs surface)
//   autonomous     → autonomous (new; always-execute)
//   inherit        → (card-only; defers to config.autonomy.default)
export const AUTONOMY_MODES = [
  'inherit',
  'escort',
  'assist',
  'auto',
  'critical',
  'hybrid',
  'autonomous',
] as const;
export type Autonomy = (typeof AUTONOMY_MODES)[number];

export const AUTONOMY_SPECTRUM = ['assist', 'hybrid', 'autonomous'] as const;
export type AutonomyMode = (typeof AUTONOMY_SPECTRUM)[number];

export type ModelOverrides = Record<string, string>;

export interface CardFrontmatter {
  id: string;
  title: string;
  kind: Kind;
  column: Column;
  phase: string; // 'unassigned' if no phase yet
  priority: number;
  autonomy: Autonomy;
  model_overrides: ModelOverrides;
  created: string; // ISO 8601
  source: string; // discover | user | linear | github | exercise:<session>
  labels: string[];
  blocked_by: string[];
  tracker_id?: string;
  tracker_url?: string;
}

export interface Card {
  frontmatter: CardFrontmatter;
  body: string;
  path: string; // absolute path to the .md file
}

export interface BlastRadius {
  level: 'low' | 'medium' | 'high';
  reason: string;
}

export interface RecommendationOption {
  id: string;
  confidence: number; // 0..1
  rationale: string;
}

export interface Recommendation {
  type: 'recommendation';
  card: string;
  operation: string;
  blast_radius: BlastRadius;
  options: RecommendationOption[];
  recommended: string; // option id
}

// ---------- Phase 2: Operation result types ----------

export type VerdictDecision = 'APPROVED' | 'NEEDS-CHANGES' | 'NEEDS-INFO';

export interface Verdict {
  decision: VerdictDecision;
  reasoning: string;
  changes_required: string[]; // empty if APPROVED
}

export interface DiffFile {
  path: string;                       // repo-relative
  action: 'create' | 'modify' | 'delete';
  content: string;                    // full file content for create|modify
}

export const COMMIT_TYPES = ['feat', 'fix', 'test', 'docs', 'refactor', 'chore'] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

export interface Diff {
  step: string;                       // e.g. '1.2'
  commit_type: CommitType;
  commit_subject: string;             // <70 chars, imperative
  files: DiffFile[];
  notes: string;                      // freeform; mirrors plan's HOW for the step
}

export type VerifyOutcome = 'PASS' | 'FAIL' | 'SKIP';

export interface VerifyReport {
  outcome: VerifyOutcome;
  command: string;
  exit_code: number;
  summary: string;                    // LLM-written narrative
  failures: string[];                 // empty if PASS
}

export interface ResolutionDoc {
  card_id: string;
  summary: string;                    // 3–5 sentence what-shipped narrative
  files_changed: string[];
  ship_commit: string;                // SHA of the resolve commit
}

export type DriftKind =
  | 'branch-mismatch'
  | 'last-commit-mismatch'
  | 'uncommitted-state-mismatch'
  | 'tag-mismatch'
  | 'state-md-template'
  | 'state-md-missing'
  | 'state-md-unparseable';

export interface Drift {
  kind: DriftKind;
  expected: string;
  actual: string;
  detail: string;
}

export interface CardSummary {
  id: string;
  title: string;
  column: Column;
  phase: string;
  priority: number;
  kind: Kind;
  labels: string[];
  blocked_by: string[];
}

export interface Status {
  cards: CardSummary[];
  by_column: Record<Column, number>;
  by_phase: Record<string, number>;
  errors?: Array<{ path: string; message: string }>;
}

export interface OrderingEntry {
  id: string;
  rank: number;                       // 1-indexed
  rationale: string;
}

export interface Ordering {
  generated_at: string;               // ISO 8601
  entries: OrderingEntry[];
}

export interface DiscoveredItem {
  slug: string;                       // proposed slug for the new card
  title: string;
  kind: Kind;
  rationale: string;
  source_evidence: string;            // where it was found
}

export interface ExerciseFinding {
  id: string;                         // unique within session
  scenario: string;
  observed: string;
  severity: 'note' | 'low' | 'medium' | 'high';
  evidence: string;
}

export interface ExerciseSession {
  id: string;                         // session-id (slug-friendly)
  goal: string;
  scenarios: string[];
  findings: ExerciseFinding[];
  created: string;
}

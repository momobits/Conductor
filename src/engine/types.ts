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

export const AUTONOMY_MODES = ['inherit', 'escort', 'assist', 'auto', 'critical'] as const;
export type Autonomy = (typeof AUTONOMY_MODES)[number];

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

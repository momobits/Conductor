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

export const AUTONOMY_MODES = ['inherit', 'escort', 'assist', 'auto'] as const;
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
  source: string; // discover | user | linear | exercise:<session>
  labels: string[];
  blocked_by: string[];
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

// src/config/schema.ts
//
// Zod schemas for runtime-validated parsing of:
//   - card frontmatter (.conductor/cards/<id>.md YAML head)
//   - project config (.conductor/config.yaml)
//
// Keep schema in sync with src/engine/types.ts. Schema is the parser at
// boundaries; types.ts is the type system used everywhere internal.

import { z } from 'zod';
import { COLUMNS, KINDS, AUTONOMY_MODES } from '../engine/types.js';

export const ColumnSchema = z.enum(COLUMNS);
export const KindSchema = z.enum(KINDS);
export const AutonomySchema = z.enum(AUTONOMY_MODES);

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

export const ProjectConfigSchema = z
  .object({
    routing: z
      .object({
        default: z.string(),
        functions: z.record(z.string(), z.string()).default({}),
      })
      .default({ default: 'claude-sonnet-4-6', functions: {} }),
    autonomy: z
      .object({
        default: AutonomySchema.default('assist'),
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
      })
      .default({}),
    verify_command: z.string().default('npm test'),
    cost_ceilings: z
      .object({
        per_card_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),
        per_day_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),
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

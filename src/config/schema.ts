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
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

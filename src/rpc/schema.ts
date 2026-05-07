// src/rpc/schema.ts
//
// Zod schemas for JSON-RPC method params. Schemas are the parser at the
// boundary; method handlers (rpc/methods.ts) call .parse() to enforce shape
// before invoking the engine.

import { z } from 'zod';
import { ColumnSchema, KindSchema, CardFrontmatterSchema, ProjectConfigSchema } from '../config/schema.js';

export const CardNewParams = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: KindSchema.default('issue'),
  body: z.string().optional(),
});

export const CardGetParams = z.object({
  id: z.string().min(1),
});

export const CardListParams = z.object({
  column: ColumnSchema.optional(),
});

export const CardUpdateParams = z
  .object({
    id: z.string().min(1),
    frontmatterPatch: CardFrontmatterSchema.partial().optional(),
    bodyAppend: z.string().optional(),
  })
  .refine((v) => v.frontmatterPatch !== undefined || v.bodyAppend !== undefined, {
    message: 'card_update requires frontmatterPatch or bodyAppend',
  });

export const TransitionParams = z.object({
  id: z.string().min(1),
  to: ColumnSchema,
});

export const ScanParams = z.object({});
export const OrderParams = z.object({});
export const DiscoverParams = z.object({});

export const ExerciseNewParams = z.object({
  goal: z.string().optional(),
});

export const ExerciseFileParams = z.object({
  sessionId: z.string().min(1),
  finding: z.object({
    scenario: z.string(),
    observed: z.string(),
    severity: z.enum(['note', 'low', 'medium', 'high']),
    evidence: z.string().default(''),
  }),
});

export const WorkCardParams = z.object({
  id: z.string().min(1),
  step: z.string().optional(),
});

export const WorkNextParams = z.object({});

export const RecommendParams = z.object({
  cardId: z.string().min(1),
  recommendation: z.object({
    type: z.literal('recommendation'),
    card: z.string(),
    operation: z.string(),
    blast_radius: z.object({
      level: z.enum(['low', 'medium', 'high']),
      reason: z.string(),
    }),
    options: z
      .array(
        z.object({
          id: z.string(),
          confidence: z.number().min(0).max(1),
          rationale: z.string(),
        }),
      )
      .min(1),
    recommended: z.string(),
  }),
});

export const ConfigGetParams = z.object({});
export const ConfigSetParams = z.object({
  config: ProjectConfigSchema,
});

export const SessionStatusParams = z.object({
  cardId: z.string().optional(),
});

export const ChatParams = z.object({
  cardId: z.string().min(1),
  message: z.string().min(1),
});

// tests/conductor/autonomy.test.ts
//
// Phase 30.7 / Relay #60 dual-driver-autonomy-spectrum-config.
//
// Unit coverage for src/conductor/autonomy.ts helpers:
//   - mapLegacyAutonomy: card-level legacy → spectrum mapping
//   - effectiveAutonomy: card override vs project default resolution
//   - autoExecuteThreshold: executor gating shape per mode

import { describe, it, expect } from 'vitest';
import {
  mapLegacyAutonomy,
  effectiveAutonomy,
  autoExecuteThreshold,
} from '../../src/conductor/autonomy.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { Card, Autonomy, AutonomyMode } from '../../src/engine/types.js';

function makeCard(autonomy: Autonomy): Card {
  return {
    frontmatter: {
      id: 'test-card',
      title: 'Test card',
      kind: 'feature',
      column: 'planned',
      phase: 'unassigned',
      priority: 1,
      autonomy,
      model_overrides: {},
      created: '2026-05-24T00:00:00Z',
      source: 'user',
      labels: [],
      blocked_by: [],
    },
    body: '',
    path: '/tmp/test-card.md',
  };
}

describe('mapLegacyAutonomy', () => {
  it('maps every legacy + new value onto a spectrum-or-inherit value', () => {
    const cases: Array<[Autonomy, AutonomyMode | 'inherit']> = [
      ['inherit', 'inherit'],
      ['escort', 'assist'],
      ['assist', 'assist'],
      ['auto', 'autonomous'],
      ['critical', 'autonomous'],
      ['hybrid', 'hybrid'],
      ['autonomous', 'autonomous'],
    ];
    for (const [input, expected] of cases) {
      expect(mapLegacyAutonomy(input), `mapping for ${input}`).toBe(expected);
    }
  });
});

describe('effectiveAutonomy', () => {
  it('returns the project default when card autonomy is "inherit"', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'hybrid' } });
    const card = makeCard('inherit');
    expect(effectiveAutonomy(card, config)).toBe('hybrid');
  });

  it('returns the card override when set to a spectrum value', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'assist' } });
    const card = makeCard('autonomous');
    expect(effectiveAutonomy(card, config)).toBe('autonomous');
  });

  it('maps a legacy card-level value onto spectrum', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'assist' } });
    const card = makeCard('critical');
    expect(effectiveAutonomy(card, config)).toBe('autonomous');
  });

  it('card "escort" maps to "assist"', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'autonomous' } });
    const card = makeCard('escort');
    expect(effectiveAutonomy(card, config)).toBe('assist');
  });
});

describe('autoExecuteThreshold', () => {
  it('autonomous → always-execute', () => {
    const config = ProjectConfigSchema.parse({});
    expect(autoExecuteThreshold('autonomous', config)).toEqual({ kind: 'always-execute' });
  });

  it('assist → always-surface', () => {
    const config = ProjectConfigSchema.parse({});
    expect(autoExecuteThreshold('assist', config)).toEqual({ kind: 'always-surface' });
  });

  it('hybrid → threshold from config (default 0.7)', () => {
    const config = ProjectConfigSchema.parse({});
    expect(autoExecuteThreshold('hybrid', config)).toEqual({
      kind: 'threshold',
      minConfidence: 0.7,
    });
  });

  it('hybrid threshold honors operator tuning', () => {
    const config = ProjectConfigSchema.parse({
      autonomy: { default: 'hybrid', hybrid_confidence_threshold: 0.9 },
    });
    expect(autoExecuteThreshold('hybrid', config)).toEqual({
      kind: 'threshold',
      minConfidence: 0.9,
    });
  });
});

describe('schema preprocess: legacy-config migration', () => {
  it('maps legacy "auto" default to "autonomous"', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'auto' } });
    expect(config.autonomy.default).toBe('autonomous');
  });

  it('maps legacy "escort" default to "assist"', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'escort' } });
    expect(config.autonomy.default).toBe('assist');
  });

  it('maps legacy "critical" default to "autonomous"', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'critical' } });
    expect(config.autonomy.default).toBe('autonomous');
  });

  it('preserves spectrum values unchanged', () => {
    const config = ProjectConfigSchema.parse({ autonomy: { default: 'hybrid' } });
    expect(config.autonomy.default).toBe('hybrid');
  });

  it('infers spectrum from legacy transitions block (mostly auto → autonomous)', () => {
    const config = ProjectConfigSchema.parse({
      autonomy: {
        transitions: {
          discovered_to_planned: 'auto',
          planned_to_approved: 'auto',
          approved_to_building: 'auto',
          building_to_verifying: 'auto',
          verifying_to_shipped: 'assist',
          shipped_to_archived: 'manual',
        },
      },
    });
    expect(config.autonomy.default).toBe('autonomous');
  });

  it('infers spectrum from legacy transitions block (mostly manual → assist)', () => {
    const config = ProjectConfigSchema.parse({
      autonomy: {
        transitions: {
          discovered_to_planned: 'manual',
          planned_to_approved: 'manual',
          approved_to_building: 'manual',
          building_to_verifying: 'manual',
          verifying_to_shipped: 'manual',
          shipped_to_archived: 'auto',
        },
      },
    });
    expect(config.autonomy.default).toBe('assist');
  });

  it('infers spectrum from legacy transitions block (mixed → hybrid)', () => {
    const config = ProjectConfigSchema.parse({
      autonomy: {
        transitions: {
          discovered_to_planned: 'auto',
          planned_to_approved: 'assist',
          approved_to_building: 'manual',
          building_to_verifying: 'auto',
          verifying_to_shipped: 'assist',
          shipped_to_archived: 'manual',
        },
      },
    });
    expect(config.autonomy.default).toBe('hybrid');
  });

  it('budgets default to per-mode values from the spec table', () => {
    const config = ProjectConfigSchema.parse({});
    expect(config.autonomy.budgets.assist.orchestrator_calls_per_card).toBeGreaterThan(0);
    expect(config.autonomy.budgets.hybrid.orchestrator_calls_per_card).toBeGreaterThan(0);
    expect(config.autonomy.budgets.autonomous.orchestrator_calls_per_card).toBeGreaterThan(0);
  });
});

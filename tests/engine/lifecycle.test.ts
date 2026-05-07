import { describe, it, expect } from 'vitest';
import {
  canTransition,
  nextOperation,
  transitionPolicy,
  TerminalColumn,
} from '../../src/engine/lifecycle.js';
import type { ProjectConfig } from '../../src/config/schema.js';

const config: ProjectConfig = {
  routing: { default: 'claude-sonnet-4-6', functions: {} },
  autonomy: {
    default: 'assist',
    transitions: {
      discovered_to_planned: 'auto',
      planned_to_approved: 'assist',
      approved_to_building: 'manual',
      building_to_verifying: 'auto',
      verifying_to_shipped: 'assist',
      shipped_to_archived: 'manual',
    },
  },
};

describe('canTransition', () => {
  it('permits valid forward transitions', () => {
    expect(canTransition('discovered', 'planned')).toBe(true);
    expect(canTransition('planned', 'approved')).toBe(true);
    expect(canTransition('approved', 'building')).toBe(true);
    expect(canTransition('building', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'archived')).toBe(true);
  });

  it('permits known backward edges (review rejection, post-impl fix)', () => {
    expect(canTransition('planned', 'discovered')).toBe(true);
    expect(canTransition('building', 'approved')).toBe(true);
    expect(canTransition('verifying', 'building')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('discovered', 'shipped')).toBe(false);
    expect(canTransition('archived', 'discovered')).toBe(false);
    expect(canTransition('shipped', 'building')).toBe(false);
  });
});

describe('nextOperation', () => {
  it('returns analyze for a Discovered card', () => {
    expect(nextOperation('discovered')).toBe('analyze');
  });

  it('returns review for a Planned card', () => {
    expect(nextOperation('planned')).toBe('review');
  });

  it('returns null for terminal states', () => {
    expect(nextOperation('archived')).toBeNull();
  });
});

describe('transitionPolicy', () => {
  it('reads autonomy policy for a transition pair', () => {
    expect(transitionPolicy(config, 'discovered', 'planned')).toBe('auto');
    expect(transitionPolicy(config, 'planned', 'approved')).toBe('assist');
    expect(transitionPolicy(config, 'approved', 'building')).toBe('manual');
  });

  it('returns "manual" for unrecognized transition pairs', () => {
    expect(transitionPolicy(config, 'discovered', 'building')).toBe('manual');
  });
});

describe('TerminalColumn', () => {
  it('archived is terminal', () => {
    expect(TerminalColumn).toBe('archived');
  });
});

import { describe, it, expect } from 'vitest';
import {
  canTransition,
  nextOperation,
  transitionPolicy,
  TerminalColumn,
  transitionDirection,
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
    expect(canTransition('approved', 'planned')).toBe(true);
    expect(canTransition('building', 'approved')).toBe(true);
    expect(canTransition('verifying', 'building')).toBe(true);
  });

  it('Phase 30.6 widen: accepts all column→column edges except no-op', () => {
    // All forward + backward + cross-skip edges now legal.
    expect(canTransition('discovered', 'shipped')).toBe(true);
    expect(canTransition('archived', 'discovered')).toBe(true);
    expect(canTransition('shipped', 'building')).toBe(true);
  });

  it('rejects no-op (from === to) transitions', () => {
    expect(canTransition('planned', 'planned')).toBe(false);
    expect(canTransition('archived', 'archived')).toBe(false);
  });
});

describe('transitionDirection (Phase 30.6)', () => {
  it('classifies forward edges', () => {
    expect(transitionDirection('discovered', 'planned')).toBe('forward');
    expect(transitionDirection('shipped', 'archived')).toBe('forward');
    expect(transitionDirection('discovered', 'shipped')).toBe('forward');
  });

  it('classifies backward edges', () => {
    expect(transitionDirection('verifying', 'planned')).toBe('backward');
    expect(transitionDirection('archived', 'shipped')).toBe('backward');
    expect(transitionDirection('approved', 'planned')).toBe('backward');
  });

  it('classifies no-op', () => {
    expect(transitionDirection('planned', 'planned')).toBe('noop');
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

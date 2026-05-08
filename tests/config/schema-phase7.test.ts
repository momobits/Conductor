import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema, CardFrontmatterSchema } from '../../src/config/schema.js';

describe('CardFrontmatterSchema — Phase 7 tracker fields', () => {
  it('accepts tracker_id and tracker_url as optional fields', () => {
    const fm = CardFrontmatterSchema.parse({
      id: 'gh-456-thing',
      title: 'thing',
      kind: 'issue',
      column: 'discovered',
      created: '2026-05-08T00:00:00Z',
      source: 'github',
      tracker_id: '456',
      tracker_url: 'https://github.com/a/b/issues/456',
    });
    expect(fm.tracker_id).toBe('456');
    expect(fm.tracker_url).toBe('https://github.com/a/b/issues/456');
  });
  it('still parses when tracker fields are omitted', () => {
    const fm = CardFrontmatterSchema.parse({
      id: 'card-1',
      title: 't',
      kind: 'issue',
      column: 'discovered',
      created: '2026-05-08T00:00:00Z',
      source: 'user',
    });
    expect(fm.tracker_id).toBeUndefined();
  });
});

describe('ProjectConfigSchema — Phase 7 tracker block', () => {
  it('defaults tracker.kind to "none" and poll_interval_ms to 0', () => {
    const cfg = ProjectConfigSchema.parse({ routing: { default: 'mock' } });
    expect(cfg.tracker.kind).toBe('none');
    expect(cfg.tracker.poll_interval_ms).toBe(0);
  });
  it('accepts linear with project_slug', () => {
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      tracker: { kind: 'linear', api_key_env: 'LINEAR_API_KEY', project_slug: 'team-foo' },
    });
    expect(cfg.tracker.kind).toBe('linear');
    if (cfg.tracker.kind === 'linear') {
      expect(cfg.tracker.project_slug).toBe('team-foo');
    }
  });
  it('accepts github with owner+repo', () => {
    const cfg = ProjectConfigSchema.parse({
      routing: { default: 'mock' },
      tracker: { kind: 'github', api_key_env: 'GITHUB_TOKEN', owner: 'acme', repo: 'widgets' },
    });
    expect(cfg.tracker.kind).toBe('github');
    if (cfg.tracker.kind === 'github') {
      expect(cfg.tracker.owner).toBe('acme');
      expect(cfg.tracker.repo).toBe('widgets');
    }
  });
  it('rejects linear without project_slug', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        routing: { default: 'mock' },
        tracker: { kind: 'linear', api_key_env: 'LINEAR_API_KEY' },
      }),
    ).toThrow();
  });
  it('rejects github without owner or repo', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        routing: { default: 'mock' },
        tracker: { kind: 'github', api_key_env: 'GITHUB_TOKEN', owner: 'acme' },
      }),
    ).toThrow();
  });
});

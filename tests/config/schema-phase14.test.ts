import { describe, it, expect } from 'vitest';
import { ProjectConfigSchema } from '../../src/config/schema.js';

describe('Phase 14 brain_log config block', () => {
  it('applies defaults when brain_log is omitted from config', () => {
    const cfg = ProjectConfigSchema.parse({});
    expect(cfg.brain_log.keep_days).toBe(30);
    expect(cfg.brain_log.keep_last_n).toBe(200);
  });

  it('inner brain_log block is lenient (mirrors run_log) — unknown sub-keys are silently stripped', () => {
    // run_log's inner z.object is not .strict(); brain_log mirrors that.
    // The OUTER ProjectConfigSchema.strict() rejection of unknown TOP-LEVEL
    // keys is covered by tests/config/schema-phase6.test.ts / schema-phase7.test.ts.
    const cfg = ProjectConfigSchema.parse({ brain_log: { keep_days: 7, bogus: 'ignored' } as unknown });
    expect(cfg.brain_log.keep_days).toBe(7);
    expect(cfg.brain_log.keep_last_n).toBe(200);
    expect(cfg.brain_log).not.toHaveProperty('bogus');
  });

  it('accepts explicit retention values', () => {
    const cfg = ProjectConfigSchema.parse({ brain_log: { keep_days: 14, keep_last_n: 1000 } });
    expect(cfg.brain_log.keep_days).toBe(14);
    expect(cfg.brain_log.keep_last_n).toBe(1000);
  });

  it('rejects negative keep_days', () => {
    expect(() => ProjectConfigSchema.parse({ brain_log: { keep_days: -1 } })).toThrow();
  });

  it('rejects non-positive keep_last_n', () => {
    expect(() => ProjectConfigSchema.parse({ brain_log: { keep_last_n: 0 } })).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { preserveYamlComments } from '../../src/config/preserve_comments.js';

describe('preserveYamlComments (Relay #27)', () => {
  it('returns dump unchanged when existing is null (ENOENT)', () => {
    const dump = 'routing:\n  default: a\n';
    expect(preserveYamlComments(null, dump)).toBe(dump);
  });

  it('returns dump unchanged when existing is empty string', () => {
    const dump = 'routing:\n  default: a\n';
    expect(preserveYamlComments('', dump)).toBe(dump);
  });

  it('preserves file-head preamble (omniforge claude-sub case)', () => {
    const existing = [
      '# Claude-subscription-only config — routes every op through claude.',
      '# Prerequisites:',
      '#   1. Install Claude Code',
      '',
      'routing:',
      '  default: claude-sub:sonnet',
    ].join('\n');
    const dump = 'routing:\n  default: claude-sub:sonnet\n';
    const out = preserveYamlComments(existing, dump);
    expect(out.startsWith('# Claude-subscription-only config')).toBe(true);
    expect(out).toContain('# Prerequisites:');
    expect(out).toContain('routing:');
  });

  it('preserves section-leading comment blocks', () => {
    const existing = [
      'routing:',
      '  default: a',
      '',
      '# Autonomy controls — manual overrides go here',
      'autonomy:',
      '  default: assist',
    ].join('\n');
    const dump = 'routing:\n  default: a\nautonomy:\n  default: auto\n';
    const out = preserveYamlComments(existing, dump);
    expect(out).toContain('# Autonomy controls — manual overrides go here\nautonomy:');
  });

  it('preserves end-of-line annotations on nested keys (init template case)', () => {
    const existing = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7        # heavy reasoning',
      '    plan: claude-opus-4-7',
    ].join('\n');
    const dump = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7',
      '    plan: claude-opus-4-7',
      '',
    ].join('\n');
    const out = preserveYamlComments(existing, dump);
    expect(out).toContain('analyze: claude-opus-4-7  # heavy reasoning');
  });

  it('drops section-leading comments whose key disappeared from the dump', () => {
    // Section-leading comments (those attached to a specific key) are dropped
    // when their key isn't in the new dump. File-head preamble is preserved
    // separately — it describes the file as a whole.
    const existing = [
      'routing:',
      '  default: a',
      '# orphan section above removed key',
      'removed_key:',
      '  foo: bar',
    ].join('\n');
    const dump = 'routing:\n  default: a\n';
    const out = preserveYamlComments(existing, dump);
    expect(out).not.toContain('orphan');
  });

  it('passes through dumps with no surviving comments', () => {
    const existing = 'routing:\n  default: a\n';
    const dump = 'routing:\n  default: b\n';
    expect(preserveYamlComments(existing, dump)).toBe(dump);
  });

  it('preserves end-of-line annotations on top-level scalar keys', () => {
    // verify_command is the only top-level scalar in ProjectConfigSchema;
    // its EOL annotation must survive the same way nested EOL annotations do.
    const existing = 'verify_command: npm test  # custom override\nrouting:\n  default: a\n';
    const dump = 'verify_command: npm test\nrouting:\n  default: a\n';
    const out = preserveYamlComments(existing, dump);
    expect(out).toContain('verify_command: npm test  # custom override');
  });
});

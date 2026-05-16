import { describe, it, expect } from 'vitest';
import { replaceAutonomyDefault } from '../../src/ui/views/routing.js';

describe('replaceAutonomyDefault (Relay #24)', () => {
  it('patches autonomy.default in the canonical configToYaml shape', () => {
    const yaml = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7',
      'autonomy:',
      '  default: assist',
      '  transitions:',
      '    discovered_to_planned: auto',
      'verify_command: npm test',
      '',
    ].join('\n');
    const out = replaceAutonomyDefault(yaml, 'auto');
    expect(out).toContain('autonomy:\n  default: auto\n');
    expect(out).toContain('routing:\n  default: claude-sonnet-4-6');
    expect(out).toContain('verify_command: npm test');
  });

  it('returns null when no autonomy block exists', () => {
    const yaml = 'routing:\n  default: claude-sonnet-4-6\n';
    expect(replaceAutonomyDefault(yaml, 'auto')).toBeNull();
  });

  it('does not patch routing.default — only autonomy.default', () => {
    const yaml = 'routing:\n  default: A\nautonomy:\n  default: B\n';
    const out = replaceAutonomyDefault(yaml, 'C');
    expect(out).toBe('routing:\n  default: A\nautonomy:\n  default: C\n');
  });

  it('preserves uncommitted edits outside the autonomy block', () => {
    const yaml = 'routing:\n  default: WIP_VALUE_USER_PASTED\nautonomy:\n  default: assist\n';
    const out = replaceAutonomyDefault(yaml, 'auto');
    expect(out).toContain('WIP_VALUE_USER_PASTED');
    expect(out).toContain('default: auto');
  });

  it('returns null on malformed input (no top-level autonomy: line)', () => {
    expect(replaceAutonomyDefault('autonomy:assist\n', 'auto')).toBeNull();
  });

  it('tolerates CR-LF line endings', () => {
    const yaml = 'autonomy:\r\n  default: assist\r\n';
    const out = replaceAutonomyDefault(yaml, 'auto');
    expect(out).toContain('  default: auto');
  });
});

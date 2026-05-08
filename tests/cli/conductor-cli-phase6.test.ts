import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autonomySet } from '../../src/cli/commands/autonomy.js';
import { brainStatus } from '../../src/cli/commands/brain.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-cli6-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(join(repo, '.conductor', 'config.yaml'), 'autonomy:\n  default: assist\n', 'utf8');
  return repo;
}

describe('Phase 6 CLI commands', () => {
  let repo: string;
  beforeEach(() => { repo = setupRepo(); });

  it('autonomy set auto rewrites config.yaml', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await autonomySet(repo, 'auto');
    writeSpy.mockRestore();
    const yaml = readFileSync(join(repo, '.conductor', 'config.yaml'), 'utf8');
    expect(yaml).toMatch(/default:\s*auto/);
  });

  it('autonomy set rejects invalid mode', async () => {
    await expect(autonomySet(repo, 'turbo')).rejects.toThrow(/Invalid autonomy mode/);
  });

  it('brain status prints "not running" when daemon is not running', async () => {
    const lines: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    await brainStatus(repo);
    writeSpy.mockRestore();
    expect(lines.join('')).toMatch(/not running|not-running|Brain: idle/i);
  });
});

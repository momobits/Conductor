import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadProjectConfig } from '../../src/config/load.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'sample-config.yaml');

describe('loadProjectConfig', () => {
  it('parses a complete config file', async () => {
    const config = await loadProjectConfig(fixture);
    expect(config.routing.default).toBe('claude-sonnet-4-6');
    expect(config.routing.functions.analyze).toBe('claude-opus-4-7');
    expect(config.autonomy.default).toBe('assist');
    expect(config.autonomy.transitions.discovered_to_planned).toBe('auto');
  });

  it('applies defaults for missing fields', async () => {
    const config = await loadProjectConfig(undefined, {
      routing: { default: 'claude-sonnet-4-6' },
    });
    expect(config.autonomy.default).toBe('assist');
    expect(config.autonomy.transitions.approved_to_building).toBe('manual');
    expect(config.routing.functions).toEqual({});
  });

  it('throws on invalid YAML', async () => {
    await expect(
      loadProjectConfig(undefined, '!@#$ this is definitely not yaml [[[' as unknown),
    ).rejects.toThrow();
  });
});

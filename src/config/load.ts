// src/config/load.ts
//
// Load and validate .conductor/config.yaml. Two entry points:
//   - loadProjectConfig(path): read from disk
//   - loadProjectConfig(undefined, raw): parse from a JS object or YAML string
// (the second form is for tests and importer flows that don't write to disk).

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import {
  ProjectConfigSchema,
  type ProjectConfig,
  sawLegacyAutonomyShape,
  resetLegacyAutonomyFlag,
} from './schema.js';

// Phase 30.7 / Relay #60: once-per-process latch so the deprecation warning
// for legacy autonomy.transitions.* config fires exactly once, even when
// config_set + multiple config_get calls re-parse during a session.
let _legacyAutonomyWarned = false;

export async function loadProjectConfig(
  path?: string,
  raw?: unknown,
): Promise<ProjectConfig> {
  let parsed: unknown;
  if (path !== undefined) {
    const text = await readFile(path, 'utf8');
    parsed = yaml.load(text);
  } else if (typeof raw === 'string') {
    parsed = yaml.load(raw);
  } else {
    parsed = raw ?? {};
  }
  resetLegacyAutonomyFlag();
  const out = ProjectConfigSchema.parse(parsed);
  if (sawLegacyAutonomyShape() && !_legacyAutonomyWarned) {
    _legacyAutonomyWarned = true;
    process.stderr.write(
      '[autonomy] DEPRECATED: legacy autonomy config detected (escort | auto | critical default, ' +
        'or autonomy.transitions.* per-edge block). Mapped to spectrum shape (assist | hybrid | ' +
        'autonomous). Update your .conductor/config.yaml: see docs/operations.md § Autonomy modes.\n',
    );
  }
  return out;
}

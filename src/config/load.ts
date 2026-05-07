// src/config/load.ts
//
// Load and validate .conductor/config.yaml. Two entry points:
//   - loadProjectConfig(path): read from disk
//   - loadProjectConfig(undefined, raw): parse from a JS object or YAML string
// (the second form is for tests and importer flows that don't write to disk).

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { ProjectConfigSchema, type ProjectConfig } from './schema.js';

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
  return ProjectConfigSchema.parse(parsed);
}

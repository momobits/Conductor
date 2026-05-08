// src/trackers/factory.ts
//
// Shared TrackerAdapter constructor used by both the CLI and the RPC
// method for tracker_pull. Reads config.tracker.api_key_env from
// process.env and instantiates Linear/GitHub. Returns null for kind=none.

import type { ProjectConfig } from '../config/schema.js';
import type { TrackerAdapter } from './tracker.js';
import { LinearAdapter } from './linear.js';
import { GitHubAdapter } from './github.js';

export function makeTrackerAdapter(cfg: ProjectConfig): TrackerAdapter | null {
  const t = cfg.tracker;
  if (t.kind === 'none') return null;
  const apiKey = process.env[t.api_key_env];
  if (!apiKey) throw new Error(`${t.api_key_env} is not set in the environment`);
  if (t.kind === 'linear') {
    return new LinearAdapter({
      apiKey,
      endpoint: t.endpoint,
      projectSlug: t.project_slug,
      activeStates: t.active_states,
    });
  }
  return new GitHubAdapter({
    apiKey,
    endpoint: t.endpoint,
    owner: t.owner,
    repo: t.repo,
    activeStates: t.active_states,
  });
}

// src/trackers/github.ts
//
// GitHubAdapter — read-only GitHub Issues REST client. v1 supports
// listActiveIssues (state filter), getIssue(number), and skips pull
// requests (GitHub returns PRs from /issues; we filter on pull_request).

import type { TrackerAdapter, TrackerIssue } from './tracker.js';

export interface GitHubAdapterArgs {
  apiKey: string;
  endpoint: string;
  owner: string;
  repo: string;
  activeStates: string[];
  fetchFn?: typeof fetch;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  pull_request?: unknown;
}

export class GitHubAdapter implements TrackerAdapter {
  readonly kind = 'github' as const;
  private readonly args: GitHubAdapterArgs;
  private readonly fetchFn: typeof fetch;

  constructor(args: GitHubAdapterArgs) {
    this.args = args;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  private async req(path: string): Promise<Response> {
    return this.fetchFn(`${this.args.endpoint}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.args.apiKey}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  }

  async listActiveIssues(): Promise<TrackerIssue[]> {
    const state = this.args.activeStates.includes('open') ? 'open' : 'all';
    const path = `/repos/${this.args.owner}/${this.args.repo}/issues?state=${state}&per_page=100`;
    const res = await this.req(path);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const issues = (await res.json()) as GitHubIssue[];
    return issues
      .filter((i) => i.pull_request === undefined && this.args.activeStates.includes(i.state))
      .map(toIssue);
  }

  async getIssue(trackerId: string): Promise<TrackerIssue | null> {
    const path = `/repos/${this.args.owner}/${this.args.repo}/issues/${trackerId}`;
    const res = await this.req(path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const i = (await res.json()) as GitHubIssue;
    if (i.pull_request !== undefined) return null;
    return toIssue(i);
  }
}

function toIssue(i: GitHubIssue): TrackerIssue {
  return {
    tracker: 'github',
    tracker_id: String(i.number),
    title: i.title,
    body: i.body ?? '',
    state: i.state,
    url: i.html_url,
    labels: i.labels.map((l) => l.name),
    created_at: i.created_at,
  };
}

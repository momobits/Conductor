// src/trackers/linear.ts
//
// LinearAdapter — read-only Linear GraphQL client. v1 supports
// listActiveIssues (filtered by state name) and getIssue(identifier).
// All HTTP through the injected fetchFn for unit-testability.

import type { TrackerAdapter, TrackerIssue } from './tracker.js';

export interface LinearAdapterArgs {
  apiKey: string;
  endpoint: string;
  projectSlug: string;
  activeStates: string[];
  fetchFn?: typeof fetch;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
  url: string;
  labels: { nodes: Array<{ name: string }> };
  createdAt: string;
}

const LIST_QUERY = `
  query ListIssues($slug: String!) {
    team(id: $slug) {
      issues(first: 100) {
        nodes {
          id identifier title description url createdAt
          state { name }
          labels { nodes { name } }
        }
      }
    }
  }
`;

const GET_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) {
      id identifier title description url createdAt
      state { name }
      labels { nodes { name } }
    }
  }
`;

export class LinearAdapter implements TrackerAdapter {
  readonly kind = 'linear' as const;
  private readonly args: LinearAdapterArgs;
  private readonly fetchFn: typeof fetch;

  constructor(args: LinearAdapterArgs) {
    this.args = args;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  private async query<T>(q: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(this.args.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.args.apiKey,
      },
      body: JSON.stringify({ query: q, variables }),
    });
    if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
    return (await res.json()) as T;
  }

  async listActiveIssues(): Promise<TrackerIssue[]> {
    const resp = await this.query<{ data: { team: { issues: { nodes: LinearIssueNode[] } } } }>(LIST_QUERY, {
      slug: this.args.projectSlug,
    });
    const nodes = resp.data?.team?.issues?.nodes ?? [];
    const allowed = new Set(this.args.activeStates);
    return nodes.filter((n) => allowed.has(n.state.name)).map(toIssue);
  }

  async getIssue(trackerId: string): Promise<TrackerIssue | null> {
    const resp = await this.query<{ data: { issue: LinearIssueNode | null } }>(GET_QUERY, { id: trackerId });
    return resp.data?.issue ? toIssue(resp.data.issue) : null;
  }
}

function toIssue(n: LinearIssueNode): TrackerIssue {
  return {
    tracker: 'linear',
    tracker_id: n.identifier,
    title: n.title,
    body: n.description ?? '',
    state: n.state.name,
    url: n.url,
    labels: n.labels.nodes.map((l) => l.name),
    created_at: n.createdAt,
  };
}

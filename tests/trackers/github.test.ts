import { describe, it, expect } from 'vitest';
import { GitHubAdapter } from '../../src/trackers/github.js';

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

const ISSUES_PAYLOAD = [
  {
    number: 456,
    title: 'Refactor logging',
    body: 'See incident X',
    state: 'open',
    html_url: 'https://github.com/acme/widgets/issues/456',
    labels: [{ name: 'tech-debt' }],
    created_at: '2026-04-15T00:00:00Z',
    pull_request: undefined,
  },
  {
    number: 457,
    title: 'PR — not an issue',
    body: '',
    state: 'open',
    html_url: 'https://github.com/acme/widgets/pull/457',
    labels: [],
    created_at: '2026-04-16T00:00:00Z',
    pull_request: { url: 'pr-url' },
  },
];

describe('GitHubAdapter', () => {
  it('listActiveIssues normalizes REST payload and filters PRs', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'acme',
      repo: 'widgets',
      activeStates: ['open'],
      fetchFn: stubFetch(ISSUES_PAYLOAD),
    });
    const issues = await a.listActiveIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.tracker).toBe('github');
    expect(issues[0]?.tracker_id).toBe('456');
    expect(issues[0]?.labels).toEqual(['tech-debt']);
  });

  it('throws on 404', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'nope',
      repo: 'nope',
      activeStates: ['open'],
      fetchFn: stubFetch({ message: 'Not Found' }, 404),
    });
    await expect(a.listActiveIssues()).rejects.toThrow(/404/);
  });

  it('getIssue returns null on 404', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'acme',
      repo: 'widgets',
      activeStates: ['open'],
      fetchFn: stubFetch({ message: 'Not Found' }, 404),
    });
    const i = await a.getIssue('999');
    expect(i).toBeNull();
  });

  it('getIssue returns null when the response is a PR', async () => {
    const a = new GitHubAdapter({
      apiKey: 'ghp-token',
      endpoint: 'https://api.github.com',
      owner: 'acme',
      repo: 'widgets',
      activeStates: ['open'],
      fetchFn: stubFetch({
        number: 11,
        title: 'PR',
        body: '',
        state: 'open',
        html_url: 'pr',
        labels: [],
        created_at: '2026-05-01T00:00:00Z',
        pull_request: { url: 'pr' },
      }),
    });
    expect(await a.getIssue('11')).toBeNull();
  });
});

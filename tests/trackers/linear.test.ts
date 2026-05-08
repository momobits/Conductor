import { describe, it, expect } from 'vitest';
import { LinearAdapter } from '../../src/trackers/linear.js';

function stubFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      async json() {
        return body;
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

const TEAM_PAYLOAD = {
  data: {
    team: {
      issues: {
        nodes: [
          {
            id: 'uuid-1',
            identifier: 'ABC-123',
            title: 'Auth token expires silently',
            description: 'Body of the issue',
            state: { name: 'Todo' },
            url: 'https://linear.app/team/issue/ABC-123',
            labels: { nodes: [{ name: 'bug' }] },
            createdAt: '2026-05-01T00:00:00Z',
          },
        ],
      },
    },
  },
};

describe('LinearAdapter', () => {
  it('listActiveIssues normalizes Linear payload to TrackerIssue[]', async () => {
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo', 'In Progress'],
      fetchFn: stubFetch(TEAM_PAYLOAD),
    });
    const issues = await a.listActiveIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.tracker).toBe('linear');
    expect(issues[0]?.tracker_id).toBe('ABC-123');
    expect(issues[0]?.title).toBe('Auth token expires silently');
    expect(issues[0]?.state).toBe('Todo');
    expect(issues[0]?.labels).toEqual(['bug']);
  });

  it('throws on non-200', async () => {
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo'],
      fetchFn: stubFetch({}, false, 401),
    });
    await expect(a.listActiveIssues()).rejects.toThrow(/401/);
  });

  it('skips issues whose state is not in activeStates', async () => {
    const mixed = {
      data: {
        team: {
          issues: {
            nodes: [
              {
                id: '1',
                identifier: 'A-1',
                title: 't1',
                description: '',
                state: { name: 'Todo' },
                url: 'u1',
                labels: { nodes: [] },
                createdAt: '2026-05-01T00:00:00Z',
              },
              {
                id: '2',
                identifier: 'A-2',
                title: 't2',
                description: '',
                state: { name: 'Done' },
                url: 'u2',
                labels: { nodes: [] },
                createdAt: '2026-05-01T00:00:00Z',
              },
            ],
          },
        },
      },
    };
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo'],
      fetchFn: stubFetch(mixed),
    });
    const issues = await a.listActiveIssues();
    expect(issues.map((i) => i.tracker_id)).toEqual(['A-1']);
  });

  it('getIssue returns null when API returns null issue', async () => {
    const a = new LinearAdapter({
      apiKey: 'lin-key',
      endpoint: 'https://api.linear.app/graphql',
      projectSlug: 'team-foo',
      activeStates: ['Todo'],
      fetchFn: stubFetch({ data: { issue: null } }),
    });
    const i = await a.getIssue('NOPE-1');
    expect(i).toBeNull();
  });
});

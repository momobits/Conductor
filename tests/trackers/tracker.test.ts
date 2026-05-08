import { describe, it, expect } from 'vitest';
import type { TrackerAdapter, TrackerIssue } from '../../src/trackers/tracker.js';

describe('TrackerAdapter contract', () => {
  it('TrackerIssue carries the fields a card needs', () => {
    const issue: TrackerIssue = {
      tracker: 'linear',
      tracker_id: 'ABC-123',
      title: 'sample',
      body: 'body',
      state: 'Todo',
      url: 'https://linear.app/team/issue/ABC-123',
      labels: ['bug'],
      created_at: '2026-05-08T00:00:00Z',
    };
    expect(issue.tracker_id).toBe('ABC-123');
  });

  it('a TrackerAdapter is callable as listActiveIssues + getIssue', async () => {
    const dummy: TrackerAdapter = {
      kind: 'linear',
      async listActiveIssues() {
        return [];
      },
      async getIssue() {
        return null;
      },
    };
    expect(dummy.kind).toBe('linear');
    expect(await dummy.listActiveIssues()).toEqual([]);
    expect(await dummy.getIssue('x')).toBeNull();
  });
});

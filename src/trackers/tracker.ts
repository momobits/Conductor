// src/trackers/tracker.ts
//
// TrackerAdapter is the abstraction over external issue trackers (Linear,
// GitHub). Symmetric to ModelAdapter; engine code calls
// adapter.listActiveIssues() and the tracker_pull op normalizes results
// into Cards.

export type TrackerKind = 'linear' | 'github';

export interface TrackerIssue {
  tracker: TrackerKind;
  tracker_id: string; // e.g. 'ABC-123' (linear) or '456' (github)
  title: string;
  body: string;
  state: string; // tracker-specific state name
  url: string;
  labels: string[];
  created_at: string; // ISO 8601
}

export interface TrackerAdapter {
  readonly kind: TrackerKind;
  listActiveIssues(): Promise<TrackerIssue[]>;
  getIssue(trackerId: string): Promise<TrackerIssue | null>;
}

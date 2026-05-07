// src/engine/ops/exercise.ts
//
// Exercise op family: capability-mapping + scenario-running across a
// shared session at .conductor/exercise/<id>/_control.md.

import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, ExerciseSession, ExerciseFinding } from '../types.js';

const MAP_PROMPT = `You are designing exercise scenarios that exercise the
user's stated goal. Produce 3-7 specific scenarios that, if walked end-to-end,
would surface gaps, regressions, or unhandled edges.

Return ONLY a single JSON object on one line:

  { "scenarios": ["<scenario>", ...] }`.trim();

const RUN_PROMPT = `You are running exercise scenarios and reporting
findings. For each scenario, surface anything observable: bugs, gaps,
ambiguous behavior, missing docs.

Return ONLY a single JSON object on one line:

  { "findings": [
      { "id": "<short slug>", "scenario": "<scenario>", "observed": "<what>", "severity": "note"|"low"|"medium"|"high", "evidence": "<where/how>" },
      ...
    ]
  }`.trim();

function sessionDir(repo: string, id: string): string {
  return join(repo, '.conductor', 'exercise', id);
}

function controlPath(repo: string, id: string): string {
  return join(sessionDir(repo, id), '_control.md');
}

export interface ExerciseMapArgs {
  repo: string;
  adapter: ModelAdapter;
  model: string;
  sessionId: string;
  goal: string;
}

export async function exerciseMap(args: ExerciseMapArgs): Promise<ExerciseSession> {
  const { repo, adapter, model, sessionId, goal } = args;
  const resp = await adapter.invoke({
    operation: 'exercise_map',
    model,
    system: MAP_PROMPT,
    user: `Goal: ${goal}`,
  });
  let scenarios: string[];
  try {
    const raw = JSON.parse(resp.text.trim());
    scenarios = Array.isArray(raw.scenarios) ? raw.scenarios.map(String) : [];
  } catch (e) {
    throw new Error(`Failed to parse exercise_map JSON: ${(e as Error).message}\n${resp.text}`);
  }

  const session: ExerciseSession = {
    id: sessionId,
    goal,
    scenarios,
    findings: [],
    created: new Date().toISOString(),
  };

  await mkdir(sessionDir(repo, sessionId), { recursive: true });
  const md = [
    `# Exercise session: ${sessionId}`,
    '',
    `**Goal:** ${goal}`,
    `**Created:** ${session.created}`,
    '',
    '## Scenarios',
    '',
    ...scenarios.map((s) => `- ${s}`),
    '',
    '## Findings',
    '',
    '_(none yet)_',
    '',
  ].join('\n');
  await writeFile(controlPath(repo, sessionId), md, 'utf8');
  return session;
}

export interface ExerciseRunArgs {
  repo: string;
  adapter: ModelAdapter;
  model: string;
  session: ExerciseSession;
}

export async function exerciseRun(args: ExerciseRunArgs): Promise<ExerciseFinding[]> {
  const { repo, adapter, model, session } = args;
  const resp = await adapter.invoke({
    operation: 'exercise_run',
    model,
    system: RUN_PROMPT,
    user: [
      `Goal: ${session.goal}`,
      'Scenarios:',
      ...session.scenarios.map((s) => `- ${s}`),
    ].join('\n'),
  });
  let findings: ExerciseFinding[];
  try {
    const raw = JSON.parse(resp.text.trim());
    findings = Array.isArray(raw.findings) ? raw.findings.map((f: unknown) => {
      const o = f as Record<string, unknown>;
      return {
        id: String(o.id ?? ''),
        scenario: String(o.scenario ?? ''),
        observed: String(o.observed ?? ''),
        severity: o.severity as ExerciseFinding['severity'],
        evidence: String(o.evidence ?? ''),
      };
    }) : [];
  } catch (e) {
    throw new Error(`Failed to parse exercise_run JSON: ${(e as Error).message}\n${resp.text}`);
  }

  session.findings.push(...findings);

  const append = [
    '',
    '### Run @ ' + new Date().toISOString(),
    '',
    ...findings.map((f) => `- **${f.id}** (${f.severity}) [${f.scenario}] — ${f.observed} _(evidence: ${f.evidence})_`),
    '',
  ].join('\n');
  await appendFile(controlPath(repo, session.id), append, 'utf8');

  return findings;
}

export interface ExerciseFileArgs {
  session: ExerciseSession;
  finding: ExerciseFinding;
  now: Date;
}

export async function exerciseFile(args: ExerciseFileArgs): Promise<Card> {
  const { session, finding, now } = args;
  const dateStr = now.toISOString().slice(0, 10);
  const slug = finding.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const id = `${dateStr}-${slug}`;
  const body = [
    `# Original Finding`,
    '',
    `Scenario: ${finding.scenario}`,
    `Severity: ${finding.severity}`,
    `Observed: ${finding.observed}`,
    `Evidence: ${finding.evidence}`,
    '',
  ].join('\n');
  return {
    frontmatter: {
      id,
      title: `${finding.observed.slice(0, 60)}`,
      kind: 'exercise-finding',
      column: 'discovered',
      phase: 'unassigned',
      priority: finding.severity === 'high' ? 1 : finding.severity === 'medium' ? 2 : 3,
      autonomy: 'inherit',
      model_overrides: {},
      created: now.toISOString(),
      source: `exercise:${session.id}`,
      labels: [],
      blocked_by: [],
    },
    body,
    path: '', // caller fills in once it knows the cards directory
  };
}

export interface AppendFindingArgs {
  repo: string;
  sessionId: string;
  finding: {
    scenario: string;
    observed: string;
    severity: 'note' | 'low' | 'medium' | 'high';
    evidence?: string;
  };
}

export async function appendExerciseFinding(args: AppendFindingArgs): Promise<void> {
  const dir = sessionDir(args.repo, args.sessionId);
  await mkdir(dir, { recursive: true });
  const ctrl = controlPath(args.repo, args.sessionId);
  const lines = [
    `\n### Finding: ${args.finding.scenario}`,
    `- severity: ${args.finding.severity}`,
    `- observed: ${args.finding.observed}`,
  ];
  if (args.finding.evidence) {
    lines.push(`- evidence: ${args.finding.evidence}`);
  }
  await appendFile(ctrl, `${lines.join('\n')}\n`);
}

export interface ExerciseAutoArgs {
  repo: string;
  adapter: ModelAdapter;
  model: string;
  sessionId: string;
  goal: string;
  now: Date;
}

export interface ExerciseAutoResult {
  session: ExerciseSession;
  cards: Card[];
}

export async function exerciseAuto(args: ExerciseAutoArgs): Promise<ExerciseAutoResult> {
  const session = await exerciseMap({
    repo: args.repo, adapter: args.adapter, model: args.model,
    sessionId: args.sessionId, goal: args.goal,
  });
  const findings = await exerciseRun({
    repo: args.repo, adapter: args.adapter, model: args.model, session,
  });
  const cards: Card[] = [];
  for (const f of findings) {
    cards.push(await exerciseFile({ session, finding: f, now: args.now }));
  }
  return { session, cards };
}

// tests/integration/full-lifecycle-sweep.test.ts
//
// Cohort 3.1 guard: drive ONE card all the way through the 7-column
// lifecycle (discovered -> planned -> approved -> building -> verifying ->
// shipped -> archived) through the REAL walker (TaskAgent, the same code
// path `conductor work` + the RPC `work_card` use), backed by a scripted
// MockAdapter. The prior Phase-6 e2e deliberately seeded an EMPTY queue to
// avoid driving a real card, so nothing in the suite ever proved a card can
// actually traverse the pipeline end-to-end. This is that missing test.
//
// TaskAgent.run() advances exactly ONE column per call (it switches on the
// card's CURRENT column, runs that column's op(s), performs the gated
// transition, then returns). So a full sweep re-instantiates a fresh
// TaskAgent per column and drains its event stream, re-reading the card's
// `column` between hops. This mirrors how the daemon's per-card driver
// re-enters the walker each iteration.
//
// Determinism: no real API keys. The MockAdapter is a FIFO queue consumed in
// op-invocation order; we push exactly the responses each op needs, in order:
//   discovered: analyze (text) , plan (text)
//   planned:    review  (JSON APPROVED)
//   approved:   implement (JSON diff w/ one create file)   [needs step]
//   building:   verify  (JSON PASS)   [runner stubbed, no real command]
//   verifying:  notebook (NO adapter call — deterministic)
//   shipped:    resolve (JSON summary)

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { readCard } from '../../src/engine/state/card.js';
import { readRunArtifact } from '../../src/agent/run_artifact.js';
import type { TaskEvent } from '../../src/agent/events.js';
import type { Column } from '../../src/engine/types.js';

// All six lifecycle edges set to `auto` so transitionPolicy() returns 'auto'
// (its default is 'manual', which would halt instead of advance). Matches the
// fully-autonomous config the Phase-6 e2e fixture uses.
const AUTO_CONFIG = ProjectConfigSchema.parse({
  routing: { default: 'mock' },
  verify_command: 'echo ok',
  autonomy: {
    default: 'auto',
    transitions: {
      discovered_to_planned: 'auto',
      planned_to_approved: 'auto',
      approved_to_building: 'auto',
      building_to_verifying: 'auto',
      verifying_to_shipped: 'auto',
      shipped_to_archived: 'auto',
    },
  },
});

async function setupGitRepo(cardId: string): Promise<{ repo: string; cardPath: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-lifecycle-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });

  // The implement op commits per step via simple-git, so the working tree must
  // be a real git repo with an identity + at least one prior commit (so
  // lastCommitSha() in resolve has something to read).
  const git = simpleGit(repo);
  await git.init();
  await git.addConfig('user.email', 'test@conductor.test');
  await git.addConfig('user.name', 'Conductor Test');
  await git.addConfig('commit.gpgsign', 'false');

  const cardPath = join(cardsDir, `${cardId}.md`);
  writeFileSync(
    cardPath,
    `---
id: ${cardId}
title: Full lifecycle sweep card
kind: feature
column: discovered
phase: cohort-3
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-30T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Drive me through the whole pipeline.
`,
    'utf8',
  );
  // Seed an initial commit so the repo has history before implement's first
  // step commit, and so resolve's lastCommitSha() has a sha to report.
  await git.add(['.conductor/cards/' + cardId + '.md']);
  await git.commit('chore: seed card');

  return { repo, cardPath };
}

/** Drain one TaskAgent.run() (one column hop) and collect its events.
 *
 *  `now` is injected per-hop with a distinct timestamp so each hop produces a
 *  distinct runId. runId is derived as `YYYYMMDDTHHMMSS-<cardId>` (second
 *  precision); without distinct timestamps all six hops would collide on one
 *  run dir within the same wall-clock second, and each op's `<op>.md` would
 *  overwrite the previous hop's in that single dir. A monotonically-advancing
 *  injected clock mirrors production (where hops are minutes apart) and keeps
 *  every op's artifact addressable. */
async function runOneHop(args: {
  repo: string;
  cardId: string;
  adapter: MockAdapter;
  step?: string;
  now: () => Date;
}): Promise<TaskEvent[]> {
  const agent = new TaskAgent({
    repo: args.repo,
    cardId: args.cardId,
    adapter: args.adapter,
    config: AUTO_CONFIG,
    step: args.step,
    // Stub the verify runner so 'building' never shells out to a real command.
    runner: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    now: args.now,
  });
  const events: TaskEvent[] = [];
  for await (const e of agent.run()) events.push(e);
  return events;
}

/** Distinct second-precision clock per hop (1 minute apart) so each hop's
 *  runId is unique. */
function hopClock(hopIndex: number): () => Date {
  const base = Date.UTC(2026, 4, 30, 12, 0, 0); // 2026-05-30T12:00:00Z
  return () => new Date(base + hopIndex * 60_000);
}

async function columnOf(cardPath: string): Promise<Column> {
  return (await readCard(cardPath)).frontmatter.column;
}

async function commitCount(repo: string): Promise<number> {
  const git = simpleGit(repo);
  const log = await git.log();
  return log.total;
}

describe('Full lifecycle card sweep (Cohort 3.1 guard)', () => {
  it('drives one card discovered -> archived through the real walker, persisting per-op artifacts + git commits', async () => {
    const cardId = '2026-05-30-lifecycle-sweep';
    const { repo, cardPath } = await setupGitRepo(cardId);

    expect(await columnOf(cardPath)).toBe('discovered');
    const commitsBefore = await commitCount(repo);

    // ---- Hop 1: discovered -> planned (analyze + plan) ----
    // analyze returns plain text; plan returns the atomic-step markdown that
    // review/implement will later read from the substrate.
    const planText = [
      '### Resolved decisions from analysis',
      '- Create a hello module at src/hello.ts',
      '',
      '### Step 1.1 — add hello module',
      'WHAT: create src/hello.ts',
      'HOW: write an exported greeting function',
      'WHY: completes the issue',
      'RISK: low',
      'VERIFY: tests import it',
      'ROLLBACK: delete the file',
    ].join('\n');
    const hop1Adapter = new MockAdapter([
      'Validation: issue exists. Root Cause: missing module. Blast Radius: 1 file. Approach: add it.',
      planText,
    ]);
    const hop1 = await runOneHop({ repo, cardId, adapter: hop1Adapter, now: hopClock(0) });
    expect(hop1[hop1.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'planned' });
    expect(await columnOf(cardPath)).toBe('planned');

    // ---- Hop 2: planned -> approved (review APPROVED) ----
    const hop2Adapter = new MockAdapter([
      JSON.stringify({ decision: 'APPROVED', reasoning: 'Plan is sound.', changes_required: [] }),
    ]);
    const hop2 = await runOneHop({ repo, cardId, adapter: hop2Adapter, now: hopClock(1) });
    expect(hop2[hop2.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'approved' });
    expect(await columnOf(cardPath)).toBe('approved');

    // ---- Hop 3: approved -> building (implement step 1.1, applies a file + commits) ----
    const hop3Adapter = new MockAdapter([
      JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add hello module',
        files: [
          { path: 'src/hello.ts', action: 'create', content: 'export const hello = () => "hi";\n' },
        ],
        notes: 'created the hello module',
      }),
    ]);
    const hop3 = await runOneHop({ repo, cardId, adapter: hop3Adapter, step: '1.1', now: hopClock(2) });
    expect(hop3[hop3.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'building' });
    expect(await columnOf(cardPath)).toBe('building');
    // implement applied the diff to disk.
    expect(existsSync(join(repo, 'src', 'hello.ts'))).toBe(true);
    expect(readFileSync(join(repo, 'src', 'hello.ts'), 'utf8')).toContain('export const hello');

    // ---- Hop 4: building -> verifying (verify PASS) ----
    const hop4Adapter = new MockAdapter([
      JSON.stringify({ outcome: 'PASS', summary: 'All checks pass.', failures: [] }),
    ]);
    const hop4 = await runOneHop({ repo, cardId, adapter: hop4Adapter, now: hopClock(3) });
    expect(hop4[hop4.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'verifying' });
    expect(await columnOf(cardPath)).toBe('verifying');

    // ---- Hop 5: verifying -> shipped (notebook — deterministic, NO adapter call) ----
    const hop5Adapter = new MockAdapter([]); // notebook makes no adapter.invoke()
    const hop5 = await runOneHop({ repo, cardId, adapter: hop5Adapter, now: hopClock(4) });
    expect(hop5[hop5.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'shipped' });
    expect(await columnOf(cardPath)).toBe('shipped');
    // notebook wrote the .ipynb artifact.
    expect(existsSync(join(repo, '.conductor', 'archive', 'notebooks', `${cardId}.ipynb`))).toBe(true);

    // ---- Hop 6: shipped -> archived (resolve — moves card to archive) ----
    const hop6Adapter = new MockAdapter([
      JSON.stringify({ summary: 'Shipped the hello module.', files_changed: ['src/hello.ts'] }),
    ]);
    const hop6 = await runOneHop({ repo, cardId, adapter: hop6Adapter, now: hopClock(5) });
    expect(hop6[hop6.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'archived' });

    // ---- Final lifecycle assertions ----
    // (a) Card ended at archived. resolve() removes the card from cards/ and
    //     writes it to archive/cards/ with column flipped to 'archived'.
    expect(existsSync(cardPath)).toBe(false);
    const archivedCardPath = join(repo, '.conductor', 'archive', 'cards', `${cardId}.md`);
    expect(existsSync(archivedCardPath)).toBe(true);
    expect((await readCard(archivedCardPath)).frontmatter.column).toBe('archived');
    // resolve also wrote the implemented summary.
    expect(existsSync(join(repo, '.conductor', 'archive', 'implemented', `${cardId}.md`))).toBe(true);

    // (b) Each op's artifact persisted in the per-run substrate. We re-find
    //     the run dirs by scanning .conductor/runs (the artifact runIds differ
    //     per hop — each hop got a distinct injected clock). Assert each op
    //     kind produced a usable artifact in some run dir.
    const { readdirSync } = await import('node:fs');
    const runsDir = join(repo, '.conductor', 'runs');
    const runIds = readdirSync(runsDir);
    // Six hops with distinct second-precision clocks → up to 6 run dirs (the
    // analyze+plan hop shares one dir; one dir per subsequent hop).
    expect(runIds.length).toBeGreaterThanOrEqual(5);

    const opPresent = async (op: 'analyze' | 'plan' | 'review' | 'implement' | 'verify' | 'notebook'): Promise<boolean> => {
      for (const runId of runIds) {
        const text = await readRunArtifact(repo, runId, op);
        if (text && text.trim().length > 0) return true;
      }
      return false;
    };
    expect(await opPresent('analyze')).toBe(true);
    expect(await opPresent('plan')).toBe(true);
    expect(await opPresent('review')).toBe(true);
    expect(await opPresent('implement')).toBe(true);
    expect(await opPresent('verify')).toBe(true);
    expect(await opPresent('notebook')).toBe(true);

    // (c) Git commits were created during the walk. implement commits its step
    //     (`feat(cohort-3.1.1): add hello module`); the count must exceed the
    //     pre-walk baseline (the seed commit).
    const commitsAfter = await commitCount(repo);
    expect(commitsAfter).toBeGreaterThan(commitsBefore);
    const git = simpleGit(repo);
    const log = await git.log();
    const subjects = log.all.map((c) => c.message);
    expect(subjects.some((s) => s.includes('add hello module'))).toBe(true);
    // The implement commit carries the Control commit-per-step scope shape
    // `feat(<phase>.<step>): ...` → `feat(cohort-3.1.1): ...`.
    expect(subjects.some((s) => /^feat\(cohort-3\.1\.1\):/.test(s))).toBe(true);
  });
});

// tests/integration/offline-lifecycle.test.ts
//
// Keyless end-to-end guard: drive ONE card all the way through the 7-column
// lifecycle (discovered -> planned -> approved -> building -> verifying ->
// shipped -> archived) through the REAL walker (TaskAgent) backed by the REAL
// RoutingAdapter (NOT a MockAdapter) with routing.default = 'offline'.
//
// This proves the pipeline runs end-to-end with NO API keys and NO injected
// adapter: TaskAgent constructs `new RoutingAdapter()` itself when none is
// passed, RoutingAdapter resolves the 'offline' model id to the OfflineAdapter
// via resolveProvider, and every op consumes the OfflineAdapter's deterministic
// response. Mirrors tests/integration/full-lifecycle-sweep.test.ts (temp git
// repo, fully-`auto` autonomy.transitions, --step for the approved column).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { readCard } from '../../src/engine/state/card.js';
import type { TaskEvent } from '../../src/agent/events.js';
import type { Column } from '../../src/engine/types.js';

// routing.default = 'offline' → every op resolves to the OfflineAdapter through
// the REAL RoutingAdapter (TaskAgent builds it when no adapter is injected).
// All six lifecycle edges set to 'auto' so transitionPolicy() advances instead
// of halting.
const OFFLINE_CONFIG = ProjectConfigSchema.parse({
  routing: { default: 'offline' },
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
  const repo = mkdtempSync(join(tmpdir(), 'conductor-offline-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });

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
title: Offline keyless lifecycle card
kind: feature
column: discovered
phase: offline-demo
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-30T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Drive me through the whole pipeline with NO API keys.
`,
    'utf8',
  );
  await git.add(['.conductor/cards/' + cardId + '.md']);
  await git.commit('chore: seed card');

  return { repo, cardPath };
}

async function runOneHop(args: {
  repo: string;
  cardId: string;
  step?: string;
  now: () => Date;
}): Promise<TaskEvent[]> {
  // NOTE: no `adapter` passed → TaskAgent constructs `new RoutingAdapter()`.
  // This is the real CLI/RPC code path; routing.default='offline' selects the
  // OfflineAdapter for every op. No API keys, no MockAdapter.
  const agent = new TaskAgent({
    repo: args.repo,
    cardId: args.cardId,
    config: OFFLINE_CONFIG,
    step: args.step,
    // Stub the verify runner so 'building' never shells out to a real command;
    // the offline adapter classifies the (stubbed) output as PASS.
    runner: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    now: args.now,
  });
  const events: TaskEvent[] = [];
  for await (const e of agent.run()) events.push(e);
  return events;
}

function hopClock(hopIndex: number): () => Date {
  const base = Date.UTC(2026, 4, 30, 12, 0, 0);
  return () => new Date(base + hopIndex * 60_000);
}

async function columnOf(cardPath: string): Promise<Column> {
  return (await readCard(cardPath)).frontmatter.column;
}

async function commitCount(repo: string): Promise<number> {
  return (await simpleGit(repo).log()).total;
}

describe('Offline keyless lifecycle (real RoutingAdapter, no API keys)', () => {
  it('drives one card discovered -> archived through the real walker + RoutingAdapter with model "offline"', async () => {
    const cardId = '2026-05-30-offline-lifecycle';
    const { repo, cardPath } = await setupGitRepo(cardId);

    expect(await columnOf(cardPath)).toBe('discovered');
    const commitsBefore = await commitCount(repo);

    // Hop 1: discovered -> planned (analyze + plan, both via OfflineAdapter).
    const hop1 = await runOneHop({ repo, cardId, now: hopClock(0) });
    expect(hop1[hop1.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'planned' });
    expect(await columnOf(cardPath)).toBe('planned');

    // Hop 2: planned -> approved (review returns APPROVED).
    const hop2 = await runOneHop({ repo, cardId, now: hopClock(1) });
    expect(hop2[hop2.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'approved' });
    expect(await columnOf(cardPath)).toBe('approved');

    // Hop 3: approved -> building (implement step 1.1 emits a fresh file + commits).
    const hop3 = await runOneHop({ repo, cardId, step: '1.1', now: hopClock(2) });
    expect(hop3[hop3.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'building' });
    expect(await columnOf(cardPath)).toBe('building');

    // The offline implement file was created on disk (placeholder, not real code).
    const offlineFile = join(repo, 'conductor-offline', 'step-1.1.md');
    expect(existsSync(offlineFile)).toBe(true);
    expect(readFileSync(offlineFile, 'utf8')).toContain('Offline placeholder');

    // Hop 4: building -> verifying (verify classified PASS).
    const hop4 = await runOneHop({ repo, cardId, now: hopClock(3) });
    expect(hop4[hop4.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'verifying' });
    expect(await columnOf(cardPath)).toBe('verifying');

    // Hop 5: verifying -> shipped (notebook — deterministic, no adapter call).
    const hop5 = await runOneHop({ repo, cardId, now: hopClock(4) });
    expect(hop5[hop5.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'shipped' });
    expect(await columnOf(cardPath)).toBe('shipped');

    // Hop 6: shipped -> archived (resolve summary, then archive move).
    const hop6 = await runOneHop({ repo, cardId, now: hopClock(5) });
    expect(hop6[hop6.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'archived' });

    // Card reached archived: removed from cards/, written to archive/cards/.
    expect(existsSync(cardPath)).toBe(false);
    const archivedCardPath = join(repo, '.conductor', 'archive', 'cards', `${cardId}.md`);
    expect(existsSync(archivedCardPath)).toBe(true);
    expect((await readCard(archivedCardPath)).frontmatter.column).toBe('archived');
    expect(existsSync(join(repo, '.conductor', 'archive', 'implemented', `${cardId}.md`))).toBe(true);

    // Commits were made during the walk (the implement step commit).
    const commitsAfter = await commitCount(repo);
    expect(commitsAfter).toBeGreaterThan(commitsBefore);
    const subjects = (await simpleGit(repo).log()).all.map((c) => c.message);
    // implement commits with Control's `<type>(<phase>.<step>): ...` scope shape.
    expect(subjects.some((s) => /^chore\(offline-demo\.1\.1\):/.test(s))).toBe(true);
  });
});

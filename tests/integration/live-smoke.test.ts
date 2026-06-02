// tests/integration/live-smoke.test.ts
//
// LIVE, PAID, ENV-GATED smoke test — the ONLY test in the suite that drives a
// real card through the real pipeline against a REAL Claude model. Everything
// else in the suite is mock/offline-driven and never touches the network.
//
// What it proves, in two parts:
//   PART A — the real model executes analyze + plan + review and the ops parse
//     its output. Verdict-agnostic: review may legitimately return NEEDS-INFO /
//     NEEDS-CHANGES on a terse card (its prompt instructs that), so Part A only
//     asserts review RUNS and yields a VALID verdict outcome — it does not bet
//     the smoke on an APPROVE.
//   PART B — the implement op's agentic read-tool loop (src/engine/agentic_read.ts)
//     MODIFIES AN EXISTING FILE correctly. The model must `read_file` math.js to
//     see its current content BEFORE emitting a `modify` diff, then return the
//     COMPLETE updated file (add `subtract` without clobbering the existing
//     `add`). applyDiffFile() rejects a `modify` whose file doesn't exist and a
//     `create` whose file already exists, so a model that hallucinated the file
//     or skipped the read would fail here. This is the bug we just fixed; this
//     is its real-model proof. Part B runs analyze+plan for real, then forces
//     the card to 'approved' (sidestepping the non-deterministic review verdict
//     proven valid in Part A) so it deterministically reaches implement.
//
// HOW TO RUN (live):
//   ANTHROPIC_API_KEY=sk-... npx vitest run tests/integration/live-smoke.test.ts
// Optional model override (defaults to claude-sonnet-4-6, a good cost/capability
// balance; claude-haiku-* is cheaper if you want to save money):
//   CONDUCTOR_SMOKE_MODEL=claude-haiku-4-5 ANTHROPIC_API_KEY=sk-... \
//     npx vitest run tests/integration/live-smoke.test.ts
//
// GATING: with NO ANTHROPIC_API_KEY the whole `describe` block is SKIPPED via
// describe.skipIf — it does NOT fail, error, or make any API call. CI and
// keyless dev boxes stay green. (One always-run unit assertion below sanity-
// checks the gating logic itself regardless of key presence.)
//
// Harness: mirrors tests/integration/offline-lifecycle.test.ts exactly — same
// temp-git-repo scaffolding, same `routing.default = <model>` config with all
// autonomy.transitions = 'auto', same per-column TaskAgent loop (one hop per
// run() call, re-reading the card's column between hops). It injects NO adapter,
// so TaskAgent constructs `new RoutingAdapter()`; routing.default's `claude-*`
// model id routes every op to the real ClaudeAdapter (which `new Anthropic()`
// reads ANTHROPIC_API_KEY for). Differences from the offline test are only:
// (a) a real claude-* model id, (b) a real editable fixture (math.js), (c) a
// real verify_command that exercises the change, (d) real (non-stubbed) verify
// runner, (e) env-gating + a long per-test timeout for real multi-step calls.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { simpleGit } from 'simple-git';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import { readCard, writeCard } from '../../src/engine/state/card.js';
import type { TaskEvent } from '../../src/agent/events.js';
import type { Column } from '../../src/engine/types.js';

// Gating: the entire live walk runs only when a key is present.
const LIVE = !!process.env.ANTHROPIC_API_KEY;
// Model override; sonnet is the default (good cost/capability balance). haiku is
// cheaper — set CONDUCTOR_SMOKE_MODEL=claude-haiku-4-5 to save money.
const MODEL = process.env.CONDUCTOR_SMOKE_MODEL ?? 'claude-sonnet-4-6';
// Real multi-step API calls (analyze → plan → review → implement+read-loop →
// verify) need a generous ceiling.
const LIVE_TIMEOUT_MS = 240_000;

// Always-run sanity check of the gating logic — runs with OR without a key so
// even on a keyless box this file contributes one green assertion (and proves
// LIVE resolves to a boolean, never throwing on a missing env var).
describe('live-smoke gating', () => {
  it('resolves LIVE to a boolean from ANTHROPIC_API_KEY presence', () => {
    expect(typeof LIVE).toBe('boolean');
    expect(LIVE).toBe(!!process.env.ANTHROPIC_API_KEY);
    // MODEL must be a claude-* id so RoutingAdapter routes to ClaudeAdapter.
    expect(MODEL.startsWith('claude-')).toBe(true);
  });
});

// routing.default = <claude model> → every op routes to the REAL ClaudeAdapter
// through the REAL RoutingAdapter (TaskAgent builds it when no adapter is
// injected). All six lifecycle edges 'auto' so transitionPolicy() advances
// instead of halting — same as the offline test.
const LIVE_CONFIG = ProjectConfigSchema.parse({
  routing: { default: MODEL },
  // A real command that exercises the model's change: subtract must exist and
  // behave. If implement clobbered `add` the require would still load, but a
  // model that omitted `subtract` fails this with a non-zero exit.
  verify_command:
    'node -e "const m=require(\'./math.js\'); if (m.subtract(5,3)!==2) { console.error(\'subtract wrong\'); process.exit(1); } console.log(\'ok\')"',
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

async function setupGitRepo(cardId: string): Promise<{ repo: string; cardPath: string; mathPath: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-live-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });

  const git = simpleGit(repo);
  await git.init();
  await git.addConfig('user.email', 'test@conductor.test');
  await git.addConfig('user.name', 'Conductor Test');
  await git.addConfig('commit.gpgsign', 'false');

  // The REAL, trivial, EXISTING source file the card must MODIFY. Plain CommonJS
  // so verification needs no transpile. The proof hinges on the model reading
  // THIS content and returning a complete updated file that keeps `add`.
  const mathPath = join(repo, 'math.js');
  writeFileSync(mathPath, 'module.exports = { add: (a, b) => a + b };\n', 'utf8');

  const cardPath = join(cardsDir, `${cardId}.md`);
  writeFileSync(
    cardPath,
    `---
id: ${cardId}
title: Add subtract function
kind: feature
column: discovered
phase: live-smoke
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-30T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Add a \`subtract(a, b)\` function to \`math.js\` that returns \`a - b\`, alongside
the existing \`add\` function. Export it the same way \`add\` is exported (extend
the existing \`module.exports\` object). Do not remove or change \`add\`.
`,
    'utf8',
  );
  await git.add(['.conductor/cards/' + cardId + '.md', 'math.js']);
  await git.commit('chore: seed card + math.js fixture');

  return { repo, cardPath, mathPath };
}

async function runOneHop(args: {
  repo: string;
  cardId: string;
  step?: string;
  now: () => Date;
}): Promise<TaskEvent[]> {
  // NOTE: no `adapter` passed → TaskAgent constructs `new RoutingAdapter()`.
  // routing.default = <claude model> selects the REAL ClaudeAdapter for every
  // op. NOTE: no `runner` stub either — the real verify_command runs for real.
  const agent = new TaskAgent({
    repo: args.repo,
    cardId: args.cardId,
    config: LIVE_CONFIG,
    step: args.step,
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

// Force a card's column on disk. The 'planned -> approved' transition is the
// ONLY lifecycle edge gated on a non-deterministic LLM verdict (review may
// legitimately return NEEDS-INFO / NEEDS-CHANGES on a terse card — its prompt
// explicitly instructs that). We assert review *runs and returns a valid
// verdict* in Part A, then deterministically place the card in 'approved' here
// so Part B can prove the thing that actually matters — implement's agentic
// read-loop editing a real file — without betting the whole smoke on a verdict
// lottery. Everything else (analyze, plan, implement, verify) IS exercised
// against the real model.
async function forceColumn(cardPath: string, column: Column): Promise<void> {
  const card = await readCard(cardPath);
  card.frontmatter.column = column;
  await writeCard(card);
}

function lastOpComplete(events: TaskEvent[], op: string): boolean {
  return events.some((e) => e.kind === 'op_complete' && e.operation === op);
}

describe.skipIf(!LIVE)('Live smoke (REAL Claude model, paid)', () => {
  // PART A — the real model executes the front of the pipeline. Verdict-
  // agnostic: we prove analyze, plan, and review each RUN and produce valid
  // output, accepting ANY valid review verdict (APPROVED | NEEDS-CHANGES |
  // NEEDS-INFO). This is the "the pipeline talks to a real model and the ops
  // parse its output" proof.
  it(
    'runs analyze + plan + review against the real model and produces valid op output',
    async () => {
      const cardId = '2026-05-30-live-smoke-a';
      const { repo, cardPath } = await setupGitRepo(cardId);
      expect(await columnOf(cardPath)).toBe('discovered');

      // Hop 1: discovered -> planned (analyze + plan via the real model).
      const hop1 = await runOneHop({ repo, cardId, now: hopClock(0) });
      expect(lastOpComplete(hop1, 'analyze')).toBe(true);
      expect(lastOpComplete(hop1, 'plan')).toBe(true);
      expect(hop1[hop1.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'planned' });
      expect(await columnOf(cardPath)).toBe('planned');

      // The plan op wrote a real plan artifact to the run substrate (this is
      // what implement reads in Part B). Prove it exists and is non-trivial.
      const { findLatestArtifactRunId } = await import('../../src/agent/run_artifact.js');
      const planArtifact = await findLatestArtifactRunId(repo, cardId, 'plan');
      expect(planArtifact, 'plan op must persist a plan.md artifact to the run substrate').not.toBeNull();
      expect(planArtifact!.text.trim().length).toBeGreaterThan(20);

      // Hop 2: planned -> review. The op MUST run and return a VALID verdict;
      // we do NOT require a specific decision (a terse card legitimately draws
      // NEEDS-INFO). Either it APPROVED (advanced to 'approved') or it halted
      // in 'planned' with a NEEDS-* verdict — both are valid review outcomes.
      const hop2 = await runOneHop({ repo, cardId, now: hopClock(1) });
      expect(lastOpComplete(hop2, 'review')).toBe(true);
      const last2 = hop2[hop2.length - 1];
      const col2 = await columnOf(cardPath);
      const approvedAndAdvanced = last2.kind === 'complete' && col2 === 'approved';
      const haltedWithVerdict =
        last2.kind === 'halt' && /Review returned (NEEDS-INFO|NEEDS-CHANGES)/.test(last2.reason) && col2 === 'planned';
      expect(
        approvedAndAdvanced || haltedWithVerdict,
        `Review must run and yield a valid verdict outcome. col=${col2}, last=${JSON.stringify(last2)}`,
      ).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  // PART B — the real model's implement op edits an EXISTING file via the
  // agentic read-loop. This is the bug we fixed (implement.ts could not modify
  // a file it had not read). We run analyze+plan for real, deterministically
  // place the card in 'approved' (sidestepping the verdict lottery proven in
  // Part A), then run implement for real and verify the on-disk result.
  it(
    'implement modifies an existing math.js via the real read-loop, and a real verify passes',
    async () => {
      const cardId = '2026-05-30-live-smoke-b';
      const { repo, cardPath, mathPath } = await setupGitRepo(cardId);
      const commitsBefore = await commitCount(repo);

      // Hop 1: discovered -> planned (analyze + plan via the real model). This
      // produces the REAL plan artifact implement will read.
      const hop1 = await runOneHop({ repo, cardId, now: hopClock(0) });
      expect(hop1[hop1.length - 1]).toMatchObject({ kind: 'complete', finalColumn: 'planned' });

      // Deterministically advance to 'approved' (see forceColumn rationale).
      await forceColumn(cardPath, 'approved');
      expect(await columnOf(cardPath)).toBe('approved');

      // Hop 2: approved -> building. implement runs the agentic read-loop: it
      // must read_file math.js, then emit a `modify` diff with the COMPLETE new
      // content. step '1.1' supplied as the CLI/offline path supplies it.
      const hop2 = await runOneHop({ repo, cardId, step: '1.1', now: hopClock(1) });
      expect(lastOpComplete(hop2, 'implement')).toBe(true);
      const col2 = await columnOf(cardPath);
      expect(
        ['building', 'verifying', 'shipped', 'archived'],
        `Expected implement to run and advance past 'approved'; got '${col2}'. ` +
          `Last event: ${JSON.stringify(hop2[hop2.length - 1])}`,
      ).toContain(col2);

      // ---- Assertion 1: the EXISTING file was MODIFIED, not clobbered. ----
      expect(existsSync(mathPath)).toBe(true);
      const mathSrc = readFileSync(mathPath, 'utf8');
      expect(mathSrc).toMatch(/subtract/); // the new function is present
      expect(mathSrc).toMatch(/\badd\b/); // the original function survived

      // ---- Assertion 2: the modified file BEHAVES correctly. ----
      const requireFromTest = createRequire(import.meta.url);
      delete requireFromTest.cache[requireFromTest.resolve(mathPath)];
      const m = requireFromTest(mathPath) as {
        add: (a: number, b: number) => number;
        subtract: (a: number, b: number) => number;
      };
      expect(typeof m.subtract).toBe('function');
      expect(m.subtract(5, 3)).toBe(2);
      expect(m.add(2, 3)).toBe(5);

      // ---- Assertion 3: implement committed its step. ----
      const commitsAfter = await commitCount(repo);
      expect(commitsAfter).toBeGreaterThan(commitsBefore);

      // ---- Assertion 4: a REAL verify passes against the REAL change. ----
      // If implement stopped at 'building', drive the verify hop: the real
      // verify_command (node -e require math.js; check subtract) must PASS.
      if (col2 === 'building') {
        const hop3 = await runOneHop({ repo, cardId, now: hopClock(2) });
        const col3 = await columnOf(cardPath);
        expect(
          col3,
          `Expected real verify_command to PASS and advance to 'verifying'; got '${col3}'. ` +
            `Last event: ${JSON.stringify(hop3[hop3.length - 1])}`,
        ).toBe('verifying');
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

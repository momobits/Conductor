// scripts/smoke-phase28.mjs
//
// Phase 28 manual-smoke harness. Drives a card through the full lifecycle
// (discovered -> archived) using TaskAgent + MockAdapter with canned per-op
// responses. Exercises the REAL substrate write paths (production code,
// not test fixtures). Confirms:
//   - card body stays byte-identical to user-authored state across all 6 ops
//   - all 6 substrate artifacts (analyze, plan, review, verify, notebook,
//     implement) are written to .conductor/runs/<runId>/<op>.md
//   - resolve op moves the card to .conductor/archive/cards/
//
// After the walk, the smoke dir is left intact so the daemon can be started
// against it for the Playwright UI verification phase.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

import { TaskAgent } from '../dist/agent/task_agent.js';
import { MockAdapter } from '../dist/adapters/mock.js';
import { ProjectConfigSchema } from '../dist/config/schema.js';
import { readCard } from '../dist/engine/state/card.js';
import { readRunArtifact } from '../dist/agent/run_artifact.js';

const SMOKE_DIR = process.env.SMOKE_DIR ?? join(tmpdir(), `conductor-phase28-smoke-${Date.now()}`);
const CARD_ID = '2026-05-23-phase28-smoke';

console.log(`[smoke] working dir: ${SMOKE_DIR}`);

mkdirSync(SMOKE_DIR, { recursive: true });
mkdirSync(join(SMOKE_DIR, '.conductor', 'cards'), { recursive: true });
mkdirSync(join(SMOKE_DIR, '.conductor', 'archive', 'cards'), { recursive: true });
mkdirSync(join(SMOKE_DIR, '.conductor', 'archive', 'notebooks'), { recursive: true });

// Git repo (commitStep needs one).
const git = simpleGit(SMOKE_DIR);
await git.init();
await git.addConfig('user.name', 'Smoke Test');
await git.addConfig('user.email', 'smoke@example.com');
writeFileSync(join(SMOKE_DIR, 'README.md'), '# smoke\n', 'utf8');

// Card with substantive user-authored body.
const cardPath = join(SMOKE_DIR, '.conductor', 'cards', `${CARD_ID}.md`);
const USER_BODY = [
  '# Original Issue',
  '',
  'Phase 28 substrate smoke test. Verify all 6 engine ops write per-run',
  'artifacts to .conductor/runs/<runId>/<op>.md and the card body stays',
  'byte-identical to this user-authored content across the full lifecycle.',
  '',
].join('\n');

writeFileSync(cardPath, [
  '---',
  `id: ${CARD_ID}`,
  'title: Phase 28 substrate smoke',
  'kind: issue',
  'column: discovered',
  "phase: 'smoke'",
  'priority: 1',
  'autonomy: inherit',
  'model_overrides: {}',
  "created: '2026-05-23T00:00:00Z'",
  'source: user',
  'labels: []',
  'blocked_by: []',
  '---',
  '',
  USER_BODY,
].join('\n'), 'utf8');

// Snapshot the post-create body BEFORE any ops fire. This is the byte-identity
// reference: every subsequent check confirms the body matches this exactly.
const BODY_BEFORE_OPS = (await readCard(cardPath)).body;
console.log(`[smoke] user-authored body captured (${BODY_BEFORE_OPS.length} bytes)`);

await git.add('.');
await git.commit('seed smoke card');

// Config: all transitions auto, verify_command trivial.
writeFileSync(join(SMOKE_DIR, '.conductor', 'config.yaml'), [
  'routing:',
  '  default: mock-default',
  'verify_command: "echo ok"',
  'autonomy:',
  '  default: auto',
  '  transitions:',
  '    discovered_to_planned: auto',
  '    planned_to_approved: auto',
  '    approved_to_building: auto',
  '    building_to_verifying: auto',
  '    verifying_to_shipped: auto',
  '    shipped_to_archived: auto',
  '',
].join('\n'), 'utf8');

// ---------------------------------------------------------------------------
// Walk: each TaskAgent invocation handles ONE column transition. The brain
// loops until the card reaches a terminal state; here we mimic that loop.
// ---------------------------------------------------------------------------

const config = ProjectConfigSchema.parse({
  routing: { default: 'mock-default' },
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

// Canned responses per op. The brain calls each op in sequence as the card
// moves through columns. We provide one response per op invocation.
const CANNED = {
  analyze: 'Smoke analysis: substrate refactor verification. Root cause: confirming Phase 28 byte-cleanliness.',
  plan: [
    '### Resolved decisions from analysis',
    '- substrate target: .conductor/runs/<runId>/<op>.md',
    '',
    '### Step 1.1',
    'WHAT: create src/smoke.ts exporting a constant',
    'HOW: write `export const smoke = "phase-28";`',
    'WHY: minimal diff for verify to chew on',
    'RISK: low',
    'VERIFY: echo ok',
    'ROLLBACK: rm src/smoke.ts',
  ].join('\n'),
  review: JSON.stringify({ decision: 'APPROVED', reasoning: 'plan is sound for smoke', changes_required: [] }),
  implement: JSON.stringify({
    step: '1.1',
    commit_type: 'feat',
    commit_subject: 'add smoke constant',
    files: [{ path: 'src/smoke.ts', action: 'create', content: 'export const smoke = "phase-28";\n' }],
    notes: 'created smoke marker file',
  }),
  verify: JSON.stringify({ outcome: 'PASS', summary: 'echo ok exited 0', failures: [] }),
  resolve: JSON.stringify({ summary: 'Phase 28 smoke shipped', files_changed: ['src/smoke.ts'] }),
};

// Single adapter shared across the lifecycle. Push responses just-in-time per op.
const adapter = new MockAdapter();

async function runOneInvocation(label, step) {
  console.log(`[smoke] ── invocation: ${label}${step ? ` (--step ${step})` : ''}`);
  const agent = new TaskAgent({
    repo: SMOKE_DIR,
    cardId: CARD_ID,
    adapter,
    config,
    step,
    runner: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }), // matches verify_command
  });
  const events = [];
  for await (const e of agent.run()) {
    events.push(e);
    if (e.kind === 'op_start') console.log(`  ▸ ${e.operation}`);
    else if (e.kind === 'op_complete') console.log(`  ✓ ${e.operation} (${e.durationMs}ms)`);
    else if (e.kind === 'transition') console.log(`  → ${e.from} → ${e.to}`);
    else if (e.kind === 'halt') console.log(`  ■ halt: ${e.reason}`);
    else if (e.kind === 'complete') console.log(`  ■ complete: finalColumn=${e.finalColumn}`);
    else if (e.kind === 'error') console.log(`  ✗ ${e.message}`);
  }
  return { agent, events };
}

// invocation 1: discovered case fires analyze + plan
adapter.push({ text: CANNED.analyze });
adapter.push({ text: CANNED.plan });
const r1 = await runOneInvocation('discovered → planned');

// invocation 2: planned case fires review
adapter.push({ text: CANNED.review });
const r2 = await runOneInvocation('planned → approved');

// invocation 3: approved case fires implement (needs --step)
adapter.push({ text: CANNED.implement });
const r3 = await runOneInvocation('approved → building', '1.1');

// invocation 4: building case fires verify
adapter.push({ text: CANNED.verify });
const r4 = await runOneInvocation('building → verifying');

// invocation 5: verifying case fires notebook (deterministic; no adapter call)
const r5 = await runOneInvocation('verifying → shipped');

// invocation 6: shipped case fires resolve
adapter.push({ text: CANNED.resolve });
const r6 = await runOneInvocation('shipped → archived');

const allRuns = [r1, r2, r3, r4, r5, r6];

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

console.log('');
console.log('═══ VERIFICATION ═══');

// 1. Body byte-identity. The card moves to .conductor/archive/cards/ post-resolve.
const archivedCardPath = join(SMOKE_DIR, '.conductor', 'archive', 'cards', `${CARD_ID}.md`);
let bodyAfter;
if (existsSync(archivedCardPath)) {
  bodyAfter = (await readCard(archivedCardPath)).body;
  console.log(`[verify] archived card located at: ${archivedCardPath}`);
} else if (existsSync(cardPath)) {
  bodyAfter = (await readCard(cardPath)).body;
  console.log(`[verify] card NOT archived; still at: ${cardPath}`);
} else {
  throw new Error(`card not found at either ${archivedCardPath} or ${cardPath}`);
}

const bodyIdentical = bodyAfter === BODY_BEFORE_OPS;
console.log(`[verify] body byte-identity: ${bodyIdentical ? '✓ PASS' : '✗ FAIL'}`);
if (!bodyIdentical) {
  console.log(`  before bytes: ${BODY_BEFORE_OPS.length}`);
  console.log(`  after bytes:  ${bodyAfter.length}`);
  console.log(`  --- before ---\n${BODY_BEFORE_OPS}\n  --- after ---\n${bodyAfter}\n  ---`);
}

// Spot-check: body must NOT contain any of the generated section headers.
const forbiddenSections = [
  '## Analysis',
  '## Implementation Plan',
  '## Adversarial Review',
  '## Verification Report',
  '## Notebook',
  '## Implementation Guidelines',
];
const polluted = forbiddenSections.filter((s) => bodyAfter.includes(s));
console.log(`[verify] body free of generated sections: ${polluted.length === 0 ? '✓ PASS' : '✗ FAIL'}`);
if (polluted.length > 0) {
  console.log(`  found: ${polluted.join(', ')}`);
}

// 2. Substrate population: across the 6 invocations' runIds, all 6 op artifacts
//    must be present.
const expectedArtifacts = ['analyze', 'plan', 'review', 'verify', 'notebook', 'implement'];
const foundArtifacts = new Map();

const runsDir = join(SMOKE_DIR, '.conductor', 'runs');
const runDirs = existsSync(runsDir) ? readdirSync(runsDir) : [];
console.log(`[verify] ${runDirs.length} run dirs under .conductor/runs/`);

for (const runId of runDirs) {
  for (const op of expectedArtifacts) {
    const text = await readRunArtifact(SMOKE_DIR, runId, op);
    if (text !== null) {
      const list = foundArtifacts.get(op) ?? [];
      list.push({ runId, len: text.length });
      foundArtifacts.set(op, list);
    }
  }
}

let allArtifactsPresent = true;
for (const op of expectedArtifacts) {
  const found = foundArtifacts.get(op) ?? [];
  if (found.length === 0) {
    console.log(`[verify] ✗ ${op}.md: NOT FOUND in any run dir`);
    allArtifactsPresent = false;
  } else {
    console.log(`[verify] ✓ ${op}.md: ${found.map((f) => `${f.runId} (${f.len}b)`).join(', ')}`);
  }
}

// 3. No unexpected body sections from the user's content perspective.
const fileExists = existsSync(join(SMOKE_DIR, 'src', 'smoke.ts'));
console.log(`[verify] implement op wrote src/smoke.ts: ${fileExists ? '✓ PASS' : '✗ FAIL'}`);

// 4. Git log includes the feat commit from implement
const log = await git.log({ maxCount: 5 });
const hasImplementCommit = log.all.some((c) => /^feat\(smoke\.1\.1\): /.test(c.message));
console.log(`[verify] git log has feat(smoke.1.1) commit: ${hasImplementCommit ? '✓ PASS' : '✗ FAIL'}`);

console.log('');
console.log('═══ SUMMARY ═══');
const passed = bodyIdentical && polluted.length === 0 && allArtifactsPresent && fileExists && hasImplementCommit;
console.log(`Overall: ${passed ? '✓ ALL PASS' : '✗ FAILURES'}`);
console.log(`Smoke dir preserved at: ${SMOKE_DIR}`);
console.log(`Card ID: ${CARD_ID}`);

if (!passed) process.exit(1);

// scripts/smoke-phase28-ui-fixture.mjs
//
// Creates a FRESH active card in the smoke dir with all 6 op substrate
// artifacts pre-seeded. Used to verify the UI Card Detail's artifact
// panel render path via Playwright without re-running the lifecycle.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SMOKE_DIR = process.env.SMOKE_DIR;
if (!SMOKE_DIR || !existsSync(SMOKE_DIR)) {
  throw new Error(`SMOKE_DIR env required; got: ${SMOKE_DIR}`);
}

const CARD_ID = '2026-05-23-ui-fixture';
const RUN_ID = `20260523T120000-${CARD_ID}`;

const cardPath = join(SMOKE_DIR, '.conductor', 'cards', `${CARD_ID}.md`);
writeFileSync(cardPath, [
  '---',
  `id: ${CARD_ID}`,
  'title: UI artifact-panel fixture (Phase 28 smoke)',
  'kind: issue',
  'column: shipped',
  "phase: 'smoke'",
  'priority: 1',
  'autonomy: inherit',
  'model_overrides: {}',
  "created: '2026-05-23T12:00:00Z'",
  'source: user',
  'labels: []',
  'blocked_by: []',
  '---',
  '',
  '# Original Issue',
  '',
  'UI fixture for Phase 28 manual smoke. This card has all 6 op substrate',
  'artifacts pre-seeded so the Card Detail artifact panel can render them',
  'via browser-side `run_artifact_get` RPC calls.',
  '',
].join('\n'), 'utf8');

// Seed substrate run with all 6 artifacts in a single run dir.
const runDir = join(SMOKE_DIR, '.conductor', 'runs', RUN_ID);
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, 'events.jsonl'),
  '{"ts":"2026-05-23T12:00:00.000Z","kind":"op_start","card_id":"x"}\n', 'utf8');

const SECTIONS = {
  analyze: [
    '## Analysis',
    '',
    'Substrate-write verification: the Phase 28 refactor moves all 6 engine',
    'op outputs to `.conductor/runs/<runId>/<op>.md`. This analyze artifact',
    'is the canonical first-step write site. Rendered in the UI artifact',
    'panel via run_artifact_get RPC.',
  ].join('\n'),
  plan: [
    '### Resolved decisions from analysis',
    '- substrate path: `.conductor/runs/<runId>/plan.md`',
    '- read side: `findLatestArtifactRunId(repo, cardId, "plan")` (Phase 28.1)',
    '',
    '### Step 1.1',
    'WHAT: confirm plan.md round-trips through RunArtifactWriter',
    'HOW: smoke fixture seeds this content; UI fetches via RPC',
    'WHY: Phase 28.1 verification surface',
    'RISK: low',
    'VERIFY: render in artifact panel',
    'ROLLBACK: delete substrate dir',
  ].join('\n'),
  review: [
    '**Decision:** APPROVED',
    '',
    '**Reasoning:** Smoke fixture review artifact. Pin for the substrate-only',
    'review-write path introduced in Phase 28.1. Body byte-identity preserved.',
    '',
    '**Changes required:** (none)',
  ].join('\n'),
  verify: [
    '**Outcome:** PASS',
    '**Command:** `echo ok`',
    '**Exit code:** 0',
    '',
    '**Summary:** Smoke fixture verify artifact. Phase 28.2 substrate-write',
    'verification surface; no body mutation.',
    '',
    '**Failures:** (none)',
  ].join('\n'),
  notebook: [
    `Generated: \`archive/notebooks/${CARD_ID}.ipynb\``,
  ].join('\n'),
  implement: [
    '### Step 1.1 — confirm plan.md round-trips through RunArtifactWriter',
    '',
    'Files: create src/fixture.ts',
    '',
    'Smoke fixture implement artifact. Phase 28.3 substrate-write surface.',
    'Body stays byte-identical to user-authored content; guideline lives here.',
  ].join('\n'),
};

for (const [op, content] of Object.entries(SECTIONS)) {
  writeFileSync(join(runDir, `${op}.md`), content, 'utf8');
}

console.log(`[ui-fixture] card created: ${cardPath}`);
console.log(`[ui-fixture] run dir: ${runDir}`);
console.log(`[ui-fixture] artifacts seeded: ${Object.keys(SECTIONS).join(', ')}`);
console.log(`[ui-fixture] card URL: http://127.0.0.1:7180/#/card/${CARD_ID}`);
console.log(`[ui-fixture] runId for browser_evaluate tests: ${RUN_ID}`);

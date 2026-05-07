# Phase 2 — Operations Breadth + Control Discipline + Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase 1 engine spine to cover the full Relay+Control pipeline (review → implement → verify → notebook → resolve), add Control's discipline (commit-per-step, tag-per-phase, drift detection), add project-wide ops (scan, order, discover, exercise), and ship a one-shot importer that migrates `.relay/` and `.control/` into `.conductor/`.

**Architecture:** All operations follow the Phase 1 contract: typed engine functions that accept a Card (and optional context) plus a ModelAdapter, return a typed result, and append a Markdown section to the card body. New project-wide ops (scan/order/discover) operate on the cards directory rather than a single card. Control discipline is implemented as a `git` module (engine/state/git.ts) plus a `session` module (engine/state/session.ts) for atomic state.md writes; `detect_drift` is a deterministic op routed through the `local` adapter (no LLM call). The importer is a CLI command that reads `.relay/` and `.control/` and writes `.conductor/` files using the same Card CRUD path Phase 1 established.

**Tech Stack:** Same as Phase 1 (TypeScript 5.6+, Node 20+, Vitest, Commander.js, gray-matter, js-yaml, Zod, @anthropic-ai/sdk). New deps this phase: `simple-git` for git primitives, `execa` for `verify` to run the project's test command.

**Spec reference:** `docs/superpowers/specs/2026-05-06-conductor-design1.md` § Phase 2 (in §12), § 5.2 (operations), § 6 (engine + drift detection), § 11 (compatibility / migration).

**Phase tag at completion:** `phase-2-operations-discipline-migration-closed`.

---

## Sub-phase checkpoints

The plan is organized so the executor can run tests + commit a checkpoint after each sub-phase. Each sub-phase produces working software:

- **Sub-phase A (Tasks 1–3) — Foundation.** Types and helpers all later tasks depend on.
- **Sub-phase B (Tasks 4–8) — Lifecycle ops.** review, implement, verify, notebook, resolve. Card can be driven Discovered → Archived via the engine.
- **Sub-phase C (Tasks 9–11) — Control discipline.** detect_drift op, hook subscribers, phase-close logic.
- **Sub-phase D (Tasks 12–15) — Project-wide ops.** scan, order, discover, exercise family.
- **Sub-phase E (Tasks 16–22) — CLI surface.** All new commands wired through.
- **Sub-phase F (Tasks 23–25) — Migration importer + close.** `conductor import`, end-to-end test, README + tag.

After each sub-phase, run `npm test` and commit a milestone (e.g., `chore(2.A): sub-phase A foundation complete`).

---

## File Structure

```
conductor/
├── package.json                              # task 1: add simple-git, execa
├── src/
│   ├── engine/
│   │   ├── types.ts                          # task 1: extend with Phase 2 result types
│   │   ├── state/
│   │   │   ├── card.ts                       # (Phase 1 — unchanged unless noted)
│   │   │   ├── git.ts                        # task 2: NEW — git primitives
│   │   │   └── session.ts                    # task 3: NEW — state.md/journal helpers
│   │   ├── hooks/
│   │   │   ├── bus.ts                        # (Phase 1 — unchanged)
│   │   │   └── subscribers.ts                # task 10: NEW — SessionStart/SessionEnd
│   │   ├── lifecycle.ts                      # (Phase 1 — unchanged in Phase 2)
│   │   ├── phase.ts                          # task 11: NEW — phase-close logic
│   │   └── ops/
│   │       ├── analyze.ts                    # (Phase 1)
│   │       ├── plan.ts                       # (Phase 1)
│   │       ├── review.ts                     # task 4: NEW
│   │       ├── implement.ts                  # task 5: NEW
│   │       ├── verify.ts                     # task 6: NEW
│   │       ├── notebook.ts                   # task 7: NEW
│   │       ├── resolve.ts                    # task 8: NEW
│   │       ├── detect_drift.ts               # task 9: NEW
│   │       ├── scan.ts                       # task 12: NEW
│   │       ├── order.ts                      # task 13: NEW
│   │       ├── discover.ts                   # task 14: NEW
│   │       └── exercise.ts                   # task 15: NEW (4 sub-ops)
│   ├── adapters/                             # (Phase 1 — unchanged)
│   ├── config/
│   │   ├── schema.ts                         # task 6: extend with verify_command
│   │   └── load.ts                           # (Phase 1 — unchanged)
│   ├── importer/
│   │   ├── relay.ts                          # task 24: NEW
│   │   └── control.ts                        # task 24: NEW
│   └── cli/
│       ├── index.ts                          # tasks 16–23: wire new commands
│       └── commands/
│           ├── work.ts                       # task 16: extend for new ops
│           ├── scan.ts                       # task 17: NEW
│           ├── order.ts                      # task 18: NEW
│           ├── discover.ts                   # task 19: NEW
│           ├── exercise.ts                   # task 20: NEW
│           ├── phase.ts                      # task 21: NEW (phase close subcommand)
│           ├── drift.ts                      # task 22: NEW
│           └── import.ts                     # task 23: NEW
├── tests/
│   ├── engine/
│   │   ├── state/
│   │   │   ├── git.test.ts                   # task 2
│   │   │   └── session.test.ts               # task 3
│   │   ├── hooks/
│   │   │   └── subscribers.test.ts           # task 10
│   │   ├── phase.test.ts                     # task 11
│   │   └── ops/
│   │       ├── review.test.ts                # task 4
│   │       ├── implement.test.ts             # task 5
│   │       ├── verify.test.ts                # task 6
│   │       ├── notebook.test.ts              # task 7
│   │       ├── resolve.test.ts               # task 8
│   │       ├── detect_drift.test.ts          # task 9
│   │       ├── scan.test.ts                  # task 12
│   │       ├── order.test.ts                 # task 13
│   │       ├── discover.test.ts              # task 14
│   │       └── exercise.test.ts              # task 15
│   ├── importer/
│   │   ├── relay.test.ts                     # task 24
│   │   └── control.test.ts                   # task 24
│   ├── cli/
│   │   ├── work-phase2.test.ts               # task 16
│   │   ├── scan.test.ts                      # task 17
│   │   ├── order.test.ts                     # task 18
│   │   ├── discover.test.ts                  # task 19
│   │   ├── exercise.test.ts                  # task 20
│   │   ├── phase.test.ts                     # task 21
│   │   ├── drift.test.ts                     # task 22
│   │   └── import.test.ts                    # task 23
│   ├── integration/
│   │   └── phase2-end-to-end.test.ts         # task 25
│   └── fixtures/
│       ├── relay/                            # task 24: sample .relay/ tree
│       └── control/                          # task 24: sample .control/ tree
└── README.md                                 # task 25: refresh
```

---

## Tasks

## Sub-phase A — Foundation

### Task 1: Extend engine types + add new dependencies

**Files:**
- Modify: `package.json`
- Modify: `src/engine/types.ts`

- [ ] **Step 1: Add `simple-git` and `execa` to dependencies**

Edit `package.json` and add to `dependencies`:

```json
    "execa": "^9.5.1",
    "simple-git": "^3.27.0",
```

Then run:

```bash
npm install
```

Expected: install completes; `package-lock.json` updates.

- [ ] **Step 2: Append Phase 2 result types to `src/engine/types.ts`**

Append below the existing `Recommendation` interface:

```typescript
// ---------- Phase 2: Operation result types ----------

export type VerdictDecision = 'APPROVED' | 'NEEDS-CHANGES' | 'NEEDS-INFO';

export interface Verdict {
  decision: VerdictDecision;
  reasoning: string;
  changes_required: string[]; // empty if APPROVED
}

export interface DiffFile {
  path: string;                       // repo-relative
  action: 'create' | 'modify' | 'delete';
  content: string;                    // full file content for create|modify
}

export interface Diff {
  step: string;                       // e.g. '1.2'
  commit_type: 'feat' | 'fix' | 'test' | 'docs' | 'refactor' | 'chore';
  commit_subject: string;             // <70 chars, imperative
  files: DiffFile[];
  notes: string;                      // freeform; mirrors plan's HOW for the step
}

export type VerifyOutcome = 'PASS' | 'FAIL' | 'SKIP';

export interface VerifyReport {
  outcome: VerifyOutcome;
  command: string;
  exit_code: number;
  summary: string;                    // LLM-written narrative
  failures: string[];                 // empty if PASS
}

export interface ResolutionDoc {
  card_id: string;
  summary: string;                    // 3–5 sentence what-shipped narrative
  files_changed: string[];
  ship_commit: string;                // SHA of the resolve commit
}

export type DriftKind =
  | 'branch-mismatch'
  | 'last-commit-mismatch'
  | 'uncommitted-state-mismatch'
  | 'tag-mismatch'
  | 'state-md-template'
  | 'state-md-missing'
  | 'state-md-unparseable';

export interface Drift {
  kind: DriftKind;
  expected: string;
  actual: string;
  detail: string;
}

export interface CardSummary {
  id: string;
  title: string;
  column: Column;
  phase: string;
  priority: number;
  kind: Kind;
  labels: string[];
  blocked_by: string[];
}

export interface Status {
  cards: CardSummary[];
  by_column: Record<Column, number>;
  by_phase: Record<string, number>;
}

export interface OrderingEntry {
  id: string;
  rank: number;                       // 1-indexed
  rationale: string;
}

export interface Ordering {
  generated_at: string;               // ISO 8601
  entries: OrderingEntry[];
}

export interface DiscoveredItem {
  slug: string;                       // proposed slug for the new card
  title: string;
  kind: Kind;
  rationale: string;
  source_evidence: string;            // where it was found
}

export interface ExerciseFinding {
  id: string;                         // unique within session
  scenario: string;
  observed: string;
  severity: 'note' | 'low' | 'medium' | 'high';
  evidence: string;
}

export interface ExerciseSession {
  id: string;                         // session-id (slug-friendly)
  goal: string;
  scenarios: string[];
  findings: ExerciseFinding[];
  created: string;
}
```

- [ ] **Step 3: Verify the file compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/engine/types.ts
git commit -m "feat(2.1): Phase 2 result types + simple-git/execa deps"
```

---

### Task 2: Git module (`src/engine/state/git.ts`)

**Files:**
- Create: `src/engine/state/git.ts`
- Create: `tests/engine/state/git.test.ts`

This module wraps `simple-git` with the primitives Phase 2 ops need: clean-tree check, staged-commit per step, tag creation, current-branch / last-commit / describe lookups. Drift detection (Task 9) and implement (Task 5) and phase-close (Task 11) all use it.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/state/git.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  isCleanTree,
  commitStep,
  createPhaseTag,
  currentBranch,
  lastCommitSha,
  describeRef,
  hasTag,
} from '../../../src/engine/state/git.js';

let tmp: string;

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-git-'));
  const g = simpleGit(dir);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await writeFile(join(dir, 'README.md'), '# r\n');
  await g.add('.');
  await g.commit('initial');
  return dir;
}

beforeEach(async () => { tmp = await initRepo(); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('git module', () => {
  it('reports a clean tree after a fresh commit', async () => {
    expect(await isCleanTree(tmp)).toBe(true);
  });

  it('reports a dirty tree after an uncommitted edit', async () => {
    await writeFile(join(tmp, 'a.txt'), 'a');
    expect(await isCleanTree(tmp)).toBe(false);
  });

  it('commitStep stages all changes and uses the spec format', async () => {
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/x.ts'), 'export const x = 1;\n');
    const sha = await commitStep(tmp, {
      type: 'feat',
      phase: '2',
      step: '5.3',
      subject: 'add x constant',
    });
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
    const log = await simpleGit(tmp).log({ maxCount: 1 });
    expect(log.latest?.message).toBe('feat(2.5.3): add x constant');
    expect(await isCleanTree(tmp)).toBe(true);
  });

  it('createPhaseTag tags HEAD with phase-<name>-closed', async () => {
    await createPhaseTag(tmp, 'phase-2-foo');
    expect(await hasTag(tmp, 'phase-2-foo-closed')).toBe(true);
  });

  it('currentBranch / lastCommitSha / describeRef return strings', async () => {
    expect(typeof await currentBranch(tmp)).toBe('string');
    expect(await lastCommitSha(tmp)).toMatch(/^[0-9a-f]{40}$/);
    const desc = await describeRef(tmp);
    expect(typeof desc).toBe('string');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/state/git.test.ts
```

Expected: import errors / "module not found" — module doesn't exist yet.

- [ ] **Step 3: Implement `src/engine/state/git.ts`**

```typescript
// src/engine/state/git.ts
//
// Thin wrappers over simple-git for the primitives Conductor needs:
// commit-per-step (Control invariant), phase tagging, drift inputs.
// All functions accept the repo root as their first argument so tests
// and CLI invocations can target arbitrary working trees.

import { simpleGit, type SimpleGit } from 'simple-git';

export interface CommitStepArgs {
  type: 'feat' | 'fix' | 'test' | 'docs' | 'refactor' | 'chore';
  phase: string; // phase ordinal or short name; e.g. '2' or '2a'
  step: string;  // e.g. '5.3'
  subject: string;
}

function git(repo: string): SimpleGit {
  return simpleGit(repo);
}

export async function isCleanTree(repo: string): Promise<boolean> {
  const status = await git(repo).status();
  return status.isClean();
}

export async function commitStep(
  repo: string,
  args: CommitStepArgs,
): Promise<string> {
  const g = git(repo);
  await g.add('.');
  const subject = `${args.type}(${args.phase}.${args.step}): ${args.subject}`;
  const result = await g.commit(subject);
  return result.commit;
}

export async function createPhaseTag(repo: string, phaseName: string): Promise<string> {
  const tag = `${phaseName}-closed`;
  await git(repo).addTag(tag);
  return tag;
}

export async function hasTag(repo: string, tag: string): Promise<boolean> {
  const tags = await git(repo).tags();
  return tags.all.includes(tag);
}

export async function currentBranch(repo: string): Promise<string> {
  const status = await git(repo).status();
  return status.current ?? '';
}

export async function lastCommitSha(repo: string): Promise<string> {
  const log = await git(repo).log({ maxCount: 1 });
  return log.latest?.hash ?? '';
}

export async function describeRef(repo: string): Promise<string> {
  try {
    const out = await git(repo).raw(['describe', '--tags', '--always']);
    return out.trim();
  } catch {
    return '';
  }
}

export async function uncommittedFiles(repo: string): Promise<string[]> {
  const status = await git(repo).status();
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.not_added,
    ...status.renamed.map((r) => r.to),
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/state/git.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/state/git.ts tests/engine/state/git.test.ts
git commit -m "feat(2.2): git module — commitStep, phase tags, drift primitives"
```

---

### Task 3: Session module (`src/engine/state/session.ts`)

**Files:**
- Create: `src/engine/state/session.ts`
- Create: `tests/engine/state/session.test.ts`

Provides atomic state.md updates and append-only journal writes. Used by the SessionEnd subscriber (Task 10) and `phase close` (Task 11).

- [ ] **Step 1: Write failing tests**

Create `tests/engine/state/session.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readState,
  writeStateAtomic,
  appendJournal,
} from '../../../src/engine/state/session.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-session-'));
  await mkdir(join(tmp, '.conductor'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('session module', () => {
  it('readState returns null when state.md is missing', async () => {
    expect(await readState(tmp)).toBeNull();
  });

  it('readState returns the file contents', async () => {
    await writeFile(join(tmp, '.conductor', 'state.md'), '# STATE\nfoo\n');
    expect(await readState(tmp)).toBe('# STATE\nfoo\n');
  });

  it('writeStateAtomic writes via tmp + rename', async () => {
    await writeStateAtomic(tmp, '# STATE\nbar\n');
    const got = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(got).toBe('# STATE\nbar\n');
  });

  it('appendJournal appends a one-liner with a timestamp', async () => {
    await appendJournal(tmp, 'card 2026-05-07-x reached planned');
    const text = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(text).toMatch(/^- 20\d{2}-\d{2}-\d{2}T.*Z — card 2026-05-07-x reached planned\n$/);
  });

  it('appendJournal appends to existing content without truncating', async () => {
    await writeFile(join(tmp, '.conductor', 'journal.md'), '# Journal\n\n- prior\n');
    await appendJournal(tmp, 'next');
    const text = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(text).toContain('# Journal');
    expect(text).toContain('- prior');
    expect(text).toMatch(/- 20\d{2}-.*— next\n$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/state/session.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/state/session.ts`**

```typescript
// src/engine/state/session.ts
//
// Tier 1 working-memory helpers. state.md is overwritten atomically on
// session end (Control invariant 4); journal.md is append-only.

import { readFile, writeFile, rename, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';

function statePath(repo: string): string {
  return join(repo, '.conductor', 'state.md');
}

function journalPath(repo: string): string {
  return join(repo, '.conductor', 'journal.md');
}

export async function readState(repo: string): Promise<string | null> {
  try {
    return await readFile(statePath(repo), 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeStateAtomic(repo: string, content: string): Promise<void> {
  const final = statePath(repo);
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, final);
}

export async function appendJournal(repo: string, line: string): Promise<void> {
  const path = journalPath(repo);
  try {
    await access(path);
  } catch {
    await writeFile(path, '# Journal\n\n', 'utf8');
  }
  const ts = new Date().toISOString();
  await appendFile(path, `- ${ts} — ${line}\n`, 'utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/state/session.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/state/session.ts tests/engine/state/session.test.ts
git commit -m "feat(2.3): session module — atomic state.md + append-only journal"
```

**Sub-phase A checkpoint:** run `npm test` — all Phase 1 tests still pass + 10 new tests added.

---

## Sub-phase B — Lifecycle ops

### Task 4: `review` op

**Files:**
- Create: `src/engine/ops/review.ts`
- Create: `tests/engine/ops/review.test.ts`

Mirrors Phase 1's `analyze`/`plan` shape. Reads the card's `## Implementation Plan` section, asks the model for an adversarial verdict, appends `## Adversarial Review`. Returns a typed `Verdict`.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/review.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review } from '../../../src/engine/ops/review.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-review-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: planned',
    'phase: unassigned',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Analysis',
    'a',
    '',
    '## Implementation Plan',
    '1.1 do thing',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('review op', () => {
  it('parses APPROVED verdict and appends Adversarial Review', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'APPROVED',
        reasoning: 'plan is sound',
        changes_required: [],
      }),
      inputTokens: 50,
      outputTokens: 30,
    });
    const card = await readCard(cardPath);
    const verdict = await review({ card, adapter, model: 'mock-model' });
    expect(verdict.decision).toBe('APPROVED');
    expect(verdict.changes_required).toEqual([]);

    const after = await readCard(cardPath);
    expect(after.body).toContain('## Adversarial Review');
    expect(after.body).toContain('APPROVED');
    expect(after.body).toContain('plan is sound');
  });

  it('parses NEEDS-CHANGES with required items', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        decision: 'NEEDS-CHANGES',
        reasoning: 'rollback missing',
        changes_required: ['Add ROLLBACK to step 1.1'],
      }),
      inputTokens: 50,
      outputTokens: 30,
    });
    const card = await readCard(cardPath);
    const verdict = await review({ card, adapter, model: 'mock-model' });
    expect(verdict.decision).toBe('NEEDS-CHANGES');
    expect(verdict.changes_required).toContain('Add ROLLBACK to step 1.1');
  });

  it('throws when the card has no Implementation Plan section', async () => {
    await writeFile(cardPath, [
      '---',
      'id: 2026-05-07-x',
      'title: Sample',
      'kind: issue',
      'column: planned',
      'phase: unassigned',
      'priority: 1',
      'autonomy: inherit',
      'model_overrides: {}',
      "created: '2026-05-07T00:00:00Z'",
      'source: user',
      'labels: []',
      'blocked_by: []',
      '---',
      '',
      '# Original Issue',
      'body',
      '',
    ].join('\n'));
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(review({ card, adapter, model: 'mock-model' })).rejects.toThrow(/no Implementation Plan/);
  });

  it('throws when model output is not valid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(review({ card, adapter, model: 'mock-model' })).rejects.toThrow(/parse/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/review.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/review.ts`**

```typescript
// src/engine/ops/review.ts
//
// Operation: adversarially review a planned card. Reads the card's
// Implementation Plan, asks the model to find weaknesses, returns a
// typed Verdict and appends an Adversarial Review section.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Verdict } from '../types.js';
import { appendSection } from '../state/card.js';

export interface ReviewArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are an adversarial software reviewer. Evaluate the
provided implementation plan against the analysis. Find risks, missing
rollback paths, ambiguous steps, missing verification, and blast-radius
concerns the plan does not address.

Return ONLY a single JSON object on one line, no Markdown fence, with
exactly these fields:

  {
    "decision": "APPROVED" | "NEEDS-CHANGES" | "NEEDS-INFO",
    "reasoning": "<2-4 sentence summary>",
    "changes_required": ["<concrete change>", ...]
  }

Use APPROVED only when the plan is acceptable as-written. Use
NEEDS-CHANGES when concrete edits would make it acceptable. Use
NEEDS-INFO when more facts must be gathered before review can complete.`.trim();

const PLAN_HEADING = '## Implementation Plan';

function extractPlan(body: string): string | null {
  const idx = body.indexOf(PLAN_HEADING);
  if (idx < 0) return null;
  const after = body.slice(idx + PLAN_HEADING.length);
  const nextH2 = after.search(/\n##\s+/);
  return (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim();
}

export async function review(args: ReviewArgs): Promise<Verdict> {
  const { card, adapter, model } = args;

  const plan = extractPlan(card.body);
  if (!plan) {
    throw new Error(`Card ${card.frontmatter.id} has no Implementation Plan; run plan first.`);
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Card body (Analysis + Plan) ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'review',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let verdict: Verdict;
  try {
    const parsed = JSON.parse(resp.text.trim());
    verdict = {
      decision: parsed.decision,
      reasoning: String(parsed.reasoning ?? ''),
      changes_required: Array.isArray(parsed.changes_required)
        ? parsed.changes_required.map(String)
        : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse review JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const sectionBody = [
    `**Decision:** ${verdict.decision}`,
    '',
    `**Reasoning:** ${verdict.reasoning}`,
    '',
    verdict.changes_required.length > 0
      ? '**Changes required:**\n' + verdict.changes_required.map((c) => `- ${c}`).join('\n')
      : '**Changes required:** (none)',
  ].join('\n');

  await appendSection(card.path, 'Adversarial Review', sectionBody);
  return verdict;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/review.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/review.ts tests/engine/ops/review.test.ts
git commit -m "feat(2.4): review op with typed Verdict + Adversarial Review section"
```

---

### Task 5: `implement` op

**Files:**
- Create: `src/engine/ops/implement.ts`
- Create: `tests/engine/ops/implement.test.ts`

One step per call. Asks the model for a structured `Diff` (file edits + commit type/subject). Validates, applies edits to the working tree, calls `commitStep` from the git module, appends an `## Implementation Guidelines` entry to the card.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/implement.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { implement } from '../../../src/engine/ops/implement.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;

async function initTmp(): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-impl-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: approved',
    'phase: 2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Implementation Plan',
    '### 1.1',
    'WHAT: add file',
    'HOW: write src/x.ts',
    'WHY: needed',
    'RISK: low',
    'VERIFY: file exists',
    'ROLLBACK: delete file',
    '',
  ].join('\n'));
  await g.add('.');
  await g.commit('seed');
}

beforeEach(initTmp);
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('implement op', () => {
  it('applies a create diff and commits with the spec format', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add x constant',
        files: [{ path: 'src/x.ts', action: 'create', content: 'export const x = 1;\n' }],
        notes: 'created src/x.ts per HOW',
      }),
      inputTokens: 50,
      outputTokens: 50,
    });
    const card = await readCard(cardPath);
    const diff = await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1' });
    expect(diff.step).toBe('1.1');
    expect(diff.files).toHaveLength(1);

    const written = await readFile(join(tmp, 'src/x.ts'), 'utf8');
    expect(written).toBe('export const x = 1;\n');

    const log = await simpleGit(tmp).log({ maxCount: 1 });
    expect(log.latest?.message).toBe('feat(2.1.1): add x constant');

    const after = await readCard(cardPath);
    expect(after.body).toContain('## Implementation Guidelines');
    expect(after.body).toContain('Step 1.1');
  });

  it('applies a modify diff (replaces existing file content)', async () => {
    await writeFile(join(tmp, 'src/x.ts'), 'old\n');
    const g = simpleGit(tmp);
    await g.add('.');
    await g.commit('add old');

    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.2',
        commit_type: 'fix',
        commit_subject: 'rewrite x',
        files: [{ path: 'src/x.ts', action: 'modify', content: 'new\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.2' });
    const written = await readFile(join(tmp, 'src/x.ts'), 'utf8');
    expect(written).toBe('new\n');
  });

  it('rejects path traversal in file paths', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'evil',
        files: [{ path: '../escape.txt', action: 'create', content: 'no' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1' }),
    ).rejects.toThrow(/path/i);
  });

  it('throws when model returns invalid JSON', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'not json', inputTokens: 1, outputTokens: 1 });
    const card = await readCard(cardPath);
    await expect(
      implement({ repo: tmp, card, adapter, model: 'mock-model', step: '1.1' }),
    ).rejects.toThrow(/parse/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/implement.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/implement.ts`**

```typescript
// src/engine/ops/implement.ts
//
// Operation: apply ONE step of the implementation plan to the working
// tree, then commit with Control's commit-per-step format.

import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Diff, DiffFile } from '../types.js';
import { appendSection } from '../state/card.js';
import { commitStep } from '../state/git.js';

export interface ImplementArgs {
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
  step: string; // e.g. '1.1'
}

const SYSTEM_PROMPT = `You are an experienced software engineer applying ONE
step of an implementation plan. Read the plan carefully, identify the
requested step, and produce a concrete diff.

Return ONLY a single JSON object on one line, no Markdown fence, matching:

  {
    "step": "<step id, e.g. 1.1>",
    "commit_type": "feat" | "fix" | "test" | "docs" | "refactor" | "chore",
    "commit_subject": "<imperative, <70 chars>",
    "files": [
      { "path": "<repo-relative path>", "action": "create" | "modify" | "delete", "content": "<full file content for create/modify; empty for delete>" }
    ],
    "notes": "<freeform; mirrors the plan's HOW>"
  }

Rules:
- Use full file content (not patches) so the apply step is deterministic.
- Paths MUST be repo-relative POSIX (no leading slash, no '..').
- Do NOT include files outside what this single step requires.`.trim();

function ensureSafePath(repo: string, p: string): string {
  if (isAbsolute(p) || p.includes('\0')) {
    throw new Error(`Invalid file path (absolute or null byte): ${p}`);
  }
  const abs = resolve(repo, p);
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid file path (escapes repo): ${p}`);
  }
  return abs;
}

async function applyDiffFile(repo: string, file: DiffFile): Promise<void> {
  const abs = ensureSafePath(repo, file.path);
  if (file.action === 'delete') {
    try {
      await rm(abs);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
    return;
  }
  if (file.action === 'create') {
    try {
      await access(abs);
      throw new Error(`create requested but file exists: ${file.path}`);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, file.content, 'utf8');
}

export async function implement(args: ImplementArgs): Promise<Diff> {
  const { repo, card, adapter, model, step } = args;

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Phase: ${card.frontmatter.phase}`,
    `Step requested: ${step}`,
    '',
    '--- Card body (Analysis + Plan) ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'implement',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let diff: Diff;
  try {
    const parsed = JSON.parse(resp.text.trim());
    diff = {
      step: String(parsed.step ?? step),
      commit_type: parsed.commit_type,
      commit_subject: String(parsed.commit_subject ?? ''),
      files: Array.isArray(parsed.files) ? parsed.files : [],
      notes: String(parsed.notes ?? ''),
    };
  } catch (e) {
    throw new Error(`Failed to parse implement JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  for (const f of diff.files) {
    await applyDiffFile(repo, f);
  }

  await commitStep(repo, {
    type: diff.commit_type,
    phase: card.frontmatter.phase,
    step: diff.step,
    subject: diff.commit_subject,
  });

  const guideline = [
    `### Step ${diff.step} — ${diff.commit_subject}`,
    '',
    `Files: ${diff.files.map((f) => `${f.action} ${f.path}`).join(', ') || '(none)'}`,
    '',
    diff.notes || '_(no notes)_',
  ].join('\n');

  await appendSection(card.path, 'Implementation Guidelines', guideline);

  return diff;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/implement.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/implement.ts tests/engine/ops/implement.test.ts
git commit -m "feat(2.5): implement op — structured diffs + commit-per-step"
```

---

### Task 6: `verify` op + `verify_command` config

**Files:**
- Modify: `src/config/schema.ts`
- Create: `src/engine/ops/verify.ts`
- Create: `tests/engine/ops/verify.test.ts`

Runs the project's verification command (defaults to `npm test`), passes the captured stdout/stderr/exit code to the model, parses a structured `VerifyReport`, appends `## Verification Report`. The runner is injectable so tests don't shell out.

- [ ] **Step 1: Extend the project config schema with `verify_command`**

In `src/config/schema.ts`, expand `ProjectConfigSchema`:

```typescript
export const ProjectConfigSchema = z
  .object({
    routing: z
      .object({
        default: z.string(),
        functions: z.record(z.string(), z.string()).default({}),
      })
      .default({ default: 'claude-sonnet-4-6', functions: {} }),
    autonomy: z
      .object({
        default: AutonomySchema.default('assist'),
        transitions: z
          .object({
            discovered_to_planned: TransitionPolicy.default('auto'),
            planned_to_approved: TransitionPolicy.default('assist'),
            approved_to_building: TransitionPolicy.default('manual'),
            building_to_verifying: TransitionPolicy.default('auto'),
            verifying_to_shipped: TransitionPolicy.default('assist'),
            shipped_to_archived: TransitionPolicy.default('manual'),
          })
          .default({}),
      })
      .default({}),
    verify_command: z.string().default('npm test'),
  })
  .strict();
```

Run typecheck:

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 2: Write failing tests**

Create `tests/engine/ops/verify.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify } from '../../../src/engine/ops/verify.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-verify-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: building',
    'phase: 2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Implementation Guidelines',
    'Step 1.1 done.',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('verify op', () => {
  it('runs the runner, passes results to the model, parses PASS', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        outcome: 'PASS',
        summary: 'all green',
        failures: [],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const runner = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
    const report = await verify({
      card, adapter, model: 'mock-model',
      command: 'npm test', runner,
    });
    expect(report.outcome).toBe('PASS');
    expect(report.exit_code).toBe(0);
    expect(report.failures).toEqual([]);
    const after = await readCard(cardPath);
    expect(after.body).toContain('## Verification Report');
    expect(after.body).toContain('PASS');
  });

  it('parses FAIL with failure list', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        outcome: 'FAIL',
        summary: 'one test failed',
        failures: ['tests/x.test.ts > should foo'],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const runner = async () => ({ stdout: '', stderr: 'AssertionError', exitCode: 1 });
    const report = await verify({
      card, adapter, model: 'mock-model',
      command: 'npm test', runner,
    });
    expect(report.outcome).toBe('FAIL');
    expect(report.exit_code).toBe(1);
    expect(report.failures).toContain('tests/x.test.ts > should foo');
  });

  it('marks SKIP when runner returns exitCode 0 but model says SKIP', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        outcome: 'SKIP',
        summary: 'no tests configured',
        failures: [],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const runner = async () => ({ stdout: 'No tests', stderr: '', exitCode: 0 });
    const report = await verify({
      card, adapter, model: 'mock-model',
      command: 'echo no-op', runner,
    });
    expect(report.outcome).toBe('SKIP');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/verify.test.ts
```

Expected: module not found.

- [ ] **Step 4: Implement `src/engine/ops/verify.ts`**

```typescript
// src/engine/ops/verify.ts
//
// Operation: run the project's verify command, ask the model to
// classify the outcome, append a Verification Report.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, VerifyReport } from '../types.js';
import { appendSection } from '../state/card.js';

export interface RunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Runner = (command: string) => Promise<RunnerResult>;

export interface VerifyArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
  command: string;
  runner: Runner;
}

const SYSTEM_PROMPT = `You are evaluating the output of a verification
command. Decide whether verification PASSed, FAILed, or was SKIPped, and
extract distinct failures.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "outcome": "PASS" | "FAIL" | "SKIP",
    "summary": "<2-3 sentence narrative>",
    "failures": ["<one failure per item>", ...]
  }

PASS  — command exited 0 and all tests/checks succeeded.
FAIL  — command exited non-zero or output indicates failures.
SKIP  — no tests/checks were applicable (e.g. empty test suite).`.trim();

function truncate(s: string, max = 4000): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

export async function verify(args: VerifyArgs): Promise<VerifyReport> {
  const { card, adapter, model, command, runner } = args;

  const result = await runner(command);

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Verify command: ${command}`,
    `Exit code: ${result.exitCode}`,
    '',
    '--- stdout ---',
    truncate(result.stdout),
    '',
    '--- stderr ---',
    truncate(result.stderr),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'verify',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let parsed: { outcome: VerifyReport['outcome']; summary: string; failures: string[] };
  try {
    const raw = JSON.parse(resp.text.trim());
    parsed = {
      outcome: raw.outcome,
      summary: String(raw.summary ?? ''),
      failures: Array.isArray(raw.failures) ? raw.failures.map(String) : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse verify JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const report: VerifyReport = {
    outcome: parsed.outcome,
    command,
    exit_code: result.exitCode,
    summary: parsed.summary,
    failures: parsed.failures,
  };

  const sectionBody = [
    `**Outcome:** ${report.outcome}`,
    `**Command:** \`${report.command}\``,
    `**Exit code:** ${report.exit_code}`,
    '',
    `**Summary:** ${report.summary}`,
    '',
    report.failures.length > 0
      ? '**Failures:**\n' + report.failures.map((f) => `- ${f}`).join('\n')
      : '**Failures:** (none)',
  ].join('\n');

  await appendSection(card.path, 'Verification Report', sectionBody);
  return report;
}

// Default runner — used by CLI invocations. Importable for production but
// not pulled into tests so we can keep test runs hermetic.
export async function defaultRunner(command: string): Promise<RunnerResult> {
  const { execa } = await import('execa');
  const proc = await execa(command, { shell: true, reject: false });
  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    exitCode: proc.exitCode ?? 0,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/verify.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/engine/ops/verify.ts tests/engine/ops/verify.test.ts
git commit -m "feat(2.6): verify op with injectable runner + verify_command config"
```

---

### Task 7: `notebook` op

**Files:**
- Create: `src/engine/ops/notebook.ts`
- Create: `tests/engine/ops/notebook.test.ts`

Generates a minimal Jupyter notebook documenting the verification: one Markdown cell summarising the card + verify report, one code cell with the verify command. Writes to `.conductor/archive/notebooks/<id>.ipynb`. Phase 2 keeps this deterministic (no LLM call) — content comes from the card body.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/notebook.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notebook } from '../../../src/engine/ops/notebook.js';
import { readCard } from '../../../src/engine/state/card.js';

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-nb-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'notebooks'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', '2026-05-07-x.md');
  await writeFile(cardPath, [
    '---',
    'id: 2026-05-07-x',
    'title: Sample',
    'kind: issue',
    'column: verifying',
    'phase: 2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Verification Report',
    '**Outcome:** PASS',
    '**Command:** `npm test`',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('notebook op', () => {
  it('writes a valid ipynb to the archive', async () => {
    const card = await readCard(cardPath);
    const result = await notebook({ repo: tmp, card, command: 'npm test' });
    expect(result.path).toBe(join(tmp, '.conductor', 'archive', 'notebooks', '2026-05-07-x.ipynb'));
    const content = await readFile(result.path, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.nbformat).toBe(4);
    expect(parsed.cells).toBeInstanceOf(Array);
    expect(parsed.cells.length).toBeGreaterThanOrEqual(2);
    expect(parsed.cells[0].cell_type).toBe('markdown');
    expect(parsed.cells[0].source.join('')).toContain('Sample');
    expect(parsed.cells[1].cell_type).toBe('code');
    expect(parsed.cells[1].source.join('')).toContain('npm test');
  });

  it('appends a Notebook section to the card with the relative path', async () => {
    const card = await readCard(cardPath);
    await notebook({ repo: tmp, card, command: 'npm test' });
    const after = await readCard(cardPath);
    expect(after.body).toContain('## Notebook');
    expect(after.body).toContain('archive/notebooks/2026-05-07-x.ipynb');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/notebook.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/notebook.ts`**

```typescript
// src/engine/ops/notebook.ts
//
// Operation: produce a minimal Jupyter notebook documenting the card's
// verification. Deterministic — no LLM. Writes
// .conductor/archive/notebooks/<id>.ipynb.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Card } from '../types.js';
import { appendSection } from '../state/card.js';

export interface NotebookArgs {
  repo: string;
  card: Card;
  command: string;
}

export interface NotebookResult {
  path: string;
}

interface NbCell {
  cell_type: 'markdown' | 'code';
  metadata: Record<string, unknown>;
  source: string[];
  outputs?: unknown[];
  execution_count?: number | null;
}

function extractSection(body: string, heading: string): string {
  const idx = body.indexOf(`## ${heading}`);
  if (idx < 0) return '_(none)_';
  const after = body.slice(idx + heading.length + 3);
  const nextH2 = after.search(/\n##\s+/);
  return (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim();
}

export async function notebook(args: NotebookArgs): Promise<NotebookResult> {
  const { repo, card, command } = args;

  const verifySection = extractSection(card.body, 'Verification Report');

  const cells: NbCell[] = [
    {
      cell_type: 'markdown',
      metadata: {},
      source: [
        `# ${card.frontmatter.title}\n`,
        `\n`,
        `Card: \`${card.frontmatter.id}\`  •  Phase: \`${card.frontmatter.phase}\`\n`,
        `\n`,
        `## Verification Report\n`,
        `\n`,
        verifySection,
        `\n`,
      ],
    },
    {
      cell_type: 'code',
      metadata: {},
      execution_count: null,
      outputs: [],
      source: [
        `# Re-run the verification command outside the Conductor session.\n`,
        `import subprocess\n`,
        `result = subprocess.run(${JSON.stringify(command)}, shell=True, capture_output=True, text=True)\n`,
        `print('exit', result.returncode)\n`,
        `print(result.stdout)\n`,
        `print(result.stderr)\n`,
      ],
    },
  ];

  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells,
  };

  const outPath = join(repo, '.conductor', 'archive', 'notebooks', `${card.frontmatter.id}.ipynb`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(nb, null, 2), 'utf8');

  await appendSection(
    card.path,
    'Notebook',
    `Generated: \`archive/notebooks/${card.frontmatter.id}.ipynb\``,
  );

  return { path: outPath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/notebook.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/notebook.ts tests/engine/ops/notebook.test.ts
git commit -m "feat(2.7): notebook op — deterministic Jupyter artifact in archive/notebooks/"
```

---

### Task 8: `resolve` op

**Files:**
- Create: `src/engine/ops/resolve.ts`
- Create: `tests/engine/ops/resolve.test.ts`

Moves a card to `archive/cards/<id>.md`, writes a concise `archive/implemented/<id>.md` summary (LLM-generated), removes the card from `cards/`, returns a `ResolutionDoc`. Card frontmatter column is set to `archived` on the moved file.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/resolve.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve as resolveOp } from '../../../src/engine/ops/resolve.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;
let cardPath: string;
const ID = '2026-05-07-x';

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-res-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'implemented'), { recursive: true });
  cardPath = join(tmp, '.conductor', 'cards', `${ID}.md`);
  await writeFile(cardPath, [
    '---',
    `id: ${ID}`,
    'title: Sample',
    'kind: issue',
    'column: shipped',
    'phase: 2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Implementation Guidelines',
    'Step 1.1 — modified src/x.ts',
    '',
    '## Verification Report',
    '**Outcome:** PASS',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('resolve op', () => {
  it('moves the card to archive, writes implemented summary, returns ResolutionDoc', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        summary: 'Shipped change to x.ts. Tests green.',
        files_changed: ['src/x.ts'],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const card = await readCard(cardPath);
    const doc = await resolveOp({ repo: tmp, card, adapter, model: 'mock-model' });
    expect(doc.card_id).toBe(ID);
    expect(doc.summary).toContain('Shipped');
    expect(doc.files_changed).toContain('src/x.ts');

    // Original removed
    await expect(access(cardPath)).rejects.toThrow();

    // Archive card present, column = archived
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${ID}.md`));
    expect(archived.frontmatter.column).toBe('archived');

    // Implemented summary present
    const implemented = await readFile(
      join(tmp, '.conductor', 'archive', 'implemented', `${ID}.md`),
      'utf8',
    );
    expect(implemented).toContain('Shipped change to x.ts');
  });

  it('throws when card is not in shipped column', async () => {
    await writeFile(cardPath, (await readFile(cardPath, 'utf8')).replace('column: shipped', 'column: building'));
    const card = await readCard(cardPath);
    const adapter = new MockAdapter();
    await expect(resolveOp({ repo: tmp, card, adapter, model: 'mock-model' })).rejects.toThrow(/shipped/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/resolve.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/resolve.ts`**

```typescript
// src/engine/ops/resolve.ts
//
// Operation: archive a shipped card. Generates a concise summary via the
// model, moves the card to archive/cards/, writes archive/implemented/,
// removes from cards/. Returns a ResolutionDoc.

import { rename, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, ResolutionDoc } from '../types.js';
import { readCard, writeCard } from '../state/card.js';
import { lastCommitSha } from '../state/git.js';

export interface ResolveArgs {
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are summarising a fully shipped change for the
project's "implemented" archive. Read the card and produce a 3-5 sentence
ship summary plus the list of files changed.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "summary": "<3-5 sentences describing what shipped and why>",
    "files_changed": ["<repo-relative path>", ...]
  }`.trim();

export async function resolve(args: ResolveArgs): Promise<ResolutionDoc> {
  const { repo, card, adapter, model } = args;

  if (card.frontmatter.column !== 'shipped') {
    throw new Error(
      `Card ${card.frontmatter.id} must be in 'shipped' to resolve; currently '${card.frontmatter.column}'.`,
    );
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Card body (full lifecycle) ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'resolve',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let parsed: { summary: string; files_changed: string[] };
  try {
    const raw = JSON.parse(resp.text.trim());
    parsed = {
      summary: String(raw.summary ?? ''),
      files_changed: Array.isArray(raw.files_changed) ? raw.files_changed.map(String) : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse resolve JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const sha = await lastCommitSha(repo);
  const doc: ResolutionDoc = {
    card_id: card.frontmatter.id,
    summary: parsed.summary,
    files_changed: parsed.files_changed,
    ship_commit: sha,
  };

  // Move card to archive/cards/<id>.md, flipping column to 'archived'.
  const archivePath = join(repo, '.conductor', 'archive', 'cards', `${card.frontmatter.id}.md`);
  await mkdir(dirname(archivePath), { recursive: true });
  const updated: Card = {
    frontmatter: { ...card.frontmatter, column: 'archived' },
    body: card.body,
    path: archivePath,
  };
  await writeCard(updated);
  // Remove the original from cards/ (rename old → new path is unsafe across drives, so write+unlink via fs/promises rm).
  const { rm } = await import('node:fs/promises');
  await rm(card.path);

  // Write the implemented summary.
  const implementedPath = join(repo, '.conductor', 'archive', 'implemented', `${card.frontmatter.id}.md`);
  await mkdir(dirname(implementedPath), { recursive: true });
  const implementedBody = [
    `# ${card.frontmatter.title}`,
    '',
    `Card: \`${card.frontmatter.id}\``,
    `Phase: \`${card.frontmatter.phase}\``,
    `Ship commit: \`${sha || '(unknown)'}\``,
    '',
    '## Summary',
    '',
    parsed.summary,
    '',
    '## Files changed',
    '',
    parsed.files_changed.length > 0
      ? parsed.files_changed.map((f) => `- ${f}`).join('\n')
      : '(none reported)',
    '',
  ].join('\n');
  await writeFile(implementedPath, implementedBody, 'utf8');

  return doc;
}

// Re-export readCard for callers convenience.
export { readCard };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/resolve.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/resolve.ts tests/engine/ops/resolve.test.ts
git commit -m "feat(2.8): resolve op — archive card, write implemented summary"
```

**Sub-phase B checkpoint:** run `npm test` — all Phase 1 tests pass + ~25 new tests added. The engine can now drive Discovered → Archived end-to-end.

---

## Sub-phase C — Control discipline

### Task 9: `detect_drift` op

**Files:**
- Create: `src/engine/ops/detect_drift.ts`
- Create: `tests/engine/ops/detect_drift.test.ts`

Deterministic op (no LLM). Compares `state.md` to git status / log / describe. Returns `Drift[]` describing mismatches.

For Phase 2, `state.md` carries optional one-line markers Conductor reads to anchor the drift checks:

```
<!-- conductor:branch=main -->
<!-- conductor:last-commit=<sha> -->
<!-- conductor:tag=phase-2-... -->
```

When a marker is missing, the corresponding drift kind is suppressed. When `state.md` itself is missing, unparseable, or matches the init template verbatim, that is the only drift returned.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/detect_drift.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { detectDrift } from '../../../src/engine/ops/detect_drift.js';

let tmp: string;

async function init(state?: string): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-drift-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await writeFile(join(tmp, 'README.md'), '#\n');
  await g.add('.');
  await g.commit('initial');
  await mkdir(join(tmp, '.conductor'), { recursive: true });
  if (state !== undefined) {
    await writeFile(join(tmp, '.conductor', 'state.md'), state);
  }
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('detect_drift op', () => {
  it('returns state-md-missing when state.md does not exist', async () => {
    await init();
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.kind).toBe('state-md-missing');
  });

  it('returns state-md-template when state.md matches the init template', async () => {
    const tmpl = `# Conductor STATE\n\nCurrent phase: unassigned\nCurrent card: (none)\nNext action: file the first card with \`conductor card new <slug>\`\nRecent decisions: (none yet)\n`;
    await init(tmpl);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'state-md-template')).toBe(true);
  });

  it('returns no drift when markers match git', async () => {
    await init();
    const sha = (await simpleGit(tmp).log({ maxCount: 1 })).latest!.hash;
    const branch = (await simpleGit(tmp).status()).current ?? 'main';
    const stateText = `# State\n\n<!-- conductor:branch=${branch} -->\n<!-- conductor:last-commit=${sha} -->\n`;
    await writeFile(join(tmp, '.conductor', 'state.md'), stateText);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts).toEqual([]);
  });

  it('returns last-commit-mismatch when marker disagrees with HEAD', async () => {
    await init();
    const branch = (await simpleGit(tmp).status()).current ?? 'main';
    const stateText = `# State\n\n<!-- conductor:branch=${branch} -->\n<!-- conductor:last-commit=0000000000000000000000000000000000000000 -->\n`;
    await writeFile(join(tmp, '.conductor', 'state.md'), stateText);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'last-commit-mismatch')).toBe(true);
  });

  it('returns branch-mismatch when marker disagrees with current branch', async () => {
    await init();
    const sha = (await simpleGit(tmp).log({ maxCount: 1 })).latest!.hash;
    const stateText = `# State\n\n<!-- conductor:branch=feature/xyz -->\n<!-- conductor:last-commit=${sha} -->\n`;
    await writeFile(join(tmp, '.conductor', 'state.md'), stateText);
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'branch-mismatch')).toBe(true);
  });

  it('returns uncommitted-state-mismatch when there are dirty files', async () => {
    await init('# State\n');
    await writeFile(join(tmp, 'dirty.txt'), 'x');
    const drifts = await detectDrift({ repo: tmp });
    expect(drifts.some((d) => d.kind === 'uncommitted-state-mismatch')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/detect_drift.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/detect_drift.ts`**

```typescript
// src/engine/ops/detect_drift.ts
//
// Deterministic op: compare .conductor/state.md to current git state.
// Returns structured Drift entries; surfaces consume them as control:drift.

import type { Drift } from '../types.js';
import { readState } from '../state/session.js';
import { currentBranch, lastCommitSha, describeRef, uncommittedFiles } from '../state/git.js';

export interface DetectDriftArgs {
  repo: string;
}

const TEMPLATE_FIRST_LINES = '# Conductor STATE';
const TEMPLATE_NEXT_ACTION = 'Next action: file the first card with';

const MARKER_RE = {
  branch: /<!--\s*conductor:branch=([^\s>]+)\s*-->/,
  lastCommit: /<!--\s*conductor:last-commit=([0-9a-f]{7,40})\s*-->/i,
  tag: /<!--\s*conductor:tag=([^\s>]+)\s*-->/,
};

function extractMarker(state: string, re: RegExp): string | null {
  const m = state.match(re);
  return m && m[1] ? m[1] : null;
}

export async function detectDrift(args: DetectDriftArgs): Promise<Drift[]> {
  const { repo } = args;
  const drifts: Drift[] = [];

  const state = await readState(repo);
  if (state === null) {
    drifts.push({
      kind: 'state-md-missing',
      expected: '.conductor/state.md present',
      actual: '(missing)',
      detail: 'No state.md found. Run conductor init or restore from snapshots/.',
    });
    return drifts;
  }

  if (state.startsWith(TEMPLATE_FIRST_LINES) && state.includes(TEMPLATE_NEXT_ACTION)) {
    drifts.push({
      kind: 'state-md-template',
      expected: 'state.md authored for the project',
      actual: 'init template (unmodified)',
      detail: 'state.md still matches the init scaffold. Capture current cursor before continuing.',
    });
  }

  const branchMarker = extractMarker(state, MARKER_RE.branch);
  if (branchMarker) {
    const actual = await currentBranch(repo);
    if (actual && actual !== branchMarker) {
      drifts.push({
        kind: 'branch-mismatch',
        expected: branchMarker,
        actual,
        detail: 'state.md says we are on a different branch than git reports.',
      });
    }
  }

  const lastCommitMarker = extractMarker(state, MARKER_RE.lastCommit);
  if (lastCommitMarker) {
    const actual = await lastCommitSha(repo);
    if (actual && !actual.startsWith(lastCommitMarker.toLowerCase())) {
      drifts.push({
        kind: 'last-commit-mismatch',
        expected: lastCommitMarker,
        actual,
        detail: 'state.md last-commit marker disagrees with git HEAD.',
      });
    }
  }

  const tagMarker = extractMarker(state, MARKER_RE.tag);
  if (tagMarker) {
    const actual = await describeRef(repo);
    if (actual && !actual.startsWith(tagMarker)) {
      drifts.push({
        kind: 'tag-mismatch',
        expected: tagMarker,
        actual,
        detail: 'state.md tag marker disagrees with git describe.',
      });
    }
  }

  const dirty = await uncommittedFiles(repo);
  if (dirty.length > 0) {
    drifts.push({
      kind: 'uncommitted-state-mismatch',
      expected: 'clean working tree',
      actual: `${dirty.length} uncommitted file(s)`,
      detail: dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? ', …' : ''),
    });
  }

  return drifts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/detect_drift.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/detect_drift.ts tests/engine/ops/detect_drift.test.ts
git commit -m "feat(2.9): detect_drift op — deterministic state.md vs git checks"
```

---

### Task 10: Hook subscribers (`src/engine/hooks/subscribers.ts`)

**Files:**
- Create: `src/engine/hooks/subscribers.ts`
- Create: `tests/engine/hooks/subscribers.test.ts`

Wires Phase 2 subscribers onto the HookBus: `SessionStart` runs `detectDrift` and emits a `[control:drift]` payload through a callback, `SessionEnd` writes state.md atomically and appends a journal one-liner.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/hooks/subscribers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus } from '../../../src/engine/hooks/bus.js';
import { registerSessionStart, registerSessionEnd } from '../../../src/engine/hooks/subscribers.js';
import type { Drift } from '../../../src/engine/types.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-sub-'));
  await mkdir(join(tmp, '.conductor'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('hook subscribers', () => {
  it('SessionStart subscriber forwards drifts via the onDrift callback', async () => {
    const bus = new HookBus();
    const seen: Drift[][] = [];
    registerSessionStart(bus, { repo: tmp, onDrift: (d) => seen.push(d) });
    await bus.emit('SessionStart', { reason: 'cli-start' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.kind).toBe('state-md-missing');
  });

  it('SessionEnd subscriber writes state.md and appends a journal line', async () => {
    const bus = new HookBus();
    registerSessionEnd(bus, { repo: tmp });
    await bus.emit('SessionEnd', {
      stateMd: '# state\n',
      journalLine: 'session over — 2 cards advanced',
    });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toBe('# state\n');
    const journal = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(journal).toContain('session over — 2 cards advanced');
  });

  it('SessionEnd subscriber tolerates missing journalLine (state-only update)', async () => {
    const bus = new HookBus();
    registerSessionEnd(bus, { repo: tmp });
    await bus.emit('SessionEnd', { stateMd: '# new state\n' });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toBe('# new state\n');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/hooks/subscribers.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/hooks/subscribers.ts`**

```typescript
// src/engine/hooks/subscribers.ts
//
// Phase 2 hook subscribers: SessionStart drift check, SessionEnd
// atomic state.md update + journal append. Subscribers are pure
// callbacks registered on a HookBus instance.

import type { HookBus } from './bus.js';
import type { Drift } from '../types.js';
import { detectDrift } from '../ops/detect_drift.js';
import { writeStateAtomic, appendJournal } from '../state/session.js';

export interface SessionStartArgs {
  repo: string;
  onDrift: (drifts: Drift[]) => void | Promise<void>;
}

export function registerSessionStart(bus: HookBus, args: SessionStartArgs): void {
  bus.on('SessionStart', async () => {
    const drifts = await detectDrift({ repo: args.repo });
    if (drifts.length > 0) {
      await args.onDrift(drifts);
    }
  });
}

export interface SessionEndArgs {
  repo: string;
}

export interface SessionEndPayload {
  stateMd?: string;
  journalLine?: string;
}

export function registerSessionEnd(bus: HookBus, args: SessionEndArgs): void {
  bus.on<SessionEndPayload>('SessionEnd', async (payload) => {
    if (payload.stateMd !== undefined) {
      await writeStateAtomic(args.repo, payload.stateMd);
    }
    if (payload.journalLine) {
      await appendJournal(args.repo, payload.journalLine);
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/hooks/subscribers.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/hooks/subscribers.ts tests/engine/hooks/subscribers.test.ts
git commit -m "feat(2.10): SessionStart drift + SessionEnd state/journal subscribers"
```

---

### Task 11: Phase-close logic (`src/engine/phase.ts`)

**Files:**
- Create: `src/engine/phase.ts`
- Create: `tests/engine/phase.test.ts`

`closePhase(repo, name)` requires every card with `phase: <name>` to be in `archived`, creates the phase tag (`<name>-closed`) via the git module, and appends a journal line. Returns `{ tag, archivedCards }`. If any card in the phase is unarchived, it throws with a list of offenders so the caller can decide whether to defer them.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/phase.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closePhase } from '../../src/engine/phase.js';

let tmp: string;

async function setup(cards: { id: string; phase: string; column: string }[]): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-phase-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  for (const c of cards) {
    const dir = c.column === 'archived'
      ? join(tmp, '.conductor', 'archive', 'cards')
      : join(tmp, '.conductor', 'cards');
    await writeFile(join(dir, `${c.id}.md`), [
      '---',
      `id: ${c.id}`,
      'title: x',
      'kind: issue',
      `column: ${c.column}`,
      `phase: ${c.phase}`,
      'priority: 1',
      'autonomy: inherit',
      'model_overrides: {}',
      "created: '2026-05-07T00:00:00Z'",
      'source: user',
      'labels: []',
      'blocked_by: []',
      '---',
      '',
      'body',
      '',
    ].join('\n'));
  }
  await writeFile(join(tmp, '.conductor', 'journal.md'), '# Journal\n\n');
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('closePhase', () => {
  it('tags HEAD and reports archived cards when phase is fully archived', async () => {
    await setup([
      { id: '2026-05-07-a', phase: 'phase-2', column: 'archived' },
      { id: '2026-05-07-b', phase: 'phase-2', column: 'archived' },
      { id: '2026-05-07-c', phase: 'phase-3', column: 'planned' },
    ]);
    const result = await closePhase({ repo: tmp, name: 'phase-2' });
    expect(result.tag).toBe('phase-2-closed');
    expect(result.archivedCards.sort()).toEqual(['2026-05-07-a', '2026-05-07-b']);
    const tags = await simpleGit(tmp).tags();
    expect(tags.all).toContain('phase-2-closed');
    const journal = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(journal).toContain('phase-2 closed');
  });

  it('throws and lists unarchived cards when phase is not fully archived', async () => {
    await setup([
      { id: '2026-05-07-a', phase: 'phase-2', column: 'archived' },
      { id: '2026-05-07-b', phase: 'phase-2', column: 'building' },
    ]);
    await expect(closePhase({ repo: tmp, name: 'phase-2' })).rejects.toThrow(/2026-05-07-b/);
  });

  it('throws when no cards reference the phase', async () => {
    await setup([
      { id: '2026-05-07-c', phase: 'phase-3', column: 'archived' },
    ]);
    await expect(closePhase({ repo: tmp, name: 'phase-2' })).rejects.toThrow(/no cards/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/phase.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/phase.ts`**

```typescript
// src/engine/phase.ts
//
// Phase-close logic: enforce "every card in this phase is archived",
// create a git tag, append a journal line. Used by `conductor phase close`.

import { join } from 'node:path';
import { listCards } from './state/card.js';
import { createPhaseTag } from './state/git.js';
import { appendJournal } from './state/session.js';

export interface ClosePhaseArgs {
  repo: string;
  name: string; // e.g. 'phase-2'
}

export interface ClosePhaseResult {
  tag: string;
  archivedCards: string[];
}

export async function closePhase(args: ClosePhaseArgs): Promise<ClosePhaseResult> {
  const { repo, name } = args;

  const liveCards = await listCards(join(repo, '.conductor', 'cards'));
  const archiveCards = await listCards(join(repo, '.conductor', 'archive', 'cards'));

  const all = [...liveCards, ...archiveCards];
  const inPhase = all.filter((c) => c.frontmatter.phase === name);
  if (inPhase.length === 0) {
    throw new Error(`No cards reference phase '${name}'.`);
  }

  const unarchived = inPhase.filter((c) => c.frontmatter.column !== 'archived');
  if (unarchived.length > 0) {
    const ids = unarchived.map((c) => c.frontmatter.id).join(', ');
    throw new Error(`Cannot close ${name}: ${unarchived.length} card(s) not archived: ${ids}`);
  }

  const tag = await createPhaseTag(repo, name);
  await appendJournal(repo, `${name} closed (${inPhase.length} cards archived)`);

  return {
    tag,
    archivedCards: inPhase.map((c) => c.frontmatter.id),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/phase.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/phase.ts tests/engine/phase.test.ts
git commit -m "feat(2.11): closePhase — tag-per-phase + archived-only enforcement"
```

**Sub-phase C checkpoint:** run `npm test` — Control-discipline primitives in place.

---

## Sub-phase D — Project-wide ops

### Task 12: `scan` op

**Files:**
- Create: `src/engine/ops/scan.ts`
- Create: `tests/engine/ops/scan.test.ts`

Deterministic. Reads `.conductor/cards/*.md`, summarises every active card, returns a `Status` aggregate.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/scan.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../../../src/engine/ops/scan.js';

let tmp: string;

async function writeCardFile(dir: string, id: string, column: string, phase: string, priority: number): Promise<void> {
  await writeFile(join(dir, `${id}.md`), [
    '---',
    `id: ${id}`,
    'title: t',
    'kind: issue',
    `column: ${column}`,
    `phase: ${phase}`,
    `priority: ${priority}`,
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: [a, b]',
    'blocked_by: []',
    '---',
    '',
    'body',
    '',
  ].join('\n'));
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-scan-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('scan op', () => {
  it('returns empty Status when there are no cards', async () => {
    const status = await scan({ repo: tmp });
    expect(status.cards).toEqual([]);
    expect(status.by_column.discovered).toBe(0);
  });

  it('summarises cards and counts by column + phase', async () => {
    const cardsDir = join(tmp, '.conductor', 'cards');
    await writeCardFile(cardsDir, '2026-05-07-a', 'discovered', 'phase-2', 1);
    await writeCardFile(cardsDir, '2026-05-07-b', 'planned', 'phase-2', 2);
    await writeCardFile(cardsDir, '2026-05-07-c', 'building', 'phase-3', 1);
    const status = await scan({ repo: tmp });
    expect(status.cards).toHaveLength(3);
    expect(status.by_column.discovered).toBe(1);
    expect(status.by_column.planned).toBe(1);
    expect(status.by_column.building).toBe(1);
    expect(status.by_phase['phase-2']).toBe(2);
    expect(status.by_phase['phase-3']).toBe(1);
    expect(status.cards.map((c) => c.id).sort()).toEqual([
      '2026-05-07-a', '2026-05-07-b', '2026-05-07-c',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/scan.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/scan.ts`**

```typescript
// src/engine/ops/scan.ts
//
// Deterministic project-wide op: list active cards with metadata
// summary and per-column / per-phase counts.

import { join } from 'node:path';
import type { Column, Status } from '../types.js';
import { COLUMNS } from '../types.js';
import { listCards } from '../state/card.js';

export interface ScanArgs {
  repo: string;
}

export async function scan(args: ScanArgs): Promise<Status> {
  const cards = await listCards(join(args.repo, '.conductor', 'cards'));

  const by_column: Record<Column, number> = {} as Record<Column, number>;
  for (const col of COLUMNS) by_column[col] = 0;

  const by_phase: Record<string, number> = {};

  const summaries = cards.map((c) => {
    by_column[c.frontmatter.column] = (by_column[c.frontmatter.column] ?? 0) + 1;
    by_phase[c.frontmatter.phase] = (by_phase[c.frontmatter.phase] ?? 0) + 1;
    return {
      id: c.frontmatter.id,
      title: c.frontmatter.title,
      column: c.frontmatter.column,
      phase: c.frontmatter.phase,
      priority: c.frontmatter.priority,
      kind: c.frontmatter.kind,
      labels: c.frontmatter.labels,
      blocked_by: c.frontmatter.blocked_by,
    };
  });

  return { cards: summaries, by_column, by_phase };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/scan.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/scan.ts tests/engine/ops/scan.test.ts
git commit -m "feat(2.12): scan op — deterministic Status across active cards"
```

---

### Task 13: `order` op

**Files:**
- Create: `src/engine/ops/order.ts`
- Create: `tests/engine/ops/order.test.ts`

LLM-driven. Takes the `Status` from `scan`, asks the model to rank cards across phases, writes `.conductor/ordering.md`. Returns `Ordering`.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/order.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { order } from '../../../src/engine/ops/order.js';
import { MockAdapter } from '../../../src/adapters/mock.js';
import type { Status } from '../../../src/engine/types.js';

let tmp: string;
const STATUS: Status = {
  cards: [
    { id: '2026-05-07-a', title: 'A', column: 'planned', phase: 'phase-2', priority: 2, kind: 'issue', labels: [], blocked_by: [] },
    { id: '2026-05-07-b', title: 'B', column: 'discovered', phase: 'phase-2', priority: 1, kind: 'issue', labels: [], blocked_by: [] },
  ],
  by_column: {} as never,
  by_phase: {},
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-order-'));
  await mkdir(join(tmp, '.conductor'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('order op', () => {
  it('parses ranked entries and writes ordering.md', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        entries: [
          { id: '2026-05-07-b', rank: 1, rationale: 'unblocks A' },
          { id: '2026-05-07-a', rank: 2, rationale: 'follows B' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const o = await order({ repo: tmp, status: STATUS, adapter, model: 'mock-model' });
    expect(o.entries[0]?.id).toBe('2026-05-07-b');
    expect(o.entries[1]?.rank).toBe(2);
    const text = await readFile(join(tmp, '.conductor', 'ordering.md'), 'utf8');
    expect(text).toContain('1. 2026-05-07-b');
    expect(text).toContain('2. 2026-05-07-a');
  });

  it('throws when entries reference unknown card ids', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        entries: [{ id: 'phantom', rank: 1, rationale: 'x' }],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    await expect(order({ repo: tmp, status: STATUS, adapter, model: 'mock-model' })).rejects.toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/order.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/order.ts`**

```typescript
// src/engine/ops/order.ts
//
// Project-wide op: rank cards across phases, write ordering.md.
// LLM picks the rank; engine validates entries reference known cards.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Ordering, OrderingEntry, Status } from '../types.js';

export interface OrderArgs {
  repo: string;
  status: Status;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are prioritising the project's active cards.
Rank EVERY card given to you (no omissions). Use phase + priority +
blockers + column to inform the ordering. Lower-numbered phases come
first; within a phase, prefer cards that unblock others.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "entries": [
      { "id": "<card id>", "rank": <int starting at 1>, "rationale": "<1 sentence>" },
      ...
    ]
  }`.trim();

export async function order(args: OrderArgs): Promise<Ordering> {
  const { repo, status, adapter, model } = args;

  const userPrompt = [
    'Cards to rank:',
    JSON.stringify(status.cards, null, 2),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'order',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let entries: OrderingEntry[];
  try {
    const raw = JSON.parse(resp.text.trim());
    entries = Array.isArray(raw.entries) ? raw.entries.map((e: unknown) => {
      const o = e as Record<string, unknown>;
      return {
        id: String(o.id ?? ''),
        rank: Number(o.rank ?? 0),
        rationale: String(o.rationale ?? ''),
      };
    }) : [];
  } catch (e) {
    throw new Error(`Failed to parse order JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const knownIds = new Set(status.cards.map((c) => c.id));
  const unknown = entries.filter((e) => !knownIds.has(e.id)).map((e) => e.id);
  if (unknown.length > 0) {
    throw new Error(`Ordering references unknown card ids: ${unknown.join(', ')}`);
  }

  entries.sort((a, b) => a.rank - b.rank);

  const generated_at = new Date().toISOString();

  const md = [
    '# Ordering',
    '',
    `_Generated ${generated_at} by \`order\`._`,
    '',
    ...entries.map((e) => `${e.rank}. ${e.id} — ${e.rationale}`),
    '',
  ].join('\n');
  await writeFile(join(repo, '.conductor', 'ordering.md'), md, 'utf8');

  return { generated_at, entries };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/order.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/order.ts tests/engine/ops/order.test.ts
git commit -m "feat(2.13): order op — LLM-ranked Ordering written to ordering.md"
```

---

### Task 14: `discover` op

**Files:**
- Create: `src/engine/ops/discover.ts`
- Create: `tests/engine/ops/discover.test.ts`

LLM-driven. Inspects the repo (TODO/FIXME comments + recent git log subjects) and asks the model to triage candidate issues. Returns `DiscoveredItem[]`. Caller decides whether to file them as cards.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/discover.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { discover } from '../../../src/engine/ops/discover.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;

async function init(): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-disc-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, 'src'), { recursive: true });
  await writeFile(join(tmp, 'src', 'a.ts'), '// TODO: handle null user\nexport const a = 1;\n');
  await writeFile(join(tmp, 'src', 'b.ts'), '// FIXME: race condition on shutdown\nexport const b = 2;\n');
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('discover op', () => {
  it('reads TODO/FIXME comments + recent log and returns DiscoveredItems', async () => {
    await init();
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        items: [
          {
            slug: 'handle-null-user',
            title: 'Handle null user in src/a.ts',
            kind: 'issue',
            rationale: 'TODO comment marks unhandled null path.',
            source_evidence: 'src/a.ts:1',
          },
          {
            slug: 'shutdown-race',
            title: 'Race condition on shutdown',
            kind: 'issue',
            rationale: 'FIXME flagged in src/b.ts.',
            source_evidence: 'src/b.ts:1',
          },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const items = await discover({ repo: tmp, adapter, model: 'mock-model' });
    expect(items).toHaveLength(2);
    expect(items[0]?.slug).toBe('handle-null-user');
    expect(items[1]?.kind).toBe('issue');

    // The user prompt should have included our TODO/FIXME evidence.
    const req = adapter.lastRequest!;
    expect(req.user).toContain('TODO: handle null user');
    expect(req.user).toContain('FIXME: race condition');
  });

  it('returns an empty list when the model finds nothing', async () => {
    await init();
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 });
    const items = await discover({ repo: tmp, adapter, model: 'mock-model' });
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/discover.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/discover.ts`**

```typescript
// src/engine/ops/discover.ts
//
// Project-wide op: scan the repo for candidate issues, ask the model to
// triage them, return DiscoveredItem[]. Caller (CLI) decides which to
// file as cards.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { DiscoveredItem } from '../types.js';

export interface DiscoverArgs {
  repo: string;
  adapter: ModelAdapter;
  model: string;
}

const SYSTEM_PROMPT = `You are scanning a software project for candidate
issues. Given a list of TODO/FIXME comments and recent commit subjects,
nominate cards to file. Each item must be specific, actionable, and worth
a card.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "items": [
      {
        "slug": "<lowercase-with-dashes>",
        "title": "<<70 chars>",
        "kind": "issue" | "feature",
        "rationale": "<1-2 sentences>",
        "source_evidence": "<file:line or commit sha>"
      },
      ...
    ]
  }`.trim();

const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.md']);
const TODO_RE = /(?:TODO|FIXME|XXX|HACK)[:\s][^\n]+/gi;

async function* walkFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.conductor') continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(p);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (SCAN_EXTS.has(ext)) yield p;
    }
  }
}

async function collectTodos(repo: string): Promise<string[]> {
  const out: string[] = [];
  for await (const path of walkFiles(repo)) {
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (TODO_RE.test(line)) {
        const rel = path.slice(repo.length + 1).replace(/\\/g, '/');
        out.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
      TODO_RE.lastIndex = 0;
    }
    if (out.length > 200) break;
  }
  return out;
}

async function recentCommitSubjects(repo: string, n = 20): Promise<string[]> {
  try {
    const log = await simpleGit(repo).log({ maxCount: n });
    return log.all.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
  } catch {
    return [];
  }
}

export async function discover(args: DiscoverArgs): Promise<DiscoveredItem[]> {
  const { repo, adapter, model } = args;

  const todos = await collectTodos(repo);
  const commits = await recentCommitSubjects(repo);

  const userPrompt = [
    '--- TODO / FIXME comments ---',
    todos.length > 0 ? todos.join('\n') : '(none)',
    '',
    '--- Recent commit subjects ---',
    commits.length > 0 ? commits.join('\n') : '(none)',
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'discover',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let items: DiscoveredItem[];
  try {
    const raw = JSON.parse(resp.text.trim());
    items = Array.isArray(raw.items) ? raw.items.map((i: unknown) => {
      const o = i as Record<string, unknown>;
      return {
        slug: String(o.slug ?? ''),
        title: String(o.title ?? ''),
        kind: o.kind as DiscoveredItem['kind'],
        rationale: String(o.rationale ?? ''),
        source_evidence: String(o.source_evidence ?? ''),
      };
    }) : [];
  } catch (e) {
    throw new Error(`Failed to parse discover JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }
  return items;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/discover.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/discover.ts tests/engine/ops/discover.test.ts
git commit -m "feat(2.14): discover op — TODO/FIXME + recent log to triaged DiscoveredItems"
```

---

### Task 15: Exercise op family (`exercise_map` / `exercise_run` / `exercise_file` / `exercise_auto`)

**Files:**
- Create: `src/engine/ops/exercise.ts`
- Create: `tests/engine/ops/exercise.test.ts`

Four ops sharing per-session state at `.conductor/exercise/<id>/_control.md`.

- `exerciseMap` — model proposes scenarios for a goal; returns Session, writes `_control.md`.
- `exerciseRun` — model produces findings against scenarios; appends to `_control.md` and returns Findings.
- `exerciseFile` — converts a single Finding into a Card stub (returns the proposed card frontmatter + body); caller writes the file.
- `exerciseAuto` — chains map → run → file for every finding.

Phase 2 keeps these minimal — the goal is the API shape and persistence, not richer behavior.

- [ ] **Step 1: Write failing tests**

Create `tests/engine/ops/exercise.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exerciseMap,
  exerciseRun,
  exerciseFile,
  exerciseAuto,
} from '../../../src/engine/ops/exercise.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-ex-'));
  await mkdir(join(tmp, '.conductor', 'exercise'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('exercise op family', () => {
  it('exerciseMap creates a session and writes _control.md', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        scenarios: ['User logs in', 'Token expires mid-session'],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const session = await exerciseMap({
      repo: tmp, adapter, model: 'mock-model',
      sessionId: 'auth-walkthrough',
      goal: 'Validate auth flows end-to-end',
    });
    expect(session.id).toBe('auth-walkthrough');
    expect(session.scenarios).toHaveLength(2);
    const control = await readFile(
      join(tmp, '.conductor', 'exercise', 'auth-walkthrough', '_control.md'),
      'utf8',
    );
    expect(control).toContain('Validate auth flows');
    expect(control).toContain('User logs in');
  });

  it('exerciseRun appends findings to the session', async () => {
    const adapter = new MockAdapter();
    // 1) map
    adapter.push({
      text: JSON.stringify({ scenarios: ['Scenario X'] }),
      inputTokens: 1, outputTokens: 1,
    });
    // 2) run
    adapter.push({
      text: JSON.stringify({
        findings: [
          { id: 'f1', scenario: 'Scenario X', observed: 'Crashes on null', severity: 'medium', evidence: 'stack trace' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const session = await exerciseMap({
      repo: tmp, adapter, model: 'mock-model',
      sessionId: 's1', goal: 'g',
    });
    const findings = await exerciseRun({ repo: tmp, adapter, model: 'mock-model', session });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('f1');
    const control = await readFile(
      join(tmp, '.conductor', 'exercise', 's1', '_control.md'),
      'utf8',
    );
    expect(control).toContain('Crashes on null');
  });

  it('exerciseFile produces card stub for a finding', async () => {
    const session = {
      id: 's1',
      goal: 'g',
      scenarios: [],
      findings: [],
      created: '2026-05-07T00:00:00Z',
    };
    const finding = {
      id: 'f1',
      scenario: 'X',
      observed: 'Crash on null',
      severity: 'medium' as const,
      evidence: 'log',
    };
    const stub = await exerciseFile({ session, finding, now: new Date('2026-05-07T01:00:00Z') });
    expect(stub.frontmatter.kind).toBe('exercise-finding');
    expect(stub.frontmatter.column).toBe('discovered');
    expect(stub.frontmatter.source).toBe('exercise:s1');
    expect(stub.frontmatter.id).toMatch(/^2026-05-07-/);
    expect(stub.body).toContain('Crash on null');
  });

  it('exerciseAuto runs map + run + file for every finding', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ scenarios: ['s'] }), inputTokens: 1, outputTokens: 1 });
    adapter.push({
      text: JSON.stringify({
        findings: [
          { id: 'f1', scenario: 's', observed: 'a', severity: 'low', evidence: '-' },
          { id: 'f2', scenario: 's', observed: 'b', severity: 'high', evidence: '-' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const summary = await exerciseAuto({
      repo: tmp, adapter, model: 'mock-model',
      sessionId: 's2', goal: 'sweep',
      now: new Date('2026-05-07T02:00:00Z'),
    });
    expect(summary.session.findings).toHaveLength(2);
    expect(summary.cards).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/ops/exercise.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/engine/ops/exercise.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/ops/exercise.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/exercise.ts tests/engine/ops/exercise.test.ts
git commit -m "feat(2.15): exercise op family — map, run, file, auto with session state"
```

**Sub-phase D checkpoint:** all engine ops are now in place. Run `npm test`.

---

## Sub-phase E — CLI surface

### Task 16: Extend `conductor work` for review → resolve

**Files:**
- Modify: `src/cli/commands/work.ts`
- Create: `tests/cli/work-phase2.test.ts`

`conductor work <card>` advances the card by ONE pipeline step based on its current column:

| Column | Action |
|---|---|
| discovered | analyze + plan; column → planned (Phase 1 behaviour, kept) |
| planned | review; if APPROVED, column → approved; otherwise stays |
| approved | requires `--step <id>`; runs `implement`; column → building when first step lands |
| building | verify; if PASS, column → verifying |
| verifying | notebook; column → shipped |
| shipped | resolve; archives card |
| archived | halt with reason |

This task mostly rewires control flow; it does not redefine the ops.

- [ ] **Step 1: Write failing CLI tests**

Create `tests/cli/work-phase2.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runWork } from '../../src/cli/commands/work.js';
import { runInit } from '../../src/cli/commands/init.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;
const ID = '2026-05-07-x';

async function bootstrap(column: string): Promise<void> {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-work2-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });
  await writeFile(join(tmp, '.conductor', 'cards', `${ID}.md`), [
    '---',
    `id: ${ID}`,
    'title: t',
    'kind: issue',
    `column: ${column}`,
    'phase: 2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
    '## Analysis',
    'a',
    '',
    '## Implementation Plan',
    '### 1.1',
    'WHAT: write file',
    'HOW: src/x.ts',
    'WHY: y',
    'RISK: low',
    'VERIFY: file exists',
    'ROLLBACK: delete',
    '',
  ].join('\n'));
  await g.add('.');
  await g.commit('seed');
}

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor work — Phase 2 transitions', () => {
  it('planned → approved when review returns APPROVED', async () => {
    await bootstrap('planned');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'ok', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('approved');
    expect(result.halted).toBe(false);
  });

  it('planned stays planned when review returns NEEDS-CHANGES', async () => {
    await bootstrap('planned');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'fix', changes_required: ['x'] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('planned');
    expect(result.halted).toBe(true);
  });

  it('approved + step → building after implement', async () => {
    await bootstrap('approved');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        step: '1.1',
        commit_type: 'feat',
        commit_subject: 'add x',
        files: [{ path: 'src/x.ts', action: 'create', content: 'x\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter, step: '1.1' });
    expect(result.finalColumn).toBe('building');
  });

  it('approved without step halts with guidance', async () => {
    await bootstrap('approved');
    const adapter = new MockAdapter();
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.halted).toBe(true);
    expect(result.reason).toMatch(/--step/);
  });

  it('building → verifying when verify returns PASS', async () => {
    await bootstrap('building');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ outcome: 'PASS', summary: 'ok', failures: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({
      cwd: tmp, cardId: ID, adapter,
      runner: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });
    expect(result.finalColumn).toBe('verifying');
  });

  it('verifying → shipped after notebook', async () => {
    await bootstrap('verifying');
    const adapter = new MockAdapter();
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('shipped');
    await access(join(tmp, '.conductor', 'archive', 'notebooks', `${ID}.ipynb`));
  });

  it('shipped → archived after resolve', async () => {
    await bootstrap('shipped');
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ summary: 'shipped', files_changed: ['src/x.ts'] }),
      inputTokens: 1, outputTokens: 1,
    });
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.finalColumn).toBe('archived');
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${ID}.md`));
    expect(archived.frontmatter.column).toBe('archived');
  });

  it('archived halts (terminal)', async () => {
    await bootstrap('archived');
    const adapter = new MockAdapter();
    const result = await runWork({ cwd: tmp, cardId: ID, adapter });
    expect(result.halted).toBe(true);
    expect(result.reason).toMatch(/terminal/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/work-phase2.test.ts
```

Expected: most tests fail because work.ts only handles `discovered`.

- [ ] **Step 3: Rewrite `src/cli/commands/work.ts`**

Replace the whole file with:

```typescript
// src/cli/commands/work.ts
//
// `conductor work <card>` — advance one pipeline step. Phase 2 covers
// the full lifecycle: discovered → planned → approved → building →
// verifying → shipped → archived.

import { join } from 'node:path';
import type { Command } from 'commander';
import { readCard, writeCard } from '../../engine/state/card.js';
import { analyze } from '../../engine/ops/analyze.js';
import { plan as planOp } from '../../engine/ops/plan.js';
import { review } from '../../engine/ops/review.js';
import { implement } from '../../engine/ops/implement.js';
import { verify, defaultRunner, type Runner } from '../../engine/ops/verify.js';
import { notebook } from '../../engine/ops/notebook.js';
import { resolve as resolveOp } from '../../engine/ops/resolve.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Column } from '../../engine/types.js';

export interface WorkArgs {
  cwd: string;
  cardId: string;
  adapter?: ModelAdapter;
  step?: string;
  runner?: Runner;
}

export interface WorkResult {
  halted: boolean;
  reason?: string;
  finalColumn: Column;
}

export async function runWork(args: WorkArgs): Promise<WorkResult> {
  const cardPath = join(args.cwd, '.conductor', 'cards', `${args.cardId}.md`);

  let card: Card;
  try {
    card = await readCard(cardPath);
  } catch {
    throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);
  }

  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter: ModelAdapter = args.adapter ?? new ClaudeAdapter();
  const modelFor = (op: string): string => config.routing.functions[op] ?? config.routing.default;

  switch (card.frontmatter.column) {
    case 'discovered': {
      await analyze({ card: await readCard(cardPath), adapter, model: modelFor('analyze') });
      await planOp({ card: await readCard(cardPath), adapter, model: modelFor('plan') });
      const updated = await readCard(cardPath);
      updated.frontmatter.column = 'planned';
      await writeCard(updated);
      return { halted: false, finalColumn: 'planned' };
    }

    case 'planned': {
      const verdict = await review({
        card: await readCard(cardPath), adapter, model: modelFor('review'),
      });
      if (verdict.decision === 'APPROVED') {
        const updated = await readCard(cardPath);
        updated.frontmatter.column = 'approved';
        await writeCard(updated);
        return { halted: false, finalColumn: 'approved' };
      }
      return {
        halted: true,
        reason: `Review returned ${verdict.decision}. Card stays in 'planned'.`,
        finalColumn: 'planned',
      };
    }

    case 'approved': {
      if (!args.step) {
        return {
          halted: true,
          reason: `'approved' requires --step <id> (one step per call).`,
          finalColumn: 'approved',
        };
      }
      await implement({
        repo: args.cwd, card: await readCard(cardPath),
        adapter, model: modelFor('implement'), step: args.step,
      });
      const updated = await readCard(cardPath);
      updated.frontmatter.column = 'building';
      await writeCard(updated);
      return { halted: false, finalColumn: 'building' };
    }

    case 'building': {
      const runner = args.runner ?? defaultRunner;
      const report = await verify({
        card: await readCard(cardPath), adapter, model: modelFor('verify'),
        command: config.verify_command, runner,
      });
      if (report.outcome === 'PASS') {
        const updated = await readCard(cardPath);
        updated.frontmatter.column = 'verifying';
        await writeCard(updated);
        return { halted: false, finalColumn: 'verifying' };
      }
      return {
        halted: true,
        reason: `Verify outcome=${report.outcome}. Card stays in 'building'.`,
        finalColumn: 'building',
      };
    }

    case 'verifying': {
      await notebook({ repo: args.cwd, card: await readCard(cardPath), command: config.verify_command });
      const updated = await readCard(cardPath);
      updated.frontmatter.column = 'shipped';
      await writeCard(updated);
      return { halted: false, finalColumn: 'shipped' };
    }

    case 'shipped': {
      await resolveOp({
        repo: args.cwd, card: await readCard(cardPath),
        adapter, model: modelFor('resolve'),
      });
      return { halted: false, finalColumn: 'archived' };
    }

    case 'archived': {
      return { halted: true, reason: 'Card is in a terminal state (archived).', finalColumn: 'archived' };
    }

    case 'shipped' as never:
    default:
      return {
        halted: true,
        reason: `Unhandled column: ${card.frontmatter.column}`,
        finalColumn: card.frontmatter.column,
      };
  }
}

export function attachWork(program: Command): void {
  program
    .command('work <cardId>')
    .description('Run the next pipeline step for a card')
    .option('--step <id>', 'Implementation step id (required when card is in approved column)')
    .action(async (cardId: string, opts: { step?: string }) => {
      const result = await runWork({ cwd: process.cwd(), cardId, step: opts.step });
      // eslint-disable-next-line no-console
      console.log(
        result.halted
          ? `Halted: ${result.reason} (column=${result.finalColumn})`
          : `Done. Card now in column: ${result.finalColumn}`,
      );
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/cli/work-phase2.test.ts tests/cli/work.test.ts
```

Expected: all old + new work tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/work.ts tests/cli/work-phase2.test.ts
git commit -m "feat(2.16): conductor work covers planned through archived"
```

---

### Task 17: `conductor scan` command

**Files:**
- Create: `src/cli/commands/scan.ts`
- Create: `tests/cli/scan.test.ts`
- Modify: `src/cli/index.ts`

Lists all active cards, grouped by column.

- [ ] **Step 1: Write failing test**

Create `tests/cli/scan.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScan } from '../../src/cli/commands/scan.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-scan-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor scan', () => {
  it('returns the same Status the scan op returns', async () => {
    await writeFile(join(tmp, '.conductor', 'cards', 'a.md'), [
      '---',
      'id: a',
      'title: t',
      'kind: issue',
      'column: discovered',
      'phase: 2',
      'priority: 1',
      'autonomy: inherit',
      'model_overrides: {}',
      "created: '2026-05-07T00:00:00Z'",
      'source: user',
      'labels: []',
      'blocked_by: []',
      '---',
      '',
      'body',
    ].join('\n'));
    const status = await runScan({ cwd: tmp });
    expect(status.cards).toHaveLength(1);
    expect(status.by_column.discovered).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/scan.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/scan.ts`**

```typescript
// src/cli/commands/scan.ts
//
// `conductor scan` — print active cards grouped by column.

import type { Command } from 'commander';
import { scan } from '../../engine/ops/scan.js';
import type { Status } from '../../engine/types.js';
import { COLUMNS } from '../../engine/types.js';

export interface ScanCliArgs {
  cwd: string;
}

export async function runScan(args: ScanCliArgs): Promise<Status> {
  return scan({ repo: args.cwd });
}

export function attachScan(program: Command): void {
  program
    .command('scan')
    .description('List active cards grouped by column')
    .action(async () => {
      const status = await runScan({ cwd: process.cwd() });
      for (const col of COLUMNS) {
        const cards = status.cards.filter((c) => c.column === col);
        if (cards.length === 0) continue;
        // eslint-disable-next-line no-console
        console.log(`\n[${col}] (${cards.length})`);
        for (const c of cards) {
          // eslint-disable-next-line no-console
          console.log(`  ${c.id}  p${c.priority}  ${c.phase}  — ${c.title}`);
        }
      }
    });
}
```

- [ ] **Step 4: Wire it into `src/cli/index.ts`**

Add to imports and program registration:

```typescript
import { attachScan } from './commands/scan.js';
// ... after attachTransition(program):
attachScan(program);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/cli/scan.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/scan.ts tests/cli/scan.test.ts src/cli/index.ts
git commit -m "feat(2.17): conductor scan CLI prints cards grouped by column"
```

---

### Task 18: `conductor order` command

**Files:**
- Create: `src/cli/commands/order.ts`
- Create: `tests/cli/order.test.ts`
- Modify: `src/cli/index.ts`

Runs `scan` then `order`, writes `.conductor/ordering.md`.

- [ ] **Step 1: Write failing test**

Create `tests/cli/order.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrder } from '../../src/cli/commands/order.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-order-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await writeFile(join(tmp, '.conductor', 'cards', 'a.md'), [
    '---',
    'id: a',
    'title: t',
    'kind: issue',
    'column: planned',
    'phase: 2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    'body',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor order CLI', () => {
  it('writes ordering.md with the ranked entries', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ entries: [{ id: 'a', rank: 1, rationale: 'only one' }] }),
      inputTokens: 1, outputTokens: 1,
    });
    const o = await runOrder({ cwd: tmp, adapter, model: 'mock-model' });
    expect(o.entries[0]?.id).toBe('a');
    const text = await readFile(join(tmp, '.conductor', 'ordering.md'), 'utf8');
    expect(text).toContain('1. a');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/order.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/order.ts`**

```typescript
// src/cli/commands/order.ts
//
// `conductor order` — scan + order, writes ordering.md.

import { join } from 'node:path';
import type { Command } from 'commander';
import { scan } from '../../engine/ops/scan.js';
import { order } from '../../engine/ops/order.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Ordering } from '../../engine/types.js';

export interface OrderCliArgs {
  cwd: string;
  adapter?: ModelAdapter;
  model?: string;
}

export async function runOrder(args: OrderCliArgs): Promise<Ordering> {
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter = args.adapter ?? new ClaudeAdapter();
  const model = args.model ?? config.routing.functions.order ?? config.routing.default;
  const status = await scan({ repo: args.cwd });
  return order({ repo: args.cwd, status, adapter, model });
}

export function attachOrder(program: Command): void {
  program
    .command('order')
    .description('Scan active cards and write ordering.md')
    .action(async () => {
      const o = await runOrder({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(`Ordering written: ${o.entries.length} card(s) ranked.`);
    });
}
```

- [ ] **Step 4: Wire into `src/cli/index.ts`**

```typescript
import { attachOrder } from './commands/order.js';
attachOrder(program);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/cli/order.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/order.ts tests/cli/order.test.ts src/cli/index.ts
git commit -m "feat(2.18): conductor order CLI writes ordering.md"
```

---

### Task 19: `conductor discover` command

**Files:**
- Create: `src/cli/commands/discover.ts`
- Create: `tests/cli/discover.test.ts`
- Modify: `src/cli/index.ts`

Runs `discover` op, files cards for each item (skipping any whose computed `id` already exists).

- [ ] **Step 1: Write failing test**

Create `tests/cli/discover.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runDiscover } from '../../src/cli/commands/discover.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-disc-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, 'src'), { recursive: true });
  await writeFile(join(tmp, 'src', 'a.ts'), '// TODO: x\n');
  await g.add('.');
  await g.commit('seed');
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor discover CLI', () => {
  it('files a card per discovered item', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        items: [
          {
            slug: 'fix-x',
            title: 'Fix x',
            kind: 'issue',
            rationale: 'TODO marker',
            source_evidence: 'src/a.ts:1',
          },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const filed = await runDiscover({
      cwd: tmp, adapter, model: 'mock-model',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    expect(filed).toHaveLength(1);
    expect(filed[0]).toBe('2026-05-07-fix-x');
    const card = await readFile(join(tmp, '.conductor', 'cards', '2026-05-07-fix-x.md'), 'utf8');
    expect(card).toContain('Fix x');
    expect(card).toContain('source: discover');
  });

  it('skips items whose card id already exists', async () => {
    await writeFile(join(tmp, '.conductor', 'cards', '2026-05-07-fix-x.md'), [
      '---',
      'id: 2026-05-07-fix-x',
      'title: existing',
      'kind: issue',
      'column: discovered',
      'phase: unassigned',
      'priority: 1',
      'autonomy: inherit',
      'model_overrides: {}',
      "created: '2026-05-07T00:00:00Z'",
      'source: user',
      'labels: []',
      'blocked_by: []',
      '---',
      '',
      'body',
    ].join('\n'));
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({
        items: [
          { slug: 'fix-x', title: 'Fix x', kind: 'issue', rationale: 'r', source_evidence: 'e' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const filed = await runDiscover({
      cwd: tmp, adapter, model: 'mock-model',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    expect(filed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/discover.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/discover.ts`**

```typescript
// src/cli/commands/discover.ts
//
// `conductor discover` — run discover op and file each item as a card.

import { join } from 'node:path';
import { access, writeFile, mkdir } from 'node:fs/promises';
import type { Command } from 'commander';
import { discover } from '../../engine/ops/discover.js';
import { writeCard } from '../../engine/state/card.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';

export interface DiscoverCliArgs {
  cwd: string;
  adapter?: ModelAdapter;
  model?: string;
  now?: Date;
}

export async function runDiscover(args: DiscoverCliArgs): Promise<string[]> {
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter = args.adapter ?? new ClaudeAdapter();
  const model = args.model ?? config.routing.functions.discover ?? config.routing.default;
  const now = args.now ?? new Date();

  const items = await discover({ repo: args.cwd, adapter, model });
  const cardsDir = join(args.cwd, '.conductor', 'cards');
  await mkdir(cardsDir, { recursive: true });

  const dateStr = now.toISOString().slice(0, 10);
  const filed: string[] = [];
  for (const item of items) {
    const id = `${dateStr}-${item.slug}`;
    const path = join(cardsDir, `${id}.md`);
    try {
      await access(path);
      continue; // already exists; skip
    } catch { /* not present */ }

    await writeCard({
      frontmatter: {
        id,
        title: item.title,
        kind: item.kind,
        column: 'discovered',
        phase: 'unassigned',
        priority: 1,
        autonomy: 'inherit',
        model_overrides: {},
        created: now.toISOString(),
        source: 'discover',
        labels: [],
        blocked_by: [],
      },
      body: [
        '# Original Issue',
        '',
        item.rationale,
        '',
        `_Source evidence:_ ${item.source_evidence}`,
        '',
      ].join('\n'),
      path,
    });
    filed.push(id);
  }
  // Avoid unused-import warning when writeFile is referenced only conditionally above.
  void writeFile;
  return filed;
}

export function attachDiscover(program: Command): void {
  program
    .command('discover')
    .description('Scan repo for candidate issues and file them as cards')
    .action(async () => {
      const filed = await runDiscover({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(filed.length === 0
        ? 'No new cards filed.'
        : `Filed ${filed.length} card(s):\n  ${filed.join('\n  ')}`);
    });
}
```

- [ ] **Step 4: Wire into `src/cli/index.ts`**

```typescript
import { attachDiscover } from './commands/discover.js';
attachDiscover(program);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/cli/discover.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/discover.ts tests/cli/discover.test.ts src/cli/index.ts
git commit -m "feat(2.19): conductor discover CLI files cards from triaged items"
```

---

### Task 20: `conductor exercise <sub>` command

**Files:**
- Create: `src/cli/commands/exercise.ts`
- Create: `tests/cli/exercise.test.ts`
- Modify: `src/cli/index.ts`

Subcommands: `map <session> --goal <text>`, `run <session>`, `auto <session> --goal <text>`. `file` is folded into `auto`; surface only the three subcommands above.

- [ ] **Step 1: Write failing test**

Create `tests/cli/exercise.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExerciseAuto, runExerciseMap } from '../../src/cli/commands/exercise.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-ex-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'exercise'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor exercise CLI', () => {
  it('exercise map writes a session control file', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: JSON.stringify({ scenarios: ['s1'] }),
      inputTokens: 1, outputTokens: 1,
    });
    await runExerciseMap({
      cwd: tmp, adapter, model: 'mock-model',
      sessionId: 's1', goal: 'sweep auth',
    });
    const text = await readFile(join(tmp, '.conductor', 'exercise', 's1', '_control.md'), 'utf8');
    expect(text).toContain('sweep auth');
  });

  it('exercise auto files cards for findings', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: JSON.stringify({ scenarios: ['s'] }), inputTokens: 1, outputTokens: 1 });
    adapter.push({
      text: JSON.stringify({
        findings: [
          { id: 'f1', scenario: 's', observed: 'crash', severity: 'high', evidence: 'log' },
        ],
      }),
      inputTokens: 1, outputTokens: 1,
    });
    const res = await runExerciseAuto({
      cwd: tmp, adapter, model: 'mock-model',
      sessionId: 's2', goal: 'g',
      now: new Date('2026-05-07T00:00:00Z'),
    });
    expect(res.filedCardIds).toHaveLength(1);
    expect(res.filedCardIds[0]).toMatch(/^2026-05-07-/);
    const cardText = await readFile(
      join(tmp, '.conductor', 'cards', `${res.filedCardIds[0]}.md`),
      'utf8',
    );
    expect(cardText).toContain('crash');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/exercise.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/exercise.ts`**

```typescript
// src/cli/commands/exercise.ts
//
// `conductor exercise <sub>` — map / run / auto.

import { join } from 'node:path';
import type { Command } from 'commander';
import { exerciseMap, exerciseRun, exerciseAuto } from '../../engine/ops/exercise.js';
import { writeCard } from '../../engine/state/card.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { ExerciseSession } from '../../engine/types.js';

interface SharedArgs {
  cwd: string;
  adapter?: ModelAdapter;
  model?: string;
}

async function resolveAdapterAndModel(args: SharedArgs, op: string): Promise<{ adapter: ModelAdapter; model: string }> {
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const adapter = args.adapter ?? new ClaudeAdapter();
  const model = args.model ?? config.routing.functions[op] ?? config.routing.default;
  return { adapter, model };
}

export interface ExerciseMapCliArgs extends SharedArgs {
  sessionId: string;
  goal: string;
}

export async function runExerciseMap(args: ExerciseMapCliArgs): Promise<ExerciseSession> {
  const { adapter, model } = await resolveAdapterAndModel(args, 'exercise_map');
  return exerciseMap({
    repo: args.cwd, adapter, model,
    sessionId: args.sessionId, goal: args.goal,
  });
}

export interface ExerciseRunCliArgs extends SharedArgs {
  sessionId: string;
  session: ExerciseSession; // caller loads from disk in production
}

export async function runExerciseRun(args: ExerciseRunCliArgs) {
  const { adapter, model } = await resolveAdapterAndModel(args, 'exercise_run');
  return exerciseRun({ repo: args.cwd, adapter, model, session: args.session });
}

export interface ExerciseAutoCliArgs extends SharedArgs {
  sessionId: string;
  goal: string;
  now?: Date;
}

export interface ExerciseAutoCliResult {
  filedCardIds: string[];
}

export async function runExerciseAuto(args: ExerciseAutoCliArgs): Promise<ExerciseAutoCliResult> {
  const { adapter, model } = await resolveAdapterAndModel(args, 'exercise_auto');
  const now = args.now ?? new Date();
  const result = await exerciseAuto({
    repo: args.cwd, adapter, model,
    sessionId: args.sessionId, goal: args.goal, now,
  });
  const filedCardIds: string[] = [];
  for (const stub of result.cards) {
    const path = join(args.cwd, '.conductor', 'cards', `${stub.frontmatter.id}.md`);
    await writeCard({ ...stub, path });
    filedCardIds.push(stub.frontmatter.id);
  }
  return { filedCardIds };
}

export function attachExercise(program: Command): void {
  const ex = program.command('exercise').description('Capability-mapping exercise sessions');
  ex.command('map <sessionId>')
    .requiredOption('--goal <text>', 'Goal of the session')
    .action(async (sessionId: string, opts: { goal: string }) => {
      await runExerciseMap({ cwd: process.cwd(), sessionId, goal: opts.goal });
      // eslint-disable-next-line no-console
      console.log(`Session ${sessionId} mapped.`);
    });
  ex.command('auto <sessionId>')
    .requiredOption('--goal <text>', 'Goal of the session')
    .action(async (sessionId: string, opts: { goal: string }) => {
      const r = await runExerciseAuto({ cwd: process.cwd(), sessionId, goal: opts.goal });
      // eslint-disable-next-line no-console
      console.log(`Filed ${r.filedCardIds.length} card(s) from session ${sessionId}.`);
    });
}
```

- [ ] **Step 4: Wire into `src/cli/index.ts`**

```typescript
import { attachExercise } from './commands/exercise.js';
attachExercise(program);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/cli/exercise.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/exercise.ts tests/cli/exercise.test.ts src/cli/index.ts
git commit -m "feat(2.20): conductor exercise CLI — map / run / auto"
```

---

### Task 21: `conductor phase close <name>` command

**Files:**
- Create: `src/cli/commands/phase.ts`
- Create: `tests/cli/phase.test.ts`
- Modify: `src/cli/index.ts`

Wraps `closePhase` from Task 11.

- [ ] **Step 1: Write failing test**

Create `tests/cli/phase.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runPhaseClose } from '../../src/cli/commands/phase.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-phase-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await writeFile(join(tmp, '.conductor', 'archive', 'cards', 'a.md'), [
    '---',
    'id: a',
    'title: t',
    'kind: issue',
    'column: archived',
    'phase: phase-2',
    'priority: 1',
    'autonomy: inherit',
    'model_overrides: {}',
    "created: '2026-05-07T00:00:00Z'",
    'source: user',
    'labels: []',
    'blocked_by: []',
    '---',
    '',
    'body',
  ].join('\n'));
  await writeFile(join(tmp, '.conductor', 'journal.md'), '# Journal\n\n');
  await g.add('.');
  await g.commit('seed');
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor phase close', () => {
  it('tags HEAD when all phase cards are archived', async () => {
    const result = await runPhaseClose({ cwd: tmp, name: 'phase-2' });
    expect(result.tag).toBe('phase-2-closed');
    const tags = await simpleGit(tmp).tags();
    expect(tags.all).toContain('phase-2-closed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/phase.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/phase.ts`**

```typescript
// src/cli/commands/phase.ts
//
// `conductor phase close <name>` — gate-and-tag a phase.

import type { Command } from 'commander';
import { closePhase, type ClosePhaseResult } from '../../engine/phase.js';

export interface PhaseCloseCliArgs {
  cwd: string;
  name: string;
}

export async function runPhaseClose(args: PhaseCloseCliArgs): Promise<ClosePhaseResult> {
  return closePhase({ repo: args.cwd, name: args.name });
}

export function attachPhase(program: Command): void {
  const phase = program.command('phase').description('Phase management');
  phase.command('close <name>')
    .description('Close a phase: every card must be archived; tags HEAD with <name>-closed')
    .action(async (name: string) => {
      const result = await runPhaseClose({ cwd: process.cwd(), name });
      // eslint-disable-next-line no-console
      console.log(`${result.tag} created (${result.archivedCards.length} cards archived)`);
    });
}
```

- [ ] **Step 4: Wire into `src/cli/index.ts`**

```typescript
import { attachPhase } from './commands/phase.js';
attachPhase(program);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/cli/phase.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/phase.ts tests/cli/phase.test.ts src/cli/index.ts
git commit -m "feat(2.21): conductor phase close CLI"
```

---

### Task 22: `conductor drift` command

**Files:**
- Create: `src/cli/commands/drift.ts`
- Create: `tests/cli/drift.test.ts`
- Modify: `src/cli/index.ts`

Runs `detectDrift` and prints results in the `[control:drift]` block format Control's surfaces consume.

- [ ] **Step 1: Write failing test**

Create `tests/cli/drift.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { runDrift, formatDrift } from '../../src/cli/commands/drift.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cli-drift-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await mkdir(join(tmp, '.conductor'), { recursive: true });
  await g.commit('initial', ['--allow-empty']);
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor drift', () => {
  it('returns drifts and formats them as control:drift block', async () => {
    const drifts = await runDrift({ cwd: tmp });
    expect(drifts.some((d) => d.kind === 'state-md-missing')).toBe(true);
    const block = formatDrift(drifts);
    expect(block).toContain('[control:drift]');
    expect(block).toContain('state-md-missing');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/drift.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/drift.ts`**

```typescript
// src/cli/commands/drift.ts
//
// `conductor drift` — run detectDrift and print a [control:drift] block.

import type { Command } from 'commander';
import { detectDrift } from '../../engine/ops/detect_drift.js';
import type { Drift } from '../../engine/types.js';

export interface DriftCliArgs {
  cwd: string;
}

export async function runDrift(args: DriftCliArgs): Promise<Drift[]> {
  return detectDrift({ repo: args.cwd });
}

export function formatDrift(drifts: Drift[]): string {
  if (drifts.length === 0) {
    return '[control:drift] (no drift)';
  }
  const lines = ['[control:drift]'];
  for (const d of drifts) {
    lines.push(`  - ${d.kind}: expected=${d.expected} actual=${d.actual} — ${d.detail}`);
  }
  return lines.join('\n');
}

export function attachDrift(program: Command): void {
  program
    .command('drift')
    .description('Print drift between .conductor/state.md and git')
    .action(async () => {
      const drifts = await runDrift({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(formatDrift(drifts));
      if (drifts.length > 0) process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Wire into `src/cli/index.ts`**

```typescript
import { attachDrift } from './commands/drift.js';
attachDrift(program);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/cli/drift.test.ts
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/drift.ts tests/cli/drift.test.ts src/cli/index.ts
git commit -m "feat(2.22): conductor drift CLI prints [control:drift] block"
```

**Sub-phase E checkpoint:** all CLI commands wired. Run `npm test`.

---

## Sub-phase F — Migration importer + close

### Task 23: `conductor import` CLI scaffold + dry-run

**Files:**
- Create: `src/cli/commands/import.ts`
- Create: `tests/cli/import.test.ts`
- Modify: `src/cli/index.ts`

CLI accepts `--relay <path>` and `--control <path>` (either or both). With `--dry-run`, prints the per-file plan and exits without writing. Without it, executes imports via the readers from Task 24.

- [ ] **Step 1: Write failing test**

Create `tests/cli/import.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../../src/cli/commands/import.js';

let tmp: string;
let relay: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-imp-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  relay = join(tmp, '.relay');
  await mkdir(join(relay, 'issues'), { recursive: true });
  await writeFile(join(relay, 'issues', 'auth_token_expired.md'), [
    '---',
    'kind: issue',
    'title: Auth token expired',
    '---',
    '',
    '# Original Issue',
    'body',
    '',
  ].join('\n'));
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('conductor import CLI', () => {
  it('dry-run reports planned imports without writing files', async () => {
    const plan = await runImport({ cwd: tmp, relayPath: relay, dryRun: true });
    expect(plan.entries.length).toBeGreaterThanOrEqual(1);
    expect(plan.entries[0]?.target).toContain('cards/');
  });

  it('writes imported cards to .conductor/cards when not dry-run', async () => {
    const plan = await runImport({ cwd: tmp, relayPath: relay, dryRun: false });
    expect(plan.written).toBe(plan.entries.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/cli/import.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement `src/cli/commands/import.ts`**

```typescript
// src/cli/commands/import.ts
//
// `conductor import` — read .relay/ and/or .control/, write equivalent
// .conductor/ files. Supports --dry-run.

import type { Command } from 'commander';
import { importRelay } from '../../importer/relay.js';
import { importControl } from '../../importer/control.js';

export interface ImportCliArgs {
  cwd: string;
  relayPath?: string;
  controlPath?: string;
  dryRun: boolean;
}

export interface ImportPlanEntry {
  source: string;
  target: string;
  kind: 'card' | 'archive-card' | 'archive-implemented' | 'archive-exercise' | 'state' | 'journal' | 'decision' | 'phase' | 'snapshot' | 'ordering';
  rename?: string;
}

export interface ImportPlan {
  entries: ImportPlanEntry[];
  written: number;
}

export async function runImport(args: ImportCliArgs): Promise<ImportPlan> {
  const entries: ImportPlanEntry[] = [];
  if (args.relayPath) {
    const r = await importRelay({ from: args.relayPath, into: args.cwd, dryRun: args.dryRun });
    entries.push(...r.entries);
  }
  if (args.controlPath) {
    const c = await importControl({ from: args.controlPath, into: args.cwd, dryRun: args.dryRun });
    entries.push(...c.entries);
  }
  return {
    entries,
    written: args.dryRun ? 0 : entries.length,
  };
}

export function attachImport(program: Command): void {
  program
    .command('import')
    .description('Import existing .relay/ and .control/ trees into .conductor/')
    .option('--relay <path>', 'Path to .relay/')
    .option('--control <path>', 'Path to .control/')
    .option('--dry-run', 'Report planned imports without writing files', false)
    .action(async (opts: { relay?: string; control?: string; dryRun: boolean }) => {
      const plan = await runImport({
        cwd: process.cwd(),
        relayPath: opts.relay,
        controlPath: opts.control,
        dryRun: opts.dryRun,
      });
      // eslint-disable-next-line no-console
      console.log(`${plan.entries.length} entries planned${opts.dryRun ? '' : `, ${plan.written} written`}.`);
      for (const e of plan.entries) {
        // eslint-disable-next-line no-console
        console.log(`  ${e.kind}: ${e.source} → ${e.target}`);
      }
    });
}
```

- [ ] **Step 4: Wire into `src/cli/index.ts`**

```typescript
import { attachImport } from './commands/import.js';
attachImport(program);
```

- [ ] **Step 5: Run tests to verify they fail with a different error (importer modules don't exist yet)**

```bash
npx vitest run tests/cli/import.test.ts
```

Expected: module-not-found for `importer/relay.js`. Acceptable — Task 24 fills this in. Tests will fully pass after Task 24.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/import.ts tests/cli/import.test.ts src/cli/index.ts
git commit -m "feat(2.23): conductor import CLI scaffold + dry-run plan"
```

---

### Task 24: Importer logic — `.relay/` and `.control/` readers

**Files:**
- Create: `src/importer/relay.ts`
- Create: `src/importer/control.ts`
- Create: `tests/importer/relay.test.ts`
- Create: `tests/importer/control.test.ts`
- Create: `tests/fixtures/relay/...` (sample tree)
- Create: `tests/fixtures/control/...` (sample tree)

Implements the mapping rules from spec § 11.

**Mapping recap (the table the implementation enforces):**

| Source | Target | Notes |
|---|---|---|
| `.relay/issues/*.md` | `.conductor/cards/*.md` | column derived from sections present |
| `.relay/features/*.md` | `.conductor/cards/*.md` | kind: feature |
| `.relay/archive/issues/*.md` | `.conductor/archive/cards/*.md` | column: archived |
| `.relay/implemented/*.md` | `.conductor/archive/implemented/*.md` | verbatim |
| `.relay/exercise/<session>/` | `.conductor/exercise/<session>/` | verbatim |
| `.relay/relay-ordering.md` | `.conductor/ordering.md` | verbatim |
| `.control/progress/STATE.md` | `.conductor/state.md` | verbatim, lowercase |
| `.control/progress/journal.md` | `.conductor/journal.md` | verbatim |
| `.control/architecture/decisions/*.md` | `.conductor/decisions/*.md` | verbatim, preserve numbering |
| `.control/issues/OPEN/*.md` | `.conductor/cards/*.md` | column: building |
| `.control/issues/RESOLVED/*.md` | `.conductor/archive/cards/*.md` | column: archived |
| `.control/phases/*` | `.conductor/phases/*` | verbatim |
| `.control/snapshots/*` | `.conductor/snapshots/*` | verbatim |

**Filename normalization:** snake_case slugs become dash-case; missing date prefix becomes `<file-mtime-YYYY-MM-DD>-<slug>`.

- [ ] **Step 1: Build fixtures**

```bash
mkdir -p tests/fixtures/relay/issues tests/fixtures/relay/features tests/fixtures/relay/archive/issues tests/fixtures/relay/implemented tests/fixtures/relay/exercise/sample-session
mkdir -p tests/fixtures/control/progress tests/fixtures/control/architecture/decisions tests/fixtures/control/issues/OPEN tests/fixtures/control/issues/RESOLVED tests/fixtures/control/phases/foo tests/fixtures/control/snapshots
```

Then create:

`tests/fixtures/relay/issues/auth_token_expired.md`:

```markdown
---
kind: issue
title: Auth token expired silently
---

# Original Issue
body of bug

## Analysis
existing analysis
```

`tests/fixtures/relay/features/dark_mode.md`:

```markdown
---
kind: feature
title: Dark mode
---

# Feature
desc
```

`tests/fixtures/relay/archive/issues/2025-12-01-fixed.md`:

```markdown
---
kind: issue
title: Old fixed bug
---

# Original Issue
done
```

`tests/fixtures/relay/implemented/2025-12-01-fixed.md`:

```markdown
# Resolved 2025-12-01-fixed

Shipped fix.
```

`tests/fixtures/relay/exercise/sample-session/_control.md`:

```markdown
# session sample-session
```

`tests/fixtures/relay/relay-ordering.md`:

```markdown
1. 2025-12-01-fixed
```

`tests/fixtures/control/progress/STATE.md`:

```markdown
# STATE
phase: phase-1
```

`tests/fixtures/control/progress/journal.md`:

```markdown
- entry
```

`tests/fixtures/control/architecture/decisions/0001-pick-typescript.md`:

```markdown
# 0001 — Pick TypeScript
status: accepted
```

`tests/fixtures/control/issues/OPEN/network_timeouts.md`:

```markdown
---
kind: issue
title: Network timeouts
---

# Bug
```

`tests/fixtures/control/issues/RESOLVED/2025-09-01-old.md`:

```markdown
---
kind: issue
title: Old resolved
---

# Bug
```

`tests/fixtures/control/phases/foo/README.md`:

```markdown
# Phase foo
```

`tests/fixtures/control/snapshots/example.md`:

```markdown
snapshot
```

- [ ] **Step 2: Write failing tests**

Create `tests/importer/relay.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importRelay } from '../../src/importer/relay.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-irelay-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'implemented'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'exercise'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('importRelay', () => {
  it('plans entries for issues, features, archive, implemented, exercise, ordering', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    const plan = await importRelay({ from: fixture, into: tmp, dryRun: true });
    const kinds = new Set(plan.entries.map((e) => e.kind));
    expect(kinds.has('card')).toBe(true);
    expect(kinds.has('archive-card')).toBe(true);
    expect(kinds.has('archive-implemented')).toBe(true);
    expect(kinds.has('archive-exercise')).toBe(true);
    expect(kinds.has('ordering')).toBe(true);
  });

  it('writes a normalised card filename when source uses snake_case + no date', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    await importRelay({ from: fixture, into: tmp, dryRun: false });
    const cards = await readFile(join(tmp, '.conductor', 'cards', '2025-12-01-fixed.md'), 'utf8').catch(() => '');
    // The undated source 'auth_token_expired.md' should be prefixed with mtime date and dash-cased
    const match = (await import('node:fs/promises')).readdir(join(tmp, '.conductor', 'cards'));
    const names = await match;
    expect(names.some((n) => n.includes('auth-token-expired'))).toBe(true);
  });

  it('copies relay-ordering.md verbatim into .conductor/ordering.md', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    await importRelay({ from: fixture, into: tmp, dryRun: false });
    const text = await readFile(join(tmp, '.conductor', 'ordering.md'), 'utf8');
    expect(text).toContain('2025-12-01-fixed');
  });

  it('copies exercise sessions into .conductor/exercise/<session>/', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'relay');
    await importRelay({ from: fixture, into: tmp, dryRun: false });
    await access(join(tmp, '.conductor', 'exercise', 'sample-session', '_control.md'));
  });
});
```

Create `tests/importer/control.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importControl } from '../../src/importer/control.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-ictrl-'));
  await mkdir(join(tmp, '.conductor', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'archive', 'cards'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'decisions'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'phases'), { recursive: true });
  await mkdir(join(tmp, '.conductor', 'snapshots'), { recursive: true });
});
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('importControl', () => {
  it('writes state.md (lowercase) and journal.md verbatim', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toContain('phase: phase-1');
    const journal = await readFile(join(tmp, '.conductor', 'journal.md'), 'utf8');
    expect(journal).toContain('- entry');
  });

  it('preserves ADR numbering', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    await access(join(tmp, '.conductor', 'decisions', '0001-pick-typescript.md'));
  });

  it('imports OPEN issues to cards/ (column: building) and RESOLVED to archive/cards/ (column: archived)', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    const open = await readFile(join(tmp, '.conductor', 'cards', '2026-05-07-network-timeouts.md'), 'utf8').catch(() => '');
    // either with mtime prefix or normalized; assert by listing
    const { readdir } = await import('node:fs/promises');
    const liveNames = await readdir(join(tmp, '.conductor', 'cards'));
    expect(liveNames.some((n) => n.includes('network-timeouts'))).toBe(true);
    const archivedNames = await readdir(join(tmp, '.conductor', 'archive', 'cards'));
    expect(archivedNames.some((n) => n.includes('old'))).toBe(true);
  });

  it('copies phases/ and snapshots/ verbatim', async () => {
    const fixture = join(__dirname, '..', 'fixtures', 'control');
    await importControl({ from: fixture, into: tmp, dryRun: false });
    await access(join(tmp, '.conductor', 'phases', 'foo', 'README.md'));
    await access(join(tmp, '.conductor', 'snapshots', 'example.md'));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/importer/
```

Expected: module not found.

- [ ] **Step 4: Implement `src/importer/relay.ts`**

```typescript
// src/importer/relay.ts
//
// Importer for .relay/ trees. Maps issues/features/archive/implemented/
// exercise/ordering into .conductor/.

import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';

export interface ImportRelayArgs {
  from: string;
  into: string;
  dryRun: boolean;
}

export interface RelayPlanEntry {
  source: string;
  target: string;
  kind: 'card' | 'archive-card' | 'archive-implemented' | 'archive-exercise' | 'ordering';
}

export interface ImportRelayResult {
  entries: RelayPlanEntry[];
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

function normalizeSlug(name: string): string {
  return name.replace(/_/g, '-').toLowerCase();
}

async function ensureDateAndDash(filename: string, source: string): Promise<string> {
  const ext = filename.endsWith('.md') ? '.md' : '';
  const base = filename.slice(0, filename.length - ext.length);
  const dashed = normalizeSlug(base);
  if (DATE_PREFIX.test(dashed)) return `${dashed}${ext}`;
  const st = await stat(source);
  const mtime = new Date(st.mtimeMs).toISOString().slice(0, 10);
  return `${mtime}-${dashed}${ext}`;
}

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
}

function deriveColumn(body: string): 'discovered' | 'planned' | 'approved' | 'building' | 'verifying' {
  const has = (h: string): boolean => body.includes(`## ${h}`);
  if (has('Verification Report')) return 'verifying';
  if (has('Implementation Guidelines')) return 'building';
  if (has('Adversarial Review')) return 'approved';
  if (has('Implementation Plan')) return 'planned';
  return 'discovered';
}

async function importCardFile(args: {
  source: string;
  targetDir: string;
  kind: 'issue' | 'feature';
  archived: boolean;
  dryRun: boolean;
}): Promise<{ source: string; target: string }> {
  const { source, targetDir, kind, archived, dryRun } = args;
  const text = await readFile(source, 'utf8');
  const parsed = matter(text);
  const fname = basename(source);
  const newName = await ensureDateAndDash(fname, source);
  const idFromName = newName.replace(/\.md$/, '');
  const created = parsed.data.created ?? new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: idFromName,
    title: parsed.data.title ?? idFromName,
    kind,
    column: archived ? 'archived' : deriveColumn(parsed.content),
    phase: parsed.data.phase ?? 'unassigned',
    priority: parsed.data.priority ?? 1,
    autonomy: 'inherit',
    model_overrides: {},
    created,
    source: 'imported',
    labels: parsed.data.labels ?? [],
    blocked_by: parsed.data.blocked_by ?? [],
  };
  const target = join(targetDir, newName);
  if (!dryRun) {
    await mkdir(dirname(target), { recursive: true });
    const head = yaml.dump(fm, { lineWidth: 0, noRefs: true });
    await writeFile(target, `---\n${head}---\n\n${parsed.content.trimStart()}`, 'utf8');
  }
  return { source, target };
}

async function copyTree(src: string, dst: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d, false);
    else await copyFile(s, d);
  }
}

export async function importRelay(args: ImportRelayArgs): Promise<ImportRelayResult> {
  const entries: RelayPlanEntry[] = [];
  const dst = join(args.into, '.conductor');

  // Issues → cards
  const issuesDir = join(args.from, 'issues');
  for (const name of await listMd(issuesDir)) {
    const r = await importCardFile({
      source: join(issuesDir, name),
      targetDir: join(dst, 'cards'),
      kind: 'issue',
      archived: false,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'card' });
  }

  // Features → cards
  const featuresDir = join(args.from, 'features');
  for (const name of await listMd(featuresDir)) {
    const r = await importCardFile({
      source: join(featuresDir, name),
      targetDir: join(dst, 'cards'),
      kind: 'feature',
      archived: false,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'card' });
  }

  // Archived issues → archive/cards
  const archIssuesDir = join(args.from, 'archive', 'issues');
  for (const name of await listMd(archIssuesDir)) {
    const r = await importCardFile({
      source: join(archIssuesDir, name),
      targetDir: join(dst, 'archive', 'cards'),
      kind: 'issue',
      archived: true,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'archive-card' });
  }

  // Implemented summaries (verbatim)
  const implementedDir = join(args.from, 'implemented');
  for (const name of await listMd(implementedDir)) {
    const source = join(implementedDir, name);
    const target = join(dst, 'archive', 'implemented', name);
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'archive-implemented' });
  }

  // Exercise sessions (verbatim trees)
  const exerciseDir = join(args.from, 'exercise');
  try {
    for (const session of await readdir(exerciseDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const source = join(exerciseDir, session.name);
      const target = join(dst, 'exercise', session.name);
      await copyTree(source, target, args.dryRun);
      entries.push({ source, target, kind: 'archive-exercise' });
    }
  } catch { /* no exercise dir */ }

  // relay-ordering.md → ordering.md
  try {
    const source = join(args.from, 'relay-ordering.md');
    const target = join(dst, 'ordering.md');
    await stat(source);
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'ordering' });
  } catch { /* no ordering */ }

  return { entries };
}
```

- [ ] **Step 5: Implement `src/importer/control.ts`**

```typescript
// src/importer/control.ts
//
// Importer for .control/ trees. Maps STATE.md/journal.md/decisions/
// issues/phases/snapshots into .conductor/.

import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';

export interface ImportControlArgs {
  from: string;
  into: string;
  dryRun: boolean;
}

export interface ControlPlanEntry {
  source: string;
  target: string;
  kind: 'card' | 'archive-card' | 'state' | 'journal' | 'decision' | 'phase' | 'snapshot';
}

export interface ImportControlResult {
  entries: ControlPlanEntry[];
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

function normalizeSlug(name: string): string {
  return name.replace(/_/g, '-').toLowerCase();
}

async function ensureDateAndDash(filename: string, source: string): Promise<string> {
  const ext = filename.endsWith('.md') ? '.md' : '';
  const base = filename.slice(0, filename.length - ext.length);
  const dashed = normalizeSlug(base);
  if (DATE_PREFIX.test(dashed)) return `${dashed}${ext}`;
  const st = await stat(source);
  const mtime = new Date(st.mtimeMs).toISOString().slice(0, 10);
  return `${mtime}-${dashed}${ext}`;
}

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
}

async function copyTree(src: string, dst: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d, false);
    else await copyFile(s, d);
  }
}

async function importIssueFile(args: {
  source: string;
  targetDir: string;
  archived: boolean;
  dryRun: boolean;
}): Promise<{ source: string; target: string }> {
  const { source, targetDir, archived, dryRun } = args;
  const text = await readFile(source, 'utf8');
  const parsed = matter(text);
  const fname = basename(source);
  const newName = await ensureDateAndDash(fname, source);
  const idFromName = newName.replace(/\.md$/, '');
  const fm: Record<string, unknown> = {
    id: idFromName,
    title: parsed.data.title ?? idFromName,
    kind: 'issue',
    column: archived ? 'archived' : 'building',
    phase: parsed.data.phase ?? 'unassigned',
    priority: parsed.data.priority ?? 1,
    autonomy: 'inherit',
    model_overrides: {},
    created: parsed.data.created ?? new Date().toISOString(),
    source: 'imported',
    labels: parsed.data.labels ?? [],
    blocked_by: parsed.data.blocked_by ?? [],
  };
  const target = join(targetDir, newName);
  if (!dryRun) {
    await mkdir(dirname(target), { recursive: true });
    const head = yaml.dump(fm, { lineWidth: 0, noRefs: true });
    await writeFile(target, `---\n${head}---\n\n${parsed.content.trimStart()}`, 'utf8');
  }
  return { source, target };
}

export async function importControl(args: ImportControlArgs): Promise<ImportControlResult> {
  const entries: ControlPlanEntry[] = [];
  const dst = join(args.into, '.conductor');

  // STATE.md → state.md
  try {
    const source = join(args.from, 'progress', 'STATE.md');
    await stat(source);
    const target = join(dst, 'state.md');
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'state' });
  } catch { /* no STATE.md */ }

  // journal.md
  try {
    const source = join(args.from, 'progress', 'journal.md');
    await stat(source);
    const target = join(dst, 'journal.md');
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'journal' });
  } catch { /* no journal */ }

  // ADRs (preserve numbering)
  const decisionsDir = join(args.from, 'architecture', 'decisions');
  for (const name of await listMd(decisionsDir)) {
    const source = join(decisionsDir, name);
    const target = join(dst, 'decisions', name);
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'decision' });
  }

  // OPEN issues → cards/ (building)
  const openDir = join(args.from, 'issues', 'OPEN');
  for (const name of await listMd(openDir)) {
    const r = await importIssueFile({
      source: join(openDir, name),
      targetDir: join(dst, 'cards'),
      archived: false,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'card' });
  }

  // RESOLVED issues → archive/cards/
  const resolvedDir = join(args.from, 'issues', 'RESOLVED');
  for (const name of await listMd(resolvedDir)) {
    const r = await importIssueFile({
      source: join(resolvedDir, name),
      targetDir: join(dst, 'archive', 'cards'),
      archived: true,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'archive-card' });
  }

  // phases/ verbatim
  const phasesDir = join(args.from, 'phases');
  try {
    for (const phase of await readdir(phasesDir, { withFileTypes: true })) {
      if (!phase.isDirectory()) continue;
      const source = join(phasesDir, phase.name);
      const target = join(dst, 'phases', phase.name);
      await copyTree(source, target, args.dryRun);
      entries.push({ source, target, kind: 'phase' });
    }
  } catch { /* no phases */ }

  // snapshots/ verbatim
  const snapshotsDir = join(args.from, 'snapshots');
  try {
    for (const name of await readdir(snapshotsDir)) {
      const source = join(snapshotsDir, name);
      const target = join(dst, 'snapshots', name);
      if (!args.dryRun) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      entries.push({ source, target, kind: 'snapshot' });
    }
  } catch { /* no snapshots */ }

  return { entries };
}
```

- [ ] **Step 6: Run all importer tests**

```bash
npx vitest run tests/importer/ tests/cli/import.test.ts
```

Expected: importer tests pass; the import CLI test now also passes.

- [ ] **Step 7: Commit**

```bash
git add src/importer/relay.ts src/importer/control.ts tests/importer tests/fixtures/relay tests/fixtures/control
git commit -m "feat(2.24): .relay/ and .control/ importers"
```

---

### Task 25: Phase 2 end-to-end test + README + tag

**Files:**
- Create: `tests/integration/phase2-end-to-end.test.ts`
- Modify: `README.md`

End-to-end test drives a card from `discovered` to `archived` via the CLI runners, using MockAdapter for every LLM call and an injected verify runner.

- [ ] **Step 1: Write the integration test**

Create `tests/integration/phase2-end-to-end.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { simpleGit } from 'simple-git';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-p2-e2e-'));
  const g = simpleGit(tmp);
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.com');
  await runInit({ cwd: tmp });
  await mkdir(join(tmp, 'src'), { recursive: true });
  await g.add('.');
  await g.commit('seed');
});

afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

describe('Phase 2 end-to-end: discovered -> archived', () => {
  it('drives a card through the entire lifecycle', async () => {
    const cardPath = await runCardNew({
      cwd: tmp, slug: 'auth-token-expiry',
      title: 'Auth token expires silently', kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const id = basename(cardPath, '.md');

    const adapter = new MockAdapter();
    // analyze
    adapter.push({ text: 'Validation: yes\nRoot Cause: x\nBlast Radius: y\nApproach: z', inputTokens: 1, outputTokens: 1 });
    // plan
    adapter.push({
      text: '### 1.1\nWHAT: write file\nHOW: src/x.ts\nWHY: y\nRISK: low\nVERIFY: file exists\nROLLBACK: delete',
      inputTokens: 1, outputTokens: 1,
    });
    // review (APPROVED)
    adapter.push({
      text: JSON.stringify({ decision: 'APPROVED', reasoning: 'sound', changes_required: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    // implement (1.1)
    adapter.push({
      text: JSON.stringify({
        step: '1.1', commit_type: 'feat', commit_subject: 'add x',
        files: [{ path: 'src/x.ts', action: 'create', content: 'export const x = 1;\n' }],
        notes: '',
      }),
      inputTokens: 1, outputTokens: 1,
    });
    // verify (PASS)
    adapter.push({
      text: JSON.stringify({ outcome: 'PASS', summary: 'ok', failures: [] }),
      inputTokens: 1, outputTokens: 1,
    });
    // notebook is deterministic (no adapter call)
    // resolve
    adapter.push({
      text: JSON.stringify({ summary: 'shipped x', files_changed: ['src/x.ts'] }),
      inputTokens: 1, outputTokens: 1,
    });

    const runner = async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });

    // discovered -> planned
    let r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('planned');
    // planned -> approved
    r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('approved');
    // approved -> building
    r = await runWork({ cwd: tmp, cardId: id, adapter, step: '1.1' });
    expect(r.finalColumn).toBe('building');
    // building -> verifying
    r = await runWork({ cwd: tmp, cardId: id, adapter, runner });
    expect(r.finalColumn).toBe('verifying');
    // verifying -> shipped
    r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('shipped');
    // shipped -> archived
    r = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(r.finalColumn).toBe('archived');

    // Card moved to archive
    await access(join(tmp, '.conductor', 'archive', 'cards', `${id}.md`));
    const archived = await readCard(join(tmp, '.conductor', 'archive', 'cards', `${id}.md`));
    expect(archived.frontmatter.column).toBe('archived');
    // Implemented summary present
    await access(join(tmp, '.conductor', 'archive', 'implemented', `${id}.md`));
    // Notebook present
    await access(join(tmp, '.conductor', 'archive', 'notebooks', `${id}.ipynb`));
    // Implementation step committed
    const log = await simpleGit(tmp).log();
    expect(log.all.some((c) => c.message.startsWith('feat(2.1.1):'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
npx vitest run tests/integration/phase2-end-to-end.test.ts
```

Expected: 1 test passes (covering Phase 1 + every Phase 2 op).

- [ ] **Step 3: Refresh `README.md`**

Replace existing Phase 1 section with Phase 2 status:

```markdown
# Conductor

Per-repo, model-agnostic AI engineering harness. Unifies Relay (workflow
pipeline + persistent memory), Control (session discipline + git-backed
audit), and Symphony (autonomous orchestration).

## Status

**Phase 2** (Operations breadth + Control discipline + migration). The
full Relay+Control pipeline runs on Claude via the CLI; existing
`.relay/` / `.control/` repos can be migrated. See
`docs/superpowers/specs/2026-05-06-conductor-design1.md` and
`docs/superpowers/plans/2026-05-07-phase-2-operations-discipline-migration.md`.

## Capabilities

- `conductor init` — scaffold `.conductor/`
- `conductor card new <slug> [--title ...] [--kind ...]` — file a card
- `conductor work <card> [--step <id>]` — advance the card by one
  pipeline step (analyze/plan/review/implement/verify/notebook/resolve)
- `conductor transition <card> <column>` — manual lifecycle move
- `conductor scan` — list active cards by column
- `conductor order` — write a ranked `ordering.md`
- `conductor discover` — file cards from repo TODO/FIXME + recent log
- `conductor exercise map|auto <session> --goal <text>` — capability
  walkthroughs
- `conductor phase close <name>` — gate-and-tag a phase
- `conductor drift` — print the `[control:drift]` block
- `conductor import [--relay PATH] [--control PATH] [--dry-run]` —
  migrate an existing repo

Phase 3 adds multi-model adapters. Phase 4 adds the daemon, MCP server,
and HTTP API. Phase 5 adds the UI. Phase 6 adds the autonomous Conductor
brain.

## Try it

```bash
npm install
npm run build
node dist/cli/index.js init
node dist/cli/index.js card new auth-token-expiry --title "Auth token expires silently"
ANTHROPIC_API_KEY=sk-... node dist/cli/index.js work 2026-05-07-auth-token-expiry
```

## Development

```bash
npm test           # run all tests
npm run typecheck  # type-check without emit
npm run dev -- <args>  # run the CLI without building
```

## License

Apache-2.0 (see LICENSE).
```

- [ ] **Step 4: Run the full suite**

```bash
npm test
```

Expected: every test (Phase 1 + Phase 2) passes.

- [ ] **Step 5: Commit docs**

```bash
git add tests/integration/phase2-end-to-end.test.ts README.md
git commit -m "docs(2.25): Phase 2 end-to-end test + README refresh"
```

- [ ] **Step 6: Tag the phase**

```bash
node dist/cli/index.js phase close phase-2
```

Or, if running it through the engine isn't desired (no cards yet reference `phase-2`), tag manually:

```bash
git tag phase-2-operations-discipline-migration-closed
```

Final state check:

```bash
git log --oneline -5
git tag --list
npm test
```

Expected: clean tree, tag present, every test green.

---

## Self-review

This plan has been written; before declaring it ready, the author runs through the spec with fresh eyes:

1. **Spec coverage.** Phase 2 § 12 calls out: review, implement, verify, resolve, scan, order, discover, exercise (Tasks 4, 5, 6, 8, 12, 13, 14, 15) — covered. Drift detection (Task 9), commit-per-step (Task 5 via Task 2's git module), tag-per-phase (Task 11). Migration importer (Tasks 23 + 24). Notebook is mentioned in § 5.2 between verify and resolve and is included as Task 7. End-to-end coverage is Task 25.
2. **Placeholder scan.** No `TODO`, `TBD`, `fill in` strings. Every step that changes code shows the code.
3. **Type consistency.** `Verdict`, `Diff`, `VerifyReport`, `ResolutionDoc`, `Drift`, `Status`, `Ordering`, `DiscoveredItem`, `ExerciseSession`, `ExerciseFinding` defined in Task 1 and referenced consistently in Tasks 4–15. `Runner` type comes from Task 6 and is reused in Task 16. `Card` and `CardFrontmatter` come from Phase 1.
4. **Cross-task references.** Task 5 uses `commitStep` from Task 2. Task 8 uses `lastCommitSha` from Task 2. Task 10 uses `detectDrift` from Task 9 and `writeStateAtomic`/`appendJournal` from Task 3. Task 11 uses `listCards` (Phase 1), `createPhaseTag` (Task 2), `appendJournal` (Task 3). Task 16 uses every op from Tasks 4–8. Task 23 imports from Task 24's modules.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-phase-2-operations-discipline-migration.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks. Matches the Phase 1 cadence.
2. **Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batching with checkpoints at sub-phase boundaries.

Either path: tag `phase-2-operations-discipline-migration-closed` at the very end (Task 25 step 6).






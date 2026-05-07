# Phase 1 — Engine Spine + CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Conductor's engine spine and CLI capable of driving a card from `Discovered → Planned → Approved` using a Claude adapter, with the lifecycle state machine, Hook Bus, Card CRUD, and two operations (analyze, plan) all in place.

**Architecture:** TypeScript + Node 20+ on ESM modules. The engine exposes typed operations that route through a Model Adapter Layer; the CLI drives the engine in-process (Phase 1 has no daemon). Card state lives as markdown files in `.conductor/cards/` with frontmatter (Relay-style accretion). Lifecycle transitions are deterministic in Phase 1 (`manual` blocks autonomous transitions, `auto` fires, `assist` halts and surfaces — no Conductor confidence model yet, that arrives in Phase 6). Hook Bus emits events to in-process TypeScript subscribers (no shell scripts).

**Tech Stack:** TypeScript 5.6+, Node 20+, Vitest (testing), Commander.js (CLI), gray-matter (frontmatter), js-yaml (YAML config), Zod (schema validation), @anthropic-ai/sdk (Claude adapter).

**Spec reference:** `docs/superpowers/specs/2026-05-06-conductor-design1.md` § Phase 1 (in §12).

---

## File Structure

```
conductor/
├── package.json                          # task 1
├── tsconfig.json                         # task 1
├── vitest.config.ts                      # task 1
├── src/
│   ├── engine/
│   │   ├── types.ts                      # task 2: Card, Column, Autonomy, etc.
│   │   ├── operation.ts                  # task 8: OperationRequest/Response
│   │   ├── lifecycle.ts                  # task 6: column transitions + autonomy gates
│   │   ├── state/
│   │   │   └── card.ts                   # task 5: card CRUD + body accretion
│   │   ├── hooks/
│   │   │   └── bus.ts                    # task 7: in-process event bus
│   │   └── ops/
│   │       ├── analyze.ts                # task 10
│   │       └── plan.ts                   # task 11
│   ├── adapters/
│   │   ├── adapter.ts                    # task 8: ModelAdapter interface
│   │   ├── mock.ts                       # task 8: MockAdapter for tests
│   │   └── claude.ts                     # task 9: ClaudeAdapter (Anthropic SDK)
│   ├── config/
│   │   ├── schema.ts                     # task 3: Zod schemas
│   │   └── load.ts                       # task 4: load .conductor/config.yaml
│   └── cli/
│       ├── index.ts                      # task 12: Commander entry point
│       └── commands/
│           ├── init.ts                   # task 13
│           ├── card-new.ts               # task 14
│           ├── work.ts                   # task 15
│           └── transition.ts             # task 16
├── tests/
│   ├── engine/
│   │   ├── state/card.test.ts            # task 5
│   │   ├── lifecycle.test.ts             # task 6
│   │   ├── hooks/bus.test.ts             # task 7
│   │   └── ops/
│   │       ├── analyze.test.ts           # task 10
│   │       └── plan.test.ts              # task 11
│   ├── adapters/
│   │   ├── mock.test.ts                  # task 8
│   │   └── claude.test.ts                # task 9
│   ├── config/load.test.ts               # task 4
│   ├── cli/
│   │   ├── init.test.ts                  # task 13
│   │   ├── card-new.test.ts              # task 14
│   │   ├── work.test.ts                  # task 15
│   │   └── transition.test.ts            # task 16
│   ├── integration/
│   │   └── end-to-end.test.ts            # task 17
│   └── fixtures/
│       ├── sample-card.md                # task 5
│       └── sample-config.yaml            # task 4
└── README.md                             # task 18
```

---

## Tasks

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "conductor-workflow",
  "version": "0.1.0",
  "description": "Per-repo, model-agnostic AI engineering harness",
  "type": "module",
  "bin": {
    "conductor": "./dist/cli/index.js"
  },
  "main": "./dist/engine/index.js",
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "tsx src/cli/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.65.0",
    "commander": "^12.1.0",
    "gray-matter": "^4.0.3",
    "js-yaml": "^4.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 5000,
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 5: Verify typecheck and test commands work**

Run: `npm run typecheck`
Expected: no errors (no source files yet, but config valid).

Run: `npm test`
Expected: "No test files found" (vitest exits 0 when no tests; this is OK at this point).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore(1.1): scaffold TypeScript Node project with Vitest"
```

---

### Task 2: Engine core types

**Files:**
- Create: `src/engine/types.ts`

- [ ] **Step 1: Write `src/engine/types.ts`**

```typescript
// src/engine/types.ts
//
// Core domain types for the Conductor engine. These types are the contract
// between operations, adapters, and the CLI; they should be minimal and
// stable.

export const COLUMNS = [
  'discovered',
  'planned',
  'approved',
  'building',
  'verifying',
  'shipped',
  'archived',
] as const;
export type Column = (typeof COLUMNS)[number];

export const KINDS = ['issue', 'feature', 'exercise-finding', 'imported'] as const;
export type Kind = (typeof KINDS)[number];

export const AUTONOMY_MODES = ['inherit', 'escort', 'assist', 'auto'] as const;
export type Autonomy = (typeof AUTONOMY_MODES)[number];

export type ModelOverrides = Record<string, string>;

export interface CardFrontmatter {
  id: string;
  title: string;
  kind: Kind;
  column: Column;
  phase: string; // 'unassigned' if no phase yet
  priority: number;
  autonomy: Autonomy;
  model_overrides: ModelOverrides;
  created: string; // ISO 8601
  source: string; // discover | user | linear | exercise:<session>
  labels: string[];
  blocked_by: string[];
}

export interface Card {
  frontmatter: CardFrontmatter;
  body: string;
  path: string; // absolute path to the .md file
}

export interface BlastRadius {
  level: 'low' | 'medium' | 'high';
  reason: string;
}

export interface RecommendationOption {
  id: string;
  confidence: number; // 0..1
  rationale: string;
}

export interface Recommendation {
  type: 'recommendation';
  card: string;
  operation: string;
  blast_radius: BlastRadius;
  options: RecommendationOption[];
  recommended: string; // option id
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/types.ts
git commit -m "feat(1.2): engine core domain types"
```

---

### Task 3: Frontmatter and config Zod schemas

**Files:**
- Create: `src/config/schema.ts`

- [ ] **Step 1: Write `src/config/schema.ts`**

```typescript
// src/config/schema.ts
//
// Zod schemas for runtime-validated parsing of:
//   - card frontmatter (.conductor/cards/<id>.md YAML head)
//   - project config (.conductor/config.yaml)
//
// Keep schema in sync with src/engine/types.ts. Schema is the parser at
// boundaries; types.ts is the type system used everywhere internal.

import { z } from 'zod';
import { COLUMNS, KINDS, AUTONOMY_MODES } from '../engine/types.js';

export const ColumnSchema = z.enum(COLUMNS);
export const KindSchema = z.enum(KINDS);
export const AutonomySchema = z.enum(AUTONOMY_MODES);

const ID_PATTERN = /^[a-z0-9][a-z0-9-]+[a-z0-9]$/;

export const CardFrontmatterSchema = z
  .object({
    id: z.string().regex(ID_PATTERN, 'id must be lowercase alphanumeric with dashes'),
    title: z.string().min(1),
    kind: KindSchema,
    column: ColumnSchema,
    phase: z.string().default('unassigned'),
    priority: z.number().int().nonnegative().default(1),
    autonomy: AutonomySchema.default('inherit'),
    model_overrides: z.record(z.string(), z.string()).default({}),
    created: z.string(),
    source: z.string(),
    labels: z.array(z.string()).default([]),
    blocked_by: z.array(z.string()).default([]),
  })
  .strict();

export const TransitionPolicy = z.enum(['manual', 'assist', 'auto']);

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
  })
  .strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config/schema.ts
git commit -m "feat(1.3): Zod schemas for card frontmatter and project config"
```

---

### Task 4: Project config loader

**Files:**
- Create: `src/config/load.ts`
- Create: `tests/config/load.test.ts`
- Create: `tests/fixtures/sample-config.yaml`

- [ ] **Step 1: Create `tests/fixtures/sample-config.yaml`**

```yaml
routing:
  default: claude-sonnet-4-6
  functions:
    analyze: claude-opus-4-7
    plan: claude-opus-4-7
autonomy:
  default: assist
  transitions:
    discovered_to_planned: auto
    planned_to_approved: assist
    approved_to_building: manual
```

- [ ] **Step 2: Write the failing test `tests/config/load.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadProjectConfig } from '../../src/config/load.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'sample-config.yaml');

describe('loadProjectConfig', () => {
  it('parses a complete config file', async () => {
    const config = await loadProjectConfig(fixture);
    expect(config.routing.default).toBe('claude-sonnet-4-6');
    expect(config.routing.functions.analyze).toBe('claude-opus-4-7');
    expect(config.autonomy.default).toBe('assist');
    expect(config.autonomy.transitions.discovered_to_planned).toBe('auto');
  });

  it('applies defaults for missing fields', async () => {
    const config = await loadProjectConfig(undefined, {
      routing: { default: 'claude-sonnet-4-6' },
    });
    expect(config.autonomy.default).toBe('assist');
    expect(config.autonomy.transitions.approved_to_building).toBe('manual');
    expect(config.routing.functions).toEqual({});
  });

  it('throws on invalid YAML', async () => {
    await expect(loadProjectConfig(undefined, 'not: valid: yaml: [' as unknown)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL — module `../../src/config/load.js` not found.

- [ ] **Step 4: Write `src/config/load.ts`**

```typescript
// src/config/load.ts
//
// Load and validate .conductor/config.yaml. Two entry points:
//   - loadProjectConfig(path): read from disk
//   - loadProjectConfig(undefined, raw): parse from a JS object or YAML string
// (the second form is for tests and importer flows that don't write to disk).

import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { ProjectConfigSchema, type ProjectConfig } from './schema.js';

export async function loadProjectConfig(
  path?: string,
  raw?: unknown,
): Promise<ProjectConfig> {
  let parsed: unknown;
  if (path !== undefined) {
    const text = await readFile(path, 'utf8');
    parsed = yaml.load(text);
  } else if (typeof raw === 'string') {
    parsed = yaml.load(raw);
  } else {
    parsed = raw ?? {};
  }
  return ProjectConfigSchema.parse(parsed);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config/load.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/load.ts tests/config/load.test.ts tests/fixtures/sample-config.yaml
git commit -m "feat(1.4): project config loader with YAML + Zod validation"
```

---

### Task 5: Card CRUD with body accretion

**Files:**
- Create: `src/engine/state/card.ts`
- Create: `tests/engine/state/card.test.ts`
- Create: `tests/fixtures/sample-card.md`

- [ ] **Step 1: Create `tests/fixtures/sample-card.md`**

```markdown
---
id: 2026-05-06-auth-token-expiry
title: Auth token expires silently
kind: issue
column: discovered
phase: unassigned
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-06T12:34:56Z
source: user
labels:
  - auth
  - regression
blocked_by: []
---

# Original Issue

When a user's auth token expires, the application returns a 500 instead
of redirecting to login. Affects all `src/auth/` paths.
```

- [ ] **Step 2: Write the failing test `tests/engine/state/card.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCard,
  writeCard,
  listCards,
  appendSection,
  buildCardPath,
} from '../../../src/engine/state/card.js';
import type { CardFrontmatter } from '../../../src/engine/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardsDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cards-'));
  cardsDir = join(tmp, '.conductor', 'cards');
  await import('node:fs/promises').then((fs) => fs.mkdir(cardsDir, { recursive: true }));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('readCard', () => {
  it('parses frontmatter and body from a fixture file', async () => {
    const card = await readCard(fixturePath);
    expect(card.frontmatter.id).toBe('2026-05-06-auth-token-expiry');
    expect(card.frontmatter.column).toBe('discovered');
    expect(card.frontmatter.kind).toBe('issue');
    expect(card.frontmatter.labels).toEqual(['auth', 'regression']);
    expect(card.body).toContain('When a user');
  });

  it('rejects malformed frontmatter', async () => {
    const bad = join(tmp, 'bad.md');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(bad, '---\nnot: valid frontmatter\n---\n\nbody\n'),
    );
    await expect(readCard(bad)).rejects.toThrow();
  });
});

describe('writeCard', () => {
  it('round-trips: write then read produces identical frontmatter', async () => {
    const original = await readCard(fixturePath);
    const dest = join(cardsDir, `${original.frontmatter.id}.md`);
    await writeCard({ ...original, path: dest });
    const reread = await readCard(dest);
    expect(reread.frontmatter).toEqual(original.frontmatter);
    expect(reread.body.trim()).toBe(original.body.trim());
  });
});

describe('listCards', () => {
  it('returns all cards in cardsDir, sorted by id', async () => {
    const idA = '2026-05-06-aaa-bug';
    const idB = '2026-05-06-bbb-bug';
    await copyFile(fixturePath, join(cardsDir, `${idB}.md`));
    await copyFile(fixturePath, join(cardsDir, `${idA}.md`));
    const cards = await listCards(cardsDir);
    expect(cards).toHaveLength(2);
    // listCards sorts by filename
    expect(cards[0]!.path.endsWith(`${idA}.md`)).toBe(true);
    expect(cards[1]!.path.endsWith(`${idB}.md`)).toBe(true);
  });

  it('returns empty array when cardsDir does not exist', async () => {
    const cards = await listCards(join(tmp, 'no-such-dir'));
    expect(cards).toEqual([]);
  });
});

describe('appendSection', () => {
  it('appends a section separated by horizontal rule', async () => {
    const original = await readCard(fixturePath);
    const dest = join(cardsDir, `${original.frontmatter.id}.md`);
    await writeCard({ ...original, path: dest });
    await appendSection(dest, 'Analysis', '... appended by analyze ...');
    const updated = await readCard(dest);
    expect(updated.body).toContain('## Analysis');
    expect(updated.body).toContain('appended by analyze');
    // Ensure horizontal rule separator present
    expect(updated.body).toMatch(/\n---\n+## Analysis/);
  });
});

describe('buildCardPath', () => {
  it('joins cardsDir with id and .md suffix', () => {
    expect(buildCardPath('/tmp/c', 'abc-123')).toBe('/tmp/c/abc-123.md');
  });
});

// Vitest needs afterEach imported; declared at test scope below
import { afterEach } from 'vitest';
```

Note: the `afterEach` import at the bottom is intentional Vitest style; place it adjacent to `beforeEach` if you prefer.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/engine/state/card.test.ts`
Expected: FAIL — module `card.js` not found.

- [ ] **Step 4: Write `src/engine/state/card.ts`**

```typescript
// src/engine/state/card.ts
//
// Card persistence: read, write, list, and append-section.
// Cards are markdown files with YAML frontmatter at .conductor/cards/<id>.md.
// Body sections accrete over the lifecycle (Relay-style):
//   # Original Issue
//   ---
//   ## Analysis
//   ---
//   ## Implementation Plan
//   ---
//   etc.

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { CardFrontmatterSchema } from '../../config/schema.js';
import type { Card, CardFrontmatter } from '../types.js';

export function buildCardPath(cardsDir: string, id: string): string {
  return join(cardsDir, `${id}.md`);
}

export async function readCard(path: string): Promise<Card> {
  const text = await readFile(path, 'utf8');
  const parsed = matter(text);
  const frontmatter = CardFrontmatterSchema.parse(parsed.data);
  return {
    frontmatter,
    body: parsed.content,
    path,
  };
}

export async function writeCard(card: Card): Promise<void> {
  await mkdir(dirname(card.path), { recursive: true });
  // gray-matter's stringify is fussy with quoting; serialize manually with js-yaml
  // for predictable output and tight control over whitespace.
  const head = yaml.dump(card.frontmatter, { lineWidth: 0, noRefs: true });
  const out = `---\n${head}---\n\n${card.body.trimStart()}`;
  await writeFile(card.path, out, 'utf8');
}

export async function listCards(cardsDir: string): Promise<Card[]> {
  let entries: string[];
  try {
    entries = await readdir(cardsDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw e;
  }
  const mdFiles = entries.filter((n) => n.endsWith('.md')).sort();
  const out: Card[] = [];
  for (const name of mdFiles) {
    out.push(await readCard(join(cardsDir, name)));
  }
  return out;
}

export async function appendSection(
  path: string,
  heading: string,
  content: string,
): Promise<void> {
  const card = await readCard(path);
  const trimmed = card.body.trimEnd();
  const section = `\n\n---\n\n## ${heading}\n\n${content.trim()}\n`;
  card.body = `${trimmed}${section}`;
  await writeCard(card);
}

export type { Card, CardFrontmatter };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/engine/state/card.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/state/card.ts tests/engine/state/card.test.ts tests/fixtures/sample-card.md
git commit -m "feat(1.5): card CRUD with frontmatter parsing and body accretion"
```

---

### Task 6: Lifecycle state machine

**Files:**
- Create: `src/engine/lifecycle.ts`
- Create: `tests/engine/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test `tests/engine/lifecycle.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  canTransition,
  nextOperation,
  transitionPolicy,
  TerminalColumn,
} from '../../src/engine/lifecycle.js';
import type { ProjectConfig } from '../../src/config/schema.js';

const config: ProjectConfig = {
  routing: { default: 'claude-sonnet-4-6', functions: {} },
  autonomy: {
    default: 'assist',
    transitions: {
      discovered_to_planned: 'auto',
      planned_to_approved: 'assist',
      approved_to_building: 'manual',
      building_to_verifying: 'auto',
      verifying_to_shipped: 'assist',
      shipped_to_archived: 'manual',
    },
  },
};

describe('canTransition', () => {
  it('permits valid forward transitions', () => {
    expect(canTransition('discovered', 'planned')).toBe(true);
    expect(canTransition('planned', 'approved')).toBe(true);
    expect(canTransition('approved', 'building')).toBe(true);
    expect(canTransition('building', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'archived')).toBe(true);
  });

  it('permits known backward edges (review rejection, post-impl fix)', () => {
    expect(canTransition('planned', 'discovered')).toBe(true);
    expect(canTransition('building', 'approved')).toBe(true);
    expect(canTransition('verifying', 'building')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('discovered', 'shipped')).toBe(false);
    expect(canTransition('archived', 'discovered')).toBe(false);
    expect(canTransition('shipped', 'building')).toBe(false);
  });
});

describe('nextOperation', () => {
  it('returns analyze for a Discovered card', () => {
    expect(nextOperation('discovered')).toBe('analyze');
  });

  it('returns plan for a card mid-Discovered with analysis present', () => {
    // We model lifecycle by column only; analyze writes Analysis section then
    // the orchestrator advances state to Planned. So nextOperation('discovered')
    // returns analyze; nextOperation('planned') is the next pipeline step (review).
    expect(nextOperation('planned')).toBe('review');
  });

  it('returns null for terminal states', () => {
    expect(nextOperation('archived')).toBeNull();
  });
});

describe('transitionPolicy', () => {
  it('reads autonomy policy for a transition pair', () => {
    expect(transitionPolicy(config, 'discovered', 'planned')).toBe('auto');
    expect(transitionPolicy(config, 'planned', 'approved')).toBe('assist');
    expect(transitionPolicy(config, 'approved', 'building')).toBe('manual');
  });

  it('returns "manual" for unrecognized transition pairs', () => {
    expect(transitionPolicy(config, 'discovered', 'building')).toBe('manual');
  });
});

describe('TerminalColumn', () => {
  it('archived is terminal', () => {
    expect(TerminalColumn).toBe('archived');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/engine/lifecycle.ts`**

```typescript
// src/engine/lifecycle.ts
//
// Deterministic lifecycle state machine for cards. Phase 1 has no Conductor
// confidence model (Phase 6 adds it); transition policies here are
// deterministic: 'manual' blocks autonomous moves, 'auto' allows, 'assist'
// halts and surfaces a recommendation to the caller.

import type { Column } from './types.js';
import type { ProjectConfig } from '../config/schema.js';

export const TerminalColumn: Column = 'archived';

// Forward edges: normal lifecycle progression
const FORWARD: ReadonlyMap<Column, Column> = new Map([
  ['discovered', 'planned'],
  ['planned', 'approved'],
  ['approved', 'building'],
  ['building', 'verifying'],
  ['verifying', 'shipped'],
  ['shipped', 'archived'],
]);

// Backward edges: rejection paths, post-impl fixes
const BACKWARD: ReadonlySet<string> = new Set([
  'planned->discovered', // review REJECTED
  'building->approved', // review APPROVED_WITH_CHANGES
  'verifying->building', // verify failed; post-impl fix
]);

export function canTransition(from: Column, to: Column): boolean {
  if (FORWARD.get(from) === to) return true;
  if (BACKWARD.has(`${from}->${to}`)) return true;
  return false;
}

// The next operation that produces output for this column.
// Phase 1 only implements analyze + plan; review/implement/verify/resolve
// land in Phase 2.
const NEXT_OP: ReadonlyMap<Column, string | null> = new Map([
  ['discovered', 'analyze'],
  ['planned', 'review'],
  ['approved', 'implement'],
  ['building', 'verify'],
  ['verifying', 'notebook'],
  ['shipped', 'resolve'],
  ['archived', null],
]);

export function nextOperation(column: Column): string | null {
  return NEXT_OP.get(column) ?? null;
}

export type TransitionPolicy = 'manual' | 'assist' | 'auto';

export function transitionPolicy(
  config: ProjectConfig,
  from: Column,
  to: Column,
): TransitionPolicy {
  const key = `${from}_to_${to}` as keyof typeof config.autonomy.transitions;
  const value = config.autonomy.transitions[key];
  return (value as TransitionPolicy | undefined) ?? 'manual';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/lifecycle.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/lifecycle.ts tests/engine/lifecycle.test.ts
git commit -m "feat(1.6): deterministic lifecycle state machine + transition policy"
```

---

### Task 7: Hook Bus

**Files:**
- Create: `src/engine/hooks/bus.ts`
- Create: `tests/engine/hooks/bus.test.ts`

- [ ] **Step 1: Write the failing test `tests/engine/hooks/bus.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HookBus } from '../../../src/engine/hooks/bus.js';

describe('HookBus', () => {
  it('delivers an event to a subscribed listener', async () => {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.on('SessionStart', (payload) => {
      seen.push(payload);
    });
    await bus.emit('SessionStart', { branch: 'main' });
    expect(seen).toEqual([{ branch: 'main' }]);
  });

  it('delivers to multiple listeners in registration order', async () => {
    const bus = new HookBus();
    const order: string[] = [];
    bus.on('CardTransition', () => order.push('a'));
    bus.on('CardTransition', () => order.push('b'));
    bus.on('CardTransition', () => order.push('c'));
    await bus.emit('CardTransition', { card: 'x', from: 'discovered', to: 'planned' });
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('awaits async listeners before resolving emit', async () => {
    const bus = new HookBus();
    let resolvedFirst = false;
    bus.on('Stop', async () => {
      await new Promise((r) => setTimeout(r, 10));
      resolvedFirst = true;
    });
    await bus.emit('Stop', {});
    expect(resolvedFirst).toBe(true);
  });

  it('off() removes a listener', async () => {
    const bus = new HookBus();
    const fn = vi.fn();
    bus.on('PreCompact', fn);
    bus.off('PreCompact', fn);
    await bus.emit('PreCompact', {});
    expect(fn).not.toHaveBeenCalled();
  });

  it('catches listener errors and continues delivery', async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on('OperationComplete', () => {
      throw new Error('boom');
    });
    bus.on('OperationComplete', () => {
      seen.push('reached');
    });
    await bus.emit('OperationComplete', {});
    expect(seen).toEqual(['reached']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/hooks/bus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/engine/hooks/bus.ts`**

```typescript
// src/engine/hooks/bus.ts
//
// In-process event bus for the Conductor engine. Pure functions subscribe
// to named events; the bus delivers payloads in registration order and
// awaits async listeners before resolving emit().
//
// Listener errors are swallowed (logged via console.warn) so one bad
// subscriber cannot break the chain — Control's hook subscribers MUST NOT
// halt the engine. v2 may introduce strict mode for tests.

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'Stop'
  | 'CardTransition'
  | 'OperationComplete';

export type HookListener<P = unknown> = (payload: P) => void | Promise<void>;

export class HookBus {
  private listeners = new Map<HookEvent, Array<HookListener<unknown>>>();

  on<P = unknown>(event: HookEvent, listener: HookListener<P>): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener as HookListener<unknown>);
    this.listeners.set(event, arr);
  }

  off<P = unknown>(event: HookEvent, listener: HookListener<P>): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener as HookListener<unknown>);
    if (idx >= 0) arr.splice(idx, 1);
  }

  async emit(event: HookEvent, payload: unknown): Promise<void> {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const listener of arr) {
      try {
        await listener(payload);
      } catch (e: unknown) {
        // eslint-disable-next-line no-console
        console.warn(`[hook-bus] subscriber for ${event} threw:`, e);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/hooks/bus.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/hooks/bus.ts tests/engine/hooks/bus.test.ts
git commit -m "feat(1.7): in-process Hook Bus with async listener support"
```

---

### Task 8: ModelAdapter interface and MockAdapter

**Files:**
- Create: `src/engine/operation.ts`
- Create: `src/adapters/adapter.ts`
- Create: `src/adapters/mock.ts`
- Create: `tests/adapters/mock.test.ts`

- [ ] **Step 1: Write `src/engine/operation.ts`**

```typescript
// src/engine/operation.ts
//
// OperationRequest/Response are the contract between the engine and the
// Model Adapter Layer. Adapters do not know about Cards; they receive an
// OperationRequest (op name + prompt + tool schemas) and return an
// OperationResponse (text + parsed tool calls + token usage).

export interface OperationRequest {
  operation: string; // e.g. 'analyze', 'plan'
  model: string; // resolved model id (post-routing)
  system: string; // system prompt
  user: string; // user prompt
  tools?: ToolSchema[]; // optional tool definitions
  maxTokens?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  // Anthropic SDK uses input_schema (JSON Schema). We accept any.
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface OperationResponse {
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  raw?: unknown; // adapter-specific; for debugging
}
```

- [ ] **Step 2: Write `src/adapters/adapter.ts`**

```typescript
// src/adapters/adapter.ts
//
// ModelAdapter is the abstraction over LLM providers. Engine code calls
// adapter.invoke(request); adapter shapes the prompt for its provider and
// returns a normalized OperationResponse.

import type { OperationRequest, OperationResponse } from '../engine/operation.js';

export type CostTier = 'free' | 'cheap' | 'standard' | 'premium';

export interface AdapterCapabilities {
  tools: boolean;
  contextWindowTokens: number;
  streaming: boolean;
  costTier: CostTier;
  supportsExtendedThinking: boolean;
  supportsPromptCaching: boolean;
}

export interface ModelAdapter {
  readonly id: string; // e.g. 'claude', 'openai', 'gemini', 'local', 'mock'
  invoke(req: OperationRequest): Promise<OperationResponse>;
  capabilities(): AdapterCapabilities;
  estimateCost(req: OperationRequest): { tokens: number; dollars: number };
}
```

- [ ] **Step 3: Write `src/adapters/mock.ts`**

```typescript
// src/adapters/mock.ts
//
// MockAdapter for deterministic testing. Returns canned responses
// queued via push(). Used by every test that exercises an operation
// without hitting a real LLM.

import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse } from '../engine/operation.js';

export class MockAdapter implements ModelAdapter {
  readonly id = 'mock';
  private queue: OperationResponse[] = [];
  public lastRequest: OperationRequest | undefined;
  public allRequests: OperationRequest[] = [];

  push(response: Partial<OperationResponse>): void {
    this.queue.push({
      text: response.text ?? '',
      toolCalls: response.toolCalls ?? [],
      inputTokens: response.inputTokens ?? 0,
      outputTokens: response.outputTokens ?? 0,
      totalTokens: response.totalTokens ?? 0,
      model: response.model ?? 'mock-model',
      raw: response.raw,
    });
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    this.lastRequest = req;
    this.allRequests.push(req);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `MockAdapter has no queued response for op=${req.operation} model=${req.model}`,
      );
    }
    return next;
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 200_000,
      streaming: false,
      costTier: 'free',
      supportsExtendedThinking: false,
      supportsPromptCaching: false,
    };
  }

  estimateCost(): { tokens: number; dollars: number } {
    return { tokens: 0, dollars: 0 };
  }
}
```

- [ ] **Step 4: Write the failing test `tests/adapters/mock.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../../src/adapters/mock.js';

describe('MockAdapter', () => {
  it('returns queued responses in FIFO order', async () => {
    const m = new MockAdapter();
    m.push({ text: 'first' });
    m.push({ text: 'second' });

    const a = await m.invoke({
      operation: 'analyze',
      model: 'mock',
      system: 's',
      user: 'u',
    });
    expect(a.text).toBe('first');

    const b = await m.invoke({
      operation: 'plan',
      model: 'mock',
      system: 's',
      user: 'u',
    });
    expect(b.text).toBe('second');
  });

  it('throws when invoked with empty queue', async () => {
    const m = new MockAdapter();
    await expect(
      m.invoke({ operation: 'analyze', model: 'mock', system: 's', user: 'u' }),
    ).rejects.toThrow(/no queued response/);
  });

  it('records the most recent request', async () => {
    const m = new MockAdapter();
    m.push({ text: 'ok' });
    await m.invoke({ operation: 'plan', model: 'mock', system: 'sys', user: 'usr' });
    expect(m.lastRequest?.user).toBe('usr');
    expect(m.allRequests).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/mock.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/operation.ts src/adapters/adapter.ts src/adapters/mock.ts tests/adapters/mock.test.ts
git commit -m "feat(1.8): ModelAdapter interface, OperationRequest/Response types, MockAdapter"
```

---

### Task 9: ClaudeAdapter

**Files:**
- Create: `src/adapters/claude.ts`
- Create: `tests/adapters/claude.test.ts`

- [ ] **Step 1: Write the failing test `tests/adapters/claude.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claude.js';

// Inline mock of the Anthropic SDK's Messages.create method.
// We don't import @anthropic-ai/sdk directly in tests; the adapter
// receives a client by dependency injection so tests can supply a stub.

interface AnthropicMessageBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content: AnthropicMessageBlock[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

class FakeAnthropic {
  public lastArgs: unknown;
  constructor(private response: AnthropicMessageResponse) {}
  messages = {
    create: async (args: unknown): Promise<AnthropicMessageResponse> => {
      this.lastArgs = args;
      return this.response;
    },
  };
}

describe('ClaudeAdapter', () => {
  it('invokes the SDK with a system + user message and returns text', async () => {
    const fake = new FakeAnthropic({
      content: [{ type: 'text', text: 'hello world' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
    });
    const adapter = new ClaudeAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'analyze',
      model: 'claude-sonnet-4-6',
      system: 'You are an analyst.',
      user: 'Analyze the issue.',
    });
    expect(resp.text).toBe('hello world');
    expect(resp.inputTokens).toBe(10);
    expect(resp.outputTokens).toBe(5);
    expect(resp.totalTokens).toBe(15);
    expect(resp.model).toBe('claude-sonnet-4-6');

    const args = fake.lastArgs as Record<string, unknown>;
    expect(args.model).toBe('claude-sonnet-4-6');
    expect(args.system).toBe('You are an analyst.');
    expect((args.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      'Analyze the issue.',
    );
  });

  it('extracts tool calls from the response', async () => {
    const fake = new FakeAnthropic({
      content: [
        { type: 'text', text: 'I will use a tool.' },
        { type: 'tool_use', name: 'file_card', input: { title: 'X' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-4-6',
    });
    const adapter = new ClaudeAdapter({ client: fake as never });
    const resp = await adapter.invoke({
      operation: 'chat',
      model: 'claude-sonnet-4-6',
      system: '',
      user: 'hi',
    });
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0]?.name).toBe('file_card');
    expect(resp.toolCalls[0]?.input).toEqual({ title: 'X' });
  });

  it('reports capabilities', () => {
    const adapter = new ClaudeAdapter({ client: undefined as never });
    const caps = adapter.capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.contextWindowTokens).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/adapters/claude.ts`**

```typescript
// src/adapters/claude.ts
//
// ClaudeAdapter wraps @anthropic-ai/sdk's Messages.create. Engine code
// passes an OperationRequest; adapter shapes a Messages.create payload,
// invokes the SDK, and normalizes the result into OperationResponse.
//
// The SDK client is injected (dependency injection), so tests can supply
// a fake without touching the network.

import Anthropic from '@anthropic-ai/sdk';
import type { ModelAdapter, AdapterCapabilities } from './adapter.js';
import type { OperationRequest, OperationResponse, ToolCall } from '../engine/operation.js';

export interface ClaudeAdapterOptions {
  /** SDK client; defaults to a new Anthropic() instance. */
  client?: Anthropic;
  /** Default max_tokens when the request doesn't specify. */
  defaultMaxTokens?: number;
}

export class ClaudeAdapter implements ModelAdapter {
  readonly id = 'claude';
  private client: Anthropic;
  private defaultMaxTokens: number;

  constructor(opts: ClaudeAdapterOptions = {}) {
    // Accept any client-shaped value to support test fakes without satisfying
    // the full Anthropic class shape.
    this.client = (opts.client ?? new Anthropic()) as Anthropic;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
  }

  async invoke(req: OperationRequest): Promise<OperationResponse> {
    const result = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools as never } : {}),
    });

    const content = (result as unknown as {
      content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    }).content;

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += block.text;
      } else if (block.type === 'tool_use' && block.name) {
        toolCalls.push({ name: block.name, input: block.input });
      }
    }

    const usage = (result as unknown as { usage: { input_tokens: number; output_tokens: number } })
      .usage;
    const model = (result as unknown as { model: string }).model;

    return {
      text,
      toolCalls,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      model,
      raw: result,
    };
  }

  capabilities(): AdapterCapabilities {
    return {
      tools: true,
      contextWindowTokens: 200_000,
      streaming: true,
      costTier: 'premium',
      supportsExtendedThinking: true,
      supportsPromptCaching: true,
    };
  }

  estimateCost(req: OperationRequest): { tokens: number; dollars: number } {
    // Rough: sum prompt chars / 4 ≈ tokens; pricing tier-dependent.
    // Phase 1 ships a placeholder; Phase 7 hardens cost accounting.
    const tokens = Math.ceil((req.system.length + req.user.length) / 4);
    return { tokens, dollars: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/adapters/claude.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude.ts tests/adapters/claude.test.ts
git commit -m "feat(1.9): ClaudeAdapter wrapping Anthropic SDK with DI for testing"
```

---

### Task 10: analyze operation

**Files:**
- Create: `src/engine/ops/analyze.ts`
- Create: `tests/engine/ops/analyze.test.ts`

- [ ] **Step 1: Write the failing test `tests/engine/ops/analyze.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../../../src/engine/ops/analyze.js';
import { readCard } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-analyze-'));
  cardPath = join(tmp, 'sample.md');
  await copyFile(fixturePath, cardPath);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('analyze', () => {
  it('appends an Analysis section to the card body', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: 'Root cause: token expiry not handled in middleware.\n\nBlast radius: src/auth/.',
      inputTokens: 100,
      outputTokens: 50,
    });

    const card = await readCard(cardPath);
    const result = await analyze({ card, adapter, model: 'claude-sonnet-4-6' });

    const updated = await readCard(cardPath);
    expect(updated.body).toContain('## Analysis');
    expect(updated.body).toContain('Root cause: token expiry');
    expect(result.tokens).toBe(150);
  });

  it('passes the card body and frontmatter to the adapter', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'analysis text', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await analyze({ card, adapter, model: 'claude-opus-4-7' });

    expect(adapter.lastRequest?.operation).toBe('analyze');
    expect(adapter.lastRequest?.model).toBe('claude-opus-4-7');
    expect(adapter.lastRequest?.user).toContain('Auth token expires silently');
    expect(adapter.lastRequest?.user).toContain('When a user');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/ops/analyze.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/engine/ops/analyze.ts`**

```typescript
// src/engine/ops/analyze.ts
//
// Operation: analyze a card and append an Analysis section to its body.
// Phase 1 implements the Relay-style analysis prompt: validate the issue,
// identify root cause, map blast radius, propose an approach.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../types.js';
import { appendSection } from '../state/card.js';

export interface AnalyzeArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

export interface AnalyzeResult {
  text: string;
  tokens: number;
}

const SYSTEM_PROMPT = `You are an experienced software engineer performing
issue analysis. Given a card describing a bug, gap, or feature need:

1. Validate that the issue still exists (or note if it appears resolved).
2. Identify the root cause with specifics — file paths, function names,
   data flow.
3. Map the blast radius: what code, tests, docs, or behaviors are affected.
4. Propose an approach (high-level — implementation comes later).

Output a single Markdown block with sections: Validation, Root Cause,
Blast Radius, Approach. Be specific. Cite file:line where you can.`.trim();

export async function analyze(args: AnalyzeArgs): Promise<AnalyzeResult> {
  const { card, adapter, model } = args;

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    `Kind: ${card.frontmatter.kind}`,
    `Labels: ${card.frontmatter.labels.join(', ') || '(none)'}`,
    '',
    '--- Card body ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'analyze',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  await appendSection(card.path, 'Analysis', resp.text);

  return {
    text: resp.text,
    tokens: resp.totalTokens,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/ops/analyze.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/analyze.ts tests/engine/ops/analyze.test.ts
git commit -m "feat(1.10): analyze operation appends Analysis section to card"
```

---

### Task 11: plan operation

**Files:**
- Create: `src/engine/ops/plan.ts`
- Create: `tests/engine/ops/plan.test.ts`

- [ ] **Step 1: Write the failing test `tests/engine/ops/plan.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from '../../../src/engine/ops/plan.js';
import { readCard, appendSection } from '../../../src/engine/state/card.js';
import { MockAdapter } from '../../../src/adapters/mock.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', '..', 'fixtures', 'sample-card.md');

let tmp: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-plan-'));
  cardPath = join(tmp, 'sample.md');
  await copyFile(fixturePath, cardPath);
  // plan expects an Analysis section already present
  await appendSection(cardPath, 'Analysis', 'Root cause is X. Blast radius is Y.');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('plan', () => {
  it('appends an Implementation Plan section to the card body', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: '### Step 1\nWHAT: ...\nHOW: ...\nWHY: ...\nRISK: ...\nVERIFY: ...\nROLLBACK: ...',
      inputTokens: 80,
      outputTokens: 40,
    });

    const card = await readCard(cardPath);
    const result = await plan({ card, adapter, model: 'claude-opus-4-7' });

    const updated = await readCard(cardPath);
    expect(updated.body).toContain('## Implementation Plan');
    expect(updated.body).toContain('Step 1');
    expect(result.tokens).toBe(120);
  });

  it('includes the analysis section in the prompt', async () => {
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan', inputTokens: 1, outputTokens: 1 });

    const card = await readCard(cardPath);
    await plan({ card, adapter, model: 'claude-opus-4-7' });

    expect(adapter.lastRequest?.user).toContain('Root cause is X');
  });

  it('throws if the card has no Analysis section', async () => {
    // Use a fresh card with no Analysis appended
    const fresh = join(tmp, 'fresh.md');
    await copyFile(fixturePath, fresh);
    const card = await readCard(fresh);
    const adapter = new MockAdapter();
    adapter.push({ text: 'plan' });
    await expect(plan({ card, adapter, model: 'claude-opus-4-7' })).rejects.toThrow(
      /no Analysis section/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/ops/plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/engine/ops/plan.ts`**

```typescript
// src/engine/ops/plan.ts
//
// Operation: produce an atomic implementation plan from an analyzed card
// and append an Implementation Plan section. Plan uses Relay's atomic-step
// shape (WHAT/HOW/WHY/RISK/VERIFY/ROLLBACK per step).

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../types.js';
import { appendSection } from '../state/card.js';

export interface PlanArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
}

export interface PlanResult {
  text: string;
  tokens: number;
}

const SYSTEM_PROMPT = `You are an experienced software engineer producing an
atomic implementation plan from an issue analysis. Each step in your plan
MUST include all six fields:

  WHAT     — what change is made
  HOW      — concrete code-level approach
  WHY      — why this step is needed
  RISK     — what could go wrong; blast radius
  VERIFY   — how we confirm the step worked
  ROLLBACK — how to undo if it doesn't

Steps must be small, sequential, and independently verifiable. Number them
1.1, 1.2, etc. Output Markdown only — no preamble.`.trim();

const ANALYSIS_HEADING = '## Analysis';

export async function plan(args: PlanArgs): Promise<PlanResult> {
  const { card, adapter, model } = args;

  const analysis = extractAnalysisSection(card.body);
  if (!analysis) {
    throw new Error(`Card ${card.frontmatter.id} has no Analysis section; run analyze first.`);
  }

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Title: ${card.frontmatter.title}`,
    '',
    '--- Analysis ---',
    analysis,
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'plan',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  await appendSection(card.path, 'Implementation Plan', resp.text);

  return {
    text: resp.text,
    tokens: resp.totalTokens,
  };
}

function extractAnalysisSection(body: string): string | null {
  const idx = body.indexOf(ANALYSIS_HEADING);
  if (idx < 0) return null;
  const after = body.slice(idx + ANALYSIS_HEADING.length);
  // Take everything until the next H2 or end of body.
  const nextH2 = after.search(/\n##\s+/);
  return (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/ops/plan.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/ops/plan.ts tests/engine/ops/plan.test.ts
git commit -m "feat(1.11): plan operation appends Implementation Plan from Analysis"
```

---

### Task 12: CLI entry point with Commander

**Files:**
- Create: `src/cli/index.ts`

- [ ] **Step 1: Write `src/cli/index.ts`**

```typescript
#!/usr/bin/env node
// src/cli/index.ts
//
// Conductor CLI entry point. Phase 1 commands: init, card new, work, transition.
// Each command is a subcommand of `conductor`; subcommand modules export an
// `attach(program)` function that registers their command on the root program.

import { Command } from 'commander';
import { attachInit } from './commands/init.js';
import { attachCardNew } from './commands/card-new.js';
import { attachWork } from './commands/work.js';
import { attachTransition } from './commands/transition.js';

const program = new Command();

program
  .name('conductor')
  .description('Conductor — per-repo, model-agnostic AI engineering harness')
  .version('0.1.0');

attachInit(program);
attachCardNew(program);
attachWork(program);
attachTransition(program);

program.parseAsync(process.argv).catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
```

- [ ] **Step 2: Verify typecheck still passes (commands not yet implemented but imports compile)**

Add temporary stub modules so the typecheck passes; we'll fill them in the next tasks. Create stubs at this step OR write the commands first then come back. The cleaner path: move this task to after task 16 (transition) so all referenced modules exist. Reorder:

**Reorder note:** if running tasks strictly sequentially, do tasks 13 (init), 14 (card-new), 15 (work), 16 (transition), THEN 12 (entry point). Adjust commits accordingly.

- [ ] **Step 3: Commit (after tasks 13-16 complete)**

```bash
git add src/cli/index.ts
git commit -m "feat(1.12): CLI entry point with Commander"
```

---

### Task 13: `conductor init` command

**Files:**
- Create: `src/cli/commands/init.ts`
- Create: `tests/cli/init.test.ts`

- [ ] **Step 1: Write the failing test `tests/cli/init.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-init-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runInit', () => {
  it('creates the .conductor/ directory layout', async () => {
    await runInit({ cwd: tmp });
    const dirs = ['cards', 'archive/cards', 'decisions', 'phases', 'exercise', 'snapshots', 'runs'];
    for (const d of dirs) {
      const s = await stat(join(tmp, '.conductor', d));
      expect(s.isDirectory()).toBe(true);
    }
  });

  it('writes default config.yaml when not present', async () => {
    await runInit({ cwd: tmp });
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toContain('routing:');
    expect(config).toContain('autonomy:');
  });

  it('does not overwrite existing config.yaml', async () => {
    await runInit({ cwd: tmp });
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(tmp, '.conductor', 'config.yaml'), 'custom: true\n');
    await runInit({ cwd: tmp }); // second run
    const config = await readFile(join(tmp, '.conductor', 'config.yaml'), 'utf8');
    expect(config).toBe('custom: true\n');
  });

  it('is idempotent (running twice does not error)', async () => {
    await runInit({ cwd: tmp });
    await expect(runInit({ cwd: tmp })).resolves.not.toThrow();
  });

  it('writes initial state.md', async () => {
    await runInit({ cwd: tmp });
    const state = await readFile(join(tmp, '.conductor', 'state.md'), 'utf8');
    expect(state).toContain('# Conductor STATE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/commands/init.ts`**

```typescript
// src/cli/commands/init.ts
//
// `conductor init` — scaffold .conductor/ in the current repo.
//
// Creates the three-tier memory layout (Tier 1: state.md / ordering.md /
// journal.md; Tier 2: cards/ archive/ decisions/ phases/ exercise/;
// Tier 3 SQLite + transports are created lazily by the daemon, not here).
// Idempotent: re-runnable safely; never overwrites existing config.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';

const SUBDIRS = [
  'cards',
  'archive',
  'archive/cards',
  'archive/implemented',
  'archive/notebooks',
  'archive/exercise',
  'decisions',
  'phases',
  'exercise',
  'snapshots',
  'runs',
];

const DEFAULT_CONFIG = `# .conductor/config.yaml — Conductor project configuration
routing:
  default: claude-sonnet-4-6
  functions:
    analyze: claude-opus-4-7
    plan: claude-opus-4-7
autonomy:
  default: assist
  transitions:
    discovered_to_planned:    auto
    planned_to_approved:      assist
    approved_to_building:     manual
    building_to_verifying:    auto
    verifying_to_shipped:     assist
    shipped_to_archived:      manual
`;

const DEFAULT_STATE = `# Conductor STATE

Current phase: unassigned
Current card: (none)
Next action: file the first card with \`conductor card new <slug>\`
Recent decisions: (none yet)
`;

const DEFAULT_ORDERING = `# Ordering

(Generated by \`conductor order\`. No active cards yet.)
`;

const DEFAULT_JOURNAL = `# Journal

(One line per session, appended at session end.)
`;

export interface InitArgs {
  cwd: string;
}

export async function runInit(args: InitArgs): Promise<void> {
  const root = join(args.cwd, '.conductor');
  await mkdir(root, { recursive: true });
  for (const sub of SUBDIRS) {
    await mkdir(join(root, sub), { recursive: true });
  }
  await writeIfMissing(join(root, 'config.yaml'), DEFAULT_CONFIG);
  await writeIfMissing(join(root, 'state.md'), DEFAULT_STATE);
  await writeIfMissing(join(root, 'ordering.md'), DEFAULT_ORDERING);
  await writeIfMissing(join(root, 'journal.md'), DEFAULT_JOURNAL);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path);
    return; // exists; do not overwrite
  } catch {
    /* not present — write it */
  }
  await writeFile(path, content, 'utf8');
}

export function attachInit(program: Command): void {
  program
    .command('init')
    .description('Initialize Conductor in the current repo (.conductor/ layout + defaults)')
    .action(async () => {
      await runInit({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log('Conductor initialized. .conductor/ scaffold ready.');
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/init.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts tests/cli/init.test.ts
git commit -m "feat(1.13): conductor init scaffolds .conductor/ idempotently"
```

---

### Task 14: `conductor card new` command

**Files:**
- Create: `src/cli/commands/card-new.ts`
- Create: `tests/cli/card-new.test.ts`

- [ ] **Step 1: Write the failing test `tests/cli/card-new.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { readCard } from '../../src/engine/state/card.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-cardnew-'));
  await runInit({ cwd: tmp });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runCardNew', () => {
  it('creates a card file at .conductor/cards/<id>.md', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'auth-token-expiry',
      title: 'Auth token expires silently',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const files = await readdir(join(tmp, '.conductor', 'cards'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^2026-05-07-auth-token-expiry\.md$/);
  });

  it('writes valid frontmatter that round-trips through readCard', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'auth-token-expiry',
      title: 'Auth token expires silently',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const card = await readCard(
      join(tmp, '.conductor', 'cards', '2026-05-07-auth-token-expiry.md'),
    );
    expect(card.frontmatter.id).toBe('2026-05-07-auth-token-expiry');
    expect(card.frontmatter.title).toBe('Auth token expires silently');
    expect(card.frontmatter.kind).toBe('issue');
    expect(card.frontmatter.column).toBe('discovered');
    expect(card.frontmatter.source).toBe('user');
    expect(card.frontmatter.phase).toBe('unassigned');
  });

  it('normalizes the slug to canonical form', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'Auth Token! Expiry',
      title: 'X',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const files = await readdir(join(tmp, '.conductor', 'cards'));
    expect(files[0]).toMatch(/^2026-05-07-auth-token-expiry\.md$/);
  });

  it('refuses to overwrite an existing card file', async () => {
    await runCardNew({
      cwd: tmp,
      slug: 'dup',
      title: 'X',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    await expect(
      runCardNew({
        cwd: tmp,
        slug: 'dup',
        title: 'Y',
        kind: 'issue',
        now: new Date('2026-05-07T10:00:00Z'),
      }),
    ).rejects.toThrow(/already exists/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/card-new.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/commands/card-new.ts`**

```typescript
// src/cli/commands/card-new.ts
//
// `conductor card new <slug>` — create a new card in .conductor/cards/.
// ID format: <YYYY-MM-DD>-<slug-normalized>. Slug is lowercased and
// non-alphanumeric runs collapsed to single dashes.

import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import type { CardFrontmatter, Kind } from '../../engine/types.js';
import { CardFrontmatterSchema } from '../../config/schema.js';

export interface CardNewArgs {
  cwd: string;
  slug: string;
  title: string;
  kind: Kind;
  now?: Date;
}

export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function todayPrefix(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function runCardNew(args: CardNewArgs): Promise<string> {
  const now = args.now ?? new Date();
  const slug = normalizeSlug(args.slug);
  const id = `${todayPrefix(now)}-${slug}`;
  const path = join(args.cwd, '.conductor', 'cards', `${id}.md`);

  try {
    await access(path);
    throw new Error(`Card already exists at ${path}`);
  } catch (e: unknown) {
    if ((e as Error).message?.startsWith('Card already exists')) throw e;
    // ENOENT is what we want — file doesn't exist, proceed.
  }

  const frontmatter: CardFrontmatter = CardFrontmatterSchema.parse({
    id,
    title: args.title,
    kind: args.kind,
    column: 'discovered',
    phase: 'unassigned',
    priority: 1,
    autonomy: 'inherit',
    model_overrides: {},
    created: now.toISOString(),
    source: 'user',
    labels: [],
    blocked_by: [],
  });

  const head = yaml.dump(frontmatter, { lineWidth: 0, noRefs: true });
  const body = `\n# Original\n\n${args.title}\n\n(Edit this card to add detail before running \`conductor work\`.)\n`;
  const out = `---\n${head}---\n${body}`;
  await writeFile(path, out, 'utf8');
  return path;
}

export function attachCardNew(program: Command): void {
  const card = program.command('card').description('Card management');
  card
    .command('new <slug>')
    .description('Create a new card in .conductor/cards/')
    .option('-t, --title <title>', 'Card title (defaults to slug)')
    .option('-k, --kind <kind>', 'Card kind (issue | feature | imported)', 'issue')
    .action(async (slug: string, opts: { title?: string; kind?: string }) => {
      const path = await runCardNew({
        cwd: process.cwd(),
        slug,
        title: opts.title ?? slug,
        kind: (opts.kind ?? 'issue') as Kind,
      });
      // eslint-disable-next-line no-console
      console.log(`Card created: ${path}`);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/card-new.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/card-new.ts tests/cli/card-new.test.ts
git commit -m "feat(1.14): conductor card new with slug normalization and ID format"
```

---

### Task 15: `conductor work` command

**Files:**
- Create: `src/cli/commands/work.ts`
- Create: `tests/cli/work.test.ts`

- [ ] **Step 1: Write the failing test `tests/cli/work.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;
let id: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-work-'));
  await runInit({ cwd: tmp });
  id = (await runCardNew({
    cwd: tmp,
    slug: 'sample',
    title: 'Sample',
    kind: 'issue',
    now: new Date('2026-05-07T10:00:00Z'),
  })).match(/cards\/(.+)\.md$/)?.[1] ?? '';
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runWork', () => {
  it('runs analyze when card is in Discovered, advances to Planned', async () => {
    const adapter = new MockAdapter();
    adapter.push({
      text: 'Analysis: ...',
      inputTokens: 10,
      outputTokens: 5,
    });
    adapter.push({
      text: 'Plan: ...',
      inputTokens: 10,
      outputTokens: 5,
    });

    await runWork({ cwd: tmp, cardId: id, adapter });

    const card = await readCard(join(tmp, '.conductor', 'cards', `${id}.md`));
    expect(card.frontmatter.column).toBe('planned');
    expect(card.body).toContain('## Analysis');
    expect(card.body).toContain('## Implementation Plan');
  });

  it('halts at planned (next op is review, not implemented in Phase 1)', async () => {
    // First call advances Discovered → Planned
    const adapter = new MockAdapter();
    adapter.push({ text: 'Analysis', inputTokens: 1, outputTokens: 1 });
    adapter.push({ text: 'Plan', inputTokens: 1, outputTokens: 1 });
    await runWork({ cwd: tmp, cardId: id, adapter });

    // Second call: card is Planned; next op is review (not implemented).
    // Phase 1 expectation: prints a friendly halt message and does NOT throw.
    const result = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(result.halted).toBe(true);
    expect(result.reason).toMatch(/review.*Phase 2/i);
  });

  it('throws if the card does not exist', async () => {
    const adapter = new MockAdapter();
    await expect(
      runWork({ cwd: tmp, cardId: 'no-such-card', adapter }),
    ).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/work.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/commands/work.ts`**

```typescript
// src/cli/commands/work.ts
//
// `conductor work <card>` — run the next pipeline step for a card.
// Phase 1 implements only analyze + plan; review/implement/verify/resolve
// land in Phase 2. When the card reaches a column whose next op is not
// implemented, work halts gracefully with a Phase reference.

import { join } from 'node:path';
import type { Command } from 'commander';
import { readCard, writeCard } from '../../engine/state/card.js';
import { analyze } from '../../engine/ops/analyze.js';
import { plan as planOp } from '../../engine/ops/plan.js';
import { nextOperation } from '../../engine/lifecycle.js';
import { loadProjectConfig } from '../../config/load.js';
import { ClaudeAdapter } from '../../adapters/claude.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, Column } from '../../engine/types.js';

export interface WorkArgs {
  cwd: string;
  cardId: string;
  adapter?: ModelAdapter; // for testing; defaults to ClaudeAdapter
}

export interface WorkResult {
  halted: boolean;
  reason?: string;
  finalColumn: Column;
}

const PHASE_2_OPS = new Set(['review', 'implement', 'verify', 'notebook', 'resolve']);

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

  const op = nextOperation(card.frontmatter.column);
  if (op === null) {
    return { halted: true, reason: 'Card is in a terminal state', finalColumn: card.frontmatter.column };
  }

  if (PHASE_2_OPS.has(op)) {
    return {
      halted: true,
      reason: `Next operation '${op}' is not yet implemented (lands in Phase 2). Card stays in '${card.frontmatter.column}'.`,
      finalColumn: card.frontmatter.column,
    };
  }

  // Phase 1 walks Discovered -> Planned: run analyze, then plan, then transition.
  if (card.frontmatter.column === 'discovered') {
    const analyzeModel = config.routing.functions.analyze ?? config.routing.default;
    await analyze({ card: await readCard(cardPath), adapter, model: analyzeModel });

    const planModel = config.routing.functions.plan ?? config.routing.default;
    await planOp({ card: await readCard(cardPath), adapter, model: planModel });

    // Advance column to 'planned'
    const updated = await readCard(cardPath);
    updated.frontmatter.column = 'planned';
    await writeCard(updated);

    return { halted: false, finalColumn: 'planned' };
  }

  return {
    halted: true,
    reason: `Phase 1 only handles 'discovered' cards; this card is in '${card.frontmatter.column}'.`,
    finalColumn: card.frontmatter.column,
  };
}

export function attachWork(program: Command): void {
  program
    .command('work <cardId>')
    .description('Run the next pipeline step for a card')
    .action(async (cardId: string) => {
      const result = await runWork({ cwd: process.cwd(), cardId });
      // eslint-disable-next-line no-console
      console.log(
        result.halted
          ? `Halted: ${result.reason} (column=${result.finalColumn})`
          : `Done. Card now in column: ${result.finalColumn}`,
      );
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/work.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/work.ts tests/cli/work.test.ts
git commit -m "feat(1.15): conductor work runs analyze + plan, advances Discovered to Planned"
```

---

### Task 16: `conductor transition` command

**Files:**
- Create: `src/cli/commands/transition.ts`
- Create: `tests/cli/transition.test.ts`

- [ ] **Step 1: Write the failing test `tests/cli/transition.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runTransition } from '../../src/cli/commands/transition.js';
import { readCard, writeCard } from '../../src/engine/state/card.js';

let tmp: string;
let id: string;
let cardPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-transition-'));
  await runInit({ cwd: tmp });
  cardPath = await runCardNew({
    cwd: tmp,
    slug: 'sample',
    title: 'Sample',
    kind: 'issue',
    now: new Date('2026-05-07T10:00:00Z'),
  });
  id = cardPath.match(/cards\/(.+)\.md$/)?.[1] ?? '';
  // Move card to 'planned' so transition to 'approved' is legal
  const card = await readCard(cardPath);
  card.frontmatter.column = 'planned';
  await writeCard(card);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('runTransition', () => {
  it('transitions a card between legal columns', async () => {
    await runTransition({ cwd: tmp, cardId: id, target: 'approved' });
    const card = await readCard(cardPath);
    expect(card.frontmatter.column).toBe('approved');
  });

  it('rejects illegal transitions', async () => {
    await expect(
      runTransition({ cwd: tmp, cardId: id, target: 'shipped' }),
    ).rejects.toThrow(/illegal/i);
  });

  it('throws when card not found', async () => {
    await expect(
      runTransition({ cwd: tmp, cardId: 'no-such', target: 'approved' }),
    ).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/transition.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/commands/transition.ts`**

```typescript
// src/cli/commands/transition.ts
//
// `conductor transition <card> <column>` — manually move a card to another
// column. Validates against the lifecycle state machine; in Phase 1 the
// autonomy gates are deterministic — manual transitions skip the gate
// since the user is explicitly invoking the move.

import { join } from 'node:path';
import type { Command } from 'commander';
import { readCard, writeCard } from '../../engine/state/card.js';
import { canTransition } from '../../engine/lifecycle.js';
import type { Column } from '../../engine/types.js';
import { COLUMNS } from '../../engine/types.js';

export interface TransitionArgs {
  cwd: string;
  cardId: string;
  target: Column;
}

export async function runTransition(args: TransitionArgs): Promise<void> {
  const cardPath = join(args.cwd, '.conductor', 'cards', `${args.cardId}.md`);

  let card;
  try {
    card = await readCard(cardPath);
  } catch {
    throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);
  }

  if (!canTransition(card.frontmatter.column, args.target)) {
    throw new Error(
      `Illegal transition: ${card.frontmatter.column} -> ${args.target}`,
    );
  }

  card.frontmatter.column = args.target;
  await writeCard(card);
}

export function attachTransition(program: Command): void {
  program
    .command('transition <cardId> <column>')
    .description(`Manually transition a card. Columns: ${COLUMNS.join(' | ')}`)
    .action(async (cardId: string, column: string) => {
      if (!(COLUMNS as readonly string[]).includes(column)) {
        throw new Error(`Unknown column: ${column}. Valid: ${COLUMNS.join(', ')}`);
      }
      await runTransition({ cwd: process.cwd(), cardId, target: column as Column });
      // eslint-disable-next-line no-console
      console.log(`Card ${cardId} transitioned to ${column}.`);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/transition.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/transition.ts tests/cli/transition.test.ts
git commit -m "feat(1.16): conductor transition with lifecycle validation"
```

- [ ] **Step 6: Now write the deferred CLI entry point from Task 12**

Create `src/cli/index.ts` per the code in Task 12 Step 1.

- [ ] **Step 7: Verify CLI invokes**

Run: `npm run build`
Expected: clean build, `dist/cli/index.js` produced.

Run: `node dist/cli/index.js --help`
Expected: prints help text listing `init`, `card`, `work`, `transition`.

- [ ] **Step 8: Commit the entry point**

```bash
git add src/cli/index.ts
git commit -m "feat(1.12): CLI entry point wires init, card, work, transition"
```

---

### Task 17: End-to-end smoke test

**Files:**
- Create: `tests/integration/end-to-end.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { runCardNew } from '../../src/cli/commands/card-new.js';
import { runWork } from '../../src/cli/commands/work.js';
import { runTransition } from '../../src/cli/commands/transition.js';
import { readCard } from '../../src/engine/state/card.js';
import { MockAdapter } from '../../src/adapters/mock.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'conductor-e2e-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('end-to-end: discovered -> approved', () => {
  it('drives a card through the Phase 1 lifecycle', async () => {
    // 1. Initialize
    await runInit({ cwd: tmp });

    // 2. File a card
    const cardPath = await runCardNew({
      cwd: tmp,
      slug: 'auth-token-expiry',
      title: 'Auth token expires silently',
      kind: 'issue',
      now: new Date('2026-05-07T10:00:00Z'),
    });
    const id = cardPath.match(/cards\/(.+)\.md$/)?.[1] ?? '';

    // 3. Set up MockAdapter with canned responses
    const adapter = new MockAdapter();
    adapter.push({
      text: 'Validation: confirmed.\nRoot cause: middleware lacks expiry check.',
      inputTokens: 100,
      outputTokens: 50,
    });
    adapter.push({
      text: '### 1.1\nWHAT: Add expiry check\nHOW: ...\nWHY: ...\nRISK: low\nVERIFY: unit test\nROLLBACK: revert commit',
      inputTokens: 80,
      outputTokens: 40,
    });

    // 4. Run work — runs analyze + plan, advances to planned
    const result = await runWork({ cwd: tmp, cardId: id, adapter });
    expect(result.finalColumn).toBe('planned');

    // 5. Manually transition planned -> approved
    await runTransition({ cwd: tmp, cardId: id, target: 'approved' });

    // 6. Verify final state
    const card = await readCard(cardPath);
    expect(card.frontmatter.column).toBe('approved');
    expect(card.body).toContain('## Analysis');
    expect(card.body).toContain('## Implementation Plan');
    expect(card.body).toContain('Root cause: middleware');
    expect(card.body).toContain('Add expiry check');
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run: `npx vitest run tests/integration/end-to-end.test.ts`
Expected: 1 test passes.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/end-to-end.test.ts
git commit -m "test(1.17): end-to-end Phase 1 smoke test (discovered -> approved)"
```

---

### Task 18: README + Phase 1 verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# Conductor

Per-repo, model-agnostic AI engineering harness. Unifies Relay (workflow
pipeline + persistent memory), Control (session discipline + git-backed
audit), and Symphony (autonomous orchestration).

## Status

**Phase 1** (Engine spine + CLI). Not feature-complete; see
`docs/superpowers/specs/2026-05-06-conductor-design1.md` for the full
design and `docs/superpowers/plans/2026-05-07-phase-1-engine-spine.md`
for the active plan.

## Phase 1 capabilities

- `conductor init` — scaffold `.conductor/` in a repo
- `conductor card new <slug> [--title ...] [--kind ...]` — file a card
- `conductor work <card>` — run analyze + plan via Claude, advance card
  to `planned`
- `conductor transition <card> <column>` — manual lifecycle transition

Phase 2 adds review, implement, verify, notebook, resolve. Phase 3 adds
multi-model adapters. Phase 4 adds the daemon, MCP server, and HTTP API.
Phase 5 adds the UI. Phase 6 adds the autonomous Conductor brain.

## Try it

\`\`\`bash
npm install
npm run build
node dist/cli/index.js init
node dist/cli/index.js card new auth-token-expiry --title "Auth token expires silently"
ANTHROPIC_API_KEY=sk-... node dist/cli/index.js work 2026-05-07-auth-token-expiry
\`\`\`

## Development

\`\`\`bash
npm test           # run all tests
npm run typecheck  # type-check without emit
npm run dev -- <args>  # run the CLI without building (via tsx)
\`\`\`

## License

Apache-2.0 (see LICENSE).
```

- [ ] **Step 2: Run the full Phase 1 verification**

```bash
npm run typecheck    # expect: clean
npm test             # expect: all pass
npm run build        # expect: dist/ produced
```

- [ ] **Step 3: Manual smoke test from a real shell**

```bash
# In a fresh tmp directory:
cd $(mktemp -d)
node /path/to/conductor/dist/cli/index.js init
node /path/to/conductor/dist/cli/index.js card new sample --title "Sample issue"
ls .conductor/cards/    # expect: <today>-sample.md
cat .conductor/cards/*.md   # inspect frontmatter
```

- [ ] **Step 4: Commit + tag**

```bash
git add README.md
git commit -m "docs(1.18): Phase 1 README"
git tag phase-1-engine-spine-closed
```

The `phase-1-engine-spine-closed` tag is the recovery primitive for Phase 1 (Control invariant 3); future phases can `git reset --hard phase-1-engine-spine-closed` if needed.

---

## Phase 1 Done Criteria

- [ ] `npm test` runs all tests green (target: ~30+ tests across 11 files)
- [ ] `npm run typecheck` clean
- [ ] `npm run build` produces a working CLI binary at `dist/cli/index.js`
- [ ] Manual smoke: `init → card new → work → transition` walks a card from `discovered` to `approved`
- [ ] All commits use the `feat(1.N): ...` convention; one tag `phase-1-engine-spine-closed` placed at end

## Out of scope for Phase 1 (do NOT add)

- Daemon, MCP server, HTTP API (Phase 4)
- UI (Phase 5)
- Conductor loop / autonomy modes / `conduct` operation (Phase 6)
- Drift detection (Phase 2)
- review / implement / verify / notebook / resolve operations (Phase 2)
- Migration importer (Phase 2)
- Multi-model adapters beyond Claude (Phase 3)
- ESLint / Prettier / Husky tooling (defer to Phase 2 if useful)

---

## Implementation Notes (read before starting Task 1)

These are spot-checks the executor should apply consistently across the plan. Tests as written work on POSIX; the fixes below make them portable to Windows (the user's primary platform per the design spec).

### 1. Cross-platform card-id extraction in tests

Tests in Tasks 15, 16, and 17 extract a card id from a path using the regex `/cards\/(.+)\.md$/`. That regex assumes forward slashes; Node's `path.join` produces backslashes on Windows. **Replace with `path.basename`:**

```typescript
import { basename } from 'node:path';
// ...
const id = basename(cardPath, '.md');
```

Apply in:
- `tests/cli/work.test.ts` (beforeEach)
- `tests/cli/transition.test.ts` (beforeEach)
- `tests/integration/end-to-end.test.ts`

### 2. `afterEach` import location (Task 5)

The test file in Task 5 has the `afterEach` import at the bottom with a comment. Move it up to join the other vitest imports at the top:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

### 3. Static fs/promises imports (Tasks 5, 13)

Tests in Tasks 5 and 13 use a dynamic import: `import('node:fs/promises').then((fs) => fs.mkdir(...))`. Replace with static imports at the top of the test file:

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
```

### 4. `runCardNew` error handling for non-ENOENT access errors (Task 14)

The "card already exists" check should distinguish ENOENT (proceed) from other filesystem errors (rethrow). Replace the try/catch in `runCardNew` with:

```typescript
try {
  await access(path);
  // access succeeded => file exists
  throw new Error(`Card already exists at ${path}`);
} catch (e: unknown) {
  if (e instanceof Error && e.message.startsWith('Card already exists')) throw e;
  if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  // ENOENT — file doesn't exist, proceed with creation.
}
```

### 5. `noUncheckedIndexedAccess` and array element access

The `tsconfig.json` enables `noUncheckedIndexedAccess`. Tests that index arrays (`files[0]`, `cards[0]`) get `T | undefined`. Either:
- assert with `expect(arr[0]).toBeDefined()` first, or
- use the non-null assertion `arr[0]!` in test contexts (acceptable in tests; not in production code), or
- prefer `expect(arr).toEqual([...])` exact-match assertions when feasible.

The plan code uses `arr[0]!` and that's fine.

### 6. ANTHROPIC_API_KEY for manual smoke test only

The `npm test` suite uses `MockAdapter` everywhere — no API key needed. Only the Task 18 manual smoke test (which actually invokes Claude) requires `ANTHROPIC_API_KEY` set in the environment. Document this clearly in the README.

### 7. Hook Bus is shipped but not yet wired (Phase 1)

Task 7 ships `HookBus` and its tests, but no operation in Phase 1 emits or subscribes to events. This is intentional — the bus is the foundation Phase 2 will wire into (drift detection on `SessionStart`, snapshot on `PreCompact`, etc.). Don't add subscribers in Phase 1.

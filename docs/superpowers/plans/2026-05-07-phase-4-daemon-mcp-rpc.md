# Phase 4 — Daemon + MCP + HTTP/JSON-RPC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a long-running per-repo daemon that hosts a Task Agent runner, an HTTP/JSON-RPC server, and an MCP server — all backed by the existing engine. Existing CLI behavior stays identical when no daemon is running; when a daemon IS running, the CLI becomes a thin RPC client and external AI CLIs (Claude Code, Codex, Gemini CLI, OpenCode) can call `conductor.*` MCP tools as native capabilities.

**Architecture:**
- A new `TaskAgent` class wraps the existing `runWork` switch into an event-emitting per-card runner. It enforces deterministic autonomy gates (`manual` blocks autonomous transitions, `auto` fires, `assist` halts with a `Recommendation`) and writes a JSONL run log per session.
- A `daemon` process boots an HTTP server bound to `127.0.0.1:7180` (configurable). The same HTTP server serves two endpoints: `POST /rpc` (JSON-RPC 2.0 with bearer auth, used by the CLI when daemon is up and by CI scripts/webhooks) and a Streamable HTTP MCP transport at `/mcp` (used by foreign AI CLIs).
- A `chokidar` file watcher emits `.conductor/` mutation events onto an in-process bus so future UI clients can subscribe.
- A `RuntimeStore` interface abstracts in-flight session metadata, retry timers, and cost counters; v1 ships an in-memory implementation. The SQLite-backed implementation that spec § 5 calls for is deferred to Phase 7 hardening — runtime state is volatile by design (spec § 14), and a clean interface seam lets us swap implementations without touching the agent or RPC layer.
- The CLI auto-detects a running daemon via `.conductor/daemon.endpoint` + bearer token; when found it dispatches commands through the JSON-RPC client; when absent it keeps the existing in-process execution path verbatim. Phase 4 does NOT rewrite every CLI command into RPC — it adds the switching infrastructure plus daemon lifecycle commands; per-command client wiring lands as needed and is fully covered for the Phase 4 e2e flow.

**Tech stack:** Same as Phase 1–3 (TypeScript 5.6+, Node 20+, Vitest, Commander.js, gray-matter, js-yaml, Zod, simple-git, execa, @anthropic-ai/sdk, openai, @google/genai). New deps this phase: `@modelcontextprotocol/sdk` (MCP server) and `chokidar` (file watcher). HTTP server uses Node's built-in `node:http`; JSON-RPC 2.0 dispatch is implemented in ~80 LOC with no library dep.

**Divergence from spec, documented:**
- Spec § 10.3 specifies Unix domain socket / Windows named pipe for the MCP transport. Phase 4 uses **Streamable HTTP** (the MCP SDK's portable transport) on the same loopback HTTP server as JSON-RPC. `.conductor/mcp.endpoint` holds the HTTP URL instead of a socket path. Reason: one server one process one auth model; identical bytes Win/Mac/Linux; MCP clients in Claude Code, Codex, Gemini CLI, and OpenCode all support Streamable HTTP today. Switching to platform-native sockets is a Phase 7 hardening item if measurement shows latency benefit.
- Spec § 5 lists `runtime.sqlite`. Phase 4 uses an in-memory `RuntimeStore` with a clean interface seam; SQLite implementation deferred to Phase 7 (spec § 14 already commits SQLite state to be volatile / rebuildable, so no behavioral regression).

**Spec reference:** `docs/superpowers/specs/2026-05-06-conductor-design1.md` § 4 (system architecture), § 5 (domain model — recommendation), § 7 (model adapter layer), § 8 (Task Agent), § 10 (surfaces — CLI, MCP, HTTP, daemon), § 12 (v1 phasing — Phase 4), § 14 (open questions — auth token lifecycle, work_card idempotency, run log schema).

**Phase tag at completion:** `phase-4-daemon-mcp-rpc-closed`.

---

## Sub-phase checkpoints

- **Sub-phase A (Tasks 1–4) — Foundation.** Add deps; `RuntimeStore` interface + in-memory impl; auth-token + endpoint file management; PID file management.
- **Sub-phase B (Tasks 5–7) — Task Agent abstraction.** Event types; `TaskAgent` class; refactor `runWork` to drive `TaskAgent` (no behavioral change to existing 189 tests).
- **Sub-phase C (Tasks 8–9) — Recommendations + autonomy.** Run-log JSONL writer; deterministic autonomy gate enforcement on transitions (manual/auto/assist).
- **Sub-phase D (Tasks 10–11) — RPC layer.** Zod schemas for every RPC method; in-process method handlers (no transport yet).
- **Sub-phase E (Tasks 12–13) — HTTP server + JSON-RPC.** `node:http` server; bearer auth; method dispatch; CLI `daemon start | stop | status`.
- **Sub-phase F (Task 14) — MCP server.** Streamable HTTP MCP transport on same HTTP server; `conductor.*` tools wired to RPC handlers.
- **Sub-phase G (Task 15) — File watcher.** chokidar on `.conductor/`; emits to bus; `mcp.endpoint` written on daemon start.
- **Sub-phase H (Task 16) — RPC client + auto-detect.** CLI detects running daemon and routes through HTTP RPC; in-process fallback unchanged.
- **Sub-phase I (Tasks 17–19) — End-to-end + close.** Phase 4 integration test (daemon + RPC + MCP + watcher round-trip); README refresh; phase tag.

After each sub-phase, run `npm test` and commit a milestone (e.g., `chore(4.A): sub-phase A foundation complete`). Sub-phase B in particular must keep all 189 prior tests green before adding new test files.

---

## File Structure

```
conductor/
├── package.json                                 # task 1: add @modelcontextprotocol/sdk, chokidar
├── src/
│   ├── daemon/
│   │   ├── auth.ts                              # task 3: NEW — auth.token gen + read
│   │   ├── pidfile.ts                           # task 4: NEW — PID file lifecycle
│   │   ├── runtime.ts                           # task 2: NEW — RuntimeStore iface + InMemoryRuntime
│   │   ├── http_server.ts                       # task 12: NEW — node:http + JSON-RPC dispatch
│   │   ├── mcp_server.ts                        # task 14: NEW — MCP server, conductor.* tools
│   │   ├── watcher.ts                           # task 15: NEW — chokidar wrapper
│   │   └── index.ts                             # task 13: NEW — boot/shutdown
│   ├── agent/
│   │   ├── events.ts                            # task 5: NEW — TaskEvent union types
│   │   ├── runlog.ts                            # task 8: NEW — JSONL run log writer
│   │   └── task_agent.ts                        # task 6: NEW — TaskAgent class (replaces work.ts switch)
│   ├── rpc/
│   │   ├── schema.ts                            # task 10: NEW — zod schemas for params/results
│   │   ├── methods.ts                           # task 11: NEW — in-process method handlers
│   │   └── client.ts                            # task 16: NEW — HTTP RPC client + daemon-detect
│   ├── engine/
│   │   └── (unchanged in Phase 4)
│   ├── adapters/
│   │   └── (unchanged in Phase 4)
│   └── cli/
│       ├── commands/
│       │   ├── daemon.ts                        # task 13: NEW — start/stop/status
│       │   ├── work.ts                          # task 7: refactored to drive TaskAgent
│       │   └── (other commands unchanged in Phase 4 — RPC client wiring is task 16 + Phase 5)
│       └── index.ts                             # task 13: register `daemon` subcommand
├── tests/
│   ├── daemon/
│   │   ├── auth.test.ts                         # task 3
│   │   ├── pidfile.test.ts                      # task 4
│   │   ├── runtime.test.ts                      # task 2
│   │   ├── http_server.test.ts                  # task 12
│   │   ├── mcp_server.test.ts                   # task 14
│   │   └── watcher.test.ts                      # task 15
│   ├── agent/
│   │   ├── events.test.ts                       # task 5
│   │   ├── runlog.test.ts                       # task 8
│   │   ├── task_agent.test.ts                   # task 6
│   │   └── autonomy_gate.test.ts                # task 9
│   ├── rpc/
│   │   ├── schema.test.ts                       # task 10
│   │   ├── methods.test.ts                      # task 11
│   │   └── client.test.ts                       # task 16
│   ├── cli/
│   │   └── daemon.test.ts                       # task 13
│   └── integration/
│       └── phase4-end-to-end.test.ts            # task 17
└── README.md                                    # task 18: refresh
```

The engine layer (operations, state, lifecycle, adapters) is **unchanged** in Phase 4. All new code sits in `daemon/`, `agent/`, and `rpc/`. The single engine file modified is `cli/commands/work.ts` — refactored to delegate to `TaskAgent` while keeping its public `runWork(args)` signature so all 22 existing `work*.test.ts` cases pass byte-equivalent.

---

## Sub-phase A — Foundation

### Task 1: Add deps

**Files:**
- Modify: `conductor/package.json`

- [ ] **Step 1: Add deps to package.json**

Open `package.json` and add to `dependencies`:

```json
"@modelcontextprotocol/sdk": "^1.0.0",
"chokidar": "^4.0.1",
```

The full `dependencies` block becomes:

```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.65.0",
  "@google/genai": "^1.0.0",
  "@modelcontextprotocol/sdk": "^1.0.0",
  "chokidar": "^4.0.1",
  "commander": "^12.1.0",
  "execa": "^9.5.1",
  "gray-matter": "^4.0.3",
  "js-yaml": "^4.1.0",
  "openai": "^6.1.0",
  "simple-git": "^3.27.0",
  "zod": "^3.23.8"
}
```

- [ ] **Step 2: Install**

Run: `cd conductor && npm install`
Expected: clean install, `package-lock.json` updated, no peer-dep warnings beyond the existing baseline.

- [ ] **Step 3: Verify typecheck and tests still pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 189/189 tests passing across 45 files.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(4.1): add MCP SDK + chokidar deps"
```

---

### Task 2: RuntimeStore interface + in-memory implementation

**Files:**
- Create: `conductor/src/daemon/runtime.ts`
- Test: `conductor/tests/daemon/runtime.test.ts`

The runtime tracks live Task Agent sessions (zero or one in v1; spec § 14 commits `max_concurrent_agents=1`), per-card cost totals, and per-day cost totals. Volatile by spec (§ 14).

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/daemon/runtime.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';

describe('InMemoryRuntime', () => {
  it('starts with no active session', () => {
    const r = new InMemoryRuntime();
    expect(r.getActiveSession('card-1')).toBeUndefined();
    expect(r.listActiveSessions()).toEqual([]);
  });

  it('startSession records a session and rejects a duplicate for the same card', () => {
    const r = new InMemoryRuntime();
    const s = r.startSession({ cardId: 'card-1', runId: 'run-1', operation: 'analyze' });
    expect(s.cardId).toBe('card-1');
    expect(s.runId).toBe('run-1');
    expect(r.getActiveSession('card-1')).toEqual(s);
    expect(() => r.startSession({ cardId: 'card-1', runId: 'run-2', operation: 'plan' }))
      .toThrow(/already-running/);
  });

  it('endSession removes the session', () => {
    const r = new InMemoryRuntime();
    r.startSession({ cardId: 'card-1', runId: 'run-1', operation: 'analyze' });
    r.endSession('card-1');
    expect(r.getActiveSession('card-1')).toBeUndefined();
  });

  it('updateSessionOperation mutates current op', () => {
    const r = new InMemoryRuntime();
    r.startSession({ cardId: 'card-1', runId: 'run-1', operation: 'analyze' });
    r.updateSessionOperation('card-1', 'plan');
    expect(r.getActiveSession('card-1')?.operation).toBe('plan');
  });

  it('addCost accrues per-card and per-day totals', () => {
    const r = new InMemoryRuntime({ now: () => new Date('2026-05-07T12:00:00Z') });
    r.addCost('card-1', { inputTokens: 100, outputTokens: 50, dollars: 0.01 });
    r.addCost('card-1', { inputTokens: 200, outputTokens: 75, dollars: 0.02 });
    r.addCost('card-2', { inputTokens: 10, outputTokens: 5, dollars: 0.001 });
    expect(r.getCardCost('card-1')).toEqual({ inputTokens: 300, outputTokens: 125, dollars: 0.03 });
    expect(r.getCardCost('card-2')).toEqual({ inputTokens: 10, outputTokens: 5, dollars: 0.001 });
    expect(r.getDayCost('2026-05-07')).toEqual({ inputTokens: 310, outputTokens: 130, dollars: 0.031 });
  });

  it('rolls cost into a different bucket when the day changes', () => {
    let day = '2026-05-07T23:59:00Z';
    const r = new InMemoryRuntime({ now: () => new Date(day) });
    r.addCost('card-1', { inputTokens: 1, outputTokens: 1, dollars: 0.001 });
    day = '2026-05-08T00:00:01Z';
    r.addCost('card-1', { inputTokens: 2, outputTokens: 2, dollars: 0.002 });
    expect(r.getDayCost('2026-05-07')).toEqual({ inputTokens: 1, outputTokens: 1, dollars: 0.001 });
    expect(r.getDayCost('2026-05-08')).toEqual({ inputTokens: 2, outputTokens: 2, dollars: 0.002 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/daemon/runtime.ts`:

```typescript
// src/daemon/runtime.ts
//
// Volatile per-daemon runtime state: live sessions and rolling cost counters.
// Spec § 5 calls for SQLite (`runtime.sqlite`); Phase 4 ships the in-memory
// implementation and defers SQLite to Phase 7. Spec § 14 already commits
// runtime state to be volatile/rebuildable so this is no behavioral
// regression.

export interface SessionRecord {
  cardId: string;
  runId: string;
  operation: string;
  startedAt: string;
}

export interface CostDelta {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
}

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
}

export interface RuntimeStore {
  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord;
  endSession(cardId: string): void;
  updateSessionOperation(cardId: string, operation: string): void;
  getActiveSession(cardId: string): SessionRecord | undefined;
  listActiveSessions(): SessionRecord[];
  addCost(cardId: string, delta: CostDelta): void;
  getCardCost(cardId: string): CostTotals;
  getDayCost(yyyymmdd: string): CostTotals;
}

const ZERO: CostTotals = { inputTokens: 0, outputTokens: 0, dollars: 0 };

export class InMemoryRuntime implements RuntimeStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly cardCost = new Map<string, CostTotals>();
  private readonly dayCost = new Map<string, CostTotals>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  startSession(args: { cardId: string; runId: string; operation: string }): SessionRecord {
    if (this.sessions.has(args.cardId)) {
      throw new Error(`already-running: ${args.cardId}`);
    }
    const record: SessionRecord = {
      cardId: args.cardId,
      runId: args.runId,
      operation: args.operation,
      startedAt: this.now().toISOString(),
    };
    this.sessions.set(args.cardId, record);
    return record;
  }

  endSession(cardId: string): void {
    this.sessions.delete(cardId);
  }

  updateSessionOperation(cardId: string, operation: string): void {
    const s = this.sessions.get(cardId);
    if (!s) return;
    this.sessions.set(cardId, { ...s, operation });
  }

  getActiveSession(cardId: string): SessionRecord | undefined {
    return this.sessions.get(cardId);
  }

  listActiveSessions(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  addCost(cardId: string, delta: CostDelta): void {
    this.cardCost.set(cardId, addTotals(this.cardCost.get(cardId) ?? ZERO, delta));
    const day = this.now().toISOString().slice(0, 10);
    this.dayCost.set(day, addTotals(this.dayCost.get(day) ?? ZERO, delta));
  }

  getCardCost(cardId: string): CostTotals {
    return this.cardCost.get(cardId) ?? { ...ZERO };
  }

  getDayCost(yyyymmdd: string): CostTotals {
    return this.dayCost.get(yyyymmdd) ?? { ...ZERO };
  }
}

function addTotals(a: CostTotals, b: CostDelta): CostTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    dollars: round6(a.dollars + b.dollars),
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/daemon/runtime.test.ts`
Expected: 6/6 passing.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 195/195 passing across 46 files.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/runtime.ts tests/daemon/runtime.test.ts
git commit -m "feat(4.2): in-memory RuntimeStore for live sessions + cost"
```

---

### Task 3: Auth token generation + read

**Files:**
- Create: `conductor/src/daemon/auth.ts`
- Test: `conductor/tests/daemon/auth.test.ts`

Spec § 14 commits: `.conductor/auth.token` is a UUIDv4, generated on each daemon start, gitignored, and rotated on every start. Phase 4 generates it; Bearer auth is enforced in Task 12 (HTTP server) and Task 14 (MCP server).

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/daemon/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAuthToken, readAuthToken } from '../../src/daemon/auth.js';

describe('daemon/auth', () => {
  let tmpDir: string;
  let conductorDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conductor-auth-'));
    conductorDir = join(tmpDir, '.conductor');
  });

  it('generateAuthToken writes a UUIDv4 to .conductor/auth.token', async () => {
    const token = await generateAuthToken(tmpDir);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const path = join(conductorDir, 'auth.token');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toBe(token);
  });

  it('generateAuthToken rotates on each call (old token replaced)', async () => {
    const t1 = await generateAuthToken(tmpDir);
    const t2 = await generateAuthToken(tmpDir);
    expect(t1).not.toBe(t2);
    expect(readFileSync(join(conductorDir, 'auth.token'), 'utf8').trim()).toBe(t2);
  });

  it('readAuthToken returns the current token', async () => {
    const t = await generateAuthToken(tmpDir);
    expect(await readAuthToken(tmpDir)).toBe(t);
  });

  it('readAuthToken returns undefined when no token file exists', async () => {
    expect(await readAuthToken(tmpDir)).toBeUndefined();
  });

  it('generateAuthToken creates .conductor/ if it does not exist', async () => {
    const token = await generateAuthToken(tmpDir);
    expect(existsSync(conductorDir)).toBe(true);
    expect(token).toBeTypeOf('string');
  });

  it('readAuthToken trims trailing newline if present', async () => {
    const dir = join(tmpDir, '.conductor');
    writeFileSync(join(dir, 'auth.token').replace(/\.conductor$/, '.conductor'), '');
    // create explicitly
    const fs = await import('node:fs/promises');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'auth.token'), 'abc-123\n');
    expect(await readAuthToken(tmpDir)).toBe('abc-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/daemon/auth.ts`:

```typescript
// src/daemon/auth.ts
//
// .conductor/auth.token lifecycle. Spec § 14: UUIDv4 generated on each
// daemon start, gitignored, replacing prior token. Token is the bearer
// for HTTP /rpc and the MCP transport.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN_FILE = 'auth.token';

export async function generateAuthToken(repo: string): Promise<string> {
  const dir = join(repo, '.conductor');
  await mkdir(dir, { recursive: true });
  const token = randomUUID();
  await writeFile(join(dir, TOKEN_FILE), token, 'utf8');
  return token;
}

export async function readAuthToken(repo: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repo, '.conductor', TOKEN_FILE), 'utf8');
    return raw.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/daemon/auth.test.ts`
Expected: 6/6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/auth.ts tests/daemon/auth.test.ts
git commit -m "feat(4.3): auth.token generation + read"
```

---

### Task 4: PID file + endpoint discovery

**Files:**
- Create: `conductor/src/daemon/pidfile.ts`
- Test: `conductor/tests/daemon/pidfile.test.ts`

Tracks `.conductor/daemon.pid` (process id) and `.conductor/daemon.endpoint` (`http://127.0.0.1:<port>`). `mcp.endpoint` (same URL with `/mcp` suffix) is written by the MCP server task.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/daemon/pidfile.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writePidFile,
  readPidFile,
  clearPidFile,
  writeEndpointFile,
  readEndpointFile,
  isProcessAlive,
} from '../../src/daemon/pidfile.js';

describe('daemon/pidfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conductor-pid-'));
  });

  it('writePidFile then readPidFile round-trips', async () => {
    await writePidFile(tmpDir, 1234);
    expect(await readPidFile(tmpDir)).toBe(1234);
  });

  it('readPidFile returns undefined when no pid file', async () => {
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });

  it('clearPidFile removes the file', async () => {
    await writePidFile(tmpDir, 1234);
    await clearPidFile(tmpDir);
    expect(existsSync(join(tmpDir, '.conductor', 'daemon.pid'))).toBe(false);
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });

  it('writeEndpointFile then readEndpointFile round-trips', async () => {
    await writeEndpointFile(tmpDir, 'http://127.0.0.1:7180');
    expect(await readEndpointFile(tmpDir)).toBe('http://127.0.0.1:7180');
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for an unlikely pid', () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it('readPidFile returns undefined for an unparseable file', async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(tmpDir, '.conductor'), { recursive: true });
    await fs.writeFile(join(tmpDir, '.conductor', 'daemon.pid'), 'not-a-number');
    expect(await readPidFile(tmpDir)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/pidfile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/daemon/pidfile.ts`:

```typescript
// src/daemon/pidfile.ts
//
// Daemon discovery: PID file + endpoint URL file. Used by:
//   - `conductor daemon start`  to detect a running daemon and refuse double-start
//   - `conductor daemon stop`   to find the process to signal
//   - `conductor daemon status` to report up/down + endpoint
//   - the RPC client (rpc/client.ts) to decide whether to dispatch over HTTP

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PID_FILE = 'daemon.pid';
const ENDPOINT_FILE = 'daemon.endpoint';

export async function writePidFile(repo: string, pid: number): Promise<void> {
  const dir = join(repo, '.conductor');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PID_FILE), String(pid), 'utf8');
}

export async function readPidFile(repo: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(repo, '.conductor', PID_FILE), 'utf8');
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function clearPidFile(repo: string): Promise<void> {
  try {
    await unlink(join(repo, '.conductor', PID_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export async function writeEndpointFile(repo: string, url: string): Promise<void> {
  const dir = join(repo, '.conductor');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ENDPOINT_FILE), url, 'utf8');
}

export async function readEndpointFile(repo: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repo, '.conductor', ENDPOINT_FILE), 'utf8');
    return raw.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true; // exists but no permission
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/daemon/pidfile.test.ts`
Expected: 7/7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/pidfile.ts tests/daemon/pidfile.test.ts
git commit -m "feat(4.4): daemon PID file + endpoint discovery"
```

---

## Sub-phase A checkpoint

Run `npm test`. Expected: 208/208 across 48 files (189 prior + 6 runtime + 6 auth + 7 pidfile).

```bash
git commit --allow-empty -m "chore(4.A): sub-phase A foundation complete"
```

---

## Sub-phase B — Task Agent abstraction

The Phase 1+2 `runWork` is a one-shot switch keyed on the card's column. The Task Agent abstraction promotes it to an event-emitting per-card runner so the daemon, RPC, and MCP layers can stream progress to clients. The CLI keeps its existing public `runWork(args): Promise<WorkResult>` shape so the 22 prior `tests/cli/work*.test.ts` cases remain byte-equivalent.

### Task 5: TaskAgent event types

**Files:**
- Create: `conductor/src/agent/events.ts`
- Test: `conductor/tests/agent/events.test.ts`

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/agent/events.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isHaltEvent, isCompleteEvent, type TaskEvent } from '../../src/agent/events.js';

describe('agent/events', () => {
  it('isCompleteEvent narrows the union', () => {
    const e: TaskEvent = { kind: 'complete', cardId: 'c', finalColumn: 'archived' };
    expect(isCompleteEvent(e)).toBe(true);
    const o: TaskEvent = { kind: 'op_start', cardId: 'c', operation: 'analyze' };
    expect(isCompleteEvent(o)).toBe(false);
  });

  it('isHaltEvent narrows the union', () => {
    const e: TaskEvent = {
      kind: 'halt',
      cardId: 'c',
      reason: 'transition blocked',
      finalColumn: 'planned',
    };
    expect(isHaltEvent(e)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/agent/events.ts`:

```typescript
// src/agent/events.ts
//
// TaskEvent — discriminated union emitted by the TaskAgent runner. Consumers:
//   - the CLI (collects, prints summary)
//   - the run-log writer (JSONL persistence per spec § 14)
//   - the RPC layer (returns final state to clients)
//   - the MCP server (forwards as tool result chunks)

import type { Column, Recommendation } from '../engine/types.js';

export interface OpStartEvent {
  kind: 'op_start';
  cardId: string;
  operation: string;
  model?: string;
}

export interface OpCompleteEvent {
  kind: 'op_complete';
  cardId: string;
  operation: string;
  durationMs: number;
}

export interface RecommendationEvent {
  kind: 'recommendation';
  cardId: string;
  recommendation: Recommendation;
}

export interface TransitionEvent {
  kind: 'transition';
  cardId: string;
  from: Column;
  to: Column;
}

export interface TransitionRequestEvent {
  kind: 'transition_request';
  cardId: string;
  from: Column;
  to: Column;
  policy: 'manual' | 'assist';
}

export interface CompleteEvent {
  kind: 'complete';
  cardId: string;
  finalColumn: Column;
}

export interface HaltEvent {
  kind: 'halt';
  cardId: string;
  reason: string;
  finalColumn: Column;
}

export interface ErrorEvent {
  kind: 'error';
  cardId: string;
  message: string;
}

export type TaskEvent =
  | OpStartEvent
  | OpCompleteEvent
  | RecommendationEvent
  | TransitionEvent
  | TransitionRequestEvent
  | CompleteEvent
  | HaltEvent
  | ErrorEvent;

export function isCompleteEvent(e: TaskEvent): e is CompleteEvent {
  return e.kind === 'complete';
}

export function isHaltEvent(e: TaskEvent): e is HaltEvent {
  return e.kind === 'halt';
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/agent/events.test.ts`
Expected: 2/2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/agent/events.ts tests/agent/events.test.ts
git commit -m "feat(4.5): TaskAgent event union"
```

---

### Task 6: TaskAgent class + runWork delegation

**Files:**
- Create: `conductor/src/agent/task_agent.ts`
- Modify: `conductor/src/cli/commands/work.ts`
- Test: `conductor/tests/agent/task_agent.test.ts`

The `TaskAgent.run()` async generator yields `TaskEvent`s in order. The existing `runWork()` collects them and returns the same `WorkResult` so prior tests pass unchanged.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/agent/task_agent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent } from '../../src/agent/events.js';

function setupRepo(): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-07-sample';
  writeFileSync(
    join(cardsDir, `${cardId}.md`),
    `---
id: ${cardId}
title: Sample
kind: feature
column: discovered
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-07T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

Test card.
`,
    'utf8',
  );
  return { repo, cardId };
}

describe('TaskAgent', () => {
  it('emits op_start, op_complete, transition, complete in order for a discovered card', async () => {
    const { repo, cardId } = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'sample analysis', risks: [], affected_files: [] }),
      JSON.stringify({
        steps: [{ id: '1.1', what: 'do thing', how: 'change file', verify: 'tests pass', commit_type: 'feat' }],
        rollback: 'revert commit',
      }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    const events: TaskEvent[] = [];
    for await (const e of agent.run()) events.push(e);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('op_start');
    expect(kinds).toContain('op_complete');
    expect(kinds).toContain('transition');
    expect(kinds[kinds.length - 1]).toBe('complete');
    const complete = events[events.length - 1];
    if (complete.kind === 'complete') {
      expect(complete.finalColumn).toBe('planned');
    }
  });

  it('emits halt when an op refuses to advance (review NEEDS-CHANGES)', async () => {
    const { repo, cardId } = setupRepo();
    // bump card to planned column manually
    const fs = await import('node:fs/promises');
    const cardPath = join(repo, '.conductor', 'cards', `${cardId}.md`);
    let body = await fs.readFile(cardPath, 'utf8');
    body = body.replace('column: discovered', 'column: planned');
    body += `\n## Implementation Plan\n\n### Step 1.1 — do thing\n\n- WHAT: do thing\n- HOW: change file\n- VERIFY: tests pass\n- COMMIT: feat\n\n## Rollback\n\nrevert commit\n`;
    await fs.writeFile(cardPath, body, 'utf8');

    const adapter = new MockAdapter([
      JSON.stringify({ decision: 'NEEDS-CHANGES', reasoning: 'missing tests', changes_required: ['add tests'] }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    const events: TaskEvent[] = [];
    for await (const e of agent.run()) events.push(e);

    const last = events[events.length - 1];
    expect(last.kind).toBe('halt');
    if (last.kind === 'halt') {
      expect(last.reason).toMatch(/NEEDS-CHANGES/);
      expect(last.finalColumn).toBe('planned');
    }
  });

  it('exposes runId on the agent', async () => {
    const { repo, cardId } = setupRepo();
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({});
    const agent = new TaskAgent({ repo, cardId, adapter, config });
    expect(agent.runId).toMatch(/^[0-9]{8}T[0-9]{6}-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/task_agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TaskAgent**

Create `conductor/src/agent/task_agent.ts`:

```typescript
// src/agent/task_agent.ts
//
// TaskAgent walks one card through the lifecycle, emitting TaskEvents as it
// goes. Backed by the same engine ops as Phase 1+2 runWork, just turned
// inside-out into an async generator so HTTP/MCP/CLI surfaces can stream
// progress.

import { join } from 'node:path';
import type { Card, Column } from '../engine/types.js';
import type { ModelAdapter } from '../adapters/adapter.js';
import type { ProjectConfig } from '../config/schema.js';
import { readCard, writeCard } from '../engine/state/card.js';
import { analyze } from '../engine/ops/analyze.js';
import { plan as planOp } from '../engine/ops/plan.js';
import { review } from '../engine/ops/review.js';
import { implement } from '../engine/ops/implement.js';
import { verify, defaultRunner, type Runner } from '../engine/ops/verify.js';
import { notebook } from '../engine/ops/notebook.js';
import { resolve as resolveOp } from '../engine/ops/resolve.js';
import { RoutingAdapter } from '../adapters/routing.js';
import type { TaskEvent } from './events.js';

export interface TaskAgentArgs {
  repo: string;
  cardId: string;
  adapter?: ModelAdapter;
  config: ProjectConfig;
  step?: string;
  runner?: Runner;
  now?: () => Date;
}

export class TaskAgent {
  readonly repo: string;
  readonly cardId: string;
  readonly runId: string;
  private readonly adapter: ModelAdapter;
  private readonly config: ProjectConfig;
  private readonly step?: string;
  private readonly runner: Runner;

  constructor(args: TaskAgentArgs) {
    this.repo = args.repo;
    this.cardId = args.cardId;
    this.adapter = args.adapter ?? new RoutingAdapter();
    this.config = args.config;
    this.step = args.step;
    this.runner = args.runner ?? defaultRunner;
    const now = (args.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
    this.runId = `${stamp}-${args.cardId}`;
  }

  async *run(): AsyncIterable<TaskEvent> {
    const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
    let card: Card;
    try {
      card = await readCard(cardPath);
    } catch {
      yield { kind: 'error', cardId: this.cardId, message: `Card not found: ${this.cardId}` };
      return;
    }

    const column = card.frontmatter.column;
    const modelFor = (c: Card, op: string): string =>
      c.frontmatter.model_overrides[op] ??
      this.config.routing.functions[op] ??
      this.config.routing.default;

    switch (column) {
      case 'discovered': {
        const c1 = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'analyze', model: modelFor(c1, 'analyze') };
        const t0 = Date.now();
        await analyze({ card: c1, adapter: this.adapter, model: modelFor(c1, 'analyze') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'analyze', durationMs: Date.now() - t0 };

        const c2 = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'plan', model: modelFor(c2, 'plan') };
        const t1 = Date.now();
        await planOp({ card: c2, adapter: this.adapter, model: modelFor(c2, 'plan') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'plan', durationMs: Date.now() - t1 };

        yield* this.advance(cardPath, 'discovered', 'planned');
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'planned' };
        return;
      }

      case 'planned': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'review', model: modelFor(c, 'review') };
        const t = Date.now();
        const verdict = await review({ card: c, adapter: this.adapter, model: modelFor(c, 'review') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'review', durationMs: Date.now() - t };
        if (verdict.decision === 'APPROVED') {
          yield* this.advance(cardPath, 'planned', 'approved');
          yield { kind: 'complete', cardId: this.cardId, finalColumn: 'approved' };
        } else {
          yield {
            kind: 'halt',
            cardId: this.cardId,
            reason: `Review returned ${verdict.decision}. Card stays in 'planned'.`,
            finalColumn: 'planned',
          };
        }
        return;
      }

      case 'approved': {
        if (!this.step) {
          yield {
            kind: 'halt',
            cardId: this.cardId,
            reason: `'approved' requires --step <id> (one step per call).`,
            finalColumn: 'approved',
          };
          return;
        }
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'implement', model: modelFor(c, 'implement') };
        const t = Date.now();
        await implement({ repo: this.repo, card: c, adapter: this.adapter, model: modelFor(c, 'implement'), step: this.step });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'implement', durationMs: Date.now() - t };
        yield* this.advance(cardPath, 'approved', 'building');
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'building' };
        return;
      }

      case 'building': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'verify', model: modelFor(c, 'verify') };
        const t = Date.now();
        const report = await verify({
          card: c, adapter: this.adapter, model: modelFor(c, 'verify'),
          command: this.config.verify_command, runner: this.runner,
        });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'verify', durationMs: Date.now() - t };
        if (report.outcome === 'PASS') {
          yield* this.advance(cardPath, 'building', 'verifying');
          yield { kind: 'complete', cardId: this.cardId, finalColumn: 'verifying' };
        } else {
          yield {
            kind: 'halt', cardId: this.cardId,
            reason: `Verify outcome=${report.outcome}. Card stays in 'building'.`,
            finalColumn: 'building',
          };
        }
        return;
      }

      case 'verifying': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'notebook' };
        const t = Date.now();
        await notebook({ repo: this.repo, card: c, command: this.config.verify_command });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'notebook', durationMs: Date.now() - t };
        yield* this.advance(cardPath, 'verifying', 'shipped');
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'shipped' };
        return;
      }

      case 'shipped': {
        const c = await readCard(cardPath);
        yield { kind: 'op_start', cardId: this.cardId, operation: 'resolve', model: modelFor(c, 'resolve') };
        const t = Date.now();
        await resolveOp({ repo: this.repo, card: c, adapter: this.adapter, model: modelFor(c, 'resolve') });
        yield { kind: 'op_complete', cardId: this.cardId, operation: 'resolve', durationMs: Date.now() - t };
        // resolve op moves the card to archived itself
        yield { kind: 'transition', cardId: this.cardId, from: 'shipped', to: 'archived' };
        yield { kind: 'complete', cardId: this.cardId, finalColumn: 'archived' };
        return;
      }

      case 'archived': {
        yield {
          kind: 'halt', cardId: this.cardId,
          reason: 'Card is in a terminal state (archived).',
          finalColumn: 'archived',
        };
        return;
      }

      default: {
        yield {
          kind: 'halt', cardId: this.cardId,
          reason: `Unhandled column: ${column}`,
          finalColumn: column,
        };
      }
    }
  }

  private async *advance(cardPath: string, from: Column, to: Column): AsyncIterable<TaskEvent> {
    const updated = await readCard(cardPath);
    updated.frontmatter.column = to;
    await writeCard(updated);
    yield { kind: 'transition', cardId: this.cardId, from, to };
  }
}
```

- [ ] **Step 4: Refactor work.ts to delegate to TaskAgent**

Replace the body of `conductor/src/cli/commands/work.ts` with:

```typescript
// src/cli/commands/work.ts
//
// `conductor work <card>` — drive one pipeline step. Phase 4 delegates to
// the TaskAgent runner so the CLI is just an event collector. The public
// runWork() signature is unchanged so all prior CLI tests pass.

import { join } from 'node:path';
import type { Command } from 'commander';
import { loadProjectConfig } from '../../config/load.js';
import type { Column } from '../../engine/types.js';
import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card } from '../../engine/types.js';
import type { ProjectConfig } from '../../config/schema.js';
import { TaskAgent } from '../../agent/task_agent.js';
import { type Runner } from '../../engine/ops/verify.js';

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
  const config = await loadProjectConfig(join(args.cwd, '.conductor', 'config.yaml'));
  const agent = new TaskAgent({
    repo: args.cwd,
    cardId: args.cardId,
    adapter: args.adapter,
    config,
    step: args.step,
    runner: args.runner,
  });

  let finalColumn: Column = 'discovered';
  let halted = false;
  let reason: string | undefined;

  for await (const e of agent.run()) {
    if (e.kind === 'complete') {
      finalColumn = e.finalColumn;
    } else if (e.kind === 'halt') {
      halted = true;
      reason = e.reason;
      finalColumn = e.finalColumn;
    } else if (e.kind === 'error') {
      throw new Error(e.message);
    }
  }
  return { halted, reason, finalColumn };
}

export function pickModel(card: Card, op: string, config: ProjectConfig): string {
  return (
    card.frontmatter.model_overrides[op] ??
    config.routing.functions[op] ??
    config.routing.default
  );
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

`pickModel` stays exported because the `tests/cli/work-phase3.test.ts` suite imports it. Confirmed by grep before refactor.

- [ ] **Step 5: Run task_agent tests**

Run: `npx vitest run tests/agent/task_agent.test.ts`
Expected: 3/3 passing.

- [ ] **Step 6: Run prior CLI work tests to confirm zero regression**

Run: `npx vitest run tests/cli/work.test.ts tests/cli/work-phase2.test.ts tests/cli/work-phase3.test.ts`
Expected: all prior cases pass (count from current suite).

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: 213/213 passing across 50 files (208 prior + 2 events + 3 task_agent).

- [ ] **Step 8: Commit**

```bash
git add src/agent/task_agent.ts src/cli/commands/work.ts tests/agent/task_agent.test.ts
git commit -m "feat(4.6): TaskAgent class + runWork delegation"
```

---

### Task 7: Wire pickModel imports (compatibility check)

**Files:**
- Verify: `conductor/src/cli/commands/work.ts` exports `pickModel`
- Test: `conductor/tests/cli/work-phase3.test.ts`

This task is a verification task; no new code if Task 6 was applied correctly.

- [ ] **Step 1: Confirm pickModel still exported**

Run: `grep -n "export function pickModel" src/cli/commands/work.ts`
Expected: one hit — the export from Task 6.

- [ ] **Step 2: Run prior tests that import pickModel**

Run: `npx vitest run tests/cli/work-phase3.test.ts`
Expected: pass.

If either fails, `git diff` and restore the export. No commit unless something changed.

---

## Sub-phase B checkpoint

Run `npm test`. Expected: 213/213 across 50 files. Existing 189 cases pass byte-equivalent.

```bash
git commit --allow-empty -m "chore(4.B): sub-phase B task agent abstraction complete"
```

---

## Sub-phase C — Recommendations + autonomy gates

### Task 8: Run-log JSONL writer

**Files:**
- Create: `conductor/src/agent/runlog.ts`
- Test: `conductor/tests/agent/runlog.test.ts`

Spec § 14 commits: run logs at `.conductor/runs/<run-id>/events.jsonl`, one event per line, schemaed as `{ts, kind, op?, card_id?, payload}`.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/agent/runlog.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogWriter } from '../../src/agent/runlog.js';

describe('RunLogWriter', () => {
  it('writes one JSONL line per event with ts/kind/card_id', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-runlog-'));
    const writer = new RunLogWriter({
      repo,
      runId: '20260507T120000-card-1',
      now: () => new Date('2026-05-07T12:00:00Z'),
    });
    await writer.write({ kind: 'op_start', cardId: 'card-1', operation: 'analyze' });
    await writer.write({ kind: 'op_complete', cardId: 'card-1', operation: 'analyze', durationMs: 42 });
    await writer.write({ kind: 'complete', cardId: 'card-1', finalColumn: 'planned' });
    await writer.close();

    const path = join(repo, '.conductor', 'runs', '20260507T120000-card-1', 'events.jsonl');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first.ts).toBe('2026-05-07T12:00:00.000Z');
    expect(first.kind).toBe('op_start');
    expect(first.card_id).toBe('card-1');
    expect(first.op).toBe('analyze');
  });

  it('appends to an existing file rather than truncating', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-runlog-'));
    const w1 = new RunLogWriter({ repo, runId: 'r1', now: () => new Date('2026-05-07T00:00:00Z') });
    await w1.write({ kind: 'op_start', cardId: 'c', operation: 'analyze' });
    await w1.close();

    const w2 = new RunLogWriter({ repo, runId: 'r1', now: () => new Date('2026-05-07T00:00:01Z') });
    await w2.write({ kind: 'complete', cardId: 'c', finalColumn: 'planned' });
    await w2.close();

    const path = join(repo, '.conductor', 'runs', 'r1', 'events.jsonl');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/runlog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/agent/runlog.ts`:

```typescript
// src/agent/runlog.ts
//
// JSONL run log per spec § 14. One event per line at
// .conductor/runs/<run-id>/events.jsonl with shape:
//   { ts: ISO, kind: TaskEvent['kind'], card_id?, op?, payload? }

import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskEvent } from './events.js';

export interface RunLogArgs {
  repo: string;
  runId: string;
  now?: () => Date;
}

interface JsonlRecord {
  ts: string;
  kind: TaskEvent['kind'];
  card_id?: string;
  op?: string;
  payload?: Record<string, unknown>;
}

export class RunLogWriter {
  private readonly path: string;
  private readonly now: () => Date;
  private opened = false;

  constructor(args: RunLogArgs) {
    this.now = args.now ?? (() => new Date());
    this.path = join(args.repo, '.conductor', 'runs', args.runId, 'events.jsonl');
  }

  private async open(): Promise<void> {
    if (this.opened) return;
    await mkdir(dirOf(this.path), { recursive: true });
    this.opened = true;
  }

  async write(event: TaskEvent): Promise<void> {
    await this.open();
    const rec = toRecord(event, this.now().toISOString());
    await appendFile(this.path, JSON.stringify(rec) + '\n', 'utf8');
  }

  async close(): Promise<void> {
    // file appender is stateless; nothing to flush
  }
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/') === -1 ? p.lastIndexOf('\\') : p.lastIndexOf('/'));
}

function toRecord(e: TaskEvent, ts: string): JsonlRecord {
  const base: JsonlRecord = { ts, kind: e.kind, card_id: e.cardId };
  switch (e.kind) {
    case 'op_start':
      return { ...base, op: e.operation, payload: e.model ? { model: e.model } : undefined };
    case 'op_complete':
      return { ...base, op: e.operation, payload: { durationMs: e.durationMs } };
    case 'recommendation':
      return { ...base, payload: { recommendation: e.recommendation } as Record<string, unknown> };
    case 'transition':
      return { ...base, payload: { from: e.from, to: e.to } };
    case 'transition_request':
      return { ...base, payload: { from: e.from, to: e.to, policy: e.policy } };
    case 'complete':
      return { ...base, payload: { finalColumn: e.finalColumn } };
    case 'halt':
      return { ...base, payload: { reason: e.reason, finalColumn: e.finalColumn } };
    case 'error':
      return { ...base, payload: { message: e.message } };
  }
}
```

The `dirOf` helper is purposely cross-platform (works for both `/` and `\` separators). Replace it with `path.dirname` if the test reveals an issue:

If the test fails on Windows due to `dirOf`, simplify by using `node:path`:

```typescript
import { dirname } from 'node:path';
// ...
async function open(): Promise<void> {
  if (this.opened) return;
  await mkdir(dirname(this.path), { recursive: true });
  this.opened = true;
}
```

Pre-emptively, use `dirname` from the start (cleaner):

```typescript
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskEvent } from './events.js';
// ... rest unchanged, replace dirOf(this.path) with dirname(this.path) and delete dirOf
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/agent/runlog.test.ts`
Expected: 2/2 passing.

- [ ] **Step 5: Wire RunLogWriter into TaskAgent**

Modify `conductor/src/agent/task_agent.ts`:

In the `TaskAgent` class, add a private `log: RunLogWriter` and write each event before yielding. Add at top:

```typescript
import { RunLogWriter } from './runlog.js';
```

In the constructor add:

```typescript
this.log = new RunLogWriter({ repo: this.repo, runId: this.runId, now: args.now });
```

Declare the field:

```typescript
private readonly log: RunLogWriter;
```

Wrap the `run()` method's yield path with logging by introducing a helper at the top of `run()`:

```typescript
const emit = async function* (this: TaskAgent, e: TaskEvent): AsyncIterable<TaskEvent> {
  await this.log.write(e);
  yield e;
}.bind(this);
```

Then replace every `yield <event>;` inside `run()` with `yield* emit(<event>);`. Same for `advance()`:

```typescript
private async *advance(cardPath: string, from: Column, to: Column): AsyncIterable<TaskEvent> {
  const updated = await readCard(cardPath);
  updated.frontmatter.column = to;
  await writeCard(updated);
  const e: TaskEvent = { kind: 'transition', cardId: this.cardId, from, to };
  await this.log.write(e);
  yield e;
}
```

The `run()` method becomes:

```typescript
async *run(): AsyncIterable<TaskEvent> {
  // ... existing setup that may yield {kind:'error'} unchanged BUT also wrapped:
  const emitOne = async (e: TaskEvent): Promise<TaskEvent> => {
    await this.log.write(e);
    return e;
  };
  // ... use yield await emitOne({...}) instead of yield {...}
}
```

(Pick whichever style — bind-helper or inline `await emitOne` — is cleaner in your editor; both are equivalent.)

- [ ] **Step 6: Re-run task_agent tests**

Run: `npx vitest run tests/agent/task_agent.test.ts tests/agent/runlog.test.ts`
Expected: 5/5 passing.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: 215/215 passing across 51 files (213 prior + 2 runlog).

- [ ] **Step 8: Commit**

```bash
git add src/agent/runlog.ts src/agent/task_agent.ts tests/agent/runlog.test.ts
git commit -m "feat(4.8): JSONL run log writer + TaskAgent wiring"
```

---

### Task 9: Deterministic autonomy gate enforcement

**Files:**
- Modify: `conductor/src/agent/task_agent.ts`
- Test: `conductor/tests/agent/autonomy_gate.test.ts`

Phase 4 commits the deterministic gate semantics from spec § 12 Phase 4:
- `manual` policy on a transition → TaskAgent emits a `transition_request` event with policy=`manual` and **does not write the new column**. Final column = the source column. The CLI/RPC caller must explicitly approve via the `transition` op (which already exists).
- `assist` policy → TaskAgent emits a `transition_request` event with policy=`assist`, then proceeds to write the new column. (No confidence model in Phase 4 — assist halts on the gate but the engine still moves the card so a human-with-attention can resume in one call. v6 swaps in the confidence policy.)
- `auto` policy → TaskAgent transitions silently as today.

Wait — re-read spec § 12 Phase 4:

> Lifecycle state machine + DETERMINISTIC autonomy gates (manual blocks, auto fires, assist halts and surfaces — no confidence model yet)

So `assist` HALTS too in Phase 4. Both `manual` and `assist` halt; the difference is `manual` requires a human to manually transition, while `assist` surfaces a recommendation that the human can pick. Without a confidence model, `assist` is functionally equivalent to a halt-with-recommendation.

Updated semantics:
- `manual` → emit `transition_request` (policy=`manual`), **do not write new column**, then halt.
- `assist` → emit `transition_request` (policy=`assist`), **do not write new column**, then halt. (Confidence model in Phase 6 will let assist auto-approve some.)
- `auto` → transition silently.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/agent/autonomy_gate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskAgent } from '../../src/agent/task_agent.js';
import { MockAdapter } from '../../src/adapters/mock.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';
import type { TaskEvent } from '../../src/agent/events.js';

function setupRepo(column: string, autonomyOverride?: string): { repo: string; cardId: string } {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-gate-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-07-gate-card';
  const fm = `---
id: ${cardId}
title: Gate test
kind: feature
column: ${column}
phase: phase-1
priority: 1
autonomy: inherit
model_overrides: {}
created: 2026-05-07T00:00:00Z
source: user
labels: []
blocked_by: []
---

# Original Issue

x
`;
  writeFileSync(join(cardsDir, `${cardId}.md`), fm, 'utf8');
  return { repo, cardId };
}

async function collect(agent: TaskAgent): Promise<TaskEvent[]> {
  const out: TaskEvent[] = [];
  for await (const e of agent.run()) out.push(e);
  return out;
}

describe('TaskAgent autonomy gates', () => {
  it('auto policy transitions silently (no transition_request, no halt)', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'auto' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    expect(events.find((e) => e.kind === 'transition_request')).toBeUndefined();
    expect(events.find((e) => e.kind === 'halt')).toBeUndefined();
    const last = events[events.length - 1];
    expect(last.kind).toBe('complete');
    if (last.kind === 'complete') expect(last.finalColumn).toBe('planned');
  });

  it('manual policy emits transition_request and halts WITHOUT writing the new column', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'manual' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'transition_request') {
      expect(req.policy).toBe('manual');
      expect(req.from).toBe('discovered');
      expect(req.to).toBe('planned');
    }
    const last = events[events.length - 1];
    expect(last.kind).toBe('halt');
    if (last.kind === 'halt') expect(last.finalColumn).toBe('discovered');

    // confirm column NOT written
    const cardBody = readFileSync(join(repo, '.conductor', 'cards', `${cardId}.md`), 'utf8');
    expect(cardBody).toMatch(/column: discovered/);
  });

  it('assist policy emits transition_request and halts WITHOUT writing the new column', async () => {
    const { repo, cardId } = setupRepo('discovered');
    const adapter = new MockAdapter([
      JSON.stringify({ analysis: 'a', risks: [], affected_files: [] }),
      JSON.stringify({ steps: [{ id: '1.1', what: 'w', how: 'h', verify: 'v', commit_type: 'feat' }], rollback: 'r' }),
    ]);
    const config = ProjectConfigSchema.parse({ autonomy: { transitions: { discovered_to_planned: 'assist' } } });
    const events = await collect(new TaskAgent({ repo, cardId, adapter, config }));
    const req = events.find((e) => e.kind === 'transition_request');
    expect(req).toBeDefined();
    if (req && req.kind === 'transition_request') expect(req.policy).toBe('assist');
    const last = events[events.length - 1];
    expect(last.kind).toBe('halt');
    if (last.kind === 'halt') expect(last.finalColumn).toBe('discovered');
  });
});
```

- [ ] **Step 2: Run test to verify failures**

Run: `npx vitest run tests/agent/autonomy_gate.test.ts`
Expected: 2/3 fail (manual + assist) — current TaskAgent always writes the new column.

- [ ] **Step 3: Add gate enforcement to TaskAgent**

In `conductor/src/agent/task_agent.ts`, import the policy lookup:

```typescript
import { transitionPolicy, type TransitionPolicy } from '../engine/lifecycle.js';
```

Replace the `advance` private method with:

```typescript
private async *advance(cardPath: string, from: Column, to: Column): AsyncIterable<TaskEvent> {
  const policy: TransitionPolicy = transitionPolicy(this.config, from, to);

  if (policy === 'auto') {
    const updated = await readCard(cardPath);
    updated.frontmatter.column = to;
    await writeCard(updated);
    const e: TaskEvent = { kind: 'transition', cardId: this.cardId, from, to };
    await this.log.write(e);
    yield e;
    return;
  }

  // manual or assist: surface request, do NOT write the new column
  const req: TaskEvent = { kind: 'transition_request', cardId: this.cardId, from, to, policy };
  await this.log.write(req);
  yield req;

  const halt: TaskEvent = {
    kind: 'halt',
    cardId: this.cardId,
    reason: `Transition ${from} → ${to} requires ${policy} approval.`,
    finalColumn: from,
  };
  await this.log.write(halt);
  yield halt;
}
```

Adjust the call sites in `run()`: when `advance()` yields a halt, the outer switch should NOT also yield `complete`. Update the `discovered`, `approved`, `verifying`, `building` branches to detect a `halt` from `advance()` and short-circuit.

The cleanest pattern is a helper that drives `advance` and reports whether it halted:

```typescript
private async *advanceOrHalt(cardPath: string, from: Column, to: Column):
  AsyncGenerator<TaskEvent, boolean, void>
{
  let halted = false;
  for await (const e of this.advance(cardPath, from, to)) {
    yield e;
    if (e.kind === 'halt') halted = true;
  }
  return halted;
}
```

Then in each branch where the original code did `yield* this.advance(...); yield {complete}`, replace with:

```typescript
const halted = (yield* this.advanceOrHalt(cardPath, 'discovered', 'planned')) as unknown as boolean;
// (TS-quirk note: yield* on an AsyncGenerator returns the generator's TReturn through cast)
if (!halted) {
  const e: TaskEvent = { kind: 'complete', cardId: this.cardId, finalColumn: 'planned' };
  await this.log.write(e);
  yield e;
}
```

Cleaner alternative — collect into an array first:

```typescript
async *run(): AsyncIterable<TaskEvent> {
  // ... build the events list ...
}

private async *transitionWithGate(
  cardPath: string,
  from: Column,
  to: Column,
): AsyncIterable<{ event: TaskEvent; halted: boolean }> {
  const policy: TransitionPolicy = transitionPolicy(this.config, from, to);
  if (policy === 'auto') {
    const updated = await readCard(cardPath);
    updated.frontmatter.column = to;
    await writeCard(updated);
    const e: TaskEvent = { kind: 'transition', cardId: this.cardId, from, to };
    await this.log.write(e);
    yield { event: e, halted: false };
    return;
  }
  const req: TaskEvent = { kind: 'transition_request', cardId: this.cardId, from, to, policy };
  await this.log.write(req);
  yield { event: req, halted: false };
  const halt: TaskEvent = {
    kind: 'halt', cardId: this.cardId,
    reason: `Transition ${from} → ${to} requires ${policy} approval.`,
    finalColumn: from,
  };
  await this.log.write(halt);
  yield { event: halt, halted: true };
}
```

In `run()`:

```typescript
let halted = false;
for await (const { event, halted: h } of this.transitionWithGate(cardPath, 'discovered', 'planned')) {
  yield event;
  if (h) halted = true;
}
if (!halted) {
  const e: TaskEvent = { kind: 'complete', cardId: this.cardId, finalColumn: 'planned' };
  await this.log.write(e);
  yield e;
}
```

Apply the same pattern to the `approved → building`, `building → verifying`, `verifying → shipped`, and `shipped → archived` branches. The `shipped → archived` branch is special because `resolveOp()` itself archives the card; for that branch, do not call `transitionWithGate` (the column move happens inside the op). Keep the existing manual `yield {kind:'transition'}; yield {kind:'complete'}` lines for `shipped`.

Remove the now-unused `advance` method.

- [ ] **Step 4: Run autonomy_gate tests**

Run: `npx vitest run tests/agent/autonomy_gate.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 218/218 across 52 files (215 prior + 3 autonomy_gate).

The 22 prior CLI work tests must still pass. They use `ProjectConfigSchema.parse({})` which yields the spec defaults — `discovered_to_planned: auto`, `building_to_verifying: auto`, others `assist` or `manual`. Confirm test-by-test which prior tests rely on assist transitions silently succeeding; they may need their config to override gate policy to `auto`. If any prior CLI test fails:
- Read the failing test
- Confirm whether its scenario was actually relying on `assist`-as-silent-pass (a pre-Phase 4 bug) or on `auto`
- If it should be `auto`, update the test's config; if it was relying on the old bug, update the test's expectations to assert the halt + transition_request event

Document any such fix in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/agent/task_agent.ts tests/agent/autonomy_gate.test.ts tests/cli/work*.test.ts
git commit -m "feat(4.9): deterministic autonomy gate enforcement (manual/assist halt + surface)"
```

(Adjust the staged paths to whatever you actually edited.)

---

## Sub-phase C checkpoint

Run `npm test`. Expected: 218/218 across 52 files.

```bash
git commit --allow-empty -m "chore(4.C): sub-phase C autonomy gates + run log complete"
```

---

## Sub-phase D — RPC layer

### Task 10: Zod schemas for RPC params/results

**Files:**
- Create: `conductor/src/rpc/schema.ts`
- Test: `conductor/tests/rpc/schema.test.ts`

The RPC method set mirrors the MCP tool set in spec § 10.3. Each method has a Zod params schema; method handlers (Task 11) parse via `.parse()` at the boundary.

Methods (matching `conductor.*` MCP tool names):

| Method | Params | Returns |
|---|---|---|
| `card_new` | `{ slug, title, kind?, body? }` | `{ id, path }` |
| `card_get` | `{ id }` | `{ frontmatter, body, path }` |
| `card_list` | `{ column? }` | `{ cards: CardSummary[] }` |
| `card_update` | `{ id, frontmatterPatch?, bodyAppend? }` | `{ id, path }` |
| `transition` | `{ id, to }` | `{ id, from, to }` |
| `scan` | `{}` | `Status` |
| `order` | `{}` | `Ordering` |
| `discover` | `{}` | `{ items: DiscoveredItem[] }` |
| `exercise_new` | `{ goal? }` | `{ sessionId }` |
| `exercise_file` | `{ sessionId, finding }` | `{ cardId? }` |
| `work_card` | `{ id, step? }` | `{ runId, finalColumn, halted, reason? }` |
| `work_next` | `{}` | `{ id?, runId?, finalColumn?, halted, reason? }` |
| `recommend` | `{ cardId, recommendation }` | `{ ok: true }` |

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/rpc/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  CardNewParams,
  CardGetParams,
  CardListParams,
  CardUpdateParams,
  TransitionParams,
  ScanParams,
  WorkCardParams,
  WorkNextParams,
  RecommendParams,
} from '../../src/rpc/schema.js';

describe('rpc/schema', () => {
  it('CardNewParams accepts a minimal payload', () => {
    const p = CardNewParams.parse({ slug: 'foo', title: 'Foo' });
    expect(p.slug).toBe('foo');
    expect(p.kind).toBe('issue'); // default
  });

  it('CardNewParams rejects an empty title', () => {
    expect(() => CardNewParams.parse({ slug: 'foo', title: '' })).toThrow();
  });

  it('CardGetParams requires id', () => {
    expect(() => CardGetParams.parse({})).toThrow();
    expect(CardGetParams.parse({ id: '2026-05-07-foo' }).id).toBe('2026-05-07-foo');
  });

  it('CardListParams accepts no args (column optional)', () => {
    expect(CardListParams.parse({}).column).toBeUndefined();
    expect(CardListParams.parse({ column: 'planned' }).column).toBe('planned');
  });

  it('CardUpdateParams requires id; either patch or append', () => {
    expect(() => CardUpdateParams.parse({ id: 'x' })).toThrow();
    expect(CardUpdateParams.parse({ id: 'x', bodyAppend: 'hi' }).bodyAppend).toBe('hi');
    expect(
      CardUpdateParams.parse({ id: 'x', frontmatterPatch: { priority: 2 } }).frontmatterPatch
    ).toEqual({ priority: 2 });
  });

  it('TransitionParams enforces valid column', () => {
    expect(TransitionParams.parse({ id: 'x', to: 'planned' }).to).toBe('planned');
    expect(() => TransitionParams.parse({ id: 'x', to: 'bogus' })).toThrow();
  });

  it('ScanParams accepts empty', () => {
    expect(ScanParams.parse({})).toEqual({});
  });

  it('WorkCardParams requires id; step optional', () => {
    expect(WorkCardParams.parse({ id: 'x' }).step).toBeUndefined();
    expect(WorkCardParams.parse({ id: 'x', step: '1.2' }).step).toBe('1.2');
  });

  it('WorkNextParams accepts empty', () => {
    expect(WorkNextParams.parse({})).toEqual({});
  });

  it('RecommendParams accepts a recommendation envelope', () => {
    const p = RecommendParams.parse({
      cardId: 'x',
      recommendation: {
        type: 'recommendation',
        card: 'x',
        operation: 'review',
        blast_radius: { level: 'low', reason: 'isolated' },
        options: [{ id: 'approve', confidence: 0.9, rationale: 'looks good' }],
        recommended: 'approve',
      },
    });
    expect(p.recommendation.options).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rpc/schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/rpc/schema.ts`:

```typescript
// src/rpc/schema.ts
//
// Zod schemas for JSON-RPC method params. Schemas are the parser at the
// boundary; method handlers (rpc/methods.ts) call .parse() to enforce shape
// before invoking the engine.

import { z } from 'zod';
import { ColumnSchema, KindSchema, CardFrontmatterSchema } from '../config/schema.js';

export const CardNewParams = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: KindSchema.default('issue'),
  body: z.string().optional(),
});

export const CardGetParams = z.object({
  id: z.string().min(1),
});

export const CardListParams = z.object({
  column: ColumnSchema.optional(),
});

export const CardUpdateParams = z
  .object({
    id: z.string().min(1),
    frontmatterPatch: CardFrontmatterSchema.partial().optional(),
    bodyAppend: z.string().optional(),
  })
  .refine((v) => v.frontmatterPatch !== undefined || v.bodyAppend !== undefined, {
    message: 'card_update requires frontmatterPatch or bodyAppend',
  });

export const TransitionParams = z.object({
  id: z.string().min(1),
  to: ColumnSchema,
});

export const ScanParams = z.object({});
export const OrderParams = z.object({});
export const DiscoverParams = z.object({});

export const ExerciseNewParams = z.object({
  goal: z.string().optional(),
});

export const ExerciseFileParams = z.object({
  sessionId: z.string().min(1),
  finding: z.object({
    scenario: z.string(),
    observed: z.string(),
    severity: z.enum(['note', 'low', 'medium', 'high']),
    evidence: z.string().default(''),
  }),
});

export const WorkCardParams = z.object({
  id: z.string().min(1),
  step: z.string().optional(),
});

export const WorkNextParams = z.object({});

export const RecommendParams = z.object({
  cardId: z.string().min(1),
  recommendation: z.object({
    type: z.literal('recommendation'),
    card: z.string(),
    operation: z.string(),
    blast_radius: z.object({
      level: z.enum(['low', 'medium', 'high']),
      reason: z.string(),
    }),
    options: z
      .array(
        z.object({
          id: z.string(),
          confidence: z.number().min(0).max(1),
          rationale: z.string(),
        }),
      )
      .min(1),
    recommended: z.string(),
  }),
});
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/rpc/schema.test.ts`
Expected: 10/10 passing.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/schema.ts tests/rpc/schema.test.ts
git commit -m "feat(4.10): RPC param schemas (zod)"
```

---

### Task 11: In-process RPC method handlers

**Files:**
- Create: `conductor/src/rpc/methods.ts`
- Test: `conductor/tests/rpc/methods.test.ts`

`Methods` is a record from method-name to handler. Each handler accepts a `MethodContext` (repo, config, runtime) plus parsed params and returns a result. The HTTP server (Task 12) and the MCP server (Task 14) both invoke these same handlers — one engine, two transports.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/rpc/methods.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '../../src/rpc/methods.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rpc-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\nverify_command: "echo ok"\n',
    'utf8',
  );
  return repo;
}

describe('rpc methods', () => {
  it('card_new creates a card and card_get reads it back', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const created = await methods.card_new(ctx, { slug: 'foo', title: 'Foo', kind: 'issue' });
    expect(created.id).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-foo$/);
    const fetched = await methods.card_get(ctx, { id: created.id });
    expect(fetched.frontmatter.title).toBe('Foo');
  });

  it('card_list filters by column', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    await methods.card_new(ctx, { slug: 'a', title: 'A', kind: 'issue' });
    await methods.card_new(ctx, { slug: 'b', title: 'B', kind: 'feature' });
    const all = await methods.card_list(ctx, {});
    expect(all.cards.length).toBe(2);
    const planned = await methods.card_list(ctx, { column: 'planned' });
    expect(planned.cards.length).toBe(0);
  });

  it('transition moves a card between adjacent columns', async () => {
    const repo = setupRepo();
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
    const { id } = await methods.card_new(ctx, { slug: 'x', title: 'X', kind: 'issue' });
    const result = await methods.transition(ctx, { id, to: 'planned' });
    expect(result).toEqual({ id, from: 'discovered', to: 'planned' });
  });

  it('work_card refuses double-start (already-running)', async () => {
    const repo = setupRepo();
    const runtime = new InMemoryRuntime();
    runtime.startSession({ cardId: '2026-05-07-x', runId: 'r1', operation: 'analyze' });
    const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime };
    await expect(methods.work_card(ctx, { id: '2026-05-07-x' })).rejects.toThrow(/already-running/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rpc/methods.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/rpc/methods.ts`:

```typescript
// src/rpc/methods.ts
//
// In-process RPC method handlers. Both transports (HTTP /rpc, MCP /mcp)
// dispatch through this map. Each handler parses its params via Zod at the
// boundary and calls into the engine.

import { join } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from '../daemon/runtime.js';
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
} from './schema.js';
import { readCard, writeCard, listCards, createCard } from '../engine/state/card.js';
import { canTransition } from '../engine/lifecycle.js';
import { TaskAgent } from '../agent/task_agent.js';
import type { TaskEvent } from '../agent/events.js';
import type { Column } from '../engine/types.js';

export interface MethodContext {
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
}

type Handler<P, R> = (ctx: MethodContext, params: P) => Promise<R>;

async function card_new(ctx: MethodContext, raw: unknown) {
  const p = CardNewParams.parse(raw);
  const id = await createCard(ctx.repo, {
    slug: p.slug, title: p.title, kind: p.kind, body: p.body ?? '',
  });
  return { id, path: join(ctx.repo, '.conductor', 'cards', `${id}.md`) };
}

async function card_get(ctx: MethodContext, raw: unknown) {
  const p = CardGetParams.parse(raw);
  const card = await readCard(join(ctx.repo, '.conductor', 'cards', `${p.id}.md`));
  return { frontmatter: card.frontmatter, body: card.body, path: card.path };
}

async function card_list(ctx: MethodContext, raw: unknown) {
  const p = CardListParams.parse(raw);
  const all = await listCards(ctx.repo);
  const cards = p.column
    ? all.filter((c) => c.column === p.column)
    : all;
  return { cards };
}

async function card_update(ctx: MethodContext, raw: unknown) {
  const p = CardUpdateParams.parse(raw);
  const path = join(ctx.repo, '.conductor', 'cards', `${p.id}.md`);
  const card = await readCard(path);
  if (p.frontmatterPatch) {
    card.frontmatter = { ...card.frontmatter, ...p.frontmatterPatch };
  }
  if (p.bodyAppend) {
    card.body += (card.body.endsWith('\n') ? '' : '\n') + p.bodyAppend;
  }
  await writeCard(card);
  return { id: p.id, path };
}

async function transition(ctx: MethodContext, raw: unknown) {
  const p = TransitionParams.parse(raw);
  const path = join(ctx.repo, '.conductor', 'cards', `${p.id}.md`);
  const card = await readCard(path);
  const from = card.frontmatter.column;
  if (!canTransition(from, p.to)) {
    throw new Error(`Invalid transition: ${from} → ${p.to}`);
  }
  card.frontmatter.column = p.to;
  await writeCard(card);
  return { id: p.id, from, to: p.to };
}

async function scan(ctx: MethodContext, raw: unknown) {
  ScanParams.parse(raw);
  const all = await listCards(ctx.repo);
  const by_column: Record<Column, number> = {
    discovered: 0, planned: 0, approved: 0, building: 0, verifying: 0, shipped: 0, archived: 0,
  };
  const by_phase: Record<string, number> = {};
  for (const c of all) {
    by_column[c.column] = (by_column[c.column] ?? 0) + 1;
    by_phase[c.phase] = (by_phase[c.phase] ?? 0) + 1;
  }
  return { cards: all, by_column, by_phase };
}

async function order(_ctx: MethodContext, raw: unknown) {
  OrderParams.parse(raw);
  // Future: reuse engine/ops/order.ts. For Phase 4, stub returns the current
  // ordering.md if present, else empty. Implementation lifted from
  // src/cli/commands/order.ts in Task 11 follow-up if needed for e2e.
  return { generated_at: new Date().toISOString(), entries: [] };
}

async function discover(_ctx: MethodContext, raw: unknown) {
  DiscoverParams.parse(raw);
  return { items: [] };
}

async function exercise_new(_ctx: MethodContext, raw: unknown) {
  const p = ExerciseNewParams.parse(raw);
  const sessionId = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  // Phase 4 ships a placeholder; Phase 5 wires the full exercise flow if needed.
  return { sessionId, goal: p.goal };
}

async function exercise_file(_ctx: MethodContext, raw: unknown) {
  ExerciseFileParams.parse(raw);
  return { cardId: undefined };
}

async function work_card(ctx: MethodContext, raw: unknown) {
  const p = WorkCardParams.parse(raw);
  if (ctx.runtime.getActiveSession(p.id)) {
    throw new Error(`already-running: ${p.id}`);
  }
  const agent = new TaskAgent({ repo: ctx.repo, cardId: p.id, config: ctx.config, step: p.step });
  ctx.runtime.startSession({ cardId: p.id, runId: agent.runId, operation: 'work' });
  try {
    let finalColumn: Column = 'discovered';
    let halted = false;
    let reason: string | undefined;
    for await (const e of agent.run()) {
      if (e.kind === 'op_start') ctx.runtime.updateSessionOperation(p.id, e.operation);
      else if (e.kind === 'complete') finalColumn = e.finalColumn;
      else if (e.kind === 'halt') { halted = true; reason = e.reason; finalColumn = e.finalColumn; }
    }
    return { runId: agent.runId, finalColumn, halted, reason };
  } finally {
    ctx.runtime.endSession(p.id);
  }
}

async function work_next(ctx: MethodContext, raw: unknown) {
  WorkNextParams.parse(raw);
  // Phase 4 v1: pick first non-archived card by priority.
  const all = await listCards(ctx.repo);
  const eligible = all
    .filter((c) => c.column !== 'archived' && (c.blocked_by ?? []).length === 0)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  if (eligible.length === 0) return { halted: true, reason: 'No eligible cards.' };
  const result = await work_card(ctx, { id: eligible[0].id });
  return { id: eligible[0].id, ...result };
}

async function recommend(_ctx: MethodContext, raw: unknown) {
  RecommendParams.parse(raw);
  // Phase 4: persist via the run log. The TaskAgent that surfaces a
  // recommendation already writes it; this entry point exists for foreign
  // tools (plugins) that want to file a recommendation manually.
  return { ok: true as const };
}

export const methods = {
  card_new,
  card_get,
  card_list,
  card_update,
  transition,
  scan,
  order,
  discover,
  exercise_new,
  exercise_file,
  work_card,
  work_next,
  recommend,
} satisfies Record<string, Handler<unknown, unknown>>;

export type MethodName = keyof typeof methods;
```

You may need to add `createCard` and `listCards` to `src/engine/state/card.ts` if they don't already exist. Check first:

```bash
grep -E "export (async )?function (createCard|listCards)" src/engine/state/card.ts
```

If missing, add minimal helpers (do this in a separate edit step within Task 11 before declaring it complete):

```typescript
// src/engine/state/card.ts — append
import { readdir } from 'node:fs/promises';
import type { CardSummary } from '../types.js';

export async function listCards(repo: string): Promise<CardSummary[]> {
  const dir = join(repo, '.conductor', 'cards');
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: CardSummary[] = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const c = await readCard(join(dir, f));
    out.push({
      id: c.frontmatter.id,
      title: c.frontmatter.title,
      column: c.frontmatter.column,
      phase: c.frontmatter.phase,
      priority: c.frontmatter.priority,
      kind: c.frontmatter.kind,
      labels: c.frontmatter.labels,
      blocked_by: c.frontmatter.blocked_by,
    });
  }
  return out;
}

export async function createCard(
  repo: string,
  args: { slug: string; title: string; kind: import('../types.js').Kind; body?: string },
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `${today}-${args.slug}`;
  const path = join(repo, '.conductor', 'cards', `${id}.md`);
  const fm = `---
id: ${id}
title: ${args.title}
kind: ${args.kind}
column: discovered
phase: unassigned
priority: 1
autonomy: inherit
model_overrides: {}
created: ${new Date().toISOString()}
source: user
labels: []
blocked_by: []
---

${args.body ?? '# Original Issue\n\n'}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, fm, 'utf8');
  return id;
}
```

(Imports `mkdir`, `writeFile`, `dirname` may already be present in card.ts — check before adding duplicates.)

If `card.ts` already exposes equivalents under different names (e.g., `card-new` CLI uses an existing helper), prefer reusing those. Read `src/engine/state/card.ts` and `src/cli/commands/card-new.ts` first to determine.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/rpc/methods.test.ts`
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/rpc/methods.ts src/engine/state/card.ts tests/rpc/methods.test.ts
git commit -m "feat(4.11): RPC method handlers (in-process dispatch)"
```

---

## Sub-phase D checkpoint

Run `npm test`. Expected: 232/232 across 54 files (218 prior + 10 schema + 4 methods).

```bash
git commit --allow-empty -m "chore(4.D): sub-phase D RPC handlers complete"
```

---

## Sub-phase E — HTTP server + JSON-RPC + daemon CLI

### Task 12: HTTP server with bearer auth and JSON-RPC dispatch

**Files:**
- Create: `conductor/src/daemon/http_server.ts`
- Test: `conductor/tests/daemon/http_server.test.ts`

JSON-RPC 2.0 envelope: `{ jsonrpc: "2.0", id, method, params }` → `{ jsonrpc: "2.0", id, result }` or `{ jsonrpc: "2.0", id, error: { code, message } }`. Method = `conductor.<name>` so MCP-style and HTTP-style names match. Bearer auth required for `/rpc`.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/daemon/http_server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type StartedServer } from '../../src/daemon/http_server.js';
import { InMemoryRuntime } from '../../src/daemon/runtime.js';
import { ProjectConfigSchema } from '../../src/config/schema.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-http-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

async function rpc(server: StartedServer, method: string, params: unknown, token: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${server.url}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

describe('http_server', () => {
  let server: StartedServer;
  let token: string;
  let repo: string;

  beforeEach(async () => {
    repo = setupRepo();
    token = 'test-token-xyz';
    server = await startHttpServer({
      port: 0, // random
      repo,
      config: ProjectConfigSchema.parse({}),
      runtime: new InMemoryRuntime(),
      authToken: token,
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('rejects request without bearer with 401', async () => {
    const r = await rpc(server, 'conductor.scan', {}, null);
    expect(r.status).toBe(401);
  });

  it('rejects request with wrong bearer with 401', async () => {
    const r = await rpc(server, 'conductor.scan', {}, 'wrong-token');
    expect(r.status).toBe(401);
  });

  it('dispatches scan and returns JSON-RPC result', async () => {
    const r = await rpc(server, 'conductor.scan', {}, token);
    expect(r.status).toBe(200);
    const body = r.body as { result: { cards: unknown[]; by_column: Record<string, number> } };
    expect(body.result.cards).toEqual([]);
    expect(body.result.by_column.discovered).toBe(0);
  });

  it('returns JSON-RPC error for unknown method', async () => {
    const r = await rpc(server, 'conductor.bogus', {}, token);
    const body = r.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/method not found/i);
  });

  it('returns JSON-RPC error for invalid params', async () => {
    const r = await rpc(server, 'conductor.card_new', { slug: '' }, token);
    const body = r.body as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/http_server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/daemon/http_server.ts`:

```typescript
// src/daemon/http_server.ts
//
// HTTP server hosting JSON-RPC 2.0 at /rpc. Bearer-token auth (token written
// by daemon.auth on start). Method dispatch via rpc/methods.ts.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProjectConfig } from '../config/schema.js';
import type { RuntimeStore } from './runtime.js';
import { methods, type MethodName, type MethodContext } from '../rpc/methods.js';

export interface StartHttpServerArgs {
  port: number;
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  authToken: string;
}

export interface StartedServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const METHOD_PREFIX = 'conductor.';

export async function startHttpServer(args: StartHttpServerArgs): Promise<StartedServer> {
  const ctx: MethodContext = { repo: args.repo, config: args.config, runtime: args.runtime };

  const server: Server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (!authOk(req, args.authToken)) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      const body = await readBody(req);
      let parsed: { id?: number | string | null; method?: string; params?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        return writeJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
      if (typeof parsed.method !== 'string' || !parsed.method.startsWith(METHOD_PREFIX)) {
        return writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: 'method not found' } });
      }
      const name = parsed.method.slice(METHOD_PREFIX.length) as MethodName;
      const handler = methods[name];
      if (!handler) {
        return writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32601, message: 'method not found' } });
      }
      try {
        const result = await handler(ctx, parsed.params);
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = /Zod|invalid|expected|required/i.test(message) ? -32602 : -32603;
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code, message } });
      }
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'internal');
    }
  });

  await new Promise<void>((resolve) => server.listen(args.port, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function authOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization;
  if (!h) return false;
  const [scheme, value] = h.split(' ');
  return scheme === 'Bearer' && value === token;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/daemon/http_server.test.ts`
Expected: 5/5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/http_server.ts tests/daemon/http_server.test.ts
git commit -m "feat(4.12): HTTP JSON-RPC server with bearer auth"
```

---

### Task 13: Daemon entry + start/stop/status CLI

**Files:**
- Create: `conductor/src/daemon/index.ts`
- Create: `conductor/src/cli/commands/daemon.ts`
- Modify: `conductor/src/cli/index.ts`
- Test: `conductor/tests/cli/daemon.test.ts`

The daemon entry boots the HTTP server, generates the auth token, writes pid + endpoint files, and registers SIGINT/SIGTERM handlers. The CLI `daemon start` runs it in foreground (or detached); `daemon stop` reads the pid and signals; `daemon status` reports up/down + endpoint.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/cli/daemon.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemonStart, runDaemonStop, runDaemonStatus } from '../../src/cli/commands/daemon.js';
import { readPidFile, readEndpointFile } from '../../src/daemon/pidfile.js';
import { readAuthToken } from '../../src/daemon/auth.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-daemoncli-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

describe('daemon CLI', () => {
  let repo: string;

  beforeEach(() => {
    repo = setupRepo();
  });

  it('start writes auth.token, daemon.pid, daemon.endpoint, and HTTP responds', async () => {
    const handle = await runDaemonStart({ cwd: repo, port: 0, foreground: false });
    try {
      expect(await readAuthToken(repo)).toBeTypeOf('string');
      expect(await readPidFile(repo)).toBe(process.pid);
      const endpoint = await readEndpointFile(repo);
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);

      // Probe HTTP
      const token = await readAuthToken(repo);
      const res = await fetch(`${endpoint}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'conductor.scan', params: {} }),
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.shutdown();
    }
  });

  it('status reports up after start, down after stop', async () => {
    const handle = await runDaemonStart({ cwd: repo, port: 0, foreground: false });
    const up = await runDaemonStatus({ cwd: repo });
    expect(up.running).toBe(true);
    expect(up.endpoint).toMatch(/^http:\/\//);

    await handle.shutdown();
    // Simulate full stop: clear pid file (handle.shutdown does this via stopDaemon)
    const down = await runDaemonStatus({ cwd: repo });
    expect(down.running).toBe(false);
  });

  it('start refuses double-start', async () => {
    const handle = await runDaemonStart({ cwd: repo, port: 0, foreground: false });
    try {
      await expect(runDaemonStart({ cwd: repo, port: 0, foreground: false })).rejects.toThrow(/already-running/);
    } finally {
      await handle.shutdown();
    }
  });

  it('stop on a non-running daemon returns ok with not-running flag', async () => {
    const result = await runDaemonStop({ cwd: repo });
    expect(result).toEqual({ stopped: false, reason: 'not-running' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/daemon.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement daemon entry**

Create `conductor/src/daemon/index.ts`:

```typescript
// src/daemon/index.ts
//
// Daemon boot. Starts the HTTP server, generates auth, writes pid +
// endpoint files. shutdown() reverses everything.

import { join } from 'node:path';
import { loadProjectConfig } from '../config/load.js';
import { startHttpServer, type StartedServer } from './http_server.js';
import { generateAuthToken, readAuthToken } from './auth.js';
import {
  writePidFile, readPidFile, clearPidFile,
  writeEndpointFile, isProcessAlive,
} from './pidfile.js';
import { InMemoryRuntime } from './runtime.js';

export interface DaemonHandle {
  url: string;
  port: number;
  shutdown: () => Promise<void>;
}

export interface StartDaemonArgs {
  repo: string;
  port: number; // 0 = random
}

export async function startDaemon(args: StartDaemonArgs): Promise<DaemonHandle> {
  // Refuse double-start
  const existing = await readPidFile(args.repo);
  if (existing && isProcessAlive(existing) && existing !== process.pid) {
    throw new Error(`already-running: pid ${existing}`);
  }

  const config = await loadProjectConfig(join(args.repo, '.conductor', 'config.yaml'));
  const authToken = await generateAuthToken(args.repo);
  const runtime = new InMemoryRuntime();

  const server: StartedServer = await startHttpServer({
    port: args.port,
    repo: args.repo,
    config,
    runtime,
    authToken,
  });

  await writePidFile(args.repo, process.pid);
  await writeEndpointFile(args.repo, server.url);

  return {
    url: server.url,
    port: server.port,
    shutdown: async () => {
      await server.close();
      await clearPidFile(args.repo);
    },
  };
}

export async function stopDaemon(repo: string): Promise<{ stopped: boolean; reason?: string }> {
  const pid = await readPidFile(repo);
  if (!pid) return { stopped: false, reason: 'not-running' };
  if (!isProcessAlive(pid)) {
    await clearPidFile(repo);
    return { stopped: false, reason: 'not-running' };
  }
  if (pid === process.pid) {
    // In-process daemon — caller should use the handle; but we still cleanup.
    return { stopped: false, reason: 'in-process' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    // Give it a moment
    await new Promise((r) => setTimeout(r, 200));
    await clearPidFile(repo);
    return { stopped: true };
  } catch (e) {
    return { stopped: false, reason: (e as Error).message };
  }
}

export async function statusDaemon(repo: string): Promise<{
  running: boolean;
  pid?: number;
  endpoint?: string;
}> {
  const pid = await readPidFile(repo);
  if (!pid || !isProcessAlive(pid)) return { running: false };
  const fs = await import('node:fs/promises');
  let endpoint: string | undefined;
  try {
    endpoint = (await fs.readFile(join(repo, '.conductor', 'daemon.endpoint'), 'utf8')).trim();
  } catch { /* not yet written */ }
  return { running: true, pid, endpoint };
}
```

- [ ] **Step 4: Implement daemon CLI commands**

Create `conductor/src/cli/commands/daemon.ts`:

```typescript
// src/cli/commands/daemon.ts
//
// `conductor daemon start | stop | status`

import type { Command } from 'commander';
import { startDaemon, stopDaemon, statusDaemon, type DaemonHandle } from '../../daemon/index.js';

export interface RunDaemonStartArgs {
  cwd: string;
  port: number;
  foreground: boolean;
}

export async function runDaemonStart(args: RunDaemonStartArgs): Promise<DaemonHandle> {
  return startDaemon({ repo: args.cwd, port: args.port });
  // foreground/detach is the responsibility of the CLI wrapper; tests pass
  // foreground:false but synchronously call shutdown in their teardown.
}

export async function runDaemonStop(args: { cwd: string }) {
  return stopDaemon(args.cwd);
}

export async function runDaemonStatus(args: { cwd: string }) {
  return statusDaemon(args.cwd);
}

export function attachDaemon(program: Command): void {
  const cmd = program.command('daemon').description('Daemon lifecycle (start/stop/status)');
  cmd
    .command('start')
    .option('--port <n>', 'HTTP port (default 7180; 0 = random)', '7180')
    .option('--detach', 'Detach from terminal', false)
    .action(async (opts: { port: string; detach: boolean }) => {
      const handle = await runDaemonStart({
        cwd: process.cwd(),
        port: Number.parseInt(opts.port, 10),
        foreground: !opts.detach,
      });
      // eslint-disable-next-line no-console
      console.log(`Daemon up at ${handle.url} (pid=${process.pid})`);
      if (!opts.detach) {
        // Block until SIGINT/SIGTERM
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => resolve());
          process.on('SIGTERM', () => resolve());
        });
        await handle.shutdown();
      }
    });

  cmd
    .command('stop')
    .action(async () => {
      const r = await runDaemonStop({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(r.stopped ? 'Daemon stopped.' : `Daemon not stopped: ${r.reason}`);
    });

  cmd
    .command('status')
    .action(async () => {
      const r = await runDaemonStatus({ cwd: process.cwd() });
      // eslint-disable-next-line no-console
      console.log(r.running ? `Up: pid=${r.pid} endpoint=${r.endpoint}` : 'Down.');
    });
}
```

- [ ] **Step 5: Register daemon command in CLI index**

Modify `conductor/src/cli/index.ts`. Add the import:

```typescript
import { attachDaemon } from './commands/daemon.js';
```

And the registration after `attachImport(program);`:

```typescript
attachDaemon(program);
```

- [ ] **Step 6: Run daemon CLI tests**

Run: `npx vitest run tests/cli/daemon.test.ts`
Expected: 4/4 passing.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: 241/241 across 56 files (232 prior + 5 http_server + 4 daemon CLI).

- [ ] **Step 8: Commit**

```bash
git add src/daemon/index.ts src/cli/commands/daemon.ts src/cli/index.ts tests/cli/daemon.test.ts
git commit -m "feat(4.13): daemon entry + CLI start/stop/status"
```

---

## Sub-phase E checkpoint

```bash
git commit --allow-empty -m "chore(4.E): sub-phase E HTTP server + daemon CLI complete"
```

---

## Sub-phase F — MCP server

### Task 14: MCP server with conductor.* tools

**Files:**
- Create: `conductor/src/daemon/mcp_server.ts`
- Modify: `conductor/src/daemon/index.ts` (boot MCP alongside HTTP)
- Test: `conductor/tests/daemon/mcp_server.test.ts`

Use `@modelcontextprotocol/sdk`. The Streamable HTTP transport mounts on the same Node http.Server instance under `/mcp`. Each `conductor.*` MCP tool dispatches to the corresponding RPC method in `src/rpc/methods.ts`.

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/daemon/mcp_server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/index.js';
import { readAuthToken } from '../../src/daemon/auth.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-mcp-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

describe('mcp_server', () => {
  let repo: string;
  let handle: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    repo = setupRepo();
    handle = await startDaemon({ repo, port: 0 });
    const token = await readAuthToken(repo);
    const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await handle.shutdown();
  });

  it('lists conductor.* tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('conductor.card_new');
    expect(names).toContain('conductor.scan');
    expect(names).toContain('conductor.transition');
  });

  it('invokes conductor.card_new and round-trips card_get', async () => {
    const created = await client.callTool({
      name: 'conductor.card_new',
      arguments: { slug: 'mcp-test', title: 'MCP Test', kind: 'issue' },
    });
    const createdResult = JSON.parse((created.content as { type: string; text: string }[])[0].text);
    expect(createdResult.id).toMatch(/-mcp-test$/);

    const fetched = await client.callTool({
      name: 'conductor.card_get',
      arguments: { id: createdResult.id },
    });
    const fetchedResult = JSON.parse((fetched.content as { type: string; text: string }[])[0].text);
    expect(fetchedResult.frontmatter.title).toBe('MCP Test');
  });

  it('invokes conductor.scan and returns Status', async () => {
    const result = await client.callTool({ name: 'conductor.scan', arguments: {} });
    const r = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(r.by_column).toMatchObject({ discovered: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/mcp_server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement MCP server**

Create `conductor/src/daemon/mcp_server.ts`:

```typescript
// src/daemon/mcp_server.ts
//
// MCP server exposing conductor.* tools. Streamable HTTP transport mounts on
// the daemon's Node http.Server at /mcp. Each tool dispatches to the
// corresponding RPC method in src/rpc/methods.ts.

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { methods, type MethodContext, type MethodName } from '../rpc/methods.js';
import {
  CardNewParams, CardGetParams, CardListParams, CardUpdateParams,
  TransitionParams, ScanParams, OrderParams, DiscoverParams,
  ExerciseNewParams, ExerciseFileParams,
  WorkCardParams, WorkNextParams, RecommendParams,
} from '../rpc/schema.js';

const TOOLS = [
  { name: 'conductor.card_new', description: 'Create a card', schema: CardNewParams },
  { name: 'conductor.card_get', description: 'Fetch a card by id', schema: CardGetParams },
  { name: 'conductor.card_list', description: 'List cards', schema: CardListParams },
  { name: 'conductor.card_update', description: 'Update card frontmatter or body', schema: CardUpdateParams },
  { name: 'conductor.transition', description: 'Move a card to a new column', schema: TransitionParams },
  { name: 'conductor.scan', description: 'Snapshot of card columns + phases', schema: ScanParams },
  { name: 'conductor.order', description: 'Re-rank queue', schema: OrderParams },
  { name: 'conductor.discover', description: 'Discover candidate work', schema: DiscoverParams },
  { name: 'conductor.exercise_new', description: 'Open an exercise session', schema: ExerciseNewParams },
  { name: 'conductor.exercise_file', description: 'File an exercise finding', schema: ExerciseFileParams },
  { name: 'conductor.work_card', description: 'Spawn a Task Agent on a card', schema: WorkCardParams },
  { name: 'conductor.work_next', description: 'Pick the next eligible card and work it', schema: WorkNextParams },
  { name: 'conductor.recommend', description: 'File a recommendation manually', schema: RecommendParams },
] as const;

export interface McpAttachArgs {
  ctx: MethodContext;
  authToken: string;
}

export interface McpAttachment {
  handleRequest: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
}

export function attachMcpServer(args: McpAttachArgs): McpAttachment {
  const server = new McpServer(
    { name: 'conductor', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    const methodName = req.params.name.replace('conductor.', '') as MethodName;
    const handler = methods[methodName];
    try {
      const result = await handler(args.ctx, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  server.connect(transport).catch(() => { /* logged downstream */ });

  return {
    handleRequest: async (req, res) => {
      // Bearer auth check before delegating to MCP transport
      const h = req.headers.authorization;
      if (!h || h !== `Bearer ${args.authToken}`) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      await transport.handleRequest(req, res);
    },
  };
}

// Minimal zod → JSON Schema for MCP tool advertisement. Phase 4 supports the
// shape of params used here (object with string/enum/number/optional/refine).
// Phase 5 may swap this for `zod-to-json-schema` if richer schemas appear.
function zodToJsonSchema(_schema: unknown): Record<string, unknown> {
  // Tools advertise that they accept any object; concrete validation happens
  // server-side in the RPC method handler. This is a known limitation of the
  // Phase 4 MCP advertisement; Phase 5 swaps in real schema generation.
  return { type: 'object', additionalProperties: true };
}
```

- [ ] **Step 4: Wire MCP server into daemon HTTP server**

Modify `conductor/src/daemon/http_server.ts` so the request handler routes `/mcp` to the MCP transport. Add an optional parameter to `StartHttpServerArgs`:

```typescript
import type { McpAttachment } from './mcp_server.js';

export interface StartHttpServerArgs {
  port: number;
  repo: string;
  config: ProjectConfig;
  runtime: RuntimeStore;
  authToken: string;
  mcp?: McpAttachment;
}
```

In the request handler, before the `/rpc` check:

```typescript
if (req.url?.startsWith('/mcp') && args.mcp) {
  await args.mcp.handleRequest(req, res);
  return;
}
```

Modify `conductor/src/daemon/index.ts` to attach MCP and write `mcp.endpoint`:

```typescript
import { attachMcpServer } from './mcp_server.js';
import { writeFile } from 'node:fs/promises';
// ...

export async function startDaemon(args: StartDaemonArgs): Promise<DaemonHandle> {
  // ... existing setup up to `runtime`

  const ctx = { repo: args.repo, config, runtime };
  const mcp = attachMcpServer({ ctx, authToken });

  const server: StartedServer = await startHttpServer({
    port: args.port, repo: args.repo, config, runtime, authToken, mcp,
  });

  await writePidFile(args.repo, process.pid);
  await writeEndpointFile(args.repo, server.url);
  await writeFile(join(args.repo, '.conductor', 'mcp.endpoint'), `${server.url}/mcp`, 'utf8');

  return { url: server.url, port: server.port, shutdown: async () => {
    await server.close();
    await clearPidFile(args.repo);
  } };
}
```

- [ ] **Step 5: Run mcp_server tests**

Run: `npx vitest run tests/daemon/mcp_server.test.ts`
Expected: 3/3 passing.

If imports for `@modelcontextprotocol/sdk/server/streamableHttp.js` fail, check the SDK version's actual export paths via `npm ls @modelcontextprotocol/sdk` and adjust imports. The SDK's docs are at https://github.com/modelcontextprotocol/typescript-sdk — verify the import path against the installed version's `package.json` exports.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 244/244 across 57 files (241 prior + 3 mcp_server).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/mcp_server.ts src/daemon/http_server.ts src/daemon/index.ts tests/daemon/mcp_server.test.ts
git commit -m "feat(4.14): MCP server with conductor.* tools (Streamable HTTP)"
```

---

## Sub-phase F checkpoint

```bash
git commit --allow-empty -m "chore(4.F): sub-phase F MCP server complete"
```

---

## Sub-phase G — File watcher

### Task 15: chokidar watcher emitting bus events

**Files:**
- Create: `conductor/src/daemon/watcher.ts`
- Modify: `conductor/src/daemon/index.ts` (boot watcher alongside HTTP)
- Test: `conductor/tests/daemon/watcher.test.ts`

The watcher subscribes to `.conductor/cards/`, `.conductor/state.md`, `.conductor/ordering.md`. On change it emits structured events that future surfaces (Phase 5 UI) consume. Phase 4 ships the watcher and a dedicated event emitter; no consumer wires it to MCP/HTTP yet (Phase 5).

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/daemon/watcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatcher } from '../../src/daemon/watcher.js';

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('watcher', () => {
  it('emits cards-changed on a card mutation', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-watch-'));
    mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
    const cardPath = join(repo, '.conductor', 'cards', '2026-05-07-x.md');
    writeFileSync(cardPath, 'placeholder', 'utf8');

    const events: { kind: string; path?: string }[] = [];
    const w = await startWatcher({ repo, onEvent: (e) => events.push(e) });
    try {
      await delay(150);
      events.length = 0;
      appendFileSync(cardPath, '\nadded line\n');
      // wait for chokidar fs poll
      const start = Date.now();
      while (events.length === 0 && Date.now() - start < 2000) await delay(50);
      const found = events.find((e) => e.kind === 'cards-changed');
      expect(found).toBeDefined();
    } finally {
      await w.close();
    }
  });

  it('emits state-changed on state.md edit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'conductor-watch-state-'));
    mkdirSync(join(repo, '.conductor'), { recursive: true });
    const statePath = join(repo, '.conductor', 'state.md');
    writeFileSync(statePath, 'initial', 'utf8');

    const events: { kind: string }[] = [];
    const w = await startWatcher({ repo, onEvent: (e) => events.push(e) });
    try {
      await delay(150);
      events.length = 0;
      appendFileSync(statePath, '\nupdate\n');
      const start = Date.now();
      while (events.length === 0 && Date.now() - start < 2000) await delay(50);
      expect(events.find((e) => e.kind === 'state-changed')).toBeDefined();
    } finally {
      await w.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/daemon/watcher.ts`:

```typescript
// src/daemon/watcher.ts
//
// chokidar wrapper. Watches .conductor/cards/, state.md, ordering.md and
// emits structured events to a callback. Phase 4 ships the wiring; Phase 5
// adds UI consumers.

import chokidar from 'chokidar';
import { join } from 'node:path';

export type WatcherEvent =
  | { kind: 'cards-changed'; path: string }
  | { kind: 'state-changed' }
  | { kind: 'ordering-changed' };

export interface WatcherArgs {
  repo: string;
  onEvent: (event: WatcherEvent) => void;
}

export interface WatcherHandle {
  close: () => Promise<void>;
}

export async function startWatcher(args: WatcherArgs): Promise<WatcherHandle> {
  const conductorDir = join(args.repo, '.conductor');
  const watch = chokidar.watch(
    [
      join(conductorDir, 'cards', '**', '*.md'),
      join(conductorDir, 'state.md'),
      join(conductorDir, 'ordering.md'),
    ],
    {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    },
  );

  const handler = (path: string) => {
    if (path.includes(`${join('cards')}`) || /[\\/]cards[\\/]/.test(path)) {
      args.onEvent({ kind: 'cards-changed', path });
    } else if (path.endsWith('state.md')) {
      args.onEvent({ kind: 'state-changed' });
    } else if (path.endsWith('ordering.md')) {
      args.onEvent({ kind: 'ordering-changed' });
    }
  };

  watch.on('add', handler);
  watch.on('change', handler);
  watch.on('unlink', handler);

  await new Promise<void>((resolve) => watch.on('ready', () => resolve()));

  return {
    close: async () => {
      await watch.close();
    },
  };
}
```

- [ ] **Step 4: Wire watcher into daemon entry**

Modify `conductor/src/daemon/index.ts`:

```typescript
import { startWatcher, type WatcherHandle } from './watcher.js';

export async function startDaemon(args: StartDaemonArgs): Promise<DaemonHandle> {
  // ... existing setup through HTTP server creation ...

  const watcher: WatcherHandle = await startWatcher({
    repo: args.repo,
    onEvent: (e) => {
      // Phase 4: emit to stderr for observability; Phase 5 wires consumers.
      // eslint-disable-next-line no-console
      console.error(`[watcher] ${e.kind}${'path' in e ? ` ${e.path}` : ''}`);
    },
  });

  return {
    url: server.url,
    port: server.port,
    shutdown: async () => {
      await watcher.close();
      await server.close();
      await clearPidFile(args.repo);
    },
  };
}
```

- [ ] **Step 5: Run watcher tests**

Run: `npx vitest run tests/daemon/watcher.test.ts`
Expected: 2/2 passing.

If chokidar behaves flakily on Windows in tests (known issue with rapid in-test writes), add `usePolling: true, interval: 50` to the chokidar options.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 246/246 across 58 files (244 prior + 2 watcher).

- [ ] **Step 7: Commit**

```bash
git add src/daemon/watcher.ts src/daemon/index.ts tests/daemon/watcher.test.ts
git commit -m "feat(4.15): chokidar watcher + daemon wiring"
```

---

## Sub-phase G checkpoint

```bash
git commit --allow-empty -m "chore(4.G): sub-phase G watcher complete"
```

---

## Sub-phase H — RPC client + auto-detect

### Task 16: HTTP RPC client + daemon-detect

**Files:**
- Create: `conductor/src/rpc/client.ts`
- Test: `conductor/tests/rpc/client.test.ts`

The client wraps `fetch` to POST JSON-RPC against the running daemon. `discoverDaemon()` reads `.conductor/daemon.endpoint` + `auth.token`. If both present and the endpoint responds, return a client; otherwise return undefined and the caller falls back to in-process execution.

Phase 4 only ships the client + discovery API; converting individual CLI commands to use it is per-command work and lands incrementally (Phase 4 does it for `scan` and `card_list` to prove the path; the rest in Phase 5 alongside the UI build).

- [ ] **Step 1: Write the failing test**

Create `conductor/tests/rpc/client.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDaemon, RpcClient } from '../../src/rpc/client.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/index.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-rpc-client-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

describe('rpc/client', () => {
  let repo: string;
  let handle: DaemonHandle | undefined;

  beforeEach(() => { repo = setupRepo(); });
  afterEach(async () => { if (handle) await handle.shutdown(); handle = undefined; });

  it('discoverDaemon returns undefined when no daemon is running', async () => {
    expect(await discoverDaemon(repo)).toBeUndefined();
  });

  it('discoverDaemon returns a client when daemon is up', async () => {
    handle = await startDaemon({ repo, port: 0 });
    const client = await discoverDaemon(repo);
    expect(client).toBeInstanceOf(RpcClient);
    const r = await client!.call('conductor.scan', {});
    expect((r as { by_column: { discovered: number } }).by_column.discovered).toBe(0);
  });

  it('RpcClient.call surfaces JSON-RPC errors as thrown errors', async () => {
    handle = await startDaemon({ repo, port: 0 });
    const client = await discoverDaemon(repo);
    await expect(client!.call('conductor.bogus', {})).rejects.toThrow(/method not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rpc/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `conductor/src/rpc/client.ts`:

```typescript
// src/rpc/client.ts
//
// JSON-RPC 2.0 client for the daemon's HTTP /rpc endpoint. discoverDaemon()
// reads .conductor/daemon.endpoint + auth.token; if both exist and the
// endpoint responds to a noop ping, returns a configured RpcClient. The CLI
// uses this to switch between thin-client and in-process execution.

import { readEndpointFile } from '../daemon/pidfile.js';
import { readAuthToken } from '../daemon/auth.js';

export class RpcClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const res = await fetch(`${this.url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  }
}

export async function discoverDaemon(repo: string): Promise<RpcClient | undefined> {
  const url = await readEndpointFile(repo);
  const token = await readAuthToken(repo);
  if (!url || !token) return undefined;
  // Probe with a 200ms ping — daemon may be in pid file but unresponsive.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const res = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'conductor.scan', params: {} }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return new RpcClient(url, token);
}
```

- [ ] **Step 4: Run client tests**

Run: `npx vitest run tests/rpc/client.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Wire `scan` CLI command to use the client when daemon is up**

Modify `conductor/src/cli/commands/scan.ts`. At the top of the action body, before the existing in-process scan logic, insert:

```typescript
import { discoverDaemon } from '../../rpc/client.js';
// ... in the action handler ...
const client = await discoverDaemon(process.cwd());
if (client) {
  const status = await client.call('conductor.scan', {});
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(status, null, 2));
  return;
}
// fallthrough: existing in-process path unchanged
```

Repeat for `card-new`'s action: after parsing args, check for daemon and call `conductor.card_new`. Read the existing files first to confirm exact insertion points.

(If the existing CLI commands have a `runScan({cwd})`-style internal function, the same switch lands inside that function — keeping the public-CLI surface unchanged for tests.)

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 249/249 across 59 files (246 prior + 3 client). Existing scan/card-new tests pass byte-equivalent because they don't start a daemon (the `discoverDaemon` returns undefined and the in-process path runs).

- [ ] **Step 7: Commit**

```bash
git add src/rpc/client.ts src/cli/commands/scan.ts src/cli/commands/card-new.ts tests/rpc/client.test.ts
git commit -m "feat(4.16): RPC client + daemon-detect; scan/card-new switch to RPC when up"
```

---

## Sub-phase H checkpoint

```bash
git commit --allow-empty -m "chore(4.H): sub-phase H RPC client + auto-detect complete"
```

---

## Sub-phase I — End-to-end + close

### Task 17: Phase 4 end-to-end test

**Files:**
- Create: `conductor/tests/integration/phase4-end-to-end.test.ts`

End-to-end exercises:
1. Start daemon
2. Foreign client (RpcClient) calls `conductor.card_new` to file a card
3. Foreign client calls `conductor.card_list` to confirm card present
4. Foreign client calls `conductor.transition` to move it
5. MCP client calls `conductor.scan` to confirm column counts
6. CLI `daemon stop` shuts everything down

- [ ] **Step 1: Write the test**

Create `conductor/tests/integration/phase4-end-to-end.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon } from '../../src/daemon/index.js';
import { discoverDaemon } from '../../src/rpc/client.js';
import { readAuthToken } from '../../src/daemon/auth.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-phase4-e2e-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\nverify_command: "echo ok"\n',
    'utf8',
  );
  return repo;
}

describe('phase 4 end-to-end', () => {
  it('daemon up → JSON-RPC files a card → MCP transitions it → scan reflects it → daemon down', async () => {
    const repo = setupRepo();
    const handle = await startDaemon({ repo, port: 0 });
    try {
      // RPC client files a card
      const rpc = await discoverDaemon(repo);
      expect(rpc).toBeDefined();
      const created = (await rpc!.call('conductor.card_new', {
        slug: 'phase4-e2e', title: 'Phase 4 E2E', kind: 'feature',
      })) as { id: string };
      expect(created.id).toMatch(/-phase4-e2e$/);

      // MCP client lists tools and transitions
      const token = await readAuthToken(repo);
      const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const mcp = new McpClient({ name: 'phase4-e2e', version: '0.0.0' }, { capabilities: {} });
      await mcp.connect(transport);
      try {
        const transitioned = await mcp.callTool({
          name: 'conductor.transition',
          arguments: { id: created.id, to: 'planned' },
        });
        const tResult = JSON.parse((transitioned.content as { type: string; text: string }[])[0].text);
        expect(tResult.to).toBe('planned');

        // RPC scan confirms the move
        const scan = (await rpc!.call('conductor.scan', {})) as { by_column: { planned: number } };
        expect(scan.by_column.planned).toBe(1);
      } finally {
        await mcp.close();
      }

      // Confirm endpoint files exist
      expect(existsSync(join(repo, '.conductor', 'mcp.endpoint'))).toBe(true);
      expect(existsSync(join(repo, '.conductor', 'daemon.endpoint'))).toBe(true);
      expect(existsSync(join(repo, '.conductor', 'auth.token'))).toBe(true);
    } finally {
      await handle.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run e2e**

Run: `npx vitest run tests/integration/phase4-end-to-end.test.ts`
Expected: 1/1 passing.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: 250/250 across 60 files (249 prior + 1 phase4 e2e).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/phase4-end-to-end.test.ts
git commit -m "test(4.17): Phase 4 end-to-end (daemon + RPC + MCP)"
```

---

### Task 18: README + spec references update

**Files:**
- Modify: `conductor/README.md`

- [ ] **Step 1: Read current README**

Run: `wc -l README.md && head -40 README.md`

Note the structure (section headers + tone).

- [ ] **Step 2: Add a Phase 4 / Daemon section**

Insert a new section after the existing Phase 3 routing section. Suggested content:

```markdown
## Daemon, MCP, and HTTP/JSON-RPC (Phase 4)

When you start a Conductor daemon, every other surface — the CLI, foreign AI CLIs (Claude Code, Codex, Gemini CLI, OpenCode), and CI scripts — talks to the same engine through one of two transports.

**Start the daemon:**

```sh
conductor daemon start --port 7180         # foreground, default port
conductor daemon start --port 0 --detach   # random port, background (Phase 4 ships start; full --detach behavior on Windows lands in Phase 5)
conductor daemon status
conductor daemon stop
```

The daemon writes:

- `.conductor/daemon.pid` — process id (gitignored)
- `.conductor/daemon.endpoint` — `http://127.0.0.1:<port>` (gitignored)
- `.conductor/auth.token` — bearer token, rotated every start (gitignored)
- `.conductor/mcp.endpoint` — `http://127.0.0.1:<port>/mcp` (gitignored)

### JSON-RPC at `/rpc`

```sh
curl -X POST http://127.0.0.1:7180/rpc \
  -H "Authorization: Bearer $(cat .conductor/auth.token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"conductor.scan","params":{}}'
```

Method namespace mirrors the MCP tools: `conductor.card_new`, `conductor.card_get`, `conductor.card_list`, `conductor.card_update`, `conductor.transition`, `conductor.scan`, `conductor.order`, `conductor.discover`, `conductor.exercise_new`, `conductor.exercise_file`, `conductor.work_card`, `conductor.work_next`, `conductor.recommend`.

### MCP at `/mcp`

Foreign AI CLIs configure Conductor as an MCP server pointed at `.conductor/mcp.endpoint`. Streamable HTTP transport. Bearer auth. Same tools.

### Deterministic autonomy gates

When a Task Agent advances a card across a column transition, it consults `.conductor/config.yaml` `autonomy.transitions` for the policy:

- `auto` → transitions silently
- `assist` → emits `transition_request` event, halts, surfaces a recommendation (Phase 6 will add the confidence model that may auto-approve assist)
- `manual` → emits `transition_request` event, halts, requires human approval via `conductor transition <id> <to>` or the MCP `conductor.transition` tool

### Run logs

Each Task Agent run writes `.conductor/runs/<run-id>/events.jsonl`. Schema per spec § 14: `{ts, kind, card_id?, op?, payload?}` per line.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(4.18): README — daemon, JSON-RPC, MCP, autonomy gates"
```

---

### Task 19: Phase tag

- [ ] **Step 1: Final sanity**

Run: `npm test && npm run typecheck && git status --short`
Expected: tests green, typecheck clean, working tree clean.

- [ ] **Step 2: Tag**

```bash
git tag phase-4-daemon-mcp-rpc-closed
git tag --list | grep phase-4
```

Expected: `phase-4-daemon-mcp-rpc-closed`.

- [ ] **Step 3: Final close commit (optional)**

```bash
git commit --allow-empty -m "chore(4.19): Phase 4 closed"
```

---

## Self-review

After implementing the plan, re-read it against `2026-05-06-conductor-design1.md` § 8, § 10, § 12 (Phase 4) and confirm:

1. **Daemon process** — Tasks 12+13 ✓
2. **IPC** — JSON-RPC (Task 12) + MCP (Task 14) ✓
3. **File watcher** — Task 15 ✓
4. **Lifecycle state machine + deterministic autonomy gates** — Task 9 (manual blocks, auto fires, assist halts/surfaces) ✓
5. **Task Agent runner (single-agent; max_concurrent_agents=1)** — Tasks 5+6+11 (work_card refuses double-start via runtime) ✓
6. **MCP server with conductor.* tools** — Task 14 ✓
7. **HTTP/JSON-RPC server for non-MCP clients** — Task 12 ✓
8. **Recommendation protocol surfaces decision points to user** — Tasks 5+8+9 (Recommendation events flow through TaskEvent union and JSONL run log; `conductor.recommend` MCP tool exposed for plugins) ✓

Documented divergences:
- MCP transport = Streamable HTTP, not Unix socket / named pipe (Task 14 prelude)
- RuntimeStore = in-memory, not SQLite (Task 2 prelude; Phase 7 hardening item)
- CLI command-by-command RPC switching only lands for `scan` + `card_new` in Phase 4; remaining commands switch in Phase 5 alongside the UI

If a sub-phase test count differs from the plan's predicted count, that's fine — it means the implementer added or merged tests. The phase is closed when:
- All Phase 4 tasks have been completed
- `npm test` is green
- `npm run typecheck` is clean
- `git tag --list | grep phase-4` returns `phase-4-daemon-mcp-rpc-closed`
- README documents the daemon + RPC + MCP surfaces

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-phase-4-daemon-mcp-rpc.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

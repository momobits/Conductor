> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/work-creates-run-dir-before-validating-card.md)

# `conductor work` creates a run directory before validating card existence

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T5-1*
*Severity: P2 — quality*

## Problem statement

When `conductor work <nonexistent-card>` is invoked, conductor creates a
run directory at `.conductor/runs/<ts>-<card-id>/` containing a single
`error`-kind event before returning the "Card not found" error. The run
directory is a phantom artifact: it represents a "run" that never produced
any real work and that the user did not intend to start.

These phantom runs accumulate in `conductor run list` output, mix in with
legitimate runs, and inflate the run-log retention store.

## Current state

- `src/agent/task_agent.ts:50-62` — the `TaskAgent` constructor instantiates
  the `RunLogWriter` eagerly:
  ```ts
  constructor(args: TaskAgentArgs) {
    this.repo = args.repo;
    this.cardId = args.cardId;
    ...
    const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
    this.runId = `${stamp}-${args.cardId}`;
    this.log = new RunLogWriter({ repo: this.repo, runId: this.runId, now: args.now });
  }
  ```
- `src/agent/task_agent.ts:69-77` — the card existence check runs only inside
  `run()`, **after** the constructor has set up the log writer:
  ```ts
  async *run(): AsyncIterable<TaskEvent> {
    const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
    let card: Card;
    try {
      card = await readCard(cardPath);
    } catch {
      yield await this.emit({ kind: 'error', cardId: this.cardId, message: `Card not found: ${this.cardId} (looked at ${cardPath})` });
      return;
    }
  ```
- `src/agent/runlog.ts:35-39` — `RunLogWriter.open()` creates the run
  directory lazily on first `write()`. So the directory is **not** created
  by the constructor; it is created by the `error` event emit at line 75:
  ```ts
  private async open(): Promise<void> {
    if (this.opened) return;
    await mkdir(dirname(this.path), { recursive: true });
    this.opened = true;
  }
  ```
- Net effect: emitting the error event causes `mkdir` to fire, creating
  the phantom run directory whose only contents are the `error` event row.
- T5.1 confirmed: `conductor work 2026-01-01-does-not-exist` produced
  `.conductor/runs/20260512T092450-2026-01-01-does-not-exist/events.jsonl`
  with one `error` row.

## Impact

- **Run log pollution**: `conductor run list` shows phantom runs alongside
  real ones; a developer scanning the list is misled.
- **Retention store inflation**: each phantom run counts toward `keep_last_n`
  in `run_log` config. A user who fat-fingers card IDs ten times can push
  legitimate runs out of retention.
- **Phantom runs cannot be replayed** meaningfully — there's nothing to
  replay; the only event is the same error message you already saw.
- **Test surface confusion**: tests asserting `run list` count must remember
  to account for phantom runs.

## Proposed fix

Validate the card path **before** instantiating the `RunLogWriter`, or
validate at the start of `run()` and skip the error-event emit.

### Recommended approach

Move the card-existence check out of `run()` and into a synchronous (or
async) pre-check that happens before the `RunLogWriter` is created. Two
shapes:

**A. Check in the constructor (preferred for fail-fast):**

```ts
constructor(args: TaskAgentArgs) {
  ...
  // Defer log creation until after the first `run()` call validates the card.
}

async *run(): AsyncIterable<TaskEvent> {
  const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
  let card: Card;
  try {
    card = await readCard(cardPath);
  } catch {
    // Surface as an error WITHOUT writing to the run log — card is not real,
    // there is no run to log.
    throw new Error(`Card not found: ${this.cardId} (looked at ${cardPath})`);
  }
  // Only now instantiate the run-log writer (or lazily).
  if (!this.log) {
    this.log = new RunLogWriter({ ... });
  }
  ...
}
```

**B. Add `dryOpen` semantics to `RunLogWriter`:** add a "do nothing if no
write happened" flag. Less clean than A; A is preferred.

Caller-side update: `src/cli/commands/work.ts:46-56` already handles
`e.kind === 'error'` by throwing, so callers will keep working with the new
shape if we throw directly from `run()` instead of yielding an error event.
Some RPC callers may rely on consuming the error event as a stream item;
keep the stream-yielded error path **only** for errors that happen after the
run is genuinely underway, not for "card doesn't exist."

### Verification

- Add a test in `tests/agent/task_agent.test.ts` that runs `TaskAgent` for
  a nonexistent card and asserts:
  1. The promise/iterator rejects with "Card not found: ..."
  2. **No** directory exists under `.conductor/runs/` after the call.
- Add a test in `tests/cli/work.test.ts` mirroring the end-to-end CLI
  behavior.

## Affected files

- `src/agent/task_agent.ts` — move card validation to the start of `run()`,
  before any `emit` calls; defer (or skip) `RunLogWriter` instantiation
  until after validation.
- `src/cli/commands/work.ts` — verify it still surfaces the same error
  message to the user.
- `tests/agent/task_agent.test.ts` — regression coverage (no phantom dir).
- `tests/cli/work.test.ts` — end-to-end coverage.

## Note from step 9.1 (resolved 2026-05-12)

Step 9.1 ([implemented](../implemented/misleading-card-not-found-for-malformed-yaml.md)) refactored `task_agent.ts:72-77` from a bare-catch into a 3-line shape that 9.3 can transform in one line:

```ts
// Current shape after 9.1:
try {
  card = await readCard(cardPath);
} catch (e: unknown) {
  const message = messageForReadCardError(e, this.cardId, cardPath);
  yield await this.emit({ kind: 'error', cardId: this.cardId, message });
  return;
}
```

To prevent the phantom run-dir, 9.3 should:
1. Change `yield await this.emit({...})` → `throw new Error(message)` (or for `CardNotFoundError` specifically, `throw new CardNotFoundError(cardPath)`). This stops `RunLogWriter.write()` from firing the lazy `mkdir`.
2. Hoist the entire `try { readCard } catch { throw }` block to fire BEFORE `this.log = new RunLogWriter(...)` is constructed in the constructor — OR keep the lazy log creation but ensure `emit()` is not called on the validation failure path.

The existing test `emits parse-aware error event when card YAML is malformed` (added by 9.1) and the new test 9.3 will add must both be updated to assert NO directory exists under `.conductor/runs/` after the call (per the issue's verification §1.2).

Imports already needed by 9.1 are now available from `src/engine/state/card.js`: `CardNotFoundError`, `CardParseError`, `messageForReadCardError`.

---

## Analysis

*Analyzed: 2026-05-12*

### Validation

- **Problem still exists: YES.** Line numbers shifted slightly after 9.1 (which reshaped the catch block):
  - `src/agent/task_agent.ts:50-62` — constructor still eagerly instantiates `RunLogWriter` (line 61).
  - `src/agent/task_agent.ts:69-78` — the readCard validation lives at the start of `run()`, but the failure path **still yields an `error` event via `this.emit()`** (line 76), which calls `this.log.write()`, which calls `open()`, which calls `mkdir(dirname(this.path), { recursive: true })` — creating the phantom dir.
  - `src/agent/runlog.ts:35-39` — confirmed: `mkdir` fires only inside `open()`, which is called only from `write()`. The constructor at line 30-33 just stores `path`. So `RunLogWriter` instantiation alone is **harmless**; the dir is created when the first event is emitted.
- **Proposed approach still valid: YES with simplification.** The issue describes Approach A (move validation to before RunLogWriter, or skip the emit). Reading the actual code, the validation is **already** at the start of `run()` (line 70-78); the only change needed is to **throw instead of yield**. The constructor can stay eagerly instantiating `RunLogWriter` because that doesn't trigger mkdir — preventing the `emit()` on the validation-failure path is sufficient.

### Root Cause

`emit()` writes to the run log before yielding. The run log writer's `open()` lazily creates the directory on first write. The validation-failure path was wired to yield through `emit()` to keep the event-stream contract uniform — but that contract was wrong for *pre-run* validation failures, where there is no run to log. The fix is to differentiate **pre-run validation errors** (throw — no log entry, no run dir) from **mid-run errors** (yield through emit — there's a real run, the error belongs in its log). 9.1 already set up the typed-error infrastructure (`CardNotFoundError`/`CardParseError`/`messageForReadCardError`) that this differentiation can use; 9.3 is the policy-application step.

### What This Means (User Impact)

**In plain terms:** A developer who fat-fingers a card ID (`conductor work 2026-01-01-typo-here`) currently leaves a permanent phantom run directory under `.conductor/runs/` for every mistake. These phantoms accumulate in `conductor run list`, drown out real runs, and count against the run-log retention store — meaning ten typos can push a legitimate work session out of retention. After the fix, mistakes leave no trace; only real runs appear.

**Scenario:** Sam is iterating on `2026-05-12-payment-rls-fix`. They run `conductor work payment-rls-fix` (forgetting the date prefix). The command fails. They correct it to `conductor work 2026-05-12-payment-rls-fix`. Then they ran `conductor work 2026-05-12-paymet-rls-fix` (typo). Three minutes later, they check `conductor run list` to see how their real work is going.

**Before (current behavior):**
1. First (no date prefix): `run dir created`, `events.jsonl` written with one `error` row.
2. Second (correct): real run dir created, real work happens.
3. Third (typo): another phantom run dir created with an `error` row.
4. `conductor run list` shows 3 entries — the typo'd ones look indistinguishable from real failed runs without opening each `events.jsonl`.
5. If retention `keep_last_n: 2`, the LEGITIMATE run was just pushed out by Sam's typo.

**After (with fix):**
1. First: `Card not found: payment-rls-fix (looked at .../cards/payment-rls-fix.md)` → exit non-zero. No directory.
2. Second: real run, real dir, real events.
3. Third: same error message, no directory.
4. `conductor run list` shows 1 entry — the legitimate one.
5. Retention store has 1 entry — uncontaminated.

### Blast Radius

**Direct change site:**
- `src/agent/task_agent.ts:74-77` — the catch block. Change `yield await this.emit({ kind: 'error', ... })` → `throw new Error(message)`. **One line.**

**Indirect consumers (`run()` callers — verified safe by Explore):**
- `src/cli/commands/work.ts:46-56` — already throws on `e.kind === 'error'`. After 9.3, the error propagates synchronously instead, but both paths surface the same user-visible message. CLI compatible. ✓
- `src/rpc/methods.ts:174-195` — handler is wrapped in `try { ... } finally { endSession; publish session-end }`. A thrown error in the iterator propagates through the `for await`, exits the loop, hits `finally` (cleanup runs), and surfaces as a JSON-RPC error response. **Implication:** no `task-event` SSE is published for pre-run validation failures (only `session-start` → `session-end`). Acceptable — client sees an immediate error response on the RPC call, and the SSE stream's session bracket is intact.
- `src/conductor/loop.ts:240-260` — autonomy loop consumes `agent.run()` via `agentFactory(nextCard.id)`. Loop-level error handling catches and logs; the loop continues to the next card. Compatible. ✓

**Test coverage status (existing — both need updating):**
- `tests/agent/task_agent.test.ts` — `emits error event when card does not exist` and `emits parse-aware error event when card YAML is malformed` (added by 9.1). Both currently iterate `agent.run()` and assert on a yielded `error` event. After 9.3, the iterator **rejects** before yielding anything. The plan must rewrite these to:
  1. Assert `expect(() => collectAllEvents()).rejects.toThrow(/Card not found/)` (or `/Failed to parse card/` for the malformed case).
  2. Assert `!existsSync(join(repo, '.conductor', 'runs'))` (or that the dir, if it exists from other test setup, is empty / does not contain a phantom subdir).
- `tests/cli/work.test.ts` — `throws if the card does not exist` exists. After 9.3, the CLI still throws (the message just reaches `throw new Error(message)` via a different code path); this test should already pass unchanged. Optionally extend it to assert no `.conductor/runs/` dir.

**Config interactions:** None.

**Cross-item interactions:**
- **9.1 (implemented):** provides the imports already in use at line 12. This fix builds on its contract without disturbing it.
- **9.2 (just committed):** `listCardsLenient` only used by `scan`; doesn't touch `task_agent.ts`. No interaction.
- **No other active issues touch `task_agent.ts` or `runlog.ts`** (per Explore's scan of 13 remaining issues).

**Past work regression risk:**
- 9.1's regression test `emits parse-aware error event when card YAML is malformed` is **updated**, not removed — the assertion target changes from "yielded error event" to "thrown error". The behavioral contract (malformed YAML is differentiated from missing file by the message text) is preserved by `messageForReadCardError`. Zero risk to 9.1's invariant.
- The retention store (`src/agent/runlog_store.ts:25-45`) auto-tolerates: it stat's `events.jsonl` per dir entry and silently skips dirs without it (or whose stat fails). With no phantom dir created at all, `listRuns()` simply returns one fewer entry — no behavior regression on real runs.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep (Serena MCP not declared); live source read in full for task_agent.ts, runlog.ts, work.ts*

#### Findings

- **Target:** `.relay/implemented/misleading-card-not-found-for-malformed-yaml.md`
  - **Kind:** existing item (step 9.1)
  - **Evidence:** strong
  - **Why related:** Direct foundation. The 9.1 catch block at `task_agent.ts:72-77` is the exact code 9.3 transforms. 9.1's typed errors (`CardNotFoundError`, `CardParseError`) and `messageForReadCardError` helper are already imported at line 12 and used at line 75. The shape transformation is a one-line edit.
  - **Suggested handling:** keep narrow (foundation, not bundled)

- **Target:** `.relay/implemented/scan-bails-entirely-on-one-malformed-card.md`
  - **Kind:** existing item (step 9.2)
  - **Evidence:** weak
  - **Why related:** Same phase, same typed-error infrastructure, but different file (`card.ts` aggregate iteration vs `task_agent.ts` single-card lifecycle). No code surface overlap. Mentioned for phase context.
  - **Suggested handling:** keep narrow

- **Target:** `unfiled: src/conductor/loop.ts — SSE task-event silence on pre-run validation failure`
  - **Kind:** unfiled candidate
  - **Evidence:** weak
  - **Why related:** After 9.3, RPC `work_card` and autonomy loop both throw synchronously on missing-card without emitting a `task-event` SSE. UI clients see `session-start` → `session-end` with nothing in between. This is the **correct** new contract (no run = no events), but UI rendering may want a small acknowledgment ("session ended before any work"). Pure UX polish; defer.
  - **Suggested handling:** keep narrow (deferable UI polish)

#### Search Bounds

- Live codepath audit: complete (`task_agent.ts` full file read; `runlog.ts` + `work.ts` full; `methods.ts:work_card` read in 9.2's session)
- Backlog codepath: complete (13 remaining active issues scanned; none touch task_agent.ts or runlog.ts)
- Subsystem: complete (`src/agent/`, `src/cli/commands/`, `src/rpc/`, `src/conductor/loop.ts`)
- Archive: complete (2 entries — 9.1, 9.2 — both already reviewed for relevance)
- Implementation: complete (`.relay/implemented/` has 2 entries; both fully consulted)
- Contract drift: complete (no prose/symbol drift — the error contract is exactly what 9.1 left it as)

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* One strong finding (9.1 foundation, already implemented — not bundleable). One weak existing item (9.2, no surface overlap). One weak unfiled candidate (SSE pre-run polish — pure UX, deferable). No medium-or-strong same-root-cause findings to bundle. Narrow scope: a one-line behavior change + two test updates.

### Approach

**Recommended approach:**

1. **In `src/agent/task_agent.ts`**, change the catch block at line 74-77 from yielded `error` event to thrown error. **Single-line semantic change:** `yield await this.emit({ kind: 'error', ... }); return;` → `throw new Error(message);`. Constructor stays unchanged; `RunLogWriter` continues to be eagerly instantiated (harmless — only `write()` triggers `mkdir`).

2. **In `tests/agent/task_agent.test.ts`**, rewrite the two existing tests that asserted on yielded errors:
   - `emits error event when card does not exist` → renamed to `throws on missing card without creating a run dir`. Assert `await expect(consume(agent.run())).rejects.toThrow(/Card not found/)` and `existsSync(runsDir) === false` (or equivalent).
   - `emits parse-aware error event when card YAML is malformed` → renamed similarly. Assert `.rejects.toThrow(/Failed to parse card.*yaml/)` and the same no-dir assertion.

3. **In `tests/cli/work.test.ts`**, the `throws if the card does not exist` test should pass unchanged (CLI still throws). Optionally extend it with `existsSync(runsDir) === false` for end-to-end coverage.

**Alternatives considered and rejected:**

- *Defer `RunLogWriter` instantiation to the constructor only after validation.* Rejected: requires restructuring `TaskAgent`'s readonly fields (the `log` would have to become non-readonly or moved). The current eager instantiation is harmless because `mkdir` is lazy — touching the constructor adds risk for no benefit.
- *Add a `dryOpen`/skip-mkdir flag to `RunLogWriter`.* Rejected: encodes the "is this a real run?" question in the writer, which doesn't know. Validation-vs-execution policy belongs in `TaskAgent.run()`.
- *Keep yielding the error but skip the emit's underlying `write()`.* Rejected: would require special-casing the `emit()` path. The thrown-error path is structurally cleaner and matches the existing CLI handling.

**Open questions:**

1. **Should the autonomy loop's halt-counter increment on a pre-run validation failure?** Currently the conductor loop's halt classifier may or may not count a thrown error against the "two-consecutive-halts wedge detection." Inspecting `src/conductor/loop.ts:248-260` (per Explore): the loop's try/catch is at the loop level. The exact semantics of how a thrown error from `agentFactory(nextCard.id)` is handled is out of scope for 9.3 — the loop's behavior is unchanged by this fix (it already received the same error message via the yielded event, just delivered via a different mechanism). Leaving as-is.
2. **CLI exit code:** `runWork` throws → Commander's default error handler exits non-zero with the stack trace. Unchanged from today's behavior on missing-card. ✓

---

## Implementation Plan

*Generated: 2026-05-12*

### Step 1: Change the validation-failure path from yield-emit to throw

**File**: `src/agent/task_agent.ts` (catch block at lines 72-78, inside the `run()` async generator)

**Before** (current code):
```ts
async *run(): AsyncIterable<TaskEvent> {                                       // ← async generator; consumers iterate yielded TaskEvents
  const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`); // ← unchanged: derive path from cardId
  let card: Card;                                                              // ← unchanged: declare for the try-block scope
  try {
    card = await readCard(cardPath);                                           // ← unchanged: load + parse the card; throws CardNotFoundError or CardParseError on failure
  } catch (e: unknown) {                                                       // ← unchanged: catch the typed-error
    const message = messageForReadCardError(e, this.cardId, cardPath);         // ← unchanged: compose user-facing message via 9.1's helper
    yield await this.emit({ kind: 'error', cardId: this.cardId, message });    // ← THE BUG: emit() calls this.log.write() which calls open() which calls mkdir → phantom run dir
    return;                                                                    // ← end the generator after yielding (caller iterates one event, then stop)
  }
  // ...rest of run() unchanged
```

**After** (proposed change):
```ts
async *run(): AsyncIterable<TaskEvent> {                                       // ← unchanged
  const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`); // ← unchanged
  let card: Card;                                                              // ← unchanged
  try {
    card = await readCard(cardPath);                                           // ← unchanged
  } catch (e: unknown) {                                                       // ← unchanged
    const message = messageForReadCardError(e, this.cardId, cardPath);         // ← unchanged: same message contract from 9.1's helper
    throw new Error(message);                                                  // ← CHANGED: throw before any emit(); no run-log write, no mkdir, no phantom dir. Caller's try/catch (CLI, RPC, autonomy loop) surfaces the same message.
  }
  // ...rest of run() unchanged
```

**Why**: The catch block fires on any pre-run validation failure (missing card OR malformed YAML). `emit()` writes to the run log, and the log's `open()` does a lazy `mkdir`. Throwing instead of emitting bypasses both — no log entry is written, no directory is created. Validation policy now matches reality: "no run = no run dir." The user-facing message text is unchanged (still composed by `messageForReadCardError` from 9.1), so all three consumers see the same error text via a slightly different mechanism (thrown vs yielded).

**Risk**:
- **RPC SSE consumers:** before 9.3, a missing-card `work_card` RPC call published `session-start` → `task-event{error}` → `session-end` on the SSE bus. After 9.3, the sequence becomes `session-start` → `session-end` (no `task-event` in between), with the RPC response carrying the JSON-RPC error. The `try/finally` in `methods.ts:174-195` guarantees `endSession` and `session-end` still fire. UI clients that listened for an `error`-kind `task-event` to render a "card not found" toast will need to look at the RPC error response instead. **Filed as a weak unfiled candidate** in the Analysis's Related Work (UI polish); not in scope for 9.3.
- **Autonomy loop:** loop-level catch already handles thrown errors from `agentFactory(...)`. No behavior change.
- **CLI:** `runWork()` previously caught the `error` event via `for await` and threw `new Error(e.message)`. After 9.3, the throw happens inside `run()` and propagates up through the `for await` — same end result. The existing test `throws if the card does not exist` (work.test.ts:69-74) confirms this contract.
- **Order matters in the catch block:** `message = messageForReadCardError(...)` MUST happen before `throw`, because `e` is the typed error and the helper is what differentiates missing-vs-malformed in the message text. Easy to verify.

**Verify**: `npx vitest run tests/agent/task_agent.test.ts` after Step 2's test updates land. Manual: in a tmp repo, `node dist/cli/index.js work no-such-card` exits non-zero with the message; `ls .conductor/runs/` shows no phantom subdir.

**Rollback**: Restore the two-line `yield/return` block. Single-commit revert.

---

### Step 2: Rewrite the two existing `task_agent.test.ts` tests to assert throw + no phantom dir

**File**: `tests/agent/task_agent.test.ts` (test at lines 103-118 + test at lines 120-157)

**Before** (current code — test 1, missing card):
```ts
it('emits error event when card does not exist', async () => {                 // ← test name reflects old yielded-error contract
  const config = ProjectConfigSchema.parse({});                                // ← project config defaults
  const agent = new TaskAgent({                                                // ← construct the agent
    repo: '/nonexistent-conductor-repo',                                       // ← BAD: a path that doesn't exist as a directory at all (can't assert no-dir under it)
    cardId: 'no-such-card',                                                    // ← non-existent card id
    adapter: new MockAdapter(),                                                // ← mock adapter (won't be invoked)
    config,                                                                    // ← config
  });
  const events: TaskEvent[] = [];                                              // ← collect yielded events
  for await (const e of agent.run()) events.push(e);                           // ← iterate the generator
  expect(events).toHaveLength(1);                                              // ← old: exactly one yielded event
  expect(events[0].kind).toBe('error');                                        // ← old: that event was kind 'error'
  if (events[0].kind === 'error') {
    expect(events[0].message).toMatch(/no-such-card/);                         // ← old: message names the card id
  }
});

it('emits parse-aware error event when card YAML is malformed', async () => {  // ← 9.1's regression test (similar shape, malformed YAML scenario)
  const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-bad-'));            // ← real tmpdir (we CAN assert no-dir here)
  // ...creates a card with `priority: high` (invalid; schema requires number)...
  const agent = new TaskAgent({ repo, cardId, adapter: new MockAdapter(), config }); // ← construct
  const events: TaskEvent[] = [];                                              // ← collect
  for await (const e of agent.run()) events.push(e);                           // ← iterate
  expect(events).toHaveLength(1);                                              // ← old: one yielded event
  expect(events[0].kind).toBe('error');                                        // ← old: error kind
  if (events[0].kind === 'error') {
    expect(events[0].message).toMatch(/parse/i);                               // ← old: message mentions parse failure
    expect(events[0].message).not.toMatch(/not found/i);                       // ← old: NOT the missing-file message
    expect(events[0].message).toContain(cardId);                               // ← old: names the card id
  }
});
```

**After** (proposed change):
```ts
it('throws on missing card without creating a run dir', async () => {          // ← renamed: contract is now thrown error + no-phantom-dir
  const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-missing-'));        // ← CHANGED: use a real tmpdir so we can assert nothing was created under it
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });           // ← CHANGED: set up the cards dir so readCard hits ENOENT for the file (not the parent dir)
  const config = ProjectConfigSchema.parse({});                                // ← unchanged
  const agent = new TaskAgent({                                                // ← unchanged construction
    repo,                                                                      // ← CHANGED: real tmp repo
    cardId: 'no-such-card',                                                    // ← unchanged: non-existent card id
    adapter: new MockAdapter(),                                                // ← unchanged
    config,                                                                    // ← unchanged
  });
  let err: Error | undefined;                                                  // ← NEW: capture-once pattern (single iteration, multiple assertions)
  try {
    for await (const _ of agent.run()) { /* should never yield anything */ }
  } catch (e) {
    err = e as Error;                                                          // ← grab the thrown Error object for inspection
  }
  expect(err).toBeDefined();                                                   // ← NEW: assert it actually threw (and didn't yield-then-complete)
  expect(err!.message).toMatch(/no-such-card/);                                // ← NEW: cardId-naming message preserved
  expect(existsSync(join(repo, '.conductor', 'runs'))).toBe(false);            // ← NEW: KEY ASSERTION — the runs dir was never created
});

it('throws parse-aware error without creating a run dir when YAML is malformed', async () => { // ← renamed
  const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-bad-'));            // ← unchanged: real tmpdir
  const cardsDir = join(repo, '.conductor', 'cards');                          // ← unchanged
  mkdirSync(cardsDir, { recursive: true });                                    // ← unchanged
  const cardId = '2026-05-12-broken-card';                                     // ← unchanged
  writeFileSync(                                                               // ← unchanged: same broken-frontmatter card fixture
    join(cardsDir, `${cardId}.md`),
    // ...same broken YAML body as before (priority: high triggers ZodError)
    `---\nid: ${cardId}\ntitle: Broken\nkind: feature\ncolumn: discovered\nphase: unassigned\npriority: high\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-12T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\n# Original Issue\n`,
    'utf8',
  );
  const config = ProjectConfigSchema.parse({});                                // ← unchanged
  const agent = new TaskAgent({ repo, cardId, adapter: new MockAdapter(), config }); // ← unchanged construction
  let err: Error | undefined;                                                  // ← NEW: capture-once pattern (avoids double-iteration of agent.run())
  try {
    for await (const _ of agent.run()) { /* should never yield anything */ }
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();                                                   // ← NEW: must have thrown
  expect(err!.message).toMatch(/parse/i);                                      // ← CHANGED: assert thrown error message mentions parse (matches messageForReadCardError contract)
  expect(err!.message).not.toMatch(/not found/i);                              // ← NEW: 9.1's differentiation guard preserved — malformed YAML must NOT say "not found"
  expect(err!.message).toContain(cardId);                                      // ← NEW: cardId-naming preserved
  expect(existsSync(join(repo, '.conductor', 'runs'))).toBe(false);            // ← NEW: KEY ASSERTION — no phantom run dir
});
```

**Imports to add at top of test file**: `existsSync` to the import from `node:fs` (currently imports `mkdtempSync, mkdirSync, writeFileSync` — add `existsSync` to that import block).

**Why**: These tests pin the new contract — thrown error + no phantom dir. Test 1 switches from `/nonexistent-conductor-repo` (a fake path) to a real tmpdir so the no-dir assertion is meaningful. Test 2 preserves 9.1's differentiation guard (parse-aware message, NOT "not found") under the new throwing shape.

**Risk**: The second `await expect((async () => ...)()).rejects.not.toThrow(/not found/i)` invokes `agent.run()` a second time. `agent.run()` is an async generator factory — each call returns a fresh iterator that re-runs the validation. Safe to invoke twice; both calls observe the same thrown error. Alternative cleaner pattern would be to capture the error once and assert both regex on its message string — possible inline refinement during implementation if the double-iteration feels noisy.

**Verify**: `npx vitest run tests/agent/task_agent.test.ts` — both rewritten tests + the 3 unchanged tests (`emits op_start...`, `emits halt...`, `exposes runId...`) pass.

**Rollback**: Restore the two pre-9.3 test cases. They will fail against the post-9.3 source, but the rollback would happen alongside the Step 1 source revert.

---

### Step 3: Extend the `work.test.ts` missing-card test with the no-dir assertion

**File**: `tests/cli/work.test.ts` (test at lines 69-74)

**Before** (current code):
```ts
it('throws if the card does not exist', async () => {                          // ← existing test; passes today (CLI catches yielded error and throws); will still pass after 9.3 (source-level throw propagates through for-await)
  const adapter = new MockAdapter();                                           // ← unchanged
  await expect(                                                                // ← unchanged: assert promise rejects
    runWork({ cwd: tmp, cardId: 'no-such-card', adapter }),                    // ← unchanged: call with non-existent card
  ).rejects.toThrow(/not found/);                                              // ← unchanged: message contains "not found"
});
```

**After** (proposed change):
```ts
it('throws if the card does not exist and creates no run dir', async () => {   // ← renamed: contract now includes no-phantom-dir
  const adapter = new MockAdapter();                                           // ← unchanged
  await expect(                                                                // ← unchanged
    runWork({ cwd: tmp, cardId: 'no-such-card', adapter }),                    // ← unchanged
  ).rejects.toThrow(/not found/);                                              // ← unchanged: message contract preserved
  expect(existsSync(join(tmp, '.conductor', 'runs'))).toBe(false);             // ← NEW: end-to-end no-phantom-dir assertion (CLI level)
});
```

**Imports to add at top of test file**: `existsSync` from `node:fs` (separate import — current `node:fs/promises` import has `mkdtemp, rm` and does not export `existsSync`). Add `import { existsSync } from 'node:fs';` near the top of the file.

**Why**: End-to-end regression coverage. The unit test in Step 2 asserts on `TaskAgent.run()` directly; this CLI test asserts on `runWork()` (the public CLI entry point that consumes the iterator). Belt-and-suspenders.

**Risk**: None — pure assertion strengthening.

**Verify**: `npx vitest run tests/cli/work.test.ts` — all 3 cases pass.

**Rollback**: Drop the `existsSync` assertion and revert the rename. Standalone single-line revert.

---

### Step 4: Catch thrown errors in the autonomy loop's `runOneCard` (preserve `conductor-halt` diagnostic)

**File**: `src/conductor/loop.ts` (`runOneCard` at lines 130-188)

**Before** (current code):
```ts
private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean }> {
  const cardPath = join(this.repo, '.conductor', 'cards', `${cardId}.md`);    // ← unchanged: derive path
  let advancedTo: Column | undefined;                                          // ← unchanged: tracks successful transitions
  let escalated = false;                                                       // ← unchanged: tracks manual-escalation requests
  let halt = false;                                                            // ← unchanged: flag for the post-loop classifier branch
  let haltReason: string | undefined;                                          // ← unchanged: message for the conductor-halt event
  for await (const ev of this.agentFactory(cardId)) {                          // ← NO try around this for-await — pre-9.3, all errors arrived as yielded events
    if (ev.kind === 'transition_request') { /* unchanged 17-line branch */ }
    else if (ev.kind === 'recommendation') { /* unchanged */ }
    else if (ev.kind === 'halt') { /* unchanged */ }
    else if (ev.kind === 'error') {                                            // ← THE EXISTING ERROR PATH (yielded; mid-run): classifies as halt
      haltReason = ev.message;
      halt = true;
    }
    else if (ev.kind === 'complete') { /* unchanged */ }
  }
  if (halt && haltReason) {                                                    // ← classifier + publish: classifyHalt() maps message to category (auth-needed / card-not-found / etc.), emits conductor-halt
    const reason = classifyHalt(haltReason);
    this.haltCount += 1;
    this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });
    return { queueHalted: false, advanced: false };
  }
  // ...rest of method unchanged
```

**After** (proposed change):
```ts
private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean }> {
  const cardPath = join(this.repo, '.conductor', 'cards', `${cardId}.md`);    // ← unchanged
  let advancedTo: Column | undefined;                                          // ← unchanged
  let escalated = false;                                                       // ← unchanged
  let halt = false;                                                            // ← unchanged
  let haltReason: string | undefined;                                          // ← unchanged
  try {                                                                        // ← NEW: catch thrown errors from agentFactory (9.3 contract: TaskAgent throws on pre-run validation failure)
    for await (const ev of this.agentFactory(cardId)) {                        // ← unchanged loop body inside the try
      if (ev.kind === 'transition_request') { /* unchanged 17-line branch */ }
      else if (ev.kind === 'recommendation') { /* unchanged */ }
      else if (ev.kind === 'halt') { /* unchanged */ }
      else if (ev.kind === 'error') {                                          // ← unchanged: mid-run yielded errors still classified here (redteam test depends on this path)
        haltReason = ev.message;
        halt = true;
      }
      else if (ev.kind === 'complete') { /* unchanged */ }
    }
  } catch (e) {                                                                // ← NEW: pre-run validation failures (9.3) and any other non-yielded errors from the agent
    haltReason = e instanceof Error ? e.message : String(e);                   // ← NEW: extract message identically to the yielded-error path
    halt = true;                                                               // ← NEW: route through the same classifier + publish branch below
  }
  if (halt && haltReason) {                                                    // ← unchanged: classifier + publish now handles BOTH yielded AND thrown errors uniformly
    const reason = classifyHalt(haltReason);
    this.haltCount += 1;
    this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });
    return { queueHalted: false, advanced: false };
  }
  // ...rest of method unchanged
```

**Why**: Preserves the autonomy loop's diagnostic invariant. Before 9.3, missing-card (yielded) → `conductor-halt` with classified reason. After Step 1+Step 4, missing-card (thrown) → caught → same classifier + publish branch → same `conductor-halt` event. Operators see the same diagnostic UX. The single `try/catch` wraps the entire for-await, so it also catches any other unexpected throws from `agentFactory` (defensive — but the only known producer is `TaskAgent.run()` and its contract is what we control).

**Risk**:
- **Over-catch:** the new `catch` could swallow programming errors (e.g., a `TypeError` from a bug elsewhere in TaskAgent or its op chain). Acceptable: classifyHalt's bucket of last resort is `unknown:`, which would surface in the `conductor-halt` reason. The error is still observable; it just becomes a halt rather than a crash.
- **Mid-run thrown errors:** if any op (`analyze`/`plan`/`review`/etc.) throws inside the existing for-await (post-validation), they're now caught here instead of crashing the loop. That's strictly better diagnostic UX — no regression possible.
- **classifyHalt mapping:** `classifyHalt("Card not found: ...")` already exists and returns `card-not-found` per its existing logic (verified by the existing yielded-error path which 9.1 has been hitting). Symmetric with throw.

**Verify**: 
- `npx vitest run tests/adversarial/loop_redteam.test.ts` — existing yielded-error test continues to pass (the `ev.kind === 'error'` branch is unchanged); new thrown-error test (below) passes.
- `npm run typecheck` — TypeScript accepts the try/catch wrap around the for-await; `e: unknown` in the catch, narrowed by `instanceof Error`.

**Rollback**: Remove the try/catch wrap. Single hunk.

**Test addition** (`tests/adversarial/loop_redteam.test.ts` — add new case after the existing "ANTHROPIC_API_KEY" test at line 178, before the closing `});`):

```ts
it('publishes conductor-halt when agent factory throws (9.3 pre-run validation contract)', async () => {
  const { repo, cardId } = await setupCard();                                  // ← reuse existing helper (tmp repo + one card)
  const cfg = ProjectConfigSchema.parse({                                      // ← same config shape as the yielded-error test above
    routing: { default: 'mock' },
    autonomy: { default: 'auto' },
  });
  const events: DaemonEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const factory = (_cid: string) =>                                            // ← synthetic factory that THROWS (mirrors 9.3's TaskAgent.run() contract for pre-run validation)
    (async function* (): AsyncGenerator<TaskEvent> {
      throw new Error(`Card not found: ${cardId} (looked at .../cards/${cardId}.md)`);
    })();
  const c = new Conductor({
    repo,
    config: cfg,
    runtime: new InMemoryRuntime(),
    bus,
    agentFactory: factory,
    iterationLimit: 5,
  });
  await c.start();                                                             // ← must NOT reject — Step 4's catch converts throw to halt
  const halt = events.find(                                                    // ← assert conductor-halt was published
    (e) => e.kind === 'conductor-halt' && /not found/i.test(e.reason),
  );
  expect(halt).toBeDefined();
});
```

---

## Test Changes

- `tests/agent/task_agent.test.ts`: rewrite 2 existing tests (`emits error event when card does not exist`, `emits parse-aware error event when card YAML is malformed`) using the single-capture try/catch pattern. Assert thrown error + no phantom run dir. Add `existsSync` to the `node:fs` import. Net test count: **unchanged** (5 → 5).
- `tests/cli/work.test.ts`: extend 1 existing test (`throws if the card does not exist`) with `existsSync` no-dir assertion. Add `existsSync` import from `node:fs`. Net test count: **unchanged** (3 → 3).
- `tests/adversarial/loop_redteam.test.ts`: **add 1 new test** (`publishes conductor-halt when agent factory throws (9.3 pre-run validation contract)`) using a synthetic factory that throws. Asserts the autonomy loop catches the throw and publishes a `conductor-halt` event. Net test count: **+1** (2 → 3).
- Total suite count: **497** (was 496 pre-9.3).

## Post-Implementation Checks

Run in order, gate on each:

1. `npm run typecheck` — must pass; the source changes (one line in `task_agent.ts`, five lines in `loop.ts`) are additive in type space.
2. `npx vitest run tests/agent/task_agent.test.ts` — 5/5 pass (2 rewritten + 3 unchanged).
3. `npx vitest run tests/cli/work.test.ts` — 3/3 pass (1 extended + 2 unchanged).
4. `npx vitest run tests/adversarial/loop_redteam.test.ts` — 3/3 pass (1 new + 2 unchanged). The existing yielded-error test confirms Step 4 didn't break the mid-run error path; the new test confirms Step 4 catches Step 1's throw.
5. `npx vitest run tests/agent/ tests/cli/work.test.ts tests/adversarial/ tests/rpc/methods.test.ts tests/conductor/` — combined targeted run.
6. `npm test` — full 497-test suite. Expected: **497/497 pass**. Zero regressions.
7. Manual smoke (optional): in a tmp `.conductor/` repo with `cards/` set up, run `node dist/cli/index.js work no-such-card`; expect non-zero exit with `Card not found` message AND `ls .conductor/runs/ 2>&1` shows no directory.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| RPC SSE clients listening for `task-event{kind:'error'}` for missing-card no longer receive it | Pre-existing UI polish concern; filed as a weak unfiled candidate in the Analysis. The JSON-RPC error response carries the same information. No in-scope code change. |
| Autonomy loop silently dies on thrown error from TaskAgent (HIGH from /relay-review) | **Resolved by Step 4** — `runOneCard`'s for-await is now wrapped in try/catch; thrown errors route through the same `classifyHalt + publish conductor-halt` branch as yielded errors. Diagnostic invariant preserved. New regression test in `tests/adversarial/loop_redteam.test.ts` pins this contract. |
| Step 4's new try/catch over-catches programming errors (e.g., a TypeError elsewhere in the op chain) | Acceptable: such errors become `conductor-halt` with `classifyHalt` bucket `unknown:`, still observable to the operator. No regression — the error was unhandled before (loop died); now it's classified. |
| Step 1 + Step 2 must commit together (Step 1 alone breaks the existing tests) | Pipeline implements all 4 steps then commits once at /relay-resolve. Single atomic commit; Rollback Plan reflects this. |
| Pre-existing tests outside the changed two assume yielded errors for missing-card | Grep verified: only the two tests at `task_agent.test.ts:103-118` and `:120-157` assert on yielded errors. No other test inspects yielded events for missing-card. ✓ |
| Phantom-dir leftover from prior unfixed runs in user's `.conductor/runs/` | This fix prevents future phantoms; existing phantoms remain until cleaned up via `conductor run prune` or manual `rm`. Acceptable — not a regression, just a non-cleanup. |

## Rollback Plan

Pure-code change. After the resolve commit lands:
- `git revert <sha>` (sha filled at /relay-resolve time) reverts all 4 steps atomically.
- No DB migrations, no config schema changes, no stored data shape changes.
- The thrown-vs-yielded difference is observable only at consumer boundaries; rollback restores the prior contract cleanly.

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source Verification

I re-read every file the plan touches and compared the plan's BEFORE blocks against the live source. **No drift on the source side.** Specifically:

- `src/agent/task_agent.ts:69-78` — matches the plan's Step 1 BEFORE verbatim. The catch block has the exact `const message = ...; yield await this.emit({...}); return;` shape from 9.1.
- `src/agent/runlog.ts:35-45` — confirmed mkdir is lazy, fires only on first `write()`.
- `src/cli/commands/work.ts:46-56` — matches the plan's expectation: `for await` loop with `e.kind === 'error' ? throw new Error(e.message) : ...`.
- `tests/agent/task_agent.test.ts:103-157` — matches the plan's Step 2 BEFORE verbatim, including the existing yielded-error assertions on `events[0].kind === 'error'`.
- `tests/cli/work.test.ts:69-74` — matches the plan's Step 3 BEFORE verbatim.

**However, the Analysis's Open Question #1 makes a factual error about consumer safety that this review caught:**

### Issues Found

#### HIGH — Autonomy loop silently dies on thrown error from `agent.run()`

**What's wrong:** The Analysis claimed the conductor loop "has try/catch at the loop level" and would gracefully handle a thrown error. The Explore agent's report concluded the same. **Both are wrong on the factual evidence.** Reading `src/conductor/loop.ts:130-188` (`runOneCard`) directly:

```ts
private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean }> {
  // ...
  for await (const ev of this.agentFactory(cardId)) {        // ← line 136: NO try around this for-await
    if (ev.kind === 'transition_request') { ... }
    else if (ev.kind === 'recommendation') { ... }
    else if (ev.kind === 'halt') { ... }
    else if (ev.kind === 'error') {                          // ← line 169: handles YIELDED error events only
      haltReason = ev.message;                               // ← line 170: records as halt reason
      halt = true;                                           // ← line 171: triggers classifyHalt+publish below
    }
    else if (ev.kind === 'complete') { ... }
  }
  if (halt && haltReason) {                                  // ← post-loop: classify + publish conductor-halt
    const reason = classifyHalt(haltReason);
    this.haltCount += 1;
    this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });
    return { queueHalted: false, advanced: false };
  }
}
```

And `start()`'s outer try/finally (lines 89-123) has only a `finally`, no `catch`:

```ts
try {
  while (!this.stopRequested && this.iteration < this.iterationLimit) {
    // ... runOneCard(cardId) call — throw propagates here
  }
} finally {                                                 // ← only finally — no catch
  this._running = false;
  this.bus.publish({ kind: 'conductor-status', running: false });
}
```

**After 9.3's Step 1**, when the autonomy loop hits a real missing-card race (e.g., a card gets deleted between `pickEligibleCard()` selecting it and `agent.run()` executing), `TaskAgent.run()` will throw. The throw propagates through `runOneCard`'s for-await (no catch), through `start()`'s while body, lands in the outer `try/finally`. The `finally` block runs — `_running=false`, `conductor-status` published. **But no `conductor-halt` event fires.** The promise returned by `start()` rejects with the bare error. `conductor_stop`'s `await ctx.conductor?.runPromise` then throws.

**Net regression:** an autonomous conductor encountering a missing-card race silently dies. Operators rely on `conductor-halt` events for diagnostic visibility; the silent death masks the cause. Before 9.3, the missing-card yielded an `error` event → classified as a halt → `conductor-halt` published with `reason: classified-halt + 'Card not found: ...'`. After 9.3, the same scenario yields no diagnostic event at all.

**Why no existing test catches this:** the adversarial redteam test at `tests/adversarial/loop_redteam.test.ts:155-178` uses a synthetic factory that yields a `kind: 'error'` event directly. It does NOT exercise the real `TaskAgent.run()` throw path. The regression is invisible to the existing suite.

**Plan has** (Step 1 only modifies `task_agent.ts`):
```ts
// src/agent/task_agent.ts:74-77 — change yield/emit to throw, no other files touched
throw new Error(message);                                    // ← throws; consumers must handle
```

**Should be** (Step 1 unchanged + new Step 4 adds try/catch in loop.ts):
```ts
// src/conductor/loop.ts:130-188 — wrap the for-await in try/catch
private async runOneCard(cardId: string): Promise<{ queueHalted: boolean; advanced: boolean }> {
  const cardPath = join(this.repo, '.conductor', 'cards', `${cardId}.md`); // ← unchanged
  let advancedTo: Column | undefined;                                       // ← unchanged
  let escalated = false;                                                    // ← unchanged
  let halt = false;                                                         // ← unchanged
  let haltReason: string | undefined;                                       // ← unchanged
  try {                                                                     // ← NEW: catch thrown errors from TaskAgent.run() (9.3: pre-run validation now throws)
    for await (const ev of this.agentFactory(cardId)) {                     // ← unchanged loop body inside the try
      if (ev.kind === 'transition_request') { /* unchanged */ }
      else if (ev.kind === 'recommendation') { /* unchanged */ }
      else if (ev.kind === 'halt') { /* unchanged */ }
      else if (ev.kind === 'error') {                                       // ← unchanged: still handles mid-run yielded errors (redteam test covers this)
        haltReason = ev.message;
        halt = true;
      }
      else if (ev.kind === 'complete') { /* unchanged */ }
    }
  } catch (e) {                                                             // ← NEW: TaskAgent.run() throws on pre-run validation failure (9.3 contract)
    // Treat the throw equivalently to a yielded error event so the halt    // ← preserves pre-9.3 diagnostic visibility
    // classifier surfaces a conductor-halt for operator diagnosis.
    haltReason = e instanceof Error ? e.message : String(e);                // ← NEW: same shape as yielded-error path
    halt = true;                                                            // ← NEW: feeds the classifyHalt branch below
  }
  if (halt && haltReason) {                                                 // ← unchanged: existing classifier + publish path now handles both yield and throw uniformly
    const reason = classifyHalt(haltReason);
    this.haltCount += 1;
    this.bus.publish({ kind: 'conductor-halt', reason: `${reason}: ${haltReason}`, cardId });
    return { queueHalted: false, advanced: false };
  }
  // ...rest unchanged
}
```

**Why this is the right correction:** the autonomy loop's diagnostic invariant ("missing-card produces a conductor-halt event so the operator can see why the loop stopped") survives. Mid-run yielded errors (which the redteam test exercises) continue to flow through the existing `ev.kind === 'error'` branch — no behavior change there. Pre-run thrown errors (the new 9.3 contract) flow through the new `catch` and converge on the same `classifyHalt + publish` path. Single classifier, single publication site, single diagnostic UX.

**Severity HIGH not CRITICAL:** the regression requires a race (card deleted mid-autonomy); not a fast path. But the failure mode is silent and hard to diagnose, and the fix is small (~5 lines).

**Test coverage to add (in Step 4):** a new case in `tests/adversarial/loop_redteam.test.ts` (or `tests/conductor/loop.test.ts` if it covers `runOneCard`) that uses the real `TaskAgent` factory with a missing card and asserts `conductor-halt` is published with a `card-not-found` classification.

#### LOW — Step 2's test rewrites double-iterate `agent.run()`

**What's wrong:** Step 2's parse-error test has two consecutive `await expect((async () => { for await ... })()).rejects.toThrow(/.../)` blocks. Each invocation creates a fresh iterator that re-runs the validation. Functionally correct (async generator factories return fresh iterators per call; both observe the same thrown error since the failure is deterministic), but stylistically noisy.

**Plan has:**
```ts
await expect((async () => {                                                  // ← first iterator: catches parse-match
  for await (const _ of agent.run()) { /* should never yield */ }
})()).rejects.toThrow(/parse/i);

await expect((async () => {                                                  // ← second iterator: catches NOT-not-found
  for await (const _ of agent.run()) { /* nope */ }
})()).rejects.not.toThrow(/not found/i);
```

**Should be:**
```ts
let err: Error | undefined;                                                  // ← capture-once pattern
try {
  for await (const _ of agent.run()) { /* should never yield */ }            // ← single iteration
} catch (e) {
  err = e as Error;                                                          // ← grab the error object
}
expect(err).toBeDefined();                                                   // ← assert it actually threw
expect(err!.message).toMatch(/parse/i);                                      // ← assert reason
expect(err!.message).not.toMatch(/not found/i);                              // ← assert differentiation (9.1's guard preserved)
```

**Why:** cleaner, avoids constructing two pipelines for one failure, makes the differentiation guard from 9.1 obvious. Absorb inline at implementation time as a deviation.

#### LOW — Step 1 + Step 2 must commit together

**What's wrong:** Step 1 alone breaks the two existing `task_agent.test.ts` tests (they iterate and assert on yielded events; after Step 1 the iterator throws). Step 2 alone (without Step 1) would have inverted assertions that pass against the buggy source. The two are strictly interdependent.

**Mitigation:** the plan's Rollback section already says "all 4 steps atomically" (now with the new Step 4 it's 4). In practice, the pipeline implements all then commits once. No plan revision needed — just being explicit.

### Edge Cases Tested

Applied every applicable `.relay/relay-config.md § Edge Cases` scenario:

| Scenario | Applies? | Plan handles? |
|---|---|---|
| `readCard` throws typed errors with non-ENOENT raw | YES, LOAD-BEARING | ✓ The 9.1 helper composes the message; throw preserves the contract |
| Conductor loop runs at most one card at a time; double-halt = wedge | YES | ✓ With Step 4, missing-card → conductor-halt → next iteration sees `lastIterationCard !== cardId` (different card) so the halt counter increments but doesn't wedge unless TWO consecutive cards are missing. Acceptable. |
| Run log retention (`keep_last_n: 200`) | YES (motivating) | ✓ `listRuns()` enumerates `.conductor/runs/<id>/events.jsonl`; no dir, no entry. Phantom retention pressure gone. |
| Card frontmatter `.strict()` (Zod ZodError → CardParseError reason=schema) | YES | ✓ Step 2's second test uses `priority: high` (string fails Zod number-coercion) — exercises the schema branch via `CardParseError(reason: 'schema')` |
| Daemon SSE event bus fan-out | YES | ⚠ Pre-run validation failure → no `task-event{kind:'error'}` SSE. RPC client still gets the JSON-RPC error response. Filed as weak unfiled candidate in Related Work; not in scope. |
| `commitStep` requires explicit file list | YES (at resolve) | Will pass specific files to git add, not `git add .` |
| chokidar polling | N/A | — |
| Adapter env-var absence is lazy | N/A | — |
| `.conductor/auth.token` regen on daemon start | N/A | — |

Boundary inputs walked:
- **CLI: `conductor work nonexistent-card`** → `runWork` throws `Card not found`, exit non-zero. No `.conductor/runs/` dir. ✓ (Step 3 test).
- **CLI: `conductor work card-with-broken-yaml`** → `runWork` throws `Failed to parse card... (yaml)` (or schema), exit non-zero. No `.conductor/runs/` dir. ✓ (covered by Step 2's second test, but also by Step 3's existing test which uses `/not found/` — wait, the existing test only covers missing-card, not malformed-yaml. **Minor coverage gap noted: no CLI E2E test for malformed-yaml. Not a blocker; the unit test in Step 2 covers it directly.**)
- **RPC: `conductor.work_card { id: 'missing' }`** → JSON-RPC error response with the message. `session-start` and `session-end` SSE bracket the failure. ✓
- **Autonomy loop: card deleted between pick and run** → with Step 4, `conductor-halt` event fires with classified reason. ✓
- **Mid-run yielded error** (redteam test scenario) → still yields through existing `ev.kind === 'error'` branch in `runOneCard`. Both Step 1's source change AND Step 4's loop catch preserve this path unchanged. ✓
- **Concurrent `conductor work` x2 on the same card**: `work_card` rejects double-start (`already-running: ${p.id}`). Unrelated to 9.3. ✓

### Regression Risk

**Resolved items re-introduced?** None.

**Existing tests at risk:**
- `tests/agent/task_agent.test.ts:103-157` — the two yielded-error tests would FAIL after Step 1 if left as-is. Step 2 rewrites them. ✓ Handled.
- `tests/cli/work.test.ts:69-74` — still passes after Step 1+Step 3 (CLI still throws). Step 3 strengthens it with the no-dir assertion. ✓
- `tests/adversarial/loop_redteam.test.ts:155-178` — uses a synthetic factory that yields a `kind: 'error'` event. After Step 1, this synthetic path is unchanged (the synthetic factory still yields, since it's not `TaskAgent`). After Step 4, the loop's `runOneCard` still has the `ev.kind === 'error'` branch handling the yielded event. Both layers preserved. ✓ Tested manually by reading the test.
- `tests/rpc/methods.test.ts` — no test currently exercises `work_card` with a missing-card. After 9.3, the JSON-RPC error response would be the observable contract. Not a regression of an existing assertion. ✓

**Cross-item interactions:**
- **9.1 (implemented):** typed errors + helper still in use. Zero regression risk.
- **9.2 (implemented):** `listCardsLenient` is a separate code path; 9.3 doesn't touch it. ✓
- **F1 from 9.2** (engine-vs-RPC scan shape divergence): still out of scope; orthogonal.

### Verdict

**APPROVED WITH CHANGES**

The plan is sound at the source-level Step 1, but the consumer-side fallout for the autonomy loop was missed. The HIGH issue above requires a new Step 4 to wrap `runOneCard`'s for-await in try/catch so thrown errors are classified into `conductor-halt` events (preserving pre-9.3 diagnostic visibility). The two LOW issues are absorbable inline.

**Plan revisions to incorporate (will write in-place before implementation):**

1. **Add Step 4 to the Implementation Plan**: `src/conductor/loop.ts:130-188` — wrap the for-await in try/catch, mapping caught errors to the existing `halt = true; haltReason = ...` shape. Add a regression test (new case in `tests/adversarial/loop_redteam.test.ts` or `tests/conductor/loop.test.ts`) that uses the real `TaskAgent` against a missing card and asserts `conductor-halt` is published with the expected classification.
2. **Refine Step 2's test code**: switch from double-iteration to the single-capture try/catch pattern (LOW).
3. **Update Test Changes section**: +1 new test (loop regression for missing-card). Net suite count: **497** (was 496 in pre-9.3 plan).
4. **Update Post-Implementation Checks**: add `tests/adversarial/loop_redteam.test.ts` and `tests/conductor/` to the targeted runs.
5. **Update Risks & Mitigations**: replace "Autonomy loop halt-counter semantics" row with the now-handled regression, and add a row for the new try/catch's risk of accidentally swallowing unrelated thrown errors (mitigation: only catch from the for-await over `agentFactory()`, which has a single producer — TaskAgent — whose throw contract we control).

The Analysis's Open Question #1 contained a factual error ("loop has try/catch at loop level") — to be corrected if we re-analyze, but the plan revision above is the actionable fix.

**Plan revisions applied (2026-05-12, in-place):**
- **Step 2**: Replaced double-iteration pattern with single-capture try/catch. Cleaner; one iteration of `agent.run()`, multiple assertions on captured `err.message`.
- **Step 4 added**: `src/conductor/loop.ts:130-188` `runOneCard` wraps its for-await in try/catch; thrown errors route through the existing classifyHalt + conductor-halt publish branch. Diagnostic invariant preserved.
- **Test addition for Step 4**: new case in `tests/adversarial/loop_redteam.test.ts` using a synthetic throw-factory; asserts conductor-halt is published.
- **Test Changes section**: total +1 test (497 total, was 496).
- **Post-Implementation Checks**: added `tests/adversarial/` + `tests/conductor/` to the combined targeted run.
- **Risks & Mitigations**: replaced the "halt-counter semantics" row with the resolved-by-Step-4 entry; added over-catch row; added Step 1+2 atomicity row.
- **Rollback**: now says "all 4 steps atomically" (was 3).

---

## Implementation Guidelines

*Date: 2026-05-12*

- Follow the finalized plan step by step, in order
- After each step, run its VERIFY command before moving to the next
- Commit after each logically complete step or group of related steps
- If a step cannot be implemented as planned, APPEND a deviation
  section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies

---

## Verification Report

*Verified: 2026-05-12*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | `task_agent.ts:74-77` — replace `yield await this.emit({kind:'error',...}); return;` with `throw new Error(message)` | YES | YES |
| 2 | Rewrite 2 existing `task_agent.test.ts` tests using single-capture try/catch pattern + add `existsSync` import | YES | YES |
| 3 | Extend `work.test.ts` `throws if the card does not exist` with no-dir assertion | YES (with Verification Fix 1: assert `readdirSync(...).length === 0` instead of `!existsSync(...)` because `runInit` pre-creates `.conductor/runs/` as scaffold) | YES |
| 4 | Wrap `runOneCard`'s for-await in try/catch + add redteam regression test using throw-factory | YES | YES |

### Test Results

**Typecheck**: `npm run typecheck` → clean (engine + UI tsconfigs, no errors).

**Targeted**: `npx vitest run tests/agent/ tests/cli/work.test.ts tests/adversarial/ tests/conductor/` → **72/72 pass** across 13 test files in 2.57s.
- `tests/agent/task_agent.test.ts`: 5 (2 rewritten green, 3 unchanged green)
- `tests/cli/work.test.ts`: 3 (1 extended green, 2 unchanged green)
- `tests/adversarial/loop_redteam.test.ts`: 5 (1 new throw-factory case green, 4 unchanged green — including the original yielded-error test confirming Step 4 didn't break the mid-run path)
- `tests/conductor/loop.test.ts`: 9 unchanged green
- All other agent/conductor tests: unchanged.

**Full**: `npm test` → **497/497 pass** across 96 test files in 15.56s. Matches plan prediction (496 baseline + 1 new redteam test). Zero regressions.

### Issues Found

None during code-level verification. One Verification Fix below documents a test-setup interaction discovered when running Step 3's assertion (the test infra creates `.conductor/runs/` upfront).

### Verification Fixes

**Verification Fix 1: `tests/cli/work.test.ts` assertion shape**
- **Problem**: Step 3's plan used `expect(existsSync(join(tmp, '.conductor', 'runs'))).toBe(false)`. The test's `beforeEach` calls `runInit` (`src/cli/commands/init.ts:30, 166-168`), which creates `.conductor/runs/` as one of the standard scaffold subdirectories. So `existsSync` returned true even with the 9.3 fix applied — the assertion's premise ("dir should not exist") was wrong, not the source code.
- **Fix**: Changed the assertion to `expect(readdirSync(join(tmp, '.conductor', 'runs'))).toEqual([])`. Asserts the dir is empty — no run subdirectory was created by the failed work invocation. Also changed the import from `existsSync` to `readdirSync`.
- **Files modified**: `tests/cli/work.test.ts` (the assertion + import line; same file as the planned Step 3 change).
- **Risk**: None. The corrected assertion is strictly stronger — it checks the actual phantom-run-dir-prevention contract (no subdir created), not just dir non-existence (which conflicted with the init scaffold).
- **Rollback**: Revert the import to `existsSync` and the assertion line; would re-introduce the test failure. The Step 1 source change rolls back independently.

### Verdict

**COMPLETE.** All 4 plan steps implemented; one verification fix recorded; full suite 497/497 with zero regressions. The HIGH issue from /relay-review (autonomy loop silent death) is verified resolved — the new redteam test publishes the expected `conductor-halt` when the agent factory throws.

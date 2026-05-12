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

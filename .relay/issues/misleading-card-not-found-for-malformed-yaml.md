# Misleading "Card not found" error when card file exists but has malformed YAML

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T5-3*
*Severity: P1 — bug*

## Problem statement

When a card file exists on disk but has malformed YAML frontmatter, both
`conductor work <id>` and `conductor transition <id> <col>` return the
message `Card not found: <id> (looked at <path>)`. The file is at exactly
the path the error message names — but the error tells the user it doesn't
exist.

A developer reading this error will check the path (file is there), check
permissions (fine), and then have no diagnostic signal pointing at the
actual problem (the YAML is corrupt).

The fix is to differentiate ENOENT from "exists but parse failed" in both
callers.

## Current state

- `src/agent/task_agent.ts:72-77` (called by `conductor work`):
  ```ts
  let card: Card;
  try {
    card = await readCard(cardPath);
  } catch {
    yield await this.emit({ kind: 'error', cardId: this.cardId, message: `Card not found: ${this.cardId} (looked at ${cardPath})` });
    return;
  }
  ```
  The bare `catch` swallows **any** error from `readCard` — including YAML
  parse errors, Zod validation errors, schema-strictness rejections — and
  surfaces them all as "Card not found."
- `src/cli/commands/transition.ts:24-29` — identical anti-pattern in the
  transition command:
  ```ts
  let card;
  try {
    card = await readCard(cardPath);
  } catch {
    throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);
  }
  ```
- `src/engine/state/card.ts:35-44` — `readCard()` differentiates internally
  but doesn't expose the distinction to callers via typed errors:
  ```ts
  export async function readCard(path: string): Promise<Card> {
    const text = await readFile(path, 'utf8');         // throws ENOENT
    const parsed = matter(text);                       // throws on YAML
    const frontmatter = CardFrontmatterSchema.parse(...); // throws on Zod
    ...
  }
  ```
- T5.4 dogfood confirmed: `conductor work broken-card` (file exists,
  malformed YAML) returned `Card not found: broken-card` — the file was
  visibly present at the exact path named.

## Impact

- **Diagnosis is sabotaged**: the user is told the wrong thing about the
  state of their filesystem.
- **Combines with T5-2**: if `scan` is broken by the same card (per T5-2),
  the user has zero ability to navigate to or identify the broken file.
- **Affects every read-side card command**: `work` and `transition` are
  confirmed; also `card get`, RPC `conductor.card_get`, MCP `card_get` tool.
- **Trust damage**: error messages that lie are worse than error messages
  that are noisy.

## Proposed fix

Differentiate file-not-found from parse failure at the `readCard` call
sites. Two complementary changes:

### Change 1 — distinguish errors in callers

In both `src/agent/task_agent.ts` and `src/cli/commands/transition.ts`,
inspect the caught error:

```ts
let card: Card;
try {
  card = await readCard(cardPath);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') {
    throw new Error(`Card not found: ${cardId} (looked at ${cardPath})`);
  }
  throw new Error(`Failed to parse card: ${cardId} (${cardPath}): ${err.message}`);
}
```

The TaskAgent path (`agent/task_agent.ts:74-77`) uses a yielded error event
rather than throw — keep that shape but differentiate the message similarly.

### Change 2 — surface the distinction at the source

Optionally introduce typed errors in `readCard`:

```ts
export class CardNotFoundError extends Error {
  constructor(public readonly path: string) { super(`Card file not found: ${path}`); }
}
export class CardParseError extends Error {
  constructor(public readonly path: string, public readonly inner: Error) {
    super(`Card parse failed: ${path}: ${inner.message}`);
  }
}
```

`readCard()` catches the `node:fs/promises` ENOENT and the `gray-matter` /
Zod throws, wrapping each in the appropriate typed error. Callers can then
`instanceof`-check instead of inspecting `.code`. Cleaner long-term, but
Change 1 alone is sufficient to close the user-visible bug.

### Verification

- Regression test in `tests/agent/task_agent.test.ts`: drop a broken-YAML
  card, invoke `TaskAgent.run()`, assert the surfaced error contains "parse"
  (or "YAML") rather than "not found."
- Regression test in `tests/cli/transition.test.ts`: same for the
  transition path.
- Existing tests for ENOENT-on-missing-file should remain green.

## Affected files

- `src/agent/task_agent.ts` — differentiate ENOENT vs parse error at the
  card-read site.
- `src/cli/commands/transition.ts` — same change in the catch block.
- `src/engine/state/card.ts` (optional) — typed errors `CardNotFoundError`
  / `CardParseError`.
- `src/rpc/methods.ts` — `card_get`, `card_list` paths should propagate
  the distinct error messages.
- `tests/agent/task_agent.test.ts`, `tests/cli/transition.test.ts`,
  `tests/engine/state/card.test.ts` — regression coverage.

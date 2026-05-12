# `conductor scan` bails entirely when one card has malformed YAML — hides all healthy cards

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T5-2*
*Severity: P1 — bug*

## Problem statement

When a single card in `.conductor/cards/` has malformed YAML frontmatter,
`conductor scan` exits non-zero with the raw YAML parse error and lists
**zero cards** — including healthy cards that parse cleanly. One accidentally
corrupted card silently silences the entire board view.

This is a meaningful UX regression: a single bad file removes the developer's
ability to see any of their work queue. They cannot list cards, cannot
identify which file is broken (other than the YAML error's filename hint),
and cannot proceed without manually triaging.

The fix is to catch parse errors per-file inside `listCards()` and continue.

## Current state

- `src/engine/ops/scan.ts:16` — `scan()` calls `await listCards(...)` and
  has no try/catch:
  ```ts
  const cards = await listCards(join(args.repo, '.conductor', 'cards'));
  ```
- `src/engine/state/card.ts:54-68` — `listCards()` loops over `.md` files
  and calls `await readCard(...)` for each. If any `readCard` throws,
  `listCards` propagates the throw and stops iterating:
  ```ts
  for (const name of mdFiles) {
    out.push(await readCard(join(cardsDir, name)));
  }
  return out;
  ```
- `src/engine/state/card.ts:35-44` — `readCard` calls
  `CardFrontmatterSchema.parse(...)`, which throws on YAML/Zod failure.
- T5.4 dogfood — `broken-card.md` with `this is not yaml` in frontmatter
  caused `conductor scan` to exit 1 with the raw YAML message and zero
  cards listed; the healthy `2026-05-12-health-check-endpoint` was hidden.

## Impact

- **Severity is real**: one broken card breaks the central observability
  command. A developer cannot navigate their board, cannot triage, cannot
  see WIP.
- **Compounds with other bugs**: T5-3 (misleading "Card not found" for
  malformed YAML) means the broken card is hard to identify in the first
  place. Together, the user is stuck.
- **Affects RPC and MCP surfaces too**: `scan` is exposed via
  `conductor.scan` RPC method (`src/rpc/methods.ts`). UI clients and MCP
  clients that depend on `scan` get the same failure.
- **Daemon-mode scan**: when the daemon is up, `runScan()` delegates to
  `conductor.scan` RPC (per `src/cli/commands/scan.ts:16-19`). Both paths
  hit the same `listCards` throw.

## Proposed fix

Catch YAML/Zod parse errors per-file in `listCards`, log a warning, and
continue.

### Recommended shape

```ts
// src/engine/state/card.ts
export async function listCards(cardsDir: string): Promise<{ cards: Card[]; errors: Array<{ path: string; message: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(cardsDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { cards: [], errors: [] };
    throw e;
  }
  const mdFiles = entries.filter((n) => n.endsWith('.md')).sort();
  const cards: Card[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  for (const name of mdFiles) {
    const fullPath = join(cardsDir, name);
    try {
      cards.push(await readCard(fullPath));
    } catch (e) {
      errors.push({ path: fullPath, message: (e as Error).message });
    }
  }
  return { cards, errors };
}
```

Changing the return shape would break callers, so an alternative is to add
a second `listCardsLenient` function that returns the new shape, and keep
`listCards` strict — then route `scan` through `listCardsLenient`.

Then in `src/engine/ops/scan.ts`, attach the errors to the returned
`Status` (extend the type with an optional `errors` field) so the CLI can
surface them as warnings without bailing.

In `src/cli/commands/scan.ts:23-38`, render the warnings before the column
listing:
```ts
if (status.errors && status.errors.length > 0) {
  for (const err of status.errors) {
    process.stderr.write(`[warn] ${err.path}: ${err.message}\n`);
  }
}
// then loop over COLUMNS as today
```

Exit code should be **0** if at least some cards parsed (partial success);
**1** only if no cards loaded at all. This matches the dogfood expectation:
*"scan lists all valid cards, reports a warning for any malformed card,
and exits 0."*

### Verification

- Add a regression test in `tests/engine/state/card.test.ts` for the new
  `listCards` shape: drop a broken-YAML card alongside good ones, assert
  the good cards are returned and an error entry names the broken card.
- Add a CLI test in `tests/cli/scan.test.ts` for the warning-then-list
  flow.
- Add an end-to-end test that includes a broken card and asserts
  `runScan()` exit code is 0 and includes the healthy cards in the result.

## Affected files

- `src/engine/state/card.ts` — extend `listCards()` (or add a lenient
  variant).
- `src/engine/types.ts` — extend the `Status` interface with optional
  `errors` field.
- `src/engine/ops/scan.ts` — propagate errors through to the `Status`.
- `src/cli/commands/scan.ts` — render warnings to stderr; exit 0 on
  partial success.
- `src/rpc/methods.ts` — ensure `conductor.scan` returns the new shape to
  RPC clients.
- `src/ui/views/*` — the UI's Board view may need to render warnings; check
  consumers.
- `tests/engine/state/card.test.ts`, `tests/cli/scan.test.ts`,
  `tests/engine/ops/scan.test.ts` — regression coverage.

# Misleading "Card not found" error when card file exists but has malformed YAML

## Summary

*Resolved: 2026-05-12*

- **Problem:** `conductor work <id>` and `conductor transition <id> <col>` reported `Card not found: <id> (looked at <path>)` when the card file existed at the named path but had malformed YAML frontmatter or a Zod schema violation. The bare-catch blocks conflated three distinct exception classes (Node `ErrnoException`, gray-matter/js-yaml `YAMLException`, Zod `ZodError`) as one untyped failure surface, sending developers on multi-minute hunts for filesystem / permission / daemon-cache problems before they noticed the YAML issue.
- **Resolution:** Introduced typed errors `CardNotFoundError` and `CardParseError` (with a `reason: 'yaml' | 'schema'` discriminator) in `src/engine/state/card.ts`. `readCard()` now wraps its three throw sites in two `try` blocks — a narrow read-`try` that translates only ENOENT to `CardNotFoundError` (non-ENOENT I/O errors propagate raw), and a broad parse-`try` that wraps both `YAMLException` and `ZodError` into `CardParseError`. A single exported helper `messageForReadCardError(err, cardId, cardPath)` centralizes the user-facing message contract, used at both CLI/agent call sites. A `truncate(s, 500)` private helper caps inner-cause messages to prevent log-bloat from giant gray-matter/Zod error strings.

## Files Modified

- `src/engine/state/card.ts` — added `CardNotFoundError`, `CardParseError`, `truncate()` private helper, `messageForReadCardError()` exported helper, and `ZodError` value-import; rewrote `readCard()` body with two-try-block split. Success-path return literal `{ frontmatter, body: parsed.content, path }` preserved byte-for-byte. `normalizeDates`, `writeCard`, `listCards`, `appendSection`, `extractSection`, `createCard` unchanged.
- `src/cli/commands/transition.ts` — extended `readCard`/`writeCard` import to include `messageForReadCardError`; replaced bare catch in `runTransition()` with `catch (e: unknown) { throw new Error(messageForReadCardError(e, args.cardId, cardPath)); }`. Surrounding `canTransition` + `writeCard` logic untouched.
- `src/agent/task_agent.ts` — extended import to include `messageForReadCardError`; replaced bare catch in `TaskAgent.run()` (lines 72-77) with `catch (e: unknown) { const message = messageForReadCardError(e, this.cardId, cardPath); yield await this.emit({ kind: 'error', cardId: this.cardId, message }); return; }`. Other 7 `readCard()` call sites within the file deliberately unchanged (out of locked scope).
- `tests/engine/state/card.test.ts` — extended import to include the three new exports; tightened `rejects malformed frontmatter` to `toBeInstanceOf(CardParseError)` + `/parse/i` + negative-class guard; added 5 new tests inside `describe('readCard')` covering ENOENT-typed throw, YAML-syntax `reason='yaml'` path, log-bloat cap, EISDIR rethrow; added two new top-level describe blocks — `describe('readCard schema-violation boundary cases')` with 4-row `it.each` table covering empty file / empty frontmatter / wrong type / unknown field, and `describe('messageForReadCardError')` with 3 unit-test cases for each helper branch.
- `tests/cli/transition.test.ts` — added `writeFile` to `node:fs/promises` import; added new test `throws a parse-aware message for malformed YAML (not "not found")` using the existing `beforeEach`-created card.
- `tests/agent/task_agent.test.ts` — added new test `emits parse-aware error event when card YAML is malformed` using Riley's literal `priority: high` fixture (a Zod schema violation, not a YAML syntax error) via sync fs APIs consistent with the file's existing convention.

## Verification

- `npm run typecheck` — clean (both engine `tsconfig.json` and UI `tsconfig.ui.json`).
- `npm test` — **488/488 tests pass across 96 test files** in 15.15s. Zero regressions.
- Targeted runs:
  - `npx vitest run tests/engine/state/card.test.ts` → 18/18 (was 7; +11 net).
  - `npx vitest run tests/cli/transition.test.ts` → 4/4 (was 3; +1 net).
  - `npx vitest run tests/agent/task_agent.test.ts` → 5/5 (was 4; +1 net).

## Caveats

- **Scope-locked at `keep narrow` by /relay-analyze.** Step 9.1 fixes only the two cited CLI/agent call sites and introduces the typed-error abstraction. Six other `readCard()` call sites continue to propagate the new typed errors raw to their consumers — strictly more informative than the old raw `YAMLException`/`ZodError`/`ErrnoException`, but still not differentiated at the user-facing layer:
  - `src/rpc/methods.ts:71` (`card_get`), `:85` (`card_update`), `:99` (RPC `transition`), `:247` (`chat`) — HTTP/MCP clients see the typed-error message; no RPC error-code mapping yet.
  - `src/conductor/loop.ts:157` — autonomy loop would crash on a malformed card mid-run instead of treating it as wedged.
  - `src/engine/ops/chat.ts:60` — stale-body re-read race window.
  These are tracked in the issue's Related Work findings (#3, #4, #5) as **linked-companion candidates**. File via `/relay-new-issue` if/when needed.

- **Step 9.2 (`scan-bails-entirely-on-one-malformed-card`) depends on this work.** The new typed errors are exported and ready for consumption by 9.2's lenient-`listCards` design — it should `import { CardParseError } from '../state/card.js'` and use `instanceof CardParseError` to distinguish per-file parse failures from unknown errors that should rethrow.

- **Step 9.3 (`work-creates-run-dir-before-validating-card`) depends on this work.** The TaskAgent catch block in `task_agent.ts:72-77` is now a 3-line shape (`const message = ...; yield emit({...}); return;`) — 9.3 can change the `yield emit` to `throw new Error(message)` in one line and hoist the entire try/catch above the `RunLogWriter` instantiation, preventing the phantom run-dir side effect.

- **Phantom run-dir side effect** still present (step 9.3 owns it). The new `tests/agent/task_agent.test.ts` `emits parse-aware error event when card YAML is malformed` creates a phantom `.conductor/runs/<ts>-<id>/` directory in its tmp repo as a side effect — consistent with the existing `emits error event when card does not exist` test. Both will be closed by step 9.3. No `afterEach` cleanup needed (tmp dirs garbage-collected by OS).

- **`let card;` in `transition.ts` left as implicit-any.** Type-safety upgrade opportunity flagged in the Adversarial Review as out-of-scope for 9.1.

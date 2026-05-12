> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/misleading-card-not-found-for-malformed-yaml.md)

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

---

## Analysis

*Analyzed: 2026-05-12*

### Validation
- **Problem still exists: YES.** Verified against current source at HEAD `485944d`.
  - `src/engine/state/card.ts:35-44` — `readCard()` is exactly as cited. Line 36 `readFile` throws ENOENT; line 37 `matter(text)` throws on YAML syntax errors; line 38 `CardFrontmatterSchema.parse(...)` throws on Zod validation. All three throws are unwrapped and propagate to callers.
  - `src/agent/task_agent.ts:72-77` — the bare-catch block is at lines 72-77 (the issue said 74-77; minor drift only). Catches everything, yields `Card not found:` regardless of cause.
  - `src/cli/commands/transition.ts:24-29` — confirmed identical anti-pattern; `catch { throw new Error('Card not found: ...') }`.
- **Proposed approach still valid: YES** with one strengthening recommendation — adopt typed errors (Change 2 in the proposed fix) rather than `instanceof NodeJS.ErrnoException` `.code === 'ENOENT'` checks. Typed errors are cleaner, they survive minification/transpilation, and they let other call sites differentiate without re-implementing the inspection logic. See "Approach" below.

### Root Cause
The bad state comes from `readCard()` throwing three different exception types (Node.js `ErrnoException` for ENOENT, `js-yaml/gray-matter` `YAMLException` for syntax, `ZodError` for schema mismatch) **as the same untyped failure surface**. Callers cannot tell them apart cheaply, and at least two callers chose the easiest route: catch-all + a generic "Card not found" string. The result is a lie: the file *is* found; it's broken.

Two related issues — already filed — share this root cause and are bundled into Phase 9 (`relay-ordering.md § Phase 1`):
- `scan-bails-entirely-on-one-malformed-card.md` (P1) — same `readCard()` throw, propagated through `listCards()` to silence the whole board view (step 9.2 of this Control phase).
- `work-creates-run-dir-before-validating-card.md` (P2) — sits on the *same* `task_agent.ts:72-77` bare-catch block (step 9.3 of this Control phase).

### What This Means (User Impact)

**In plain terms:** A developer accidentally edits a card's frontmatter — drops a quote, uses a tab where the YAML parser wants spaces, mistypes a field name. Now when they try to work the card or move it between columns, Conductor tells them the card doesn't exist. The file is sitting at the exact path the error message names, but the system is reporting the wrong thing about reality.

**Scenario:** Riley is mid-day, eight cards on the board, just finished `conductor scan` (it worked — no broken cards yet). They open `2026-05-11-fix-payment-retry.md` in their editor to bump the priority. They change `priority: 1` to `priority: high` (typo — should have been `2`). Save. Run `conductor transition 2026-05-11-fix-payment-retry approved`. Get back:

```
Error: Card not found: 2026-05-11-fix-payment-retry (looked at /repo/.conductor/cards/2026-05-11-fix-payment-retry.md)
```

Riley `ls`'s the path. The file is there. They `cat` it. It has content. They check permissions (fine). They re-save. Same error. They start to suspect the conductor index, maybe a daemon cache, maybe filesystem case sensitivity. Eventually they look at frontmatter and notice `priority: high` is not a number. That diagnosis took 7 minutes of wrong hypotheses. The error message lied to them about which layer was broken.

**Before (current behavior):**
1. Riley introduces a YAML schema violation in card frontmatter.
2. Runs `conductor work` or `conductor transition`.
3. Sees: `Card not found: <id> (looked at <path>)`.
4. Checks the path, file exists. Confused.
5. Spends 5–10 minutes ruling out filesystem, permissions, daemon state.
6. Eventually opens the card file and discovers the YAML problem.

**After (with fix):**
1. Riley introduces a YAML schema violation in card frontmatter.
2. Runs `conductor work` or `conductor transition`.
3. Sees: `Failed to parse card: <id> (<path>): invalid_type — priority must be a number (got "high")` (or similar — exact message depends on whether the throw is gray-matter or Zod).
4. Opens the card, sees the priority field, fixes it. < 30 seconds.

### Blast Radius

**Files affected by the fix:**
- `src/engine/state/card.ts` — add `CardNotFoundError` / `CardParseError`; wrap throws inside `readCard()`. (Optionally also `listCards()` — but step 9.2 owns the `listCards` shape change, so this step should not alter `listCards`.)
- `src/agent/task_agent.ts:69-77` — `run()`'s catch differentiates the two typed errors and emits a parse-aware error event for `CardParseError`. (Step 9.3 will further refactor this block to validate before `emit`; design the catch shape with that in mind.)
- `src/cli/commands/transition.ts:24-29` — replace the bare catch with a typed-error inspection.
- `tests/engine/state/card.test.ts` — extend to assert `CardNotFoundError` for missing file and `CardParseError` for malformed YAML.
- `tests/agent/task_agent.test.ts` — add `broken YAML → error event message mentions parse/YAML, not 'not found'`.
- `tests/cli/transition.test.ts:48` — existing `throws when card not found` test uses `/not found/` and will keep passing for the ENOENT case; add a new `throws with parse-aware message for malformed YAML` test.

**Direct callers of `readCard()` (six in source):**

| File:line | Current error handling | Risk if left as-is |
|-----------|------------------------|---------------------|
| `src/agent/task_agent.ts:73` (target) | bare catch → "Card not found" | the bug |
| `src/cli/commands/transition.ts:26` (target) | bare catch → "Card not found" | the bug |
| `src/rpc/methods.ts:71` (`card_get`) | no try/catch — error propagates raw | RPC clients (HTTP/MCP) get raw `YAMLException` / Zod stack; opaque error UX |
| `src/rpc/methods.ts:85` (`card_update`) | no try/catch | same |
| `src/rpc/methods.ts:99` (RPC `transition`) | no try/catch | second `transition` path — parallel to the CLI bug, surfaces raw JS error |
| `src/rpc/methods.ts:247` (`chat`) | no try/catch | malformed card body kills the chat reply path |
| `src/conductor/loop.ts:157` | no try/catch inside autonomy loop | a malformed card during conductor run would crash the loop instead of being treated as wedged or halted |
| `src/engine/ops/chat.ts:60` | no try/catch on stale-body re-read | race window where body has been re-written mid-call could crash the op |

The two CITED bugs are the loud cases. The other six are **quiet** — they propagate the raw throw instead of lying, but they're still bugs in a downstream sense: RPC clients shouldn't get unstructured JS errors, and the autonomy loop shouldn't crash on a single bad card. **These are unfiled sibling candidates surfaced by the live-codepath audit** (see Related Work).

**Indirect consumers downstream:**
- HTTP/MCP clients of `conductor.card_get` / `conductor.card_update` / `conductor.transition` / `conductor.chat` — see raw JS error if the card is malformed.
- UI views (Board, CardDetail) that consume `card_list` and `card_get` over RPC.
- The autonomy loop in `src/conductor/loop.ts` — would catastrophically halt on a single bad card.

**Test coverage status:**
- `tests/cli/transition.test.ts:48-51` — covers ENOENT path with `/not found/`. Passes today; will still pass after fix.
- `tests/engine/state/card.test.ts:40-…` — has `rejects malformed frontmatter`; existing test will need its expected error type updated to `CardParseError`.
- **No existing test** verifies that ENOENT and parse failure produce *different* messages at any caller. This is the gap step 9.1 must fill.

**Config interactions:** None. The fix is a pure error-handling refactor; no schema, no flag, no env var touched. The card frontmatter schema (`CardFrontmatterSchema`, strict per `relay-config.md`) is *not* changed — `readCard()` still calls it; just wraps its throws.

**Cross-item interactions:**
- **9.2 (`scan-bails-entirely-on-one-malformed-card`)** — depends on this step's typed errors. The lenient `listCards` (or new `listCardsLenient`) should distinguish "skip on `CardParseError`" from "rethrow on unknown error". If 9.1 ships the typed errors first, 9.2's `try/catch` becomes `try { ... } catch (e) { if (e instanceof CardParseError) errors.push(...); else throw e; }`.
- **9.3 (`work-creates-run-dir-before-validating-card`)** — shares the `task_agent.ts:72-77` block. Coordinate the catch shape so 9.3's "validate before mkdir" change doesn't fight 9.1's typed-error differentiation. The clean ordering is: 9.1 lands typed errors + caller differentiation; 9.3 then moves the validation point earlier and switches from `yield emit(error)` to `throw` for the ENOENT case (the run-log mkdir trigger is the `emit`, not the throw).

**Past work regression risk:** `.relay/archive/` and `.relay/implemented/` are both empty (fresh Control framework install on top of pre-Control project history). No archived work touches `readCard()`. Git history shows the most recent meaningful `readCard`-area work was the pre-Control phases — none of them depended on the throw signature being unwrapped, so no regression risk.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for all dimensions (Serena MCP not available in this environment)*

#### Findings

**1. Existing item — `.relay/issues/scan-bails-entirely-on-one-malformed-card.md`**
- **Kind:** existing item (already in Phase 9 as step 9.2)
- **Evidence:** strong
- **Why related:** Shares the exact same root cause (untyped `readCard` throw). Same file (`src/engine/state/card.ts`), and `listCards` at `card.ts:54-68` is itself a consumer of `readCard`. The lenient-listCards shape in 9.2 will need to read `CardParseError` introduced here.
- **Suggested handling:** keep narrow on 9.1; 9.2's plan should `import` and consume the typed errors landed in 9.1.

**2. Existing item — `.relay/issues/work-creates-run-dir-before-validating-card.md`**
- **Kind:** existing item (already in Phase 9 as step 9.3)
- **Evidence:** strong
- **Why related:** Sits on the *same* `task_agent.ts:72-77` catch block. The proposed fix in 9.3 (move validation earlier; throw rather than yield-error) is most cleanly built on top of 9.1's typed errors — 9.3's throw can be `throw new CardNotFoundError(cardPath)` instead of an `Error` with a stringly-typed message.
- **Suggested handling:** keep narrow on 9.1; 9.3's plan should coordinate the catch-shape decision (whether to remove the catch entirely or differentiate inside it).

**3. Unfiled candidate — `src/rpc/methods.ts:71,85,99,247` (RPC readCard sites have no error normalization)**
- **Kind:** unfiled candidate
- **Evidence:** strong (live-codepath audit: four call sites in the same file all share the same gap — readCard throws bubble raw to RPC clients)
- **Why related:** Same root cause (no typed-error contract on `readCard`). When a card has malformed YAML, HTTP/MCP clients calling `card_get`, `card_update`, `transition` (the RPC variant, NOT the CLI variant fixed here), or `chat` get the raw `YAMLException` or Zod error. UI clients render this as an opaque "Internal Server Error" or stack trace fragment. Not the loud bug T5-3 documents, but a parallel bug class.
- **Suggested handling:** file companion. The fix is mechanically the same once typed errors exist — wrap each RPC method's `await readCard(...)` in a try/catch that translates `CardNotFoundError` → 404-ish RPC error and `CardParseError` → 400-ish "card body invalid" RPC error. But the choice of what RPC error code/shape to expose is a small policy decision worth its own issue.

**4. Unfiled candidate — `src/conductor/loop.ts:157` (autonomy loop crashes on malformed card)**
- **Kind:** unfiled candidate
- **Evidence:** strong (live-codepath audit)
- **Why related:** The autonomy loop reads a card to apply a column transition (line 157). No try/catch. If the card the loop is about to advance has malformed YAML between the agent's `transition_request` event and the loop's column-write, the entire conductor crashes. Should it instead halt the card (treat as wedged), skip-and-publish a `conductor-halt` event, or refuse to start in the first place? Policy question worth filing.
- **Suggested handling:** file companion (linked to wedged-card semantics; not a hot bug — narrow race window — but real).

**5. Unfiled candidate — `src/engine/ops/chat.ts:60` (chat op stale-body re-read crashes on malformed card)**
- **Kind:** unfiled candidate
- **Evidence:** medium (live-codepath audit; smaller race window — only a chat-reply race could expose it)
- **Why related:** Same readCard-throw root cause; very small race window. Lower priority but tracked for completeness.
- **Suggested handling:** keep narrow (file later if it ever fires in practice).

**6. Existing item — `.relay/issues/discover-original-issue-uses-h1-not-h2.md`**
- **Kind:** existing item
- **Evidence:** weak (shares file `src/engine/state/card.ts` only — the `createCard` default body at line 118 uses H1, which is the H1-vs-H2 concern, not the YAML-throw concern)
- **Why related:** Same file, but completely different concern. Listed for completeness; **not** a candidate for grouping.
- **Suggested handling:** keep narrow; let phase-10/`relay-ordering.md § Phase 2` own it.

#### Search Bounds

- **Live codepath audit:** complete (read `readCard()` in full plus all six first-order callers across `src/`).
- **Backlog codepath:** complete (16 issues read; 3 cite `card.ts` or `task_agent.ts:72-77`).
- **Subsystem:** complete (scanned `src/engine/state/` and `src/agent/` and `src/cli/commands/` for sibling readCard concerns; only `card.ts` itself has the typed-error surface).
- **Archive:** skipped because empty (`/.relay/archive/` does not exist on this fresh Relay install).
- **Implementation:** skipped because empty (`/.relay/implemented/` is empty).
- **Contract drift:** complete (grep for `CardNotFoundError` / `CardParseError` shows the names exist only in this issue's proposed-fix prose and in the Control phase-9 scaffold — no code symbol of either name exists yet; new abstraction, no naming collision).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-12
*Rationale:* The two existing-item findings (#1 scan, #2 work) share root cause but are already independently filed as the next two steps in the same Control phase (9.2 and 9.3). Grouping them into 9.1 would collapse the entire phase into one step and lose the per-step commit and verification granularity the operator chose when generating `relay-ordering.md`. The three unfiled candidates (#3 RPC, #4 loop, #5 chat-op) share root cause but each requires its own policy decision (RPC error-shape mapping, autonomy-loop wedged-card handling, chat-op race policy) — fixing them inside 9.1 would push design questions into a refactor. They are best handled as **linked companion** issues filed during or shortly after this phase. 9.1 stays focused on its job: introduce the typed-error abstraction and adopt it in the two cited CLI/agent call sites. 9.2 and 9.3 will then naturally consume the new types.

### Approach

**Recommended approach:**

1. Introduce two named error classes in `src/engine/state/card.ts`:
   ```ts
   export class CardNotFoundError extends Error {
     readonly code = 'CARD_NOT_FOUND' as const;
     constructor(public readonly path: string) {
       super(`Card file not found: ${path}`);
       this.name = 'CardNotFoundError';
     }
   }
   export class CardParseError extends Error {
     readonly code = 'CARD_PARSE_FAILED' as const;
     constructor(public readonly path: string, public readonly cause: unknown) {
       super(`Card parse failed: ${path}: ${(cause as Error)?.message ?? String(cause)}`);
       this.name = 'CardParseError';
     }
   }
   ```
   The `readonly code` discriminator lets callers do either `instanceof` or duck-typed `e.code === 'CARD_NOT_FOUND'` — both survive transpilation/minification cleanly.

2. Wrap `readCard()`'s body in a `try` and translate:
   ```ts
   export async function readCard(path: string): Promise<Card> {
     let text: string;
     try {
       text = await readFile(path, 'utf8');
     } catch (e) {
       if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new CardNotFoundError(path);
       throw e;
     }
     try {
       const parsed = matter(text);
       const frontmatter = CardFrontmatterSchema.parse(normalizeDates(parsed.data));
       return { frontmatter, body: parsed.content, path };
     } catch (e) {
       throw new CardParseError(path, e);
     }
   }
   ```
   This keeps the function's signature/return type stable. Existing callers that don't catch see the same "something went wrong" behavior; new typed-aware callers get differentiation.

3. **Update `src/agent/task_agent.ts:69-77`** to inspect the typed error and emit a differentiated message:
   ```ts
   try { card = await readCard(cardPath); }
   catch (e) {
     const msg = e instanceof CardParseError
       ? `Failed to parse card: ${this.cardId} (${cardPath}): ${(e.cause as Error)?.message ?? String(e.cause)}`
       : `Card not found: ${this.cardId} (looked at ${cardPath})`;
     yield await this.emit({ kind: 'error', cardId: this.cardId, message: msg });
     return;
   }
   ```
   (Note: 9.3 will refactor this block further — coordinate by leaving the catch shape simple and readable.)

4. **Update `src/cli/commands/transition.ts:24-29`** analogously:
   ```ts
   try { card = await readCard(cardPath); }
   catch (e) {
     if (e instanceof CardParseError) {
       throw new Error(`Failed to parse card: ${args.cardId} (${cardPath}): ${(e.cause as Error)?.message ?? String(e.cause)}`);
     }
     throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);
   }
   ```

5. **Tests:**
   - `tests/engine/state/card.test.ts` — add `readCard() throws CardNotFoundError for ENOENT` and `readCard() throws CardParseError for malformed YAML`. Existing `rejects malformed frontmatter` test (line 40) keeps passing — update its assertion to `await expect(...).rejects.toThrow(CardParseError)`.
   - `tests/agent/task_agent.test.ts` — add `broken YAML card surfaces parse-aware error event message`.
   - `tests/cli/transition.test.ts` — add `throws parse-aware error for malformed YAML`. The existing `throws when card not found` test (line 48-51) keeps passing — its `/not found/` regex still matches the ENOENT case.

**Alternatives considered and rejected:**

- **Pure `.code === 'ENOENT'` inspection at each call site (Change 1 only from the issue's proposed fix).** Rejected. Works for ENOENT vs everything-else, but doesn't help future call sites (the four RPC ones, the conductor loop, the chat op) differentiate cleanly. The typed-error approach is the abstraction that makes the rest of the rollout mechanical.
- **Make `readCard` return `Result<Card, CardError>` (no throws).** Rejected. Larger refactor surface (every caller changes signature), more out-of-scope for a P1 fix. Typed-throws is the smaller-blast-radius option that gives 90% of the benefit.
- **Catch + log + return null/undefined from `readCard`.** Rejected. Conflates "not found" and "broken" again at a different layer; the whole point of this fix is to PREVENT that conflation.
- **Group the RPC + loop + chat-op call sites into 9.1.** Rejected (Scope Decision above) — too much policy embedded for a single step.

**Open questions / decisions needed before implementation:**

- **Should the existing `tests/engine/state/card.test.ts:40` `rejects malformed frontmatter` test assert the specific error class (`CardParseError`)?** Recommendation: yes. The whole point of typed errors is testable differentiation. A single line change to `rejects.toThrow(CardParseError)`.
- **Should `transition.ts` and `task_agent.ts` import the typed errors directly, or duck-type on `e.code`?** Recommendation: `instanceof CardParseError`. Cleaner, more grep-able, and the typed-error file is small enough that the import is cheap. The `code` field is a backup for boundaries where the class identity might not survive (e.g., when re-thrown across an MCP wire).
- **What about `listCards()` (line 54-68 of card.ts)?** It iterates and calls `readCard` per-file. Step 9.2 owns it. **9.1 must NOT change `listCards`** — keep the change set minimal and let 9.2 add `listCardsLenient` (or whatever shape it lands on) using the typed errors introduced here.

---

## Implementation Plan

*Generated: 2026-05-12 via /relay-superplan (5-agent synthesis)*

### Strategy

*Base: Refactor-Forward (centralized `messageForReadCardError()` helper)*
*Incorporated:*
- Performance-First's two-`try` split in `readCard()` (read-`try` for ENOENT, parse-`try` for YAML+Zod) and the `reason: 'yaml' | 'schema'` discriminator on `CardParseError`.
- Safety-First's `truncate(s, 500)` private helper for log-bloat protection, `readonly code` string discriminator on the typed-error classes, the huge-YAML truncation test, and the EISDIR/non-ENOENT rethrow regression test.
- Test-Driven's `it.each` table for Zod boundary cases, Riley's `priority: high` literal fixture, and `not.toMatch(/not found/)` + `not.toBeInstanceOf(CardParseError)` negative-class anti-regression guards.

**Rejected:** Minimal Change's "fall through to 'Card not found' for unknown errors" pattern (it would re-introduce the lie for EACCES/EISDIR). Safety-First's `Object.setPrototypeOf` (unnecessary at ES2022) and `isCardParseError`/`isCardNotFoundError` duck-typed predicates (over-engineered for this single-ESM-graph codebase).

### Step 1 — Introduce typed errors, `truncate` helper, and `messageForReadCardError()` in `src/engine/state/card.ts`

**File:** `src/engine/state/card.ts` (lines 14-44; pure additions + one body rewrite of `readCard()`).

**Before** (lines 14-44):

```ts
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';        // ← fs primitives
import { join, dirname } from 'node:path';                                     // ← path utils
import matter from 'gray-matter';                                              // ← throws YAMLException
import yaml from 'js-yaml';                                                    // ← used by writeCard
import { CardFrontmatterSchema } from '../../config/schema.js';                // ← strict Zod schema
import type { Card, CardFrontmatter, Kind } from '../types.js';                // ← shared types

export function buildCardPath(cardsDir: string, id: string): string {          // ← path helper
  return join(cardsDir, `${id}.md`);                                           // ← <cardsDir>/<id>.md
}

function normalizeDates(data: Record<string, unknown>): Record<string, unknown> { // ← private; YAML Date → ISO string
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export async function readCard(path: string): Promise<Card> {                  // ← throws raw ENOENT/YAMLException/ZodError
  const text = await readFile(path, 'utf8');                                   // ← ENOENT propagates raw
  const parsed = matter(text);                                                 // ← YAMLException propagates raw
  const frontmatter = CardFrontmatterSchema.parse(normalizeDates(parsed.data)); // ← ZodError propagates raw
  return { frontmatter, body: parsed.content, path };                          // ← success-path return shape — preserved verbatim
}
```

**After:**

```ts
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';        // ← unchanged
import { join, dirname } from 'node:path';                                     // ← unchanged
import matter from 'gray-matter';                                              // ← unchanged
import yaml from 'js-yaml';                                                    // ← unchanged
import { ZodError } from 'zod';                                                // ← NEW value-import; needed to distinguish reason='schema'
import { CardFrontmatterSchema } from '../../config/schema.js';                // ← unchanged
import type { Card, CardFrontmatter, Kind } from '../types.js';                // ← unchanged

/** Defensive cap on inner-cause messages — gray-matter parse trees and       // ← NEW: prevents multi-KB error strings
 *  Zod nested-issue arrays can be multi-KB. */
const MAX_CAUSE_MSG = 500;                                                     // ← NEW: tunable
function truncate(s: string, max = MAX_CAUSE_MSG): string {                    // ← NEW: pure helper, module-private
  if (typeof s !== 'string') return String(s);                                 // ← defensive: non-string input
  return s.length <= max ? s : `${s.slice(0, max)}… [truncated ${s.length - max} chars]`; // ← explicit truncation suffix
}

/** Thrown by `readCard` when the underlying file is missing (ENOENT).        // ← NEW typed error #1
 *  `readonly code` is a stable cross-realm discriminator. */
export class CardNotFoundError extends Error {                                 // ← exported for callers + step 9.2
  readonly code = 'CARD_NOT_FOUND' as const;                                   // ← string-literal discriminator survives transpilation
  constructor(public readonly path: string) {                                  // ← carry path for callers' messages
    super(`Card file not found: ${path}`);                                     // ← default message; helper overrides at call sites
    this.name = 'CardNotFoundError';                                           // ← for stack traces / logs
  }
}

/** Thrown by `readCard` when the file exists but its YAML or schema fails    // ← NEW typed error #2
 *  to parse. `reason` discriminates between gray-matter/js-yaml syntax
 *  errors and Zod schema-validation errors. */
export class CardParseError extends Error {                                    // ← exported
  readonly code = 'CARD_PARSE_FAILED' as const;                                // ← string-literal discriminator
  constructor(
    public readonly path: string,                                              // ← which file
    public readonly reason: 'yaml' | 'schema',                                 // ← from-Performance-First: useful user-facing diagnostic
    public readonly cause: unknown,                                            // ← native `Error.cause` (Node ≥ 16.9; project requires ≥ 20)
  ) {
    const innerMsg = truncate(cause instanceof Error ? cause.message : String(cause)); // ← bounded
    super(`Failed to parse card at ${path} (${reason}): ${innerMsg}`, { cause });      // ← native cause chain preserved
    this.name = 'CardParseError';
  }
}

/** Compose the user-facing message for a readCard throw. Single source of    // ← NEW: from-Refactor-Forward; centralized contract
 *  truth — both `task_agent.ts` and `transition.ts` use this so the message
 *  shape is identical at every CLI/agent boundary. Step 9.2 (lenient
 *  listCards) and step 9.3 (work pre-validation) will reuse it as well. */
export function messageForReadCardError(err: unknown, cardId: string, cardPath: string): string {
  if (err instanceof CardNotFoundError) {
    return `Card not found: ${cardId} (looked at ${cardPath})`;                // ← preserves /not found/ test contract verbatim
  }
  if (err instanceof CardParseError) {
    const innerMsg = err.cause instanceof Error ? truncate(err.cause.message) : String(err.cause);
    return `Failed to parse card: ${cardId} (${cardPath}, ${err.reason}): ${innerMsg}`;
  }
  // Unknown error class (EACCES, EISDIR, EMFILE, transient I/O). Surface     // ← from-Performance-First: don't lie about unknowns
  // honestly — DO NOT fall through to "Card not found".
  const desc = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return `Failed to read card: ${cardId} (${cardPath}): ${desc}`;
}

export function buildCardPath(cardsDir: string, id: string): string {          // ← unchanged
  return join(cardsDir, `${id}.md`);
}

function normalizeDates(data: Record<string, unknown>): Record<string, unknown> { // ← unchanged
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export async function readCard(path: string): Promise<Card> {                  // ← signature unchanged
  let text: string;                                                            // ← hoist out so we can narrow the read-try
  try {                                                                        // ← from-Performance-First: read-try (ENOENT only)
    text = await readFile(path, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new CardNotFoundError(path);                                       // ← typed throw
    }
    throw e;                                                                   // ← non-ENOENT I/O errors (EACCES/EISDIR/etc.) propagate raw — the helper surfaces them honestly
  }
  try {                                                                        // ← parse-try (gray-matter + Zod)
    const parsed = matter(text);                                               // ← may throw YAMLException
    const frontmatter = CardFrontmatterSchema.parse(normalizeDates(parsed.data)); // ← may throw ZodError
    return { frontmatter, body: parsed.content, path };                        // ← success-path return shape is byte-identical
  } catch (e: unknown) {
    const reason: 'yaml' | 'schema' = e instanceof ZodError ? 'schema' : 'yaml'; // ← from-Performance-First
    throw new CardParseError(path, reason, e);
  }
}
```

**Why:** Splits the conflated failure surface at the source. The read-try catches ONLY ENOENT and converts to `CardNotFoundError` (other I/O errors propagate raw — better than the old lie). The parse-try wraps both gray-matter and Zod throws into `CardParseError` with a `reason` discriminator. The `messageForReadCardError()` helper centralizes the message contract so both callers (and step 9.2/9.3) get identical wording. `truncate()` prevents log-bloat from giant YAML/Zod error strings.

**Risk:**
- Adds a `ZodError` value-import. `zod` is already a direct dependency (used by `CardFrontmatterSchema`), so bundle impact is zero.
- The success-path return literal `{ frontmatter, body: parsed.content, path }` is byte-identical, preserving the V8 hidden class for downstream callers (`listCards`, `appendSection`, 4 RPC sites, `loop.ts:157`, chat op).
- `listCards()` and `appendSection()` will now propagate `CardParseError` / `CardNotFoundError` instead of raw `ZodError`/`YAMLException`/`ErrnoException`. Acceptable: both are still `Error` subclasses; existing tests use generic `.rejects.toThrow()` and stay green; step 9.2 explicitly consumes the new typed errors.
- RPC sites (`methods.ts:71,85,99,247`), `loop.ts:157`, and `chat.ts:60` propagate the typed errors raw to wire clients. Not a regression (they propagated raw before too); the new wording is strictly more informative.

**Verify:**
- `npm run typecheck`.
- `npx vitest run tests/engine/state/card.test.ts` — existing tests stay green (Step 4 will tighten them).

**Rollback:** `git checkout HEAD -- src/engine/state/card.ts`. Steps 2-3 are no-ops if reverted (they import `messageForReadCardError`).

---

### Step 2 — Wire `messageForReadCardError()` into `src/cli/commands/transition.ts`

**File:** `src/cli/commands/transition.ts` (lines 10, 24-29).

**Before:**

```ts
import { readCard, writeCard } from '../../engine/state/card.js';              // ← line 10

// inside runTransition() — lines 24-29:
let card;
try {
  card = await readCard(cardPath);
} catch {                                                                      // ← bare catch — the bug
  throw new Error(`Card not found: ${args.cardId} (looked at ${cardPath})`);   // ← lies for parse failures
}
```

**After:**

```ts
import { readCard, writeCard, messageForReadCardError } from '../../engine/state/card.js'; // ← add one named import

// inside runTransition():
let card;
try {
  card = await readCard(cardPath);
} catch (e: unknown) {
  throw new Error(messageForReadCardError(e, args.cardId, cardPath));          // ← single line; centralized contract
}
```

**Why:** The helper returns the appropriate message for ENOENT, parse failure (with `reason` and truncated cause), or unknown error — all in one place. The existing `tests/cli/transition.test.ts:48-51` `/not found/` regex test stays green because the helper returns exactly `Card not found: <id> (looked at <path>)` for `CardNotFoundError`.

**Risk:** None significant. The catch shape is now a single line that's also a trivial site for future evolution.

**Verify:** `npx vitest run tests/cli/transition.test.ts` — all existing tests pass + new Step 4 tests pass.

**Rollback:** `git checkout HEAD -- src/cli/commands/transition.ts`. Step 1's exports remain unused.

---

### Step 3 — Wire `messageForReadCardError()` into `src/agent/task_agent.ts`

**File:** `src/agent/task_agent.ts` (line 12, lines 69-77).

**Before:**

```ts
import { readCard, writeCard } from '../engine/state/card.js';                 // ← line 12

// inside run() — lines 69-77:
async *run(): AsyncIterable<TaskEvent> {
  const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
  let card: Card;
  try {
    card = await readCard(cardPath);
  } catch {                                                                    // ← bare catch — the bug
    yield await this.emit({ kind: 'error', cardId: this.cardId, message: `Card not found: ${this.cardId} (looked at ${cardPath})` });
    return;
  }
  // ... rest of run()
```

**After:**

```ts
import { readCard, writeCard, messageForReadCardError } from '../engine/state/card.js'; // ← add one named import

// inside run():
async *run(): AsyncIterable<TaskEvent> {
  const cardPath = join(this.repo, '.conductor', 'cards', `${this.cardId}.md`);
  let card: Card;
  try {
    card = await readCard(cardPath);
  } catch (e: unknown) {
    const message = messageForReadCardError(e, this.cardId, cardPath);         // ← centralized contract
    yield await this.emit({ kind: 'error', cardId: this.cardId, message });    // ← single emit; step 9.3 swaps this 1 line for `throw new Error(message)`
    return;
  }
  // ... rest of run()
```

**Why:** Symmetric to Step 2 at the agent surface. The `yield emit` shape is preserved so existing TaskEvent consumers (RunLogWriter, RPC, MCP, daemon UI) keep working. The single-line structure is exactly what step 9.3 needs to refactor: it will change `yield await this.emit(...)` to `throw new Error(message)` and lift the entire try/catch above the `RunLogWriter` instantiation — zero rework of the helper or its callers.

**Risk:**
- Other 7 `readCard()` calls inside `run()` (lines 92, 110, 158, 175, 203, 220, 257) remain unwrapped. They propagate typed errors raw to the async-iterable consumer — same behavior as today, just with more informative error classes. Locked-scope explicitly defers those.
- `instanceof CardParseError` inside the helper relies on a single class identity. Single ESM graph in this project; no dual-package hazard. Safe.

**Verify:** `npx vitest run tests/agent/task_agent.test.ts` — existing 4 tests pass + new Step 4 test passes.

**Rollback:** `git checkout HEAD -- src/agent/task_agent.ts`.

---

### Step 4 — Test updates

**File 4a — `tests/engine/state/card.test.ts`:**

Update the import to include the typed-error exports:

```ts
import {
  readCard, writeCard, listCards, appendSection, buildCardPath,
  CardNotFoundError, CardParseError, messageForReadCardError,                  // ← NEW: typed-error exports
} from '../../../src/engine/state/card.js';
```

Tighten the existing `rejects malformed frontmatter` test (line 40):

```ts
it('rejects malformed frontmatter with CardParseError', async () => {
  const bad = join(tmp, 'bad.md');
  await writeFile(bad, '---\nnot: valid frontmatter\n---\n\nbody\n');
  await expect(readCard(bad)).rejects.toBeInstanceOf(CardParseError);          // ← was generic .toThrow()
  await expect(readCard(bad)).rejects.toThrow(/parse/i);                       // ← lock message shape
  // Negative class guard
  await expect(readCard(bad)).rejects.not.toBeInstanceOf(CardNotFoundError);
});
```

Add new tests (inside the same `describe('readCard', ...)`):

```ts
it('throws CardNotFoundError when file does not exist', async () => {
  const missing = join(tmp, 'does-not-exist.md');
  await expect(readCard(missing)).rejects.toBeInstanceOf(CardNotFoundError);
  await expect(readCard(missing)).rejects.toThrow(/not found/i);
  await expect(readCard(missing)).rejects.not.toBeInstanceOf(CardParseError);
});

it('throws CardParseError with reason=yaml when YAML syntax is broken', async () => {
  const bad = join(tmp, 'yaml-syntax.md');
  await writeFile(bad, '---\ntitle: "unterminated\nkind: issue\n---\n\nbody\n');
  let err: unknown;
  try { await readCard(bad); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(CardParseError);
  expect((err as CardParseError).reason).toBe('yaml');
  expect((err as CardParseError).code).toBe('CARD_PARSE_FAILED');
});

describe('readCard schema-violation boundary cases', () => {
  it.each([
    { label: 'empty file', contents: '' },
    { label: 'empty frontmatter block', contents: '---\n---\n\nbody\n' },
    {
      label: 'priority is a string (Riley scenario)',
      contents: '---\nid: ok-1\ntitle: T\nkind: issue\ncolumn: discovered\nphase: unassigned\npriority: high\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-12T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\nbody\n',
    },
    {
      label: 'extra unknown field (strict() rejects)',
      contents: '---\nid: ok-2\ntitle: T\nkind: issue\ncolumn: discovered\nphase: unassigned\npriority: 1\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-12T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\nbogus: yes\n---\n\nbody\n',
    },
  ])('throws CardParseError with reason=schema for $label', async ({ contents }) => {
    const bad = join(tmp, 'boundary.md');
    await writeFile(bad, contents);
    let err: unknown;
    try { await readCard(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CardParseError);
    expect((err as CardParseError).reason).toBe('schema');
  });
});

it('caps CardParseError message length to prevent log-bloat', async () => {
  const huge = 'x'.repeat(50_000);
  const bad = join(tmp, 'huge.md');
  await writeFile(bad, `---\n!!!: ${huge}\n---\n`);
  let err: unknown;
  try { await readCard(bad); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(CardParseError);
  expect((err as Error).message.length).toBeLessThan(1500);  // 500 inner cap + path/header overhead
});

it('rethrows non-ENOENT fs errors verbatim (does not misclassify EISDIR as parse)', async () => {
  // Pass cardsDir (a directory) to readCard — Node returns EISDIR
  let err: unknown;
  try { await readCard(tmp); } catch (e) { err = e; }
  expect(err).not.toBeInstanceOf(CardNotFoundError);
  expect(err).not.toBeInstanceOf(CardParseError);
});

describe('messageForReadCardError', () => {
  it('returns "not found" wording for CardNotFoundError', () => {
    const err = new CardNotFoundError('/tmp/p.md');
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/not found/);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).not.toMatch(/parse/i);
  });
  it('returns "parse" wording with reason for CardParseError', () => {
    const err = new CardParseError('/tmp/p.md', 'schema', new Error('priority: Expected number, received string'));
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/parse/i);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/schema/);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).not.toMatch(/not found/);
  });
  it('surfaces unknown errors honestly (no "not found" lie)', () => {
    const err = new Error('EACCES: permission denied');
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).not.toMatch(/not found/);
    expect(messageForReadCardError(err, 'card-1', '/tmp/p.md')).toMatch(/EACCES/);
  });
});
```

**File 4b — `tests/cli/transition.test.ts`:** add `writeFile` to the existing `node:fs/promises` import, then append:

```ts
it('throws a parse-aware message for malformed YAML (not "not found")', async () => {
  // Overwrite the valid card from beforeEach with broken frontmatter
  await writeFile(cardPath, '---\npriority: high\n---\n\nbody\n', 'utf8');     // ← Riley's scenario; Zod rejects string priority
  await expect(
    runTransition({ cwd: tmp, cardId: id, target: 'approved' }),
  ).rejects.toThrow(/parse/i);
  await expect(
    runTransition({ cwd: tmp, cardId: id, target: 'approved' }),
  ).rejects.not.toThrow(/not found/i);
});
```

The existing line 48 `throws when card not found` test using `/not found/` stays untouched and passes — `CardNotFoundError` branch keeps that literal wording.

**File 4c — `tests/agent/task_agent.test.ts`:** add (inside the existing `describe('TaskAgent', ...)`):

```ts
it('emits parse-aware error event when card YAML is malformed', async () => {
  // Riley's scenario: well-formed YAML except priority is a string
  const repo = mkdtempSync(join(tmpdir(), 'conductor-agent-bad-'));
  const cardsDir = join(repo, '.conductor', 'cards');
  mkdirSync(cardsDir, { recursive: true });
  const cardId = '2026-05-12-broken-card';
  writeFileSync(
    join(cardsDir, `${cardId}.md`),
    `---\nid: ${cardId}\ntitle: Broken\nkind: feature\ncolumn: discovered\nphase: unassigned\npriority: high\nautonomy: inherit\nmodel_overrides: {}\ncreated: 2026-05-12T00:00:00Z\nsource: user\nlabels: []\nblocked_by: []\n---\n\n# Original Issue\n`,
    'utf8',
  );
  const config = ProjectConfigSchema.parse({});
  const agent = new TaskAgent({ repo, cardId, adapter: new MockAdapter(), config });
  const events: TaskEvent[] = [];
  for await (const e of agent.run()) events.push(e);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe('error');
  if (events[0].kind === 'error') {
    expect(events[0].message).toMatch(/parse/i);
    expect(events[0].message).not.toMatch(/not found/i);
    expect(events[0].message).toContain(cardId);
  }
});
```

The existing ENOENT-path test (`tests/agent/task_agent.test.ts:103` `emits error event when card does not exist`) stays untouched and passes.

**Why:** Locks every contract in the synthesized plan: typed-error identities, `reason` discriminator, message wording at both caller surfaces, negative-class anti-regression guards, log-bloat cap, EISDIR rethrow, and helper unit coverage.

**Risk:** New test fixture syntax must match existing test conventions. Verified against actual file structures (`mkdtempSync`/`mkdirSync`/`writeFileSync` from `node:fs`; `MockAdapter` from `src/adapters/mock.ts`; `ProjectConfigSchema.parse({})` from existing tests at lines 51/79/95/104).

**Verify:** `npx vitest run tests/engine/state/card.test.ts tests/agent/task_agent.test.ts tests/cli/transition.test.ts` — all new + tightened tests pass.

**Rollback:** Revert the three test files individually.

---

## Test Changes

| File | Change |
|---|---|
| `tests/engine/state/card.test.ts` | Extend import to include `CardNotFoundError`, `CardParseError`, `messageForReadCardError`. Tighten `rejects malformed frontmatter`. Add 6 new tests (ENOENT class, YAML-syntax class, 4-row `it.each` boundary table, message length cap, EISDIR rethrow). Add `describe('messageForReadCardError')` with 3 cases. |
| `tests/cli/transition.test.ts` | Add `writeFile` to fs/promises import. Add `throws a parse-aware message for malformed YAML` regression. |
| `tests/agent/task_agent.test.ts` | Add `emits parse-aware error event when card YAML is malformed` (Riley's `priority: high` fixture). |

Total: 1 import update + 1 tightened test + 12 new tests (4 named + 4 it.each rows + 3 helper-unit + 2 caller-surface). Net ~120 lines of test code added.

---

## Post-Implementation Checks (ordered)

1. `npm run typecheck` — both `tsc -p tsconfig.json` and `tsc -p tsconfig.ui.json` clean. First gate.
2. `npx vitest run tests/engine/state/card.test.ts` — typed-error invariants at the source.
3. `npx vitest run tests/cli/transition.test.ts` — CLI surface differentiates; `/not found/` test still green.
4. `npx vitest run tests/agent/task_agent.test.ts` — agent surface differentiates; ENOENT test still green.
5. `npx vitest run tests/engine/state/ tests/agent/ tests/cli/` — combined regression sweep.
6. `npm test` — full suite (catches any silent break to `listCards`, `appendSection`, 4 RPC sites, `loop.ts:157`, `chat.ts:60`, daemon, importer).
7. **Manual smoke** (optional): write a broken-YAML card to `.conductor/cards/CARD-SMOKE.md`, run `node dist/cli/index.js transition CARD-SMOKE doing` — output should contain `parse`, NOT `not found`.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `listCards()` / `appendSection()` now propagate `CardParseError` / `CardNotFoundError` instead of raw `ZodError`/`YAMLException`, breaking a downstream test that asserted on raw error class | Low (no such test found in current suite) | Low | Both are still `Error` subclasses; existing `rejects.toThrow()` matchers stay green. Step 9.2 explicitly consumes the new types. |
| RPC sites and conductor loop surface the new error wording to wire clients | Medium | Low | Strictly more informative than before; no test asserts on the old message text. The companion-issue path for RPC error-shape mapping is filed separately per the analysis Related Work. |
| `readCard()` success-path object shape change would break V8 hidden-class sharing across 7+ call sites | Very low | High | Step 1 preserves the return literal `{ frontmatter, body: parsed.content, path }` byte-for-byte. The success path has zero new allocations. `npm test` catches any silent break. |
| `Error.cause` not supported on old Node | None | None | Project requires Node ≥ 20; `cause` shipped in Node 16.9. |
| Step 9.2 depends on `CardParseError` being importable | Mitigated | n/a | Exported as `export class CardParseError` from `src/engine/state/card.ts` — single source of truth. |
| Step 9.3 needs to hoist the agent's `readCard` call before `RunLogWriter` instantiation | Mitigated | n/a | Step 3's catch is a single `const message = ...; yield ... message; return;` — 9.3 changes `yield emit(...)` → `throw new Error(message)` in one line. |
| `instanceof CardParseError` fails across module realms | Very low | Low | Single ESM graph in this repo; vitest single-worker-per-file resolution. `code` field on the classes is the cross-realm fallback if it ever becomes needed (deferred to a follow-up). |
| Existing `tests/cli/transition.test.ts:48-51` `/not found/` regex breaks | None | n/a | Helper returns literal "Card not found: ..." for `CardNotFoundError` — verified by unit test 4a. |

---

## Rollback Plan

Per-file rollbacks are listed in each step. Overall rollback in one operation:

```sh
git revert <step-9.1-commit-sha>
```

All three source files (`card.ts`, `task_agent.ts`, `transition.ts`) and three test files revert atomically. The change is purely additive at the public-API level (new exports; no removed or renamed symbols) — no data migration, no on-disk format change, no public CLI/RPC contract change.

**Partial rollback** if a downstream caller surfaces an unexpected instanceof issue: revert just `task_agent.ts` and `transition.ts`. The typed-error classes in `card.ts` remain (unused exports, harmless). Behavior at the two call sites reverts to "Card not found" for all three failure modes — the original bug. Acceptable transient state during a hotfix window.

**Forward-fix preferred over revert** for any test failure: the change is structurally simple; almost any defect is faster to forward-fix than to revert the whole step.

---

## Adversarial Review

*Reviewed: 2026-05-12*

### Source verification

Each plan-step's BEFORE block was re-read against current source at HEAD `485944d`. No drift:

- `src/engine/state/card.ts:14-44` matches the plan's BEFORE block byte-for-byte (lines 14-44, imports through `readCard`).
- `src/agent/task_agent.ts:69-77` matches plan's BEFORE (`async *run()` opening with the bare-catch yielding `Card not found`).
- `src/cli/commands/transition.ts:21-39` matches plan's BEFORE (`runTransition()` with bare-catch throwing `Card not found`).
- `tests/engine/state/card.test.ts` — verified import block (lines 6-12), `beforeEach` setup creating `tmp`/`cardsDir`, and existing `rejects malformed frontmatter` test (lines 40-44) all match plan's assumptions.
- `tests/cli/transition.test.ts` — verified `beforeEach` provides `tmp`/`id`/`cardPath`; existing `throws when card not found` test at lines 48-52 uses `/not found/` regex — the plan's helper preserves the literal "Card not found" wording for `CardNotFoundError`, so the test will stay green.
- `tests/agent/task_agent.test.ts` — verified sync fs imports (`mkdtempSync`/`mkdirSync`/`writeFileSync`); the existing `emits error event when card does not exist` test at line 103 uses `/no-such-card/` regex (NOT `/not found/`), so the new ENOENT branch's wording (which contains `no-such-card` in the cardId) keeps it green.
- `package.json` line 33 confirms `"zod": "^3.23.8"` is a direct dependency — the planned `import { ZodError } from 'zod'` is zero-cost.

### Issues Found

#### MEDIUM — Test 4a's helper-unit `describe` block placement is ambiguous

**What's wrong:** Plan Step 4a lists test additions "inside the same `describe('readCard', ...)`" and then adds a `describe('readCard schema-violation boundary cases', ...)` block and a `describe('messageForReadCardError', ...)` block. The first nested describe is correct (it tests readCard). The second tests an unrelated helper. Whether the implementer puts `describe('messageForReadCardError', ...)` at top-level or nested inside `describe('readCard')` will both compile, but the semantically correct location is top-level (sibling to the other top-level describes like `writeCard`, `listCards`, `appendSection`, `buildCardPath`).

**Plan has:**
```ts
// Inside the readCard describe, after the new boundary describe:    // ← AMBIGUOUS — implementer may nest by accident
describe('messageForReadCardError', () => {                          // ← helper unit tests
  it('returns "not found" wording for CardNotFoundError', () => { /* ... */ });
  it('returns "parse" wording with reason for CardParseError', () => { /* ... */ });
  it('surfaces unknown errors honestly (no "not found" lie)', () => { /* ... */ });
});
```

**Should be:**
```ts
// At top level of tests/engine/state/card.test.ts — sibling to       // ← EXPLICIT placement
// describe('readCard'), describe('writeCard'), describe('listCards'),
// describe('appendSection'), describe('buildCardPath'):
describe('messageForReadCardError', () => {                          // ← top-level sibling describe
  it('returns "not found" wording for CardNotFoundError', () => { /* ... */ });
  it('returns "parse" wording with reason for CardParseError', () => { /* ... */ });
  it('surfaces unknown errors honestly (no "not found" lie)', () => { /* ... */ });
});
```

**Why it matters:** The helper is exported alongside the typed errors and step 9.2 / 9.3 will both consume it. Treating its tests as a peer of `describe('readCard')` makes the test file's structure match the source module's structure and prevents future readers from assuming the helper is internal to `readCard`.

#### LOW — Huge-YAML truncation test may approach the 5000ms vitest timeout

**What's wrong:** Plan's test `caps CardParseError message length to prevent log-bloat` uses `'x'.repeat(50_000)` as the YAML payload. js-yaml on a 50KB malformed scalar is fast but not instant; combined with the surrounding test fixture I/O and vitest's 5000ms cap (`vitest.config.ts`), there's a small probability of flakiness on slower CI.

**Plan has:**
```ts
const huge = 'x'.repeat(50_000);                                     // ← 50KB payload — slow on constrained CI
```

**Should be:**
```ts
const huge = 'x'.repeat(10_000);                                     // ← 10KB still well above the 500-byte truncation threshold; cheap to parse
```

**Why it matters:** 10KB is 20× the `MAX_CAUSE_MSG = 500` cap, so the truncation behavior is still exercised. The smaller payload eliminates CI-timing risk without weakening the test.

#### LOW — Implementation commit must use explicit file list per `commitStep` edge case

**What's wrong:** The plan's Rollback section covers `git revert` but doesn't surface that the **forward commit** must use `git add <files>`, not `git add .`. Per `.relay/relay-config.md § Concurrency`: *"commitStep requires an explicit file list (`src/engine/state/git.ts:14-22`, dogfood finding T6-1). Two parallel step commits in one card would clobber each other if the file lists overlap."* This is a Control-side convention enforced project-wide.

**Implementation note (no plan change needed):** the commit for step 9.1 should be:
```sh
git add src/engine/state/card.ts \
        src/cli/commands/transition.ts \
        src/agent/task_agent.ts \
        tests/engine/state/card.test.ts \
        tests/cli/transition.test.ts \
        tests/agent/task_agent.test.ts \
        .control/phases/phase-9-malformed-yaml-error-surface/steps.md   # checkbox flip
git commit -m "fix(9.1): differentiate ENOENT from parse-failure in readCard callers"
```

**Why it matters:** The hook will not reject `git add .` outright, but the project convention is explicit lists to prevent accidental staging of `.relay/` work-in-progress edits or untracked artifacts (especially during a Control bootstrap phase where dirty trees are normal).

#### LOW — `let card;` in transition.ts stays implicit-any

**What's wrong:** Plan Step 2 doesn't tighten `let card;` to `let card: Card;`. Other planning agents flagged this as a free type-safety upgrade. `tsc --noEmit` runs with `strict: true` for this project, so implicit-any here is tolerated only because there's no inference path before the assignment. Not a bug; not a blocker.

**Implementation note:** if the implementer chooses to tighten, add `import type { Card } from '../../engine/types.js';` (or `'../../engine/state/card.js'` if `Card` is re-exported — verify). Out of 9.1's locked scope; record as a candidate for a future small-touch cleanup phase.

#### LOW — Test 4c's new TaskAgent test creates a phantom run dir as a side effect

**What's wrong:** The plan's new test for malformed-YAML emits an `error` event via `this.emit()`, which writes through `RunLogWriter`, which mkdir's `.conductor/runs/<ts>-<id>/` lazily on first write. That's the exact phantom-run-dir bug step 9.3 will fix. So this test creates a phantom run dir in its tmp repo, which gets garbage-collected with the OS tmpdir (no `afterEach rm` in `task_agent.test.ts` — consistent with existing convention).

**Why it matters:** Not a regression — the existing `emits error event when card does not exist` test at line 103 already exhibits this side effect. Step 9.3 will close it for both tests at once.

### Edge Cases to Handle

Going through `.relay/relay-config.md § Edge Cases`:

| Edge case | Applies? | How addressed |
|---|---|---|
| Provider adapters lazy-instantiated | No | Plan doesn't touch `RoutingAdapter` or `src/adapters/`. |
| `tracker.kind: 'none'` | No | Plan doesn't touch trackers. |
| Cost-ceiling `halt_on_breach: false` | No | Plan doesn't touch cost guard. |
| `autonomy.transitions.*` policy | Indirectly — plan modifies `transition.ts` | Only error-path; `canTransition` + column-write logic unchanged. Policy enforcement unaffected. |
| `MOCK` provider for tests | Yes | Test 4c uses `MockAdapter()` directly per existing convention. |
| Card frontmatter strict schema | Yes | Plan does NOT change schema; only changes error wrapping at `readCard`. Strict-rejection behavior preserved. Riley's `priority: high` fixture intentionally violates the schema to trigger the parse path. |
| `ProjectConfigSchema` strict | No | Plan doesn't add config keys. |
| Card id regex | No | Not touched. |
| Phase ordinal in `commitStep` | No | Not touched by plan; relevant only to the implementation commit shape (addressed in LOW #3 above). |
| Verify command default | No | Not touched. |
| Conductor loop one-at-a-time | No | Plan touches `task_agent.run()`'s initial readCard, before any conduct/halt logic. |
| Chokidar watcher polling | No | Tests do not exercise the watcher. |
| Daemon SSE event bus fan-out | Indirectly | The new `error`-event message wording will surface to SSE subscribers (UI + RPC + MCP). Strictly more informative; no consumer asserts on the old text. |
| Tracker poller interval | No | Not touched. |
| `commitStep` explicit file list | Yes — implementation-side | See LOW #3 above. |
| Markdown-fenced JSON from models | No | Plan doesn't touch JSON.parse sites. |
| Adapter env-var laziness | No | Not touched. |
| Provider env vars (`ANTHROPIC_API_KEY`, etc.) | No | Tests use mock adapter; no live provider calls. |
| Local provider base URL | No | Not touched. |
| Model output drift on tool-use | No | Not touched. |
| `.conductor/auth.token` regen | No | Not touched. |
| Run log retention | Indirectly | The phantom-run-dir side effect from test 4c counts toward `keep_last_n: 200` only in the tmp repo it's created in; OS tmpdir GC handles cleanup. See LOW #5 above. |
| Card body sections accrete in order | Yes | Plan's Step 1 preserves `readCard()`'s success-path return literal byte-for-byte. `appendSection` (which calls `readCard`) keeps working. |
| YAML date normalization | Yes | `normalizeDates` is unchanged; still called inside the parse-try in the same order. |
| Card path repo-relative | No | Not relevant. |

### Regression Risk

Checked `.relay/issues/` (16 active issues), `.relay/archive/` (empty), `.relay/implemented/` (empty). None depend on the OLD raw-throw behavior of `readCard`. Specific cross-cuts:

- **`scan-bails-entirely-on-one-malformed-card.md` (step 9.2):** explicitly consumes `CardParseError` for its lenient-listCards logic. Plan's exports support this directly.
- **`work-creates-run-dir-before-validating-card.md` (step 9.3):** depends on the catch shape in `task_agent.ts:72-77` being trivially refactorable. The synthesized plan makes that catch a single `const message = ...; yield ... message; return;` — step 9.3 can change `yield` → `throw` in one line.
- **`discover-original-issue-uses-h1-not-h2.md` (step 9.4 / Phase 2 of Relay):** touches `card.ts:118` (`createCard` default body — H1). Plan does NOT modify `createCard`. No conflict.

Existing tests checked individually for regression:

| Test | Risk |
|---|---|
| `tests/engine/state/card.test.ts:31-38` (`parses frontmatter and body from a fixture file`) | ✅ Safe — success path preserved verbatim. |
| `tests/engine/state/card.test.ts:40-44` (`rejects malformed frontmatter`) | ✅ Tightened by plan; existing `.rejects.toThrow()` would still pass after change (typed errors are `Error` subclasses) but the plan explicitly upgrades the assertion. |
| `tests/engine/state/card.test.ts:48-55` (`round-trips: write then read`) | ✅ Safe — success path identical. |
| `tests/engine/state/card.test.ts:59-68` (`returns all cards in cardsDir`) | ✅ Safe — fixtures are well-formed; `listCards` propagates whatever `readCard` throws. |
| `tests/engine/state/card.test.ts:70-73` (`returns empty array when cardsDir does not exist`) | ✅ Safe — `listCards`'s ENOENT branch checks readdir's error, not `readCard`'s. |
| `tests/engine/state/card.test.ts:77-86` (`appendSection`) | ✅ Safe — operates on a well-formed card. |
| `tests/cli/transition.test.ts:36-40` (`transitions a card between legal columns`) | ✅ Safe — happy path. |
| `tests/cli/transition.test.ts:42-46` (`rejects illegal transitions`) | ✅ Safe — `Illegal transition: ...` message unchanged. |
| `tests/cli/transition.test.ts:48-52` (`throws when card not found`) | ✅ Safe — helper returns `Card not found: no-such (looked at ...)` for `CardNotFoundError`; regex `/not found/` matches. |
| `tests/agent/task_agent.test.ts:42-65` (`emits op_start, op_complete, transition, complete`) | ✅ Safe — fixture is well-formed; readCard succeeds. |
| `tests/agent/task_agent.test.ts:67-90` (`emits halt when an op refuses to advance`) | ✅ Safe — fixture is well-formed. |
| `tests/agent/task_agent.test.ts:92-101` (`exposes runId`) | ✅ Safe — doesn't invoke readCard via the catch. |
| `tests/agent/task_agent.test.ts:103-118` (`emits error event when card does not exist`) | ✅ Safe — helper returns `Card not found: no-such-card (looked at ...)`; regex `/no-such-card/` matches the cardId in the message. |

No existing test is at risk of regression. The handful of cross-cutting tests (`tests/rpc/`, `tests/daemon/`, `tests/conductor/`) do not write malformed cards in their fixtures, so they propagate the new typed errors raw without asserting on the old message text.

### Verdict

**APPROVED**

The plan is sound. The five issues found are all LOW severity (4 of 5) or a single MEDIUM presentation clarification (test describe-block placement). None require rewriting the plan. The four LOW items are best handled as implementation guidelines:

1. **Test placement:** put `describe('messageForReadCardError', ...)` at top-level in `card.test.ts`, sibling to the other top-level describes.
2. **Huge-YAML test:** reduce `'x'.repeat(50_000)` to `'x'.repeat(10_000)` for CI stability.
3. **Commit hygiene:** stage explicit file list (six files plus the steps.md checkbox flip), not `git add .`.
4. **Implicit-any in transition.ts:** leave as-is for 9.1; flag for future cleanup.
5. **Phantom-run-dir side effect:** acknowledged; step 9.3 will close it for both the existing ENOENT test and the new parse test.

---

## Implementation Guidelines

*Date: 2026-05-12*

- Follow the finalized plan step by step, in order (Step 1 → 2 → 3 → 4a → 4b → 4c).
- After each step, run its VERIFY command before moving to the next:
  - After Step 1: `npm run typecheck`.
  - After Step 2: `npx vitest run tests/cli/transition.test.ts` — existing tests stay green.
  - After Step 3: `npx vitest run tests/agent/task_agent.test.ts` — existing 4 tests stay green.
  - After Step 4a/b/c: `npx vitest run tests/engine/state/card.test.ts tests/cli/transition.test.ts tests/agent/task_agent.test.ts` — all new + tightened tests pass.
- Commit ONCE for the entire step 9.1, at the end (this is a Relay-pipeline step, not multiple Control steps). Stage explicit files only:
  ```sh
  git add src/engine/state/card.ts \
          src/cli/commands/transition.ts \
          src/agent/task_agent.ts \
          tests/engine/state/card.test.ts \
          tests/cli/transition.test.ts \
          tests/agent/task_agent.test.ts \
          .control/phases/phase-9-malformed-yaml-error-surface/steps.md \
          .relay/issues/misleading-card-not-found-for-malformed-yaml.md
  ```
  Commit message: `fix(9.1): differentiate ENOENT from parse-failure in readCard callers`. Flip `- [ ] 9.1` → `- [x] 9.1` in `steps.md` **in the same commit**.
- Adversarial Review notes to apply during implementation:
  - **`describe('messageForReadCardError', ...)` goes at top-level** of `tests/engine/state/card.test.ts` (sibling to `describe('readCard')`, `describe('writeCard')`, etc.) — NOT nested inside `describe('readCard')`.
  - **Huge-YAML test:** use `'x'.repeat(10_000)` instead of `'x'.repeat(50_000)` to avoid CI flakiness.
  - Leave `let card;` in `transition.ts` as implicit-any (out of 9.1's scope).
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies. The 6 other `readCard()` callers (RPC ×4, conductor loop, chat op) are intentionally out of scope (deferred as linked-companion candidates).

---

## Verification Report

*Verified: 2026-05-12*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | Add `CardNotFoundError` + `CardParseError` + `truncate()` + `messageForReadCardError()` in `src/engine/state/card.ts`; rewrite `readCard()` body with two-try (read / parse) split using `ZodError` instanceof for `reason` discriminator | YES | YES |
| 2 | Extend `src/cli/commands/transition.ts` import + replace bare catch with `throw new Error(messageForReadCardError(...))` | YES | YES |
| 3 | Extend `src/agent/task_agent.ts` import + replace bare catch with `yield emit({ message: messageForReadCardError(...) })` | YES | YES |
| 4a | Tighten existing `rejects malformed frontmatter` + add 5 new `readCard` tests + `it.each` boundary table (4 rows) + `describe('messageForReadCardError')` at top-level (per review fix) | YES | YES |
| 4b | Add `throws a parse-aware message for malformed YAML (not "not found")` to `transition.test.ts` + add `writeFile` to fs/promises import | YES | YES |
| 4c | Add `emits parse-aware error event when card YAML is malformed` to `task_agent.test.ts` (Riley's `priority: high` fixture) | YES | YES |

**Adversarial Review fixes applied:** `describe('messageForReadCardError')` placed at top-level (per MEDIUM-1); huge-YAML payload reduced from 50KB to 10KB (per LOW-2); `let card;` in transition.ts kept implicit-any (per LOW-4 scope flag).

### Diff check

Re-read all six modified files in full. Every change matches the persisted Implementation Plan:

- `src/engine/state/card.ts` — typed errors, `truncate()` helper, `messageForReadCardError()` helper, two-try-block `readCard()`. Success-path return literal `{ frontmatter, body: parsed.content, path }` is byte-identical to pre-change. `normalizeDates` private and unchanged.
- `src/cli/commands/transition.ts` — single new named import (`messageForReadCardError`); catch is now `catch (e: unknown) { throw new Error(messageForReadCardError(e, args.cardId, cardPath)); }`. Surrounding logic (`canTransition`, `writeCard`) untouched.
- `src/agent/task_agent.ts` — single new named import; catch is now `catch (e: unknown) { const message = messageForReadCardError(...); yield await this.emit({ kind: 'error', cardId, message }); return; }`. Step 9.3's planned transformation (yield→throw) is a one-line edit. No other readCard calls in the file changed.
- `tests/engine/state/card.test.ts` — import extended; `rejects malformed frontmatter` tightened with `toBeInstanceOf(CardParseError)` + `/parse/i` + negative-class guard; 5 new tests added inside `describe('readCard')`; `describe('readCard schema-violation boundary cases')` (4 it.each rows) and `describe('messageForReadCardError')` (3 cases) added at top-level.
- `tests/cli/transition.test.ts` — `writeFile` added to fs/promises import; new test `throws a parse-aware message for malformed YAML (not "not found")` added after the existing `throws when card not found` test.
- `tests/agent/task_agent.test.ts` — new test `emits parse-aware error event when card YAML is malformed` added inside the existing `describe('TaskAgent')`, using sync fs APIs consistent with the file's existing convention.

No scope creep. No drive-by refactors. No unplanned changes.

### Completeness check

- All 6 plan steps implemented.
- All test changes made: 1 tightened + 12 new (4 new direct + 4 it.each rows + 3 helper-unit + 1 transition + 1 task_agent) = 13 net new test cases, exact match with the plan.
- All files in blast radius addressed (3 src + 3 tests).
- No TODO comments or placeholder code left behind.
- Out-of-scope sites (RPC ×4, conductor loop, chat op) explicitly NOT touched per locked scope — correct.

### Correctness check

Re-read each modified function end-to-end:

- **`readCard()`** — read-try is narrow (only ENOENT → `CardNotFoundError`; other ErrnoExceptions propagate raw). Parse-try is broad (`ZodError` → `reason='schema'`; everything else → `reason='yaml'`). Success-path return shape preserved verbatim. `Error.cause` chain set via native `super(msg, { cause })` (Node ≥ 20 supported per `package.json engines`).
- **`messageForReadCardError()`** — three-branch helper. `CardNotFoundError` branch returns literal "Card not found: ..." wording (locks `/not found/` regex test contract). `CardParseError` branch surfaces `reason` + truncated cause. Unknown-error branch surfaces error class name + message — never falls through to the "not found" lie.
- **`truncate()`** — defensive typeof check, slice-with-suffix on overflow. Pure function.
- **`runTransition()`** catch — one line; delegates to helper.
- **`TaskAgent.run()`** initial catch — three lines; const + emit + return.

Edge cases from `/relay-review`'s Edge Cases sweep all addressed: card frontmatter schema strictness preserved (Riley's fixture explicitly violates the schema and triggers the parse path); YAML date normalization preserved (`normalizeDates` unchanged, still called in the same order); SSE event bus consumers see strictly-more-informative wording; success-path object shape preserved for V8 hidden-class sharing across 7+ downstream callers.

### Test Results

`npm run typecheck` — **CLEAN** (both engine `tsconfig.json` and UI `tsconfig.ui.json`).

`npm test` (full suite, includes `pretest` UI build):

```
Test Files  96 passed (96)
     Tests  488 passed (488)
  Duration  15.15s
```

Targeted runs already verified during implementation:
- `tests/engine/state/card.test.ts` — **18/18 pass** (was 7 before; +11 net).
- `tests/cli/transition.test.ts` — **4/4 pass** (was 3 before; +1 net).
- `tests/agent/task_agent.test.ts` — **5/5 pass** (was 4 before; +1 net).

Cross-cutting suites that touch `readCard` indirectly via `listCards`/`appendSection`/RPC/loop/chat:
- `tests/rpc/methods.test.ts` — green
- `tests/daemon/mcp_server.test.ts` — green
- `tests/daemon/http_server.test.ts` — green
- `tests/conductor/loop.test.ts` — green
- `tests/engine/ops/*` — green (includes `analyze`/`plan`/`review`/`implement`/`verify`/`notebook`/`resolve` paths that depend on `appendSection` → `readCard`)
- `tests/engine/phase.test.ts` — green (4/4; calls `listCards` on both live and archive dirs)
- `tests/engine/state/git.test.ts` — green (7/7; including T6-1 regression test for `commitStep` explicit-file-list contract)

Zero regressions across the 96 test files.

### Issues Found

None.

### Verdict

**COMPLETE**






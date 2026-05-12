# Phase 9 Steps

> One branch, three sequential commits. Each step closes with a commit
> `<type>(9.<N>): <subject>` and flips its checkbox in the same commit.

- [ ] 9.1 — Differentiate ENOENT from parse-failure in `readCard` callers
- [ ] 9.2 — `scan` continues on per-card YAML failure (warns, exits 0 if any healthy)
- [ ] 9.3 — `work` validates card before creating run dir

## Step detail

### 9.1 — Differentiate ENOENT from parse-failure in `readCard` callers

**Relay item:** `.relay/issues/misleading-card-not-found-for-malformed-yaml.md` (P1 — bug, T5-3).

**What to do:**
- Introduce typed errors in `src/engine/state/card.ts`: `CardNotFoundError` (wraps ENOENT from `node:fs/promises`), `CardParseError` (wraps `gray-matter` + Zod throws). Keep error messages identifying the path.
- Rewrite call-sites to differentiate:
  - `src/agent/task_agent.ts:74-77` — the yielded error event must carry parse-error message, not "Card not found" — and only "Card not found" for genuine ENOENT.
  - `src/cli/commands/transition.ts:24-29` — same differentiation; throw with the appropriate message.
- Optional: `src/rpc/methods.ts` — `card_get` / `card_list` paths should propagate distinct messages if they have try/catch around `readCard`.

**What to verify:**
- `npm run typecheck` clean.
- New regression tests:
  - `tests/agent/task_agent.test.ts` — broken-YAML card → surfaced error contains "parse" / "YAML", not "not found".
  - `tests/cli/transition.test.ts` — same for transition path.
  - `tests/engine/state/card.test.ts` — `readCard()` throws `CardNotFoundError` for missing file and `CardParseError` for malformed YAML.
- Existing ENOENT-on-missing-file tests stay green.
- Targeted: `npx vitest run tests/agent/ tests/cli/ tests/engine/state/`.

**Commit message template:**
```
fix(9.1): differentiate ENOENT from parse-failure in readCard callers

Introduces CardNotFoundError / CardParseError typed errors in
src/engine/state/card.ts. Rewrites bare catch blocks in
task_agent.ts and transition.ts to surface the actual failure
mode. Closes T5-3.
```

---

### 9.2 — `scan` continues on per-card YAML failure (warns, exits 0 if any healthy)

**Relay item:** `.relay/issues/scan-bails-entirely-on-one-malformed-card.md` (P1 — bug, T5-2).

**Depends on:** 9.1 (uses the typed errors).

**What to do:**
- Add a `listCardsLenient(cardsDir)` returning `{ cards: Card[]; errors: Array<{ path; message }> }` in `src/engine/state/card.ts`, OR change `listCards`'s return shape (the relay issue notes the alternative; pick lenient-variant addition to avoid breaking other callers — confirm during `/relay-analyze`).
- Extend `Status` in `src/engine/types.ts` with optional `errors` field.
- In `src/engine/ops/scan.ts`, route through the lenient variant; propagate errors onto `Status`.
- In `src/cli/commands/scan.ts`, render warnings to `process.stderr` before the column listing. Exit 0 on partial success, 1 only when zero cards loaded.
- `src/rpc/methods.ts` — `conductor.scan` returns the new shape (UI clients + MCP get warnings).
- `src/ui/views/*` — check Board view; render warnings if appropriate (defer cosmetic polish if it inflates scope).

**What to verify:**
- `npm run typecheck` clean.
- New regression tests:
  - `tests/engine/state/card.test.ts` — `listCardsLenient` returns good cards + error entry for broken one.
  - `tests/cli/scan.test.ts` — warning-then-list flow; exit code 0 with partial success.
  - `tests/engine/ops/scan.test.ts` — `Status.errors` populated as expected.
- Targeted: `npx vitest run tests/engine/state/ tests/engine/ops/scan.test.ts tests/cli/scan.test.ts`.
- Then full: `npm test`.

**Commit message template:**
```
fix(9.2): scan continues on per-card YAML failure

Adds listCardsLenient() that returns {cards, errors}. scan op
propagates errors onto Status; CLI prints warnings to stderr
and exits 0 when any card parsed. Closes T5-2.
```

---

### 9.3 — `work` validates card before creating run dir

**Relay item:** `.relay/issues/work-creates-run-dir-before-validating-card.md` (P2 — quality, T5-1).

**Depends on:** 9.1 (shares `task_agent.ts:74-77` block).

**What to do:**
- In `src/agent/task_agent.ts`, defer `RunLogWriter` instantiation until after `readCard` succeeds — OR move the card-existence check into `run()` to fire *before* any `emit()` call (which is what triggers `mkdir`).
- The recommended shape (approach A in the issue): leave the constructor logic, but in `run()`, validate first; if it fails, throw rather than `emit` an error event. The CLI's existing `work.ts:46-56` already handles thrown errors. RPC callers that consume the stream still need an error path — keep the yielded-error shape only for failures that occur *after* the run is underway.

**What to verify:**
- `npm run typecheck` clean.
- New regression tests:
  - `tests/agent/task_agent.test.ts` — nonexistent card → run promise/iterator rejects with "Card not found"; **no** directory exists under `.conductor/runs/` after the call.
  - `tests/cli/work.test.ts` — end-to-end CLI behavior.
- Targeted: `npx vitest run tests/agent/ tests/cli/work.test.ts`.
- Then full: `npm test`.

**Commit message template:**
```
fix(9.3): work validates card before creating run dir

TaskAgent.run() now validates the card path before any emit()
call, preventing the lazy RunLogWriter from mkdir'ing a phantom
run directory for a nonexistent card. Closes T5-1.
```

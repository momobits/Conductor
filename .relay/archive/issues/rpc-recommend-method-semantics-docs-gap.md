> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/rpc-recommend-method-semantics-docs-gap.md). Bundled into Phase 15.1 docs PR.

# `conductor.recommend` RPC method semantics not documented — confused with "get next card"

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T4-4*
*Severity: P3 — observation (documentation)*

## Problem statement

The `conductor.recommend` RPC method **files** a recommendation manually
(for plugins / foreign tools that want to record a recommendation against
a card). The dogfood test plan described it as a method that "gets a
recommendation for the next card to work on" — the **opposite** semantic.

This is a docs gap, not a code defect. The method works correctly per its
actual design.

## Current state

- `src/rpc/methods.ts:210-216` — the implementation and its doc comment:
  ```ts
  async function recommend(_ctx: MethodContext, raw: unknown) {
    RecommendParams.parse(raw);
    // Phase 4: TaskAgent already writes recommendations to the run log when
    // it surfaces them. This entry point exists for foreign tools (plugins)
    // that want to file a recommendation manually.
    return { ok: true as const };
  }
  ```
- Required params: `{ cardId: string, recommendation: { ...Recommendation } }`.
- Returns: `{ ok: true }`. There is **no** "next card" method — for that you
  call `conductor.work_next` (which is documented under a different name).
- T4.2 dogfood: tested `conductor.recommend {}` → Error -32602 (validation),
  consistent with the params schema. The "wrong test" was the misreading of
  semantics in the plan, not a daemon defect.

## Impact

- **First-time RPC integrators** reading the method name `recommend` will
  guess the wrong semantic (similar to how `pickNext` or `next_card` is the
  conventional name for "get next").
- The internal doc comment is correct, but the public-facing tool/method
  list (e.g., the MCP `tools/list` response) carries only the description
  string, which today reads (per `src/daemon/mcp_server.ts`):
  ```ts
  { name: 'conductor.recommend', description: '...' }
  ```
  If that description is ambiguous, every MCP/RPC consumer sees the
  ambiguity.

## Proposed fix

Documentation-only. Tighten the public-facing description.

1. In `src/daemon/mcp_server.ts`, update the `conductor.recommend` tool's
   `description` to something unambiguous:
   ```
   "File a recommendation against a card (for plugins/foreign tools).
   This does NOT return a recommendation; it writes one. Use conductor.work_next
   to ask conductor which card to work on next."
   ```
2. Mirror the wording in the public RPC method table in `docs/operations.md`
   (or wherever the RPC surface is documented). Make sure both `recommend`
   and `work_next` are listed side-by-side with their distinct purposes.
3. Add a short example in the docs showing the two calls and what each does.

No code changes required.

### Verification

- Confirm the `tools/list` output (MCP) shows the new description by
  hitting `/mcp` after a `daemon start`.
- Spot-check `docs/operations.md` against the actual RPC method table to
  ensure no stale "get next recommendation" wording remains.

## Affected files

- `src/daemon/mcp_server.ts` — update the `description` string for
  `conductor.recommend`.
- `docs/operations.md` — clarify the RPC method table.
- `README.md` — if the RPC section in the README touches this, update there too.

---

## Analysis

*Analyzed: 2026-05-14*

### Validation
- Problem still exists at HEAD `3c7dc8f`. `src/daemon/mcp_server.ts:38` confirmed: `{ name: 'conductor.recommend', description: 'File a recommendation manually' }`. The current description is technically accurate ("File a recommendation") but does not explicitly contrast against the conventional "get next recommendation" semantic users may guess from the method name. Issue's recommendation (more verbose description) is still warranted.
- `docs/operations.md` has no RPC method table at all — it covers engine ops (analyze, plan, etc.) but not the RPC surface. Adding a brief RPC reference is appropriate.
- Approach (docs-only — tighten description + add RPC table to operations.md) still valid.

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-14
*Rationale:* Bundled into Phase 15.1 docs PR. See **primary item** [quickstart-work-cycle-latency-estimate-understated.md](quickstart-work-cycle-latency-estimate-understated.md) for the consolidated plan + review + verification.

### Approach
1. `src/daemon/mcp_server.ts:38` — replace `'File a recommendation manually'` with a longer description that contrasts files-vs-returns and points to `conductor.work_next` for the get-next semantic.
2. `docs/operations.md` — add a brief RPC method surface section listing `conductor.recommend` + `conductor.work_next` side-by-side with their distinct purposes.

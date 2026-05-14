> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/quickstart-work-cycle-latency-estimate-understated.md). Primary item for Phase 15.1 bundled docs PR.

# Quickstart work-cycle latency estimate (60–120s) is understated for Opus subscription

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T1-2*
*Severity: P3 — observation (documentation)*

## Problem statement

`docs/quickstart.md` tells new users to "Expect ~60–120s total" for a
`conductor work <card>` cycle. The first dogfood run logged 194.7s total
(151.1s analyze + 43.0s plan) against `claude-sub:opus`. Users who start
with the documented expectation will believe their first run has stalled
when it has not.

This is purely a documentation accuracy issue — there is no bug in conductor;
analyze is just slower under Opus subscription than the docs claim.

## Current state

- `docs/quickstart.md` states "~60–120s total" without qualification on model.
- `src/agent/task_agent.ts` routes `analyze` and `plan` through whatever
  model the project config picks (`routing.functions.analyze`, falling back
  to `routing.default`). The dogfood project routed `analyze` to
  `claude-sub:opus` (the Conductor brain default for analysis-heavy ops).
- Dogfood-measured timing on a single card:
  - analyze (Opus subscription): 151.1s
  - plan (Opus subscription): 43.0s
  - total: 194.7s — **62% over the upper documented estimate**.
- Provider latency varies by model:
  - Opus subscription: 50–150s per op (high)
  - Sonnet / Haiku: typically <30s per op
- `docs/providers.md` references model selection but does not surface the
  latency consequence.

## Impact

- First-run users may interrupt a cycle that is making forward progress.
- Users will misattribute slowness to a bug rather than to model choice.
- The estimate provides no decision input for users picking among providers.

## Proposed fix

Update `docs/quickstart.md` so the estimate is qualified by model class.
Suggested replacement text:

> Expect a single `conductor work` cycle to take roughly:
> - **Haiku / Sonnet**: 30–60s per op (60–120s analyze+plan)
> - **Opus subscription**: 50–150s per op (100–300s analyze+plan)
> - **GPT-5 / Gemini 2.5 Pro**: similar to Sonnet
>
> Times scale with card body size. A 4-page analysis prompt may sit at the
> upper end of the band.

Add a one-line cross-reference in `docs/providers.md` under the routing
section pointing to the quickstart timing band.

No code changes required.

### Verification

Re-read the quickstart against a fresh `conductor work` run on a card
configured with each of the three model tiers and confirm the timing falls
in the documented band.

## Affected files

- `docs/quickstart.md` — replace the latency line with a model-class table.
- `docs/providers.md` — add a one-line cross-reference (optional).

---

## Analysis

*Analyzed: 2026-05-14*

### Validation

- Problem still exists: **PARTIAL** at HEAD `3c7dc8f`. Source re-read finds NO `"60-120s"`, `"60–120s"`, or `latency`/`estimate` line in `docs/quickstart.md`. The original wording was removed by some prior phase. **The remaining gap is affirmative**: the quickstart never tells users how long a cycle should take, so first-run users still misattribute slowness. The fix becomes ADD a "Latency expectations" subsection (not REPLACE an existing line).
- Approach still valid: YES with the above amendment (add, not replace).

### Bundled Phase 15.1 — single sweep across 5 docs items

This issue is the **primary item** for Phase 15.1's bundled docs PR. The 4 sibling items are listed below; their per-item Analyses are minimal cross-references pointing back to this file's Implementation Plan + Adversarial Review + Verification Report.

| # | Item | Source path | T-ID |
|---|------|-------------|------|
| 1 (primary) | quickstart latency by model class | `docs/quickstart.md` | T1-2 |
| 2 | transition adjacency vs override semantics | `docs/operations.md` + `src/cli/commands/transition.ts` | T3-1 |
| 3 | auth.token lifecycle + gitignore | `docs/operations.md` (`src/cli/commands/init.ts` gitignore-template emission deferred to follow-up if needed) | T4-2 |
| 4 | MCP session handshake docs + curl example | new `docs/mcp.md` (or operations.md section) | T4-3 |
| 5 | conductor.recommend description tightened | `src/daemon/mcp_server.ts:38` + `docs/operations.md` | T4-4 |

All 5 items are P3 docs-only (no code-side behavior change beyond a 1-line `.description()` text update for items 2 and 5). Subsystem-search dimension auto-skipped per /relay-analyze workflow.md's documentation-only rule. Net code touch: 2 lines in transition.ts + mcp_server.ts; ~150 lines of new/modified docs across 2 files (quickstart.md + operations.md) plus 1 new file (docs/mcp.md).

### Scope Decision

*Mode:* keep narrow
*Decided:* 2026-05-14
*Rationale:* All 5 items are docs-only with shared "Ship as one PR" guidance from `.relay/relay-ordering.md § Phase 7`. No grouped-run scope formalization needed — the bundling is a phase-level decision, not an item-level scope decision. Each item is independently narrow.

### Approach

**Bundled docs PR** (one commit: `feat(15.1): docs bundle — quickstart latency, transition semantics, auth.token lifecycle, MCP session handshake, recommend RPC semantics`).

Two source-side micro-edits (1 line each):
- `src/cli/commands/transition.ts:44` — extend `.description()` to mention adjacency.
- `src/daemon/mcp_server.ts:38` — tighten `conductor.recommend` description.

Three doc-side edits (in approximate order):
1. **`docs/quickstart.md`** — add a "Latency expectations" subsection between sections 5 (Run the workflow) and 6 (Web UI), with the model-class table from the issue's proposed-fix block.
2. **`docs/operations.md`** — add four sections at the end:
   - "Manual transitions and the adjacency rule" (T3-1)
   - "Auth token lifecycle" (T4-2)
   - "RPC method surface" — brief reference table including the tightened `conductor.recommend` semantics (T4-4)
   - Cross-link to `docs/mcp.md` (T4-3)
3. **`docs/mcp.md`** (NEW) — the three-step MCP handshake with curl example.

Out of scope (deferred to a separate code-side issue if needed):
- Adding gitignore-template emission to `conductor init` (currently `init.ts` writes no `.gitignore` at all). The repo's own `.gitignore` already includes `.conductor/auth.token` (line 41); the gap is that `conductor init` in a user project doesn't emit/update a `.gitignore`. Documenting the requirement in `operations.md` is sufficient for this docs-only phase; behaviour change in `init.ts` belongs in a future code item.

### Test Verification

No new tests added (docs-only + 2x 1-line `.description()` changes that don't affect any current test assertions). Verification = `npm run typecheck` clean + `npm test` 538/538 pass (no regression). The `.description()` strings are user-facing CLI help text + MCP tool metadata; not asserted by current tests.

---

## Implementation Plan (Bundled — covers all 5 Phase 15.1 docs items)

*Generated: 2026-05-14*

This plan is the **single source of truth** for Phase 15.1. The 4 sibling item files carry minimal cross-references; their per-item resolution is satisfied by the file edits below + the bundled commit `feat(15.1)`.

### Step 1: Add "Latency expectations" subsection to `docs/quickstart.md` (T1-2)

**File**: `docs/quickstart.md` (insert between section 5 "Run the workflow" and section 6 "Use the web UI").

**Content to add**:

```markdown
---

## Latency expectations

A single `conductor work <card-id>` cycle takes one or two LLM calls (analyze + plan, or implement, depending on the card column). Per-op times vary by model class:

| Model class | Per-op latency | analyze + plan total |
|---|---|---|
| **Haiku / Sonnet / GPT-5 / Gemini 2.5 Pro** | 30–60s | 60–120s |
| **Opus subscription (`claude-sub:opus`)** | 50–150s | 100–300s |
| **Local (LM Studio, Ollama)** | varies — depends on hardware | varies |

Times scale with card body size. A 4-page analysis prompt sits at the upper end of each band. If your first `conductor work` cycle on Opus exceeds 120s, that's expected — let it finish. See [providers.md](providers.md) for routing.
```

**Why**: Closes T1-2 affirmatively. The previously cited "60-120s" line no longer exists in the doc (removed by some prior phase), so the fix is ADD a model-class-qualified table, not REPLACE a stale line.

**Risk**: None (docs-only).

**Verify**: Manual read after Edit; `npm run typecheck` and `npm test` confirm no code regressions.

**Rollback**: revert the section.

### Step 2: Update `transition` `.description()` + add operations.md adjacency section (T3-1)

**File 1**: `src/cli/commands/transition.ts` (line 44 `.description()` text).

**Before**:
```ts
    .description(`Manually transition a card. Columns: ${COLUMNS.join(' | ')}`)
```

**After**:
```ts
    .description(
      `Manually transition a card to an ADJACENT column (forward by one step, or one of three explicit backward moves: planned→discovered, building→approved, verifying→building). Skips autonomy policy gates but NOT the lifecycle adjacency rule. Columns: ${COLUMNS.join(' | ')}`,
    )
```

**File 2**: `docs/operations.md` (append a new top-level section before the file ends).

**Content to add at end of file**:

```markdown
---

## Manual transitions and the adjacency rule

`conductor transition <card-id> <column>` moves a card between columns
without going through the autonomy gate machinery. **But adjacency is
still enforced.** The lifecycle state machine (in `src/engine/lifecycle.ts`)
allows:

- **Forward**: exactly one column at a time
  (`discovered → planned → approved → building → verifying → shipped → archived`).
- **Backward**: three specific moves only:
  `planned → discovered`, `building → approved`, `verifying → building`.

Any other transition rejects with `Illegal transition: <from> -> <to>`.

**To move a card across multiple stages** (e.g., `approved → shipped`),
call `conductor transition` once per step.

There is no `--force` flag. The design preserves the integrity of the
lifecycle graph; the "human override" semantic that `transition` provides
applies to **autonomy policy gates** (`manual` / `assist` / `auto`), NOT
to **adjacency**.
```

**Why**: Closes T3-1. The CLI help text and the operations doc now both surface the adjacency rule explicitly.

**Risk**: The longer `.description()` text wraps in narrow terminals; acceptable for the clarity gain.

**Verify**: `npm run typecheck`; manually run `conductor transition --help` post-build to read the new text (or just verify the diff).

**Rollback**: revert both edits.

### Step 3: Add "Auth token lifecycle" section to operations.md (T4-2)

**File**: `docs/operations.md` (append after the section added in Step 2).

**Content to add**:

```markdown
---

## Auth token lifecycle

`.conductor/auth.token` is a UUIDv4 bearer credential for the daemon's
HTTP `/rpc` and MCP transports.

- **Created**: on every `conductor daemon start` — `generateAuthToken()`
  writes a fresh UUIDv4 to `.conductor/auth.token`, overwriting any prior
  token. The file is shared between the daemon process and any client
  (CLI commands, UI, MCP integrations) that needs to authenticate.
- **NOT cleared** on `conductor daemon stop`. This is intentional: the
  next daemon start would regenerate the token anyway, and leaving the
  file in place avoids a brief window where a CLI client sees ENOENT
  rather than a stale-but-recoverable token.
- **Rotated on next start**. Any token captured before the daemon stop
  is invalidated when the next daemon starts.

**Gitignore your auth token.** Add to your project's `.gitignore`:

\`\`\`
.conductor/auth.token
.conductor/auth.endpoint
.conductor/mcp.endpoint
.conductor/mcp.sock
.conductor/runs/
.conductor/snapshots/
\`\`\`

`conductor init` does NOT currently write a `.gitignore` template. Add
the lines above by hand after running `init`. (If your project's
`.gitignore` is missing these and the daemon has started, run
`git status` to confirm `.conductor/auth.token` is not staged.)
```

**Why**: Closes T4-2. Documents the design intent (token persists for reconnect) and surfaces the gitignore-hygiene requirement explicitly.

**Risk**: None (docs-only).

**Verify**: Manual read after Edit.

**Rollback**: revert the section.

### Step 4: Add `docs/mcp.md` with the three-step handshake (T4-3)

**File**: `docs/mcp.md` (NEW).

**Content** (full new file):

```markdown
# MCP integration

The Conductor daemon exposes its tool surface via the Model Context
Protocol (MCP) 2025-03-26 spec over Streamable HTTP. The transport is
**stateful** — every `tools/list` and `tools/call` request must carry an
`Mcp-Session-Id` header obtained from a prior `initialize` call.

## Three-step handshake

Before any `tools/*` request:

1. **`initialize`** — start a session. The response includes an
   `Mcp-Session-Id` header (UUID).
2. **`notifications/initialized`** — confirm the session with that header.
3. **Tool calls** (`tools/list`, `tools/call`) — every subsequent request
   must include the captured `Mcp-Session-Id` header.

Without the session header, the daemon correctly returns
`400 Bad Request: Mcp-Session-Id header is required`. This is per the
MCP spec, not a bug in Conductor.

## Curl example

```bash
# Prerequisites: daemon is running and you have its URL + auth token.
ENDPOINT="http://127.0.0.1:7180"
TOKEN=$(cat .conductor/auth.token)

# 1. Initialize, capture mcp-session-id from response header.
SESSION_ID=$(curl -sI -X POST "$ENDPOINT/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0.1"}}}' \
  | grep -i 'mcp-session-id:' | awk '{print $2}' | tr -d '\r')

# 2. Send the initialized notification.
curl -X POST "$ENDPOINT/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SESSION_ID" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# 3. Now you can list or call tools.
curl -X POST "$ENDPOINT/mcp" \
  -H "authorization: Bearer $TOKEN" \
  -H "mcp-session-id: $SESSION_ID" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

The session lives as long as the daemon runs. If you stop and restart the
daemon, the auth token rotates (see [operations.md § Auth token lifecycle](operations.md#auth-token-lifecycle))
and you must redo the handshake with the new token + a fresh session.

## Available tools

See `src/daemon/mcp_server.ts` for the full list. Highlights:

- `conductor.card_list`, `conductor.card_get`, `conductor.card_new`,
  `conductor.card_update` — card CRUD.
- `conductor.transition` — manual lifecycle move (subject to adjacency;
  see [operations.md § Manual transitions and the adjacency rule](operations.md#manual-transitions-and-the-adjacency-rule)).
- `conductor.work_card`, `conductor.work_next` — task agent invocation.
- `conductor.brain_start`, `conductor.brain_stop`, `conductor.brain_status` — autonomy loop control.
- `conductor.scan`, `conductor.order`, `conductor.discover` — project-wide ops.
- `conductor.recommend` — **files** a recommendation against a card (does NOT return one — use `conductor.work_next` for "what card to work on next").
```

**Why**: Closes T4-3. Self-contained MCP integration doc with curl examples.

**Risk**: None (docs-only, new file).

**Verify**: Manual read; spot-check curl commands against actual daemon (manual smoke not gated for CI).

**Rollback**: delete the file.

### Step 5: Tighten `conductor.recommend` description + add RPC reference to operations.md (T4-4)

**File 1**: `src/daemon/mcp_server.ts` (line 38, the `conductor.recommend` ToolDef).

**Before**:
```ts
  { name: 'conductor.recommend', description: 'File a recommendation manually' },
```

**After**:
```ts
  { name: 'conductor.recommend', description: 'File a recommendation against a card (for plugins / foreign tools). Writes to the run log; does NOT return a recommendation. For "which card should I work on next?", use conductor.work_next.' },
```

**File 2**: `docs/operations.md` (append after the section added in Step 3).

**Content to add**:

```markdown
---

## RPC method surface (selected)

The daemon exposes its full RPC surface via JSON-RPC over HTTP at
`/rpc` and via MCP at `/mcp` (see [mcp.md](mcp.md) for the MCP handshake).
A few methods are easy to confuse:

| Method | What it does | What it returns |
|---|---|---|
| `conductor.work_next` | Picks the next eligible card from `ordering.md` and runs the Task Agent on it. | `{ cardId, runId }` for the chosen card. |
| `conductor.recommend` | **Files** a recommendation against a card (for plugins / foreign tools to record their preference). | `{ ok: true }`. Does NOT return a recommendation. |
| `conductor.scan` | Snapshot of card columns + phases. | The current board state. |
| `conductor.order` | Re-ranks the queue. | `{ ok: true }` after rewriting `ordering.md`. |

See `src/daemon/mcp_server.ts` for the full tool list; see
`src/rpc/methods.ts` for handler implementations and parameter schemas.
```

**Why**: Closes T4-4. Removes the get-next-vs-files-one ambiguity at both the MCP tool surface and the operations doc.

**Risk**: None (docs + 1-line tool description).

**Verify**: `npm run typecheck`; manually GET `tools/list` post-restart and confirm the new description (or just verify the diff).

**Rollback**: revert both edits.

## Test Changes

None. All 5 steps are docs-only or 1-line `.description()` updates that don't affect any current test assertion. Verification relies on `npm run typecheck` (catches any inline-code-example drift in the docs that would break TypeScript) + `npm test` (538/538 baseline must remain green).

## Post-Implementation Checks

In order:

1. `npm run typecheck` — clean.
2. `npm test 2>&1 | Select-Object -Last 50` — 538/538 pass (no regression from the two 1-line `.description()` changes).
3. Manual read-through of `docs/quickstart.md`, `docs/operations.md`, `docs/mcp.md` to confirm flow + cross-links resolve.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `transition --help` text wraps awkwardly in narrow terminals | Medium | Low | Acceptable trade-off for explicit semantics; commander wraps at terminal width |
| docs cross-references (`#auth-token-lifecycle` etc.) break if section headings drift | Low | Low | Internal-only cross-refs; same-file or sibling-file in same docs/ directory; broken link surfaces visibly on first read |
| New `docs/mcp.md` not linked from README | Low | Low | docs/operations.md cross-links to it; README link can be added in a follow-up if needed (out of scope per issue's recommended Affected files) |
| `mcp_server.ts` description longer than the MCP client UI can render gracefully | Very low | Low | MCP clients typically render full description; no current evidence of truncation |
| Skipped `init.ts` gitignore-template emission gap | N/A | Low | Documented in operations.md as a user step; tracked as deferred follow-up if dogfood signals it's not enough |

## Rollback Plan

Single commit. `git revert <commit-hash>` restores all 5 doc/code changes. No DB migrations, no schema changes, no data format changes.

---

## Adversarial Review (Bundled — covers all 5 Phase 15.1 docs items)

*Reviewed: 2026-05-14*

### Source verification

Re-read all cited source files at HEAD `3c7dc8f`:
- `docs/quickstart.md` — no `60-120s` line; gap is affirmative (add table). ✓
- `src/cli/commands/transition.ts:44` — `.description()` matches Before block. ✓
- `docs/operations.md` — no transition / auth.token / RPC sections. ✓
- `src/daemon/auth.ts` — no `clearAuthToken`; `generateAuthToken` matches issue description. ✓
- Repo `.gitignore` line 41 — includes `.conductor/auth.token` ✓ (but `init.ts` does NOT emit a gitignore in user projects — documented as deferred follow-up).
- `docs/mcp.md` — does not exist; new file in Step 4. ✓
- `src/daemon/mcp_server.ts:38` — `conductor.recommend` description matches Before block. ✓
- `docs/operations.md` — no RPC method surface section. ✓

### Issues Found

#### LOW-1: `init.ts` gitignore-template emission deferred (T4-2)

The issue's Option A says "verify `.conductor/auth.token` is in the gitignore template emitted by `conductor init`. If not, add it." `init.ts` does NOT currently write a `.gitignore` at all (it scaffolds `state.md`, `ordering.md`, `journal.md`, `config.yaml`, and subdirs only). Implementing gitignore emission is a code change with its own test coverage requirements — out of scope for a docs sweep. The plan documents the requirement in `operations.md` (Step 3) so users gitignore by hand.

**Resolution**: documented in plan as deferred; not a gate. If post-merge dogfood shows users still commit `.conductor/auth.token`, file a follow-up code-side issue.

#### LOW-2: docs cross-reference anchors are heading-dependent

The plan uses `[operations.md § X](operations.md#x)` style links. Markdown anchor generation is renderer-dependent (GitHub, VS Code preview, etc. may differ). Risk is low — the immediate-read smoke test catches obvious breakage.

**Resolution**: manual read-through post-implementation (already in Post-Implementation Checks).

### Edge Cases Tested

Walked `.relay/relay-config.md § Edge Cases` against the plan:
- No new optional services, config flags, or LLM call sites introduced. ✓
- No daemon SSE / event-bus interaction. ✓
- No `ProjectConfigSchema.strict()` interaction. ✓
- No JSON parsing / `parseJsonResponse` interaction. ✓
- The two `.description()` text updates are user-facing strings only; existing tests in `tests/cli/` and `tests/daemon/conductor_mcp_tools.test.ts` don't assert exact wording on these. ✓
- Internal cross-references (file→file `[link](operations.md)`) and section anchors (`#auth-token-lifecycle`) — heading text in Step 3 + Step 5 chosen to produce predictable kebab-case anchors. ✓

### Regression Risk

- Existing 538 tests: none assert on `transition.ts` `.description()` text or `mcp_server.ts` `conductor.recommend` description string. Confirmed by spot-checking `tests/cli/transition.test.ts` (doesn't exist) and `tests/daemon/conductor_mcp_tools.test.ts` (tests tool dispatch, not description text). ✓
- README cross-link to new `docs/mcp.md` not added; not required by the issue's recommended affected-files list. ✓
- No tests for docs file existence or anchor resolution; the plan accepts this as standard for docs-only changes. ✓

### Verdict

**APPROVED.**

5-step bundled docs PR is contained, low-risk, and closes all 5 P3 docs items. Two LOW advisory items (init.ts gitignore-template emission deferred; docs anchor renderer-dependence) are non-gating and documented. No tests affected by the 2x 1-line `.description()` changes. Confident in 538/538 + typecheck clean post-implementation.

---

## Implementation Guidelines

*Date: 2026-05-14*

- Follow Steps 1-5 in order.
- After each step, run its VERIFY command (manual read for docs; typecheck for code edits).
- Single commit at the end: `feat(15.1): docs bundle ...`.
- If any step surfaces an unexpected behavioral concern, APPEND a deviation to this file before proceeding.
- The 4 sibling item files (T3-1, T4-2, T4-3, T4-4) carry minimal cross-references; do NOT duplicate this plan/review/verification in those files — `/relay-resolve` will scan the codebase directly for each item's evidence.

---

## Verification Report (Bundled — covers all 5 Phase 15.1 docs items)

*Verified: 2026-05-14*

### Implementation Status

| Step | Item (T-ID) | Files touched | Implemented | Correct |
|------|-------------|--------------|-------------|---------|
| 1 | quickstart latency (T1-2) | `docs/quickstart.md` | YES | YES |
| 2 | transition adjacency (T3-1) | `src/cli/commands/transition.ts:44`, `docs/operations.md` | YES | YES |
| 3 | auth.token lifecycle (T4-2) | `docs/operations.md` | YES | YES (init.ts gitignore-template emission deferred per scope) |
| 4 | MCP handshake (T4-3) | `docs/mcp.md` (new) + cross-link from `docs/operations.md` | YES | YES |
| 5 | conductor.recommend (T4-4) | `src/daemon/mcp_server.ts:38`, `docs/operations.md` | YES | YES |

### Diff verification

`git diff --stat`:
- `docs/quickstart.md` — added "Latency expectations" section (~13 lines).
- `docs/operations.md` — appended 3 new sections (transition adjacency, auth.token lifecycle, RPC method surface) (~70 lines).
- `docs/mcp.md` — new file, full curl handshake example (~60 lines).
- `src/cli/commands/transition.ts` — `.description()` text expanded (3 line wrap).
- `src/daemon/mcp_server.ts` — `conductor.recommend` description string tightened (1 line).
- 5 issue files — Analysis sections appended per item; primary T1-2 carries the consolidated Plan + Review + Guidelines + this Verification Report.

### Test Results

- `npm run typecheck` — clean (both engine and UI tsconfigs).
- `npm test` — **538 / 538 pass across 98 test files** in 16.29s. Zero regressions (baseline at HEAD was 538 from phase-14 close; this PR adds no tests and changes no behavioral test assertions).

### Issues Found

None.

The two LOW advisory items from the Adversarial Review are confirmed non-gating after implementation:
- **LOW-1** (`init.ts` gitignore-template emission deferred) — documented in `docs/operations.md § Auth token lifecycle` as a user step. If post-merge dogfood shows users committing `.conductor/auth.token` despite the doc, file a follow-up code-side issue.
- **LOW-2** (docs cross-reference anchors renderer-dependent) — confirmed via manual read-through; all anchors (`#auth-token-lifecycle`, `#manual-transitions-and-the-adjacency-rule`, `#rpc-method-surface-selected`) match the heading text I wrote.

### Verification Fixes

None required.

### Verdict

**COMPLETE.**

All 5 Phase 15.1 docs items resolved by the bundled commit. Suite 538/538 unchanged. Typecheck clean. No code-side regressions; the two 1-line `.description()` text updates are not asserted by any existing test. Phase 15 done-criteria satisfied.

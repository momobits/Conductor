# Phase 15 Steps

> 5 XS-complexity docs-only items from `.relay/relay-ordering.md § Phase 7`. The
> Relay ordering says "Ship as one PR" so the default decomposition is one
> bundled commit (`feat(15.1): docs bundle ...`) flipping the 15.1 checkbox.
> If any item's analysis surfaces an unexpected dependency on the others (or
> a code-side cleanup), split into 15.1a-15.1e sequential commits in one
> branch, with the final commit flipping the 15.1 checkbox.

- [ ] 15.1 — Documentation bundle: quickstart latency estimate, transition adjacency vs override, auth.token lifecycle + gitignore, MCP session handshake docs, conductor.recommend RPC semantics

## Step detail

### 15.1 — Documentation bundle

**Relay items** (all P3 observation, all from dogfood 2026-05-12):
1. `.relay/issues/quickstart-work-cycle-latency-estimate-understated.md` (T1-2) — `docs/quickstart.md` cites "60-120s" per `conductor work` cycle; reality is higher on Opus subscription.
2. `.relay/issues/transition-command-adjacency-vs-spec-override-semantics.md` (T3-1) — `conductor transition` enforces adjacency via `canTransition()`; spec language suggested it was a human-override. Document the actual semantics.
3. `.relay/issues/auth-token-persists-on-disk-after-daemon-stop.md` (T4-2) — `.conductor/auth.token` is not cleared by `daemon stop`, rotated on next start. Document the lifecycle; verify gitignore template.
4. `.relay/issues/mcp-tools-list-requires-session-handshake-docs-gap.md` (T4-3) — MCP `tools/list` requires `initialize` → `notifications/initialized` → `tools/list` with the captured session ID per MCP 2025-03-26. Currently undocumented.
5. `.relay/issues/rpc-recommend-method-semantics-docs-gap.md` (T4-4) — `conductor.recommend` FILES a recommendation; it does NOT return one. Tighten the public-facing description in tool list + `docs/rpc.md`.

**Complexity:** XS (all five). Per-item diff is small (≤10 lines per file).

**Planning:** This phase ships under the "Ship as one PR" guidance from
`.relay/relay-ordering.md § Phase 7`. The recommended flow is to run
`/relay-analyze` on all 5 items in one main-session pass (cheap because
the subsystem dimension is `skipped because target is documentation-only`
per `/relay-analyze` workflow.md's documentation-only short-circuit),
then a single bundled `/relay-plan` covering all 5 docs edits.
`/relay-review` is single-pass. Implementation is a sequence of
targeted Edit calls. `/relay-verify` runs `npm run typecheck` and
`npm test` to confirm no code drift slipped in via an inline code
example.

**What to do** (concrete per item):

| # | Item | Target file(s) | Change shape |
|---|------|----------------|--------------|
| 1 | quickstart latency | `docs/quickstart.md` | replace "60-120s" with a table of by-model-class estimates (Opus subscription, Sonnet, Haiku, OpenRouter, local) |
| 2 | transition adjacency | `docs/operations.md` + `src/cli/commands/transition.ts` `--help` string | document adjacency rule; clarify that `transition` is NOT an override |
| 3 | auth.token lifecycle | `docs/operations.md` (or `docs/security.md` if it exists; check) + verify `.gitignore.template` or `.gitignore` includes `.conductor/auth.token` | one paragraph on regen-on-start + not-cleared-on-stop |
| 4 | MCP session handshake | `docs/mcp.md` (or wherever MCP is documented) + curl example | step-by-step: initialize → notifications/initialized → tools/list w/ session ID |
| 5 | conductor.recommend semantics | `docs/rpc.md` (or wherever RPC methods are documented) + the `description` field in `src/rpc/methods.ts` for `conductor.recommend` (if present) | rewrite description: "files a recommendation" not "returns a recommendation" |

**What to verify:**

- `npm run typecheck` clean — guards against any inline code example
  drifting away from the actual API.
- `npm test` — full suite passes. No code paths changed; docs-only
  edits should not affect test outcomes.
- Manual scan: read each touched docs section, confirm the prose
  matches the actual code behavior at HEAD.

**Targeted test commands:**
- `npm run typecheck`
- `npm test 2>&1 | Select-Object -Last 50`

**Commit message template (single-commit path — preferred):**
```
feat(15.1): docs bundle — quickstart latency, transition semantics,
auth.token lifecycle, MCP session handshake, recommend RPC semantics

Closes 5 P3 docs-only items from the 2026-05-12 dogfood session:
T1-2, T3-1, T4-2, T4-3, T4-4. All items archived and impl docs
written. Suite unchanged (no code paths touched); typecheck clean.
```

**Commit message template (split-commit path — if an item surfaces a
code-side cleanup that needs isolation):**
```
docs(15.1a): quickstart latency by model class
docs(15.1b): transition adjacency vs override semantics
docs(15.1c): auth.token lifecycle + gitignore
docs(15.1d): MCP session handshake + curl example
docs(15.1e): conductor.recommend RPC method semantics
```
Final commit (whichever sub-step ships last) flips the 15.1 checkbox.

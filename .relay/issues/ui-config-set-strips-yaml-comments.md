# `config_set` strips all user comments from `config.yaml`

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of routing flow against omniforge.*
*Severity: P2 — silent removal of user-authored documentation in their own config file.*

## Problem statement

Any successful **Commit changes** (or any other write to `config.yaml` through `config_set`) wipes out every YAML comment line in the file. The user's narrative comments — typically setup instructions, caveats, and inline annotations — are removed without warning.

## Reproduction

1. `conductor init` (or use the omniforge claude-sub template) — produces a `config.yaml` with a multi-line `# Claude-subscription-only config — ...` preamble explaining the setup, prerequisites, launch steps, and caveats.
2. Open Routing in the UI. Make ANY edit (even a no-op space) and click **Commit changes**.
3. Inspect `config.yaml`. The entire preamble block is gone. `git diff` shows ~18 lines of comments removed.

Observed in omniforge (2026-05-15) — see `git diff .conductor/config.yaml`:

```diff
-# Claude-subscription-only config — routes every op through your locally
-# installed `claude` CLI (Claude Code). Uses your Pro/Max OAuth session;
-# no API key required; flat-rate billing.
-#
-# Prerequisites:
-#   1. Install Claude Code: https://claude.com/claude-code
-#   2. Run `claude login` interactively once
... (18 lines stripped)
 routing:
   default: claude-sub:sonnet
```

## Current state

- `src/rpc/methods.ts:227` — `const yaml = yamlDump(p.config, { lineWidth: 100, noRefs: true });`
- `js-yaml`'s `dump()` serializes the parsed object to a fresh YAML string. It has no comment-preserving mode. Comments live only in the source text, never in the parsed AST.

## Impact

- The init-emitted preamble (which `conductor init` writes for new users with prereq instructions) is destroyed the first time the user clicks **Commit changes**.
- Any user who annotates their config with `# why this model for analyze` style notes loses them.
- Pairs with [[ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults]] — the editor surface looks "lossless" but is actually destructive in two distinct ways.

## Proposed direction

Three options, in difficulty order:

- **A (lightest):** read the existing `config.yaml` text, take the comment lines + blank-line spacing, and re-emit them above the corresponding sections of the new dump. Heuristic preservation: comments above `routing:` stay above `routing:` after rewrite. Not perfect but covers the init preamble case.
- **B:** switch to a comment-preserving YAML library on the server side (e.g., `yaml` library's AST round-trip). More work but more correct.
- **C:** stop rewriting the entire file. `config_set` accepts a structural patch (e.g., JSON Patch or just per-section overlays) and the server applies a textual edit that preserves everything outside the touched sections. Hardest, but eliminates whole categories of bug at once. Subsumes the comment-strip and the field-default-overwrite bugs.

Option A is the smallest unblock; the init preamble is the most-visible casualty today.

## Verification path

After fix:

1. `conductor init` a fresh project. Verify config.yaml has its comment preamble.
2. Edit one field via the UI textarea, click **Commit changes**.
3. `git diff config.yaml` shows only the intended change. Comments preserved.

# Phase 23 Steps

- [x] 23.1 — Routing PR-2 (Relay #24 dropdown dirty guard + #27 comment preservation).

## Step detail

### 23.1 — Routing PR-2 cluster (Relay Phase 13 PR-2: #24 + #27)

Grouped run on Relay #24 leader. PR-1 already shipped the merge-aware `config_set`; #24's surgical-update implementation calls into that. #27's comment preservation layers on top — pick Option A (heuristic preservation: re-inject leading comment block above `routing:`) for the lightest unblock, or escalate to a comment-preserving YAML AST library if dogfood reveals more comment shapes.

**Verify command:** `npm test` + `npx vitest run tests/rpc/methods.test.ts tests/ui/ tests/config/`.

**Step-close commit:** `docs(23.1): flip steps.md checkbox for step 23.1`.

Commit message template per Control protocol: `<type>(23.1): <subject>`.

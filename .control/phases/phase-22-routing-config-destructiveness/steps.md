# Phase 22 Steps

- [x] 22.1 — Server-side merge in `config_set` (Relay #25 leader; grouped run with #26 Infinity coercion + #28 zod-error joined message).

## Step detail

### 22.1 — Routing config destructiveness fix (Relay Phase 13 PR-1: #25 + #26 + #28)

Single bundled step covering Relay Phase 13 PR-1's three items. Per `.relay/relay-ordering.md`:

- **#25 leader (M)** — `config_set` reads on-disk config, deep-merges request body over it, writes result. Kills the omitted-fields-reset class.
- **#26 (S)** — `Infinity` defaults coerced at the JSON boundary (custom replacer/reviver, or sentinel) so `config_get → config_set` roundtrip survives.
- **#28 (S)** — RPC layer returns zod errors as a joined human-readable string in `error.message`; structured zod array goes into `error.data` for tools.

**Verify command:** `npm test` + `npx vitest run tests/rpc/methods.test.ts tests/config/`.

**Step-close commit:** `docs(22.1): flip steps.md checkbox for step 22.1`.

Commit message template per Control protocol: `<type>(22.1): <subject>` where `<type>` ∈ `{feat, fix, refactor, test, docs, chore}`.

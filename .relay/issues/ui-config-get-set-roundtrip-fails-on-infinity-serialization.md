# `config_get` → `config_set` roundtrip fails because `.inf` JSON-serializes to `null`

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of routing RPC roundtrip.*
*Severity: P2 — programmatic clients of the config RPC cannot read-then-write.*

> Grouped into [ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults](ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md) run on 2026-05-16. See [ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults](ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md) for closure status and per-entry obligation (closure: full).

## Problem statement

`config_get` returns the daemon's parsed `ProjectConfig`. Two fields in the schema default to `Number.POSITIVE_INFINITY`:

```ts
// src/config/schema.ts:64-70
cost_ceilings: z.object({
  per_card_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),
  per_day_dollars:  z.number().positive().default(Number.POSITIVE_INFINITY),
  halt_on_breach:   z.boolean().default(false),
}).default({}),
```

When the daemon serializes the result to JSON (in the JSON-RPC response), `Infinity` is not a valid JSON value, so `JSON.stringify` writes it as `null`. The client receives `per_card_dollars: null`. Posting that same object straight back through `config_set` makes zod reject the request:

```json
{
  "code": "invalid_type",
  "expected": "number",
  "received": "null",
  "path": ["config", "cost_ceilings", "per_card_dollars"]
}
```

Confirmed via Playwright (2026-05-15): fetch `conductor.config_get` → take `result.config` → fetch `conductor.config_set` with `{ config }` → `-32602` error.

## Why it doesn't bite the Routing UI today

The Routing view's `yamlToConfig` parser drops every field outside `routing`, `autonomy`, `verify_command`. So the textarea-driven commit never sends `cost_ceilings` and the missing-field defaults take over. The bug only surfaces when a **programmatic client** (test harness, future UI feature, external tooling) tries to do a full-shape roundtrip.

## Current state

- `src/rpc/methods.ts:218-223` — `config_get` returns the parsed config straight through.
- `src/rpc/methods.ts:225-232` — `config_set` reparses via the same zod schema; `null` fails the `positive number` constraint.
- `src/config/schema.ts:66-67` — defaults use `Number.POSITIVE_INFINITY`.

## Impact

- A `relay-verify` / dogfood harness that wants to capture config, mutate one field, and commit it cannot do so naively.
- The Routing UI's "save error" surface is already ugly (see [[ui-routing-save-error-renders-raw-zod-json]]); if a future feature adds a "raw JSON edit" mode, this bug surfaces visibly.

## Proposed direction

Pick one (or combine):

- **A:** on `config_get`, replace `Infinity` with a JSON-safe sentinel (`null` is the current de-facto sentinel — make it explicit and document it). On `config_set`, coerce `null` back to `Infinity` for the cost-ceiling fields before zod parsing.
- **B:** change the schema default from `Number.POSITIVE_INFINITY` to a finite sentinel like `0` (with semantics: "0 = disabled / no ceiling"). Avoids non-JSON-representable values entirely.
- **C:** stop sending `cost_ceilings`/`confidence`/`run_log`/`brain_log`/`tracker` over the wire at all for the Routing endpoint, and add a dedicated `config_set_routing` RPC that only touches the fields the UI exposes. The unmodified fields stay on disk untouched.

Option C also fixes [[ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults]].

## Verification path

After fix:

```js
const { config } = await rpc.call('config_get');
const { ok } = await rpc.call('config_set', { config });
// expect ok === true
```

# Routing yaml commit silently resets schema-defaulted fields to their defaults

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of routing flow against omniforge.*
*Severity: P2 — silent data loss for any non-default config field outside the textarea's narrow shape.*

## Problem statement

The Routing textarea renders only `routing`, `autonomy`, and `verify_command`. The schema defines several more top-level fields with non-trivial defaults: `cost_ceilings`, `confidence`, `run_log`, `brain_log`, `tracker`. When the user clicks **Commit changes**, the client calls `config_set` with **only** the textarea's narrow shape. Zod parses the partial object and fills missing fields with their schema defaults. The server then writes the resulting full object back to `config.yaml`, **clobbering** any customizations the user had in those omitted fields.

## Reproduction

1. Manually edit `.conductor/config.yaml` to customize a cost ceiling: `cost_ceilings.per_card_dollars: 0.50`.
2. Open Routing in the UI.
3. Make any change to the textarea (e.g., add a space at the end).
4. Click **Commit changes**.
5. Re-read `config.yaml`. The cost ceiling reverts to `.inf` (its schema default).

## Why it doesn't bite the omniforge config today

The on-disk config happened to have schema-default values for all the affected fields, so the "reset to defaults" was idempotent in this specific test. A user who has *customized* any field outside the textarea's shape loses that customization the moment they commit.

## Current state

- `src/ui/views/routing.ts:37-73` — `yamlToConfig()` only constructs `{ routing, autonomy, verify_command }`. Any other key in the textarea is silently ignored; any field not in the textarea is missing from the submitted config.
- `src/rpc/methods.ts:225-232` — `config_set` calls `ConfigSetParams.parse(raw)` (which uses `ProjectConfigSchema`). Zod fills defaults for missing fields, then `yamlDump` writes the *full* normalized object back to disk.

## Impact

- The textarea hides the fact that other config keys exist.
- A user-friendly mental model would be "I'm editing these three sections; everything else stays the same." The actual behavior is "I'm editing the whole config; missing sections snap to defaults."
- Pairs with [[ui-config-get-set-roundtrip-fails-on-infinity-serialization]] (same surface, related cause).

## Proposed direction

Three options, in preference order:

- **A (preferred):** server-side merge. `config_set` reads the current on-disk config, deep-merges the request body over it, then writes the result. Missing fields preserve disk state.
- **B:** client-side merge. UI calls `config_get` immediately before `config_set`, deep-merges the textarea-parsed fields into the fetched object, then sends the whole thing. (Limitation: blocked by [[ui-config-get-set-roundtrip-fails-on-infinity-serialization]] until that's resolved.)
- **C:** expose the omitted fields in the textarea by widening `configToYaml` to emit them. Loses minimalism; bloats the editor. Not recommended.

Option A also retroactively makes `conductor_set_autonomy` (which constructs `{ ...ctx.config, autonomy: {...} }`) safer.

## Verification path

After fix:

1. Manually `cost_ceilings.per_card_dollars: 0.50` in `config.yaml`.
2. Use the UI to bump `verify_command`.
3. Read `config.yaml`. `cost_ceilings.per_card_dollars` should still be `0.50`, NOT `.inf`.

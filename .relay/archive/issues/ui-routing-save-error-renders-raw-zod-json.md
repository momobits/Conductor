> **ARCHIVED — RESOLVED IN GROUPED RUN** with [ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults](../../implemented/ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md). See run leader's Per-Entry Closure for closure status and obligation granularity.

# Routing config save error renders raw zod JSON instead of a readable message

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P2 — usability of the validation feedback path.*

> Grouped into [ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults](ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md) run on 2026-05-16. See [ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults](ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md) for closure status and per-entry obligation (closure: full).

## Problem statement

When `config_set` returns a validation error, the Routing view prints the error string verbatim. Because the server forwards the zod-formatted error array as the JSON-RPC message text, the user sees something like:

```
save failed — [ { "received": "", "code": "invalid_enum_value", "options": [ "inherit", "escort", "assist", "auto", "critical" ], "path": [ "config", "autonomy", "default" ], "message": "Invalid enum value. Expected 'inherit' | 'escort' | 'assist' | 'auto' | 'critical', received ''" } ]
```

…rendered on a single wrapping line inside the error `<div>`. The actual `message` field is buried inside the array.

## Current state

- `src/ui/views/routing.ts:131-151` — `saveBtn` handler concatenates the raw `err.message` into the user-facing string: `errEl.textContent = \`save failed — ${(err as Error).message}\`;`.
- The server-side handler returns the zod error array as the JSON-RPC error's `message`. Verified by submitting `this is not valid yaml: {{{` and clicking **Commit changes** (Playwright run 2026-05-15).

## Impact

The error contains the information the user needs (`Invalid enum value. Expected '...'`), but it is wrapped in noise. A user who hits this in real config editing has to mentally parse a zod error array to find the message — high friction for what should be a pointed correction.

## Proposed direction

Either:
- **A:** server returns the joined `.message` strings (one per error) as the JSON-RPC error message; structured details optionally in `error.data` for programmatic clients. Browser-side stays simple.
- **B:** browser-side parses the message-as-JSON-array and renders one line per error, leading with `path` + `message`.

Option A is cleaner — keeps the wire format human-friendly by default. Same fix improves any other JSON-RPC client that surfaces these errors.

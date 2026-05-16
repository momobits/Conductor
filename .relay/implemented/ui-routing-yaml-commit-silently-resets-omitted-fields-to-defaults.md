# Routing yaml commit silently resets schema-defaulted fields to their defaults

## Summary

*Resolved: 2026-05-16*

Phase 22 closed Relay Phase 13 PR-1 as a **grouped run** of 3 entries (#25 leader + #26 + #28 siblings) sharing the `config_set` RPC boundary. The grouped run shipped as 3 commits in one branch (Commits A/B/C) plus a step-close commit.

**Problem**: every UI Routing commit silently destroyed disk-resident customizations in 5 top-level config blocks (`cost_ceilings`, `confidence`, `run_log`, `brain_log`, `tracker`). Cause: `config_set` re-parsed the request body through `ProjectConfigSchema`, which filled omitted fields with schema defaults, then wrote the full normalized object to disk. Compounding: `cost_ceilings.per_card_dollars` defaults to `Number.POSITIVE_INFINITY` which JSON serializes as `null`, causing roundtrip failure for any programmatic client; the RPC error formatter forwarded ZodError's `.message` (a JSON-stringified array of issues) verbatim, producing unreadable single-line wraps in the UI's error pane.

**Approach**: server-side deep-merge in `config_set` reading the disk baseline via `loadProjectConfig`, merging the user's partial body over it, then re-validating via `ProjectConfigSchema`. **Critical /relay-review fix**: the handler bypasses `ConfigSetParams.parse` because that path fills schema defaults for omitted fields, which would defeat the merge by overwriting disk customizations with defaults. The corrected flow shape-checks via `z.record(z.unknown())` and treats the inner config as `Partial`. Cost_ceilings preprocess transforms `null → Infinity` at the schema layer, making JSON roundtrip transparent. HTTP RPC error handler formats `ZodError.issues` as `<path>: <msg>` joined by `; ` (top-level refines labeled `(root)`); structured issues exposed in `error.data.issues`.

## Files Modified

**Schema layer**
- `src/config/schema.ts` — `cost_ceilings.per_card_dollars` and `per_day_dollars` use `z.preprocess(v => v === null ? Infinity : v, z.number().positive()).default(Infinity)`. Accepts JSON's `null` form of Infinity at parse time; preserves `z.number().positive()` rejection for zero/negative/non-numeric inputs.

**RPC layer**
- `src/rpc/methods.ts:config_set` — bypasses `ConfigSetParams.parse` for the merge phase (it would fill defaults and defeat the merge); shape-checks via `z.object({ config: z.record(z.unknown()) })`; reads disk baseline via `loadProjectConfig` with ENOENT → `ProjectConfigSchema.parse({})` fallback; deep-merges user's partial over disk baseline via new `deepMergeConfig` helper; re-validates merged result via `ProjectConfigSchema.parse` so type errors in user input (e.g., `routing.default: 123`) still surface as ZodErrors; aligns `ctx.config` with merged disk state.
- `src/rpc/methods.ts:deepMergeConfig` (new) — overlays user partial over disk baseline. Iterates patch keys only (omitted keys preserve base). Plain-object pairs at the second level use shallow merge (`{ ...baseVal, ...patchVal }`); arrays and primitives replaced wholesale; `tracker` discriminatedUnion replaced wholesale when `kind` differs to prevent field cross-pollination between variants.
- `src/rpc/methods.ts:isPlainObject` (new) — type guard excluding arrays + null.
- `ConfigSetParams` import removed from `src/rpc/methods.ts` (no longer used by the handler); schema export in `src/rpc/schema.ts` retained for future callers.

**Daemon HTTP layer**
- `src/daemon/http_server.ts:97-118` — RPC error catch block now branches on `ZodError`. Formats `err.issues` as `<path>: <msg>` joined by `; ` for `error.message`; top-level refines (empty path) labeled `(root)`; structured `ZodIssue[]` exposed in `error.data.issues` for programmatic clients. Non-ZodError path unchanged.

**Tests** (+11 net new; baseline 585 → 596)
- `tests/config/schema-phase22.test.ts` — NEW, 7 tests (default Infinity; null→Infinity coerce on both fields; finite values pass; full JSON roundtrip preserves Infinity; non-numeric rejected; zero/negative rejected — `z.number().positive()` preserved).
- `tests/rpc/methods.test.ts` — EXTENDED with +2 tests (`config_set preserves disk-resident customizations on partial commit (#25)`; `config_set roundtrip with Infinity defaults works without scrubbing (#26)`). 24/24 total.
- `tests/daemon/http_server.test.ts` — EXTENDED with +2 tests (`ZodError message is human-readable joined string with structured issues in error.data` — invalid `card_new` returns formatted message + `error.data.issues`; `refine error formats top-level path as (root)` — `card_update` refine produces `^\(root\):` prefix). 8/8 total.

## Verification

- Full suite: `npm test` → **596/596 pass** (baseline 585 → +11 net new) in ~16s across 102 test files.
- Typecheck: `npm run typecheck` → clean for both engine and UI tsconfigs.
- Targeted regression: `npx vitest run tests/config/ tests/rpc/ tests/daemon/http_server.test.ts` → 82/82 in ~2.8s.
- Manual smoke (recommended at /phase-close): pre-seed `.conductor/config.yaml` with `cost_ceilings: { per_card_dollars: 0.50, halt_on_breach: true }`. Open UI Routing. Edit a `routing.functions.X` line. Commit. Re-read disk. `cost_ceilings` block must be intact. Then commit a deliberately invalid `autonomy.default: typo`; error pane must show `config.autonomy.default: Invalid enum value. Expected '...', received 'typo'` (single readable line, no `[{`).

## Caveats

- **`routing.functions` and `autonomy.transitions` shallow inner merge** — the second-level merge is `{ ...baseVal, ...patchVal }`, which replaces inner maps wholesale per top-level key. The UI's `configToYaml` always emits the COMPLETE functions/transitions map (verified at `src/ui/views/routing.ts:19-35`), so the textarea path is unaffected. A programmatic client sending a partial functions map (e.g., `{ routing: { functions: { analyze: 'opus' } } }` intending to update just `analyze` while preserving `plan: 'haiku'` on disk) would have its merge replace the full functions map. Documented as future-extension area; not surfaced by current dogfood. If a programmatic client needs deeper-merge semantics, file a follow-up.
- **`ConfigSetParams` export retained but unused in methods.ts** — kept in `src/rpc/schema.ts` for future callers (other RPC handlers, potential external tooling). The export is harmless but technically dead from the current code path's perspective. Removal deferred until a future cleanup pass.
- **`loadProjectConfig` adds ~1ms disk read per config_set call** — acceptable for an interactive config-edit RPC; not on any hot path.
- **Pattern precedent at n=3+**: pure-helper extraction (Phase 18 + Phase 20 + Phase 21 substrate helpers + Phase 22 `deepMergeConfig` / `isPlainObject`); JSONL/markdown-writer family (n=3 at Phase 21). Both thresholds fired multiple phases back. ADR filing remains deferred per operator decision; no new pressure introduced by this phase.
- **Closes Relay Phase 13 PR-1**: #25 (full), #26 (full), #28 (full). PR-2 items (#24 routing autonomy dropdown overwrite + #27 yaml comment preservation) deferred to Phase 23 per established ordering; PR-2 depends on PR-1's merge-aware `config_set` for the dropdown's surgical-update implementation.

## Per-Entry Closure

| # | Target | Kind | Obligation | Disposition | Citation |
|---|--------|------|------------|-------------|----------|
| 1 | ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults (this — run leader) | run leader | full | closed | This impl doc + `tests/rpc/methods.test.ts` #25 regression. |
| 2 | ui-config-get-set-roundtrip-fails-on-infinity-serialization | existing item | full | closed | `src/config/schema.ts:64-78` + `tests/config/schema-phase22.test.ts` roundtrip test + `tests/rpc/methods.test.ts` #26 regression. |
| 3 | ui-routing-save-error-renders-raw-zod-json | existing item | full | closed | `src/daemon/http_server.ts:97-118` + `tests/daemon/http_server.test.ts` two new tests. |

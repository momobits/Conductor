> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md)

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

---

## Analysis

*Analyzed: 2026-05-16*

### Validation

- **Problem still exists: YES.** Confirmed at HEAD `098474c`:
  - `src/rpc/methods.ts:225-232` — `config_set` calls `ConfigSetParams.parse(raw)` which routes through `ProjectConfigSchema.parse` (`src/rpc/schema.ts:102-104`). Zod fills omitted top-level fields with their schema defaults; the full normalized object is then `yamlDump`'d to disk via line 228.
  - `src/ui/views/routing.ts:37-73` — `yamlToConfig` constructs a partial `{ routing, autonomy, verify_command }` object; sends it to `config_set`. Lines 74-159 confirm only those 3 fields are emitted by `configToYaml` either, so the round-trip never sees `cost_ceilings`, `confidence`, `run_log`, `brain_log`, `tracker`.
  - `src/config/schema.ts:66-67` — `Number.POSITIVE_INFINITY` defaults (#26 root cause). All other defaults are finite (`keep_days: 30`, `keep_last_n: 200`, `poll_interval_ms: 0`).
  - `src/daemon/http_server.ts:101-103` — `err.message` forwarded verbatim into JSON-RPC `error.message`. ZodError's `.message` getter returns a JSON-stringified array of issues, which is what surfaces in the UI's error div (#28 root cause).
- **Proposed approach still valid: YES (Option A — server-side merge).** Option B (client-side merge) was blocked by #26 (Infinity round-trip). PR-1's combined fix (deep-merge + Infinity coercion + zod-error join) closes that gap by handling Infinity at the schema layer rather than the wire.

### Root Cause

Three converging failures share the `src/rpc/methods.ts:config_set` boundary:

1. **Full-overwrite write semantic**. `config_set` does `parse → write full object`. There is no merge against disk state; any field absent from the request body gets the schema default. The textarea's narrow shape (`routing` + `autonomy` + `verify_command`) is therefore destructive to the 5 other top-level fields.
2. **JSON's loss of Infinity**. `cost_ceilings.per_card_dollars` and `.per_day_dollars` default to `Number.POSITIVE_INFINITY`. `JSON.stringify` emits `Infinity` as `null`. `config_get` over the JSON-RPC wire returns `null` to the client; sending that back through `config_set` fails `z.number().positive()` because `null` doesn't pass `typeof === 'number'`.
3. **ZodError.message is JSON-array shaped**. `http_server.ts:101-103` forwards `err.message` for any handler throw. For a ZodError, that string is the JSON-stringified `issues` array — readable only after re-parsing the message string. The UI prints it verbatim, producing the unreadable single-line wrap reported in `ui-routing-save-error-renders-raw-zod-json`.

All three resolve at the same RPC boundary; bundling them as PR-1 prevents three separate visits.

### What This Means (User Impact)

**In plain terms:** Right now, every time you commit a change in the Routing UI, the daemon silently resets your cost-ceiling, retention, and tracker config back to their built-in defaults — even though the UI only intended to update the routing/autonomy/verify_command sections. The cost-ceiling values can't be safely round-tripped through the daemon's HTTP API at all, because the default value is `infinity` and JSON can't represent that — so any tool trying to read-then-write the config gets rejected. And when something goes wrong, the error pane shows a wall of JSON instead of the actual problem.

**Scenario A — silent customization wipe (#25):**

> You're tightening cost-ceilings on a real card-running setup. You hand-edit `.conductor/config.yaml`:
>
> ```yaml
> cost_ceilings:
>   per_card_dollars: 0.50
>   halt_on_breach: true
> ```
>
> The daemon reloads and respects the ceiling. Later in the day, you open the Routing UI to swap the `analyze` model from `claude-sonnet-4-6` to `claude-opus-4-7`. You edit the textarea and click **Commit changes** — the routing-functions update lands. Later you check whether the brain wedged on a budget breach. You re-read `.conductor/config.yaml`. The cost ceiling is gone:
>
> ```yaml
> cost_ceilings:
>   per_card_dollars: .inf
>   halt_on_breach: false
> ```
>
> No warning, no diff. The cards have been running unchecked since the routing commit. No way to know without grepping the file.

**Before:** every commit silently resets ~5 top-level config blocks to schema defaults; user-customized values are lost without any signal.
**After:** server reads on-disk config, deep-merges the request body over it; only fields explicitly present in the request are touched. The on-disk `cost_ceilings.per_card_dollars: 0.50` survives every routing edit.

**Scenario B — programmatic round-trip rejection (#26):**

> You write a small script to bulk-update tracker config across 12 projects. It calls `config_get`, mutates one field, calls `config_set` with the result:
>
> ```js
> const { config } = await rpc.call('config_get');
> config.tracker = { kind: 'linear', api_key_env: 'LINEAR_API_KEY', project_slug: `proj-${id}`, ... };
> await rpc.call('config_set', { config });
> ```
>
> Every call returns `-32602 invalid_type: expected number, received null at config.cost_ceilings.per_card_dollars`. You realize the daemon returned `null` for Infinity over JSON. You can manually delete `cost_ceilings` from the request body, but now you're guessing which other fields have JSON-unsafe defaults.

**Before:** any read-then-write workflow against the RPC fails on Infinity defaults; clients have to know which fields to scrub.
**After:** schema accepts `null` as a synonym for `+Infinity` on `cost_ceilings.per_*` fields; round-trip works without client knowledge.

**Scenario C — unreadable validation error (#28):**

> You commit a routing edit with `autonomy.default: typo`. The error pane shows:
>
> ```
> save failed — [ { "received": "typo", "code": "invalid_enum_value", "options": [ "inherit", "escort", "assist", "auto", "critical" ], "path": [ "config", "autonomy", "default" ], "message": "Invalid enum value. Expected 'inherit' | 'escort' | 'assist' | 'auto' | 'critical', received 'typo'" } ]
> ```
>
> The information you need (`Invalid enum value. Expected '…'`) is buried inside a JSON-stringified array on one wrapping line.

**Before:** zod errors render as raw JSON arrays — high parsing friction.
**After:** server-side joiner converts `ZodError.issues` into `<path>: <message>; <path>: <message>` on the JSON-RPC `error.message` field; structured details optionally available in `error.data` for tools.

### Blast Radius

**Files / functions to change:**

| File | Function | Change |
|------|----------|--------|
| `src/rpc/methods.ts` | `config_set` | Read on-disk YAML before write; deep-merge request body over it; write merged result. ~15 lines |
| `src/config/schema.ts` | `cost_ceilings` schema | `per_card_dollars` and `per_day_dollars` accept `null` as Infinity via `.preprocess`/`z.union` transform. ~6 lines |
| `src/daemon/http_server.ts` | RPC error handler (lines 100-103) | ZodError → `issues.map(...).join('; ')` for human-readable `.message`; optionally `data: err.issues` for programmatic clients. ~6 lines |
| `src/rpc/methods.ts` (optional) | `config_get` | No change needed if schema-side null↔Infinity transform is symmetric; JSON serialization already produces `null` for Infinity (de-facto behavior). |

**New helpers (likely):**
- A small `deepMerge(base, patch)` in `src/rpc/methods.ts` or `src/config/merge.ts`. Sufficient for plain-object record types; arrays in the schema (`labels`, `blocked_by`, `active_states`) should be replace-not-merge (patch wins; this is the right shallow semantic for arrays in YAML configs).

**Callers / consumers to audit:**
- `src/rpc/methods.ts:conductor_set_autonomy` (line 294-299) — calls `methods.config_set(ctx, { config: next })` where `next = { ...ctx.config, autonomy: { ...ctx.config.autonomy, default: p.mode } }`. After deep-merge, this remains correct: `next` contains all fields from `ctx.config`, so the merge is a no-op for non-autonomy paths. **No regression**; in fact safer because partial autonomy updates from this path become explicit.
- `src/ui/views/routing.ts:117-118` — autonomy dropdown also calls `conductor_set_autonomy` then re-fetches via `config_get` (the #24 dirty-guard issue, deferred to PR-2).
- `tests/rpc/methods.test.ts:187-232` — existing `config_set` test sends a full custom routing/autonomy/verify_command config; asserts those values round-trip. New behavior: omitted fields now PRESERVE disk state (regression test needed). Existing assertions stay valid.

**Test coverage status (current 585 baseline):**
- `tests/rpc/methods.test.ts:187` `config_set validates the YAML and writes the file` — needs extension for omitted-field preservation.
- `tests/rpc/methods.test.ts:212` `config_set rejects invalid config with a validation error` — should still pass; verify the error message is human-readable now (could add assertion on shape).
- `tests/rpc/methods.test.ts:220` `config_set publishes config-changed on the bus` — unchanged.
- New tests needed:
  - **#25 regression**: pre-seed `.conductor/config.yaml` with custom `cost_ceilings.per_card_dollars: 0.50`; call `config_set` with a partial `{ routing, autonomy, verify_command }` body; assert disk still has `per_card_dollars: 0.50`.
  - **#26 regression**: full `config_get` → `config_set` round-trip with no client-side scrubbing; assert no error + `per_card_dollars` still Infinity (or equivalent) after round-trip.
  - **#28 regression**: send invalid config (e.g., bad enum); assert thrown error's `message` is human-readable (no raw `[{` JSON-array prefix); assert `data` carries the structured `issues` array.
- Test count delta target: +3 to +5 → 588-590.

**Config interactions:**
- `ProjectConfigSchema` strict mode (`.strict()` at line 114) — passes only if request body contains no unknown top-level keys. Deep-merge must NOT introduce unknown keys; the merge output is always a valid `ProjectConfig` (since merged from two valid sources).
- `loadProjectConfig` (`src/config/load.ts`) — used by `config_get` to read fresh. The deep-merge fix could re-use `loadProjectConfig` to read on-disk before merging; cleaner than reading raw text.

**Cross-item interactions:**
- Phase 12 #20 partial closure tracked the plan-op dual-write shim sunset in `engine-ops-still-append-to-card-body.md`. No interaction with this phase (different RPC surface).
- Phase 13 #24 (dropdown dirty guard) deferred to PR-2 — its "auto-merge surgically" implementation depends on PR-1's deep-merge being in place.
- Phase 13 #27 (yaml comment preservation) deferred to PR-2 — yamlDump strips comments; orthogonal to PR-1's merge semantic. Will benefit from a deep-merge baseline because comment preservation only matters when disk state is preserved.

**Past work regression risk:**
- **Phase 14.1** (`brain_log` config block addition) — added a new top-level field with `.default({})`. Deep-merge handles this correctly: a request body without `brain_log` doesn't reset the on-disk `brain_log` block. Improvement, not regression.
- **Phase 6** (`BrainLogWriter`) — reads config at daemon boot. `ctx.config` is updated via `Object.assign(ctx.config, p.config)` at line 230. With deep-merge, in-memory update should ALSO be deep-merged to match disk state. Verify in implementation.

### Related Work

*Search dimensions executed: live codepath audit | backlog codepath | subsystem | archive | implemented | contract drift*
*Tooling: grep for symbol + prose searches (Serena MCP not invoked).*

#### Findings

- **Target:** `.relay/issues/ui-config-get-set-roundtrip-fails-on-infinity-serialization.md` (#26)
  - **Kind:** existing item
  - **Evidence:** **strong** (shares file `src/rpc/methods.ts:config_set`, shares schema `src/config/schema.ts:cost_ceilings`)
  - **Why related:** same RPC handler boundary; the Infinity round-trip failure is asymptomatic in the current Routing UI only because `yamlToConfig` drops the field before sending — but once deep-merge lands, the field WILL be present in the merged result via the disk read, and `config_set` must accept `null` (the JSON-serialized form of Infinity) without rejecting. Solving #26 at the schema layer (preprocess `null → Infinity`) makes deep-merge transparent to JSON's loss-of-Infinity.
  - **Suggested handling:** **group into current run** — without #26 fixed, the deep-merge of #25 would resurface as a new failure mode.

- **Target:** `.relay/issues/ui-routing-save-error-renders-raw-zod-json.md` (#28)
  - **Kind:** existing item
  - **Evidence:** **strong** (shares the RPC error pipeline `src/daemon/http_server.ts:101-103`; same surface as #25's failure-mode signalling)
  - **Why related:** Server-side join of `ZodError.issues` into a human-readable string is a one-line fix at the same RPC error boundary that signals #25 / #26 validation failures. Bundling avoids two visits to the same try/catch.
  - **Suggested handling:** **group into current run** — explicitly per Phase 13 PR-1 strategy.

- **Target:** `.relay/issues/ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md` (#24, P1)
  - **Kind:** existing item
  - **Evidence:** **medium** (shares file `src/ui/views/routing.ts`; depends structurally on this fix per relay-ordering.md Phase 13 explicit ordering)
  - **Why related:** the dropdown's "auto-merge surgically" plan depends on `config_set` being merge-aware. PR-1 unblocks PR-2 mechanically.
  - **Suggested handling:** **keep narrow** (deferred to Phase 23 PR-2 per established ordering).

- **Target:** `.relay/issues/ui-config-set-strips-yaml-comments.md` (#27)
  - **Kind:** existing item
  - **Evidence:** **medium** (shares `src/rpc/methods.ts:config_set` and `yamlDump` call)
  - **Why related:** comment preservation depends on the merge being in place — comment preservation is only valuable if disk state is preserved. Orthogonal mechanism (needs comment-preserving YAML library); deferred per Phase 13 PR split.
  - **Suggested handling:** **keep narrow** (deferred to Phase 23 PR-2).

- **Target:** `src/rpc/methods.ts:conductor_set_autonomy`
  - **Kind:** existing call site
  - **Evidence:** **strong** (direct caller of `config_set`)
  - **Why related:** after deep-merge lands, this call path still works correctly because `next` includes all fields from `ctx.config`. No code change needed; documented for impl-doc audit trail.
  - **Suggested handling:** **keep narrow** (no change).

- **Target:** `unfiled: src/config/schema.ts:tracker.discriminatedUnion::project_slug — required field has no default`
  - **Kind:** unfiled candidate
  - **Evidence:** **weak** (live-source observation; not in current dogfood backlog)
  - **Why related:** while reviewing schema for Infinity defaults, noticed `tracker` discriminatedUnion's `linear` variant requires `project_slug` (no default). If the on-disk config sets `tracker.kind: linear` without `project_slug`, parse fails. Out of PR-1 scope; documented for future operator awareness.
  - **Suggested handling:** **keep narrow** (no action this phase; possibly file a separate issue later if dogfood surfaces it).

- **Target:** `.relay/implemented/brain-events-not-persisted-across-daemon-restarts.md` (Phase 14.1)
  - **Kind:** implementation precedent
  - **Evidence:** **medium** (`brain_log` config block added with `.default({})`; same schema file)
  - **Why related:** establishes the "new config block with `.default({})`" pattern Phase 22 inherits. Confirms `brain_log` won't get reset by a partial commit once deep-merge lands.
  - **Suggested handling:** **keep narrow** (cite in impl doc).

#### Search Bounds

- Live codepath audit: complete (`config_set`, `config_get`, `conductor_set_autonomy`, `yamlToConfig`, `configToYaml`, http_server RPC error handler, ProjectConfigSchema, loadProjectConfig).
- Backlog codepath: complete (17 active issues scanned via Explore agent; 4 share Phase 13 cluster).
- Subsystem: complete (`src/rpc/`, `src/config/`, `src/ui/views/routing.ts`, `src/daemon/http_server.ts`).
- Archive: complete (24 archived issues; no config-merge precedent found).
- Implementation: complete (20 implemented; Phase 14.1 schema pattern cited).
- Contract drift: complete (`Number.POSITIVE_INFINITY` appears at 2 schema sites + 2 logic-cutoff sites; only schema sites need transform).

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-16
*Rationale:* Per the rubric "Medium/strong findings sharing target's root cause | Grouped run" — #26 and #28 both share the `config_set` RPC boundary with #25, both have strong evidence grade, and Phase 13 ordering explicitly bundles them as PR-1. The structural fix (deep-merge in `config_set`) makes #26 (Infinity round-trip) survive by changing the schema to accept `null` as Infinity, and #28 (error join) is a one-line change at the same try/catch boundary that signals validation failures for both. Splitting these three would force three round-trips through the same RPC handler with overlapping test coverage. #24 and #27 are explicitly deferred to Phase 23 PR-2 per the established ordering.

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults | run leader | n/a | full |
| 2 | ui-config-get-set-roundtrip-fails-on-infinity-serialization | existing item | strong | full |
| 3 | ui-routing-save-error-renders-raw-zod-json | existing item | strong | full |

#### Planner Contract

- `/relay-plan` must emit a `### Grouped Run Coverage` section.
- The coverage section must map every grouped entry to at least one concrete plan step.
- Each entry has closure obligation `full`; plan must include explicit file or symbol coverage for each.
- If the planner cannot cover an entry cleanly, it must stop and route back to scope reduction rather than silently continue.

#### Closure Contract

- `/relay-review` must verify each grouped entry's cited evidence is addressed in the plan.
- `/relay-verify` must verify the diff touched the files or symbols promised by the plan's `Grouped Run Coverage` section.
- `/relay-resolve` must record per-entry closure status; any entry remaining open must be re-opened or have a follow-up filed.

### Approach

**Recommended approach: Option A (server-side deep-merge) + schema-layer Infinity coercion + RPC error-handler join.**

Single commit (`feat(22.1)`) or three small commits in one branch — likely single commit since all 3 fixes converge on the same handler boundary and share tests.

1. **`#25` server-side deep-merge in `config_set`**:
   - Read on-disk YAML via `loadProjectConfig(path)` to get a parsed, defaults-filled baseline.
   - Deep-merge request body's `p.config` over the baseline (plain-object merge with array-replace semantics; tracker discriminatedUnion replaced as a whole if `kind` differs).
   - Re-validate the merged result via `ProjectConfigSchema.parse` (guards against the merge producing an invalid shape).
   - `yamlDump` the merged + revalidated object.
   - In-memory `Object.assign(ctx.config, merged)` (still shallow at top-level — sufficient because we just re-merged disk + patch and the result is canonical).

2. **`#26` Infinity coercion at the schema layer**:
   - Change `per_card_dollars` and `per_day_dollars` from `z.number().positive().default(Number.POSITIVE_INFINITY)` to `z.preprocess(v => v === null ? Number.POSITIVE_INFINITY : v, z.number().positive()).default(Number.POSITIVE_INFINITY)`.
   - This accepts `null` as a synonym for Infinity at parse time; the JSON round-trip (`Infinity → null → Infinity`) becomes transparent.
   - No changes to `config_get`; existing JSON serialization continues to emit `null` for Infinity, which the new preprocess accepts on the way back.

3. **`#28` zod-error join in HTTP RPC handler**:
   - In `src/daemon/http_server.ts:100-103`, when `err instanceof ZodError`, format `err.issues` as `issues.map(i => \`${i.path.join('.') || '(root)'}: ${i.message}\`).join('; ')` for the JSON-RPC `error.message`.
   - Optionally include `data: { issues: err.issues }` in the envelope for programmatic clients.

**Step-close commit:** `docs(22.1): flip steps.md checkbox for step 22.1`.

**Alternatives considered and rejected:**

- **Option B (client-side merge in routing.ts)** — rejected. Requires the client to read full config, mutate it, and send the whole thing. Blocked by #26 (which Option A fixes server-side anyway). Pushes complexity to every future client.
- **Option C (dedicated `config_set_routing` RPC)** — rejected. Adds API surface (a new method per config slice) and forces every future UI feature touching config to choose between full and partial set. Deep-merge is the general solution.
- **Schema change to finite sentinel `0` instead of Infinity** (from #26 issue's Option B) — rejected. Semantic shift (`0 = disabled`) requires every consumer of cost-ceilings to handle the sentinel; cost_guard, brain log, and any future cost-aware code would need migration. Preprocess `null → Infinity` is local to the schema and preserves the existing in-memory semantic.
- **Client-side JSON-array parse for #28** (issue's Option B) — rejected. Bandages the wire format instead of fixing it; every future JSON-RPC client would re-implement the parse.
- **Including #24 + #27 in PR-1** — rejected per Phase 13 ordering. PR-2 depends on PR-1's deep-merge being in place; sequencing is intentional.

**Open questions / decisions needed before implementation:**

1. **Where does `deepMerge` live?** Recommend inline helper in `src/rpc/methods.ts` (single use site; ~10 lines). If used by PR-2 later for UI surgical updates, extract to `src/config/merge.ts`. Initial inline-then-extract pattern matches Phase 21's `RunArtifactWriter` precedent (started as new module because n=3).
2. **Should arrays be merged or replaced?** Replace. `labels`, `blocked_by`, `tracker.active_states` are wholesale-replace semantics in YAML config; partial-array merge would be surprising. Plan implementation will document this.
3. **Should `tracker` (discriminatedUnion) be merged or replaced?** Replace when `kind` differs; otherwise field-merge within the same kind. Implementation can simplify to always-replace if the merge complexity isn't worth it; clarified in plan.
4. **In-memory `ctx.config` update path**. Current shallow `Object.assign(ctx.config, p.config)` is also affected — should this be `Object.assign(ctx.config, merged)` (the deep-merge result)? Yes — keeps daemon's in-memory state aligned with disk.
5. **`error.data` payload shape**. Plan can ship `error.data = { issues: err.issues }` for programmatic clients OR keep `error.data` undefined (simpler; #28's issue file doesn't require it). Recommend including for forward-compat — costs nothing, helps future tooling.

---

## Implementation Plan

*Generated: 2026-05-16*

Three changes, three commits in one branch (each is testable in isolation and safe-to-stop-here):

- **Commit A** (`feat(22.1)`) — `#26` Infinity coercion at the schema layer. Foundation for Commit B's roundtrip; lands first so the schema accepts the JSON-serialized `null` form of Infinity.
- **Commit B** (`feat(22.1)`) — `#25` server-side deep-merge in `config_set`. Reads on-disk via `loadProjectConfig`, deep-merges request body over it, revalidates, writes merged result.
- **Commit C** (`feat(22.1)`) — `#28` zod-error join in HTTP RPC handler. One-line readable error; structured issues in `error.data`.

Step-close commit (`docs(22.1)`) flips the steps.md checkbox after all three land.

### Step 1: Schema accepts `null` as a synonym for Infinity on cost ceilings

**File**: `src/config/schema.ts`, `cost_ceilings` object schema (lines 64-70)

**Before** (current code):
```ts
    cost_ceilings: z                                                                   // ← top-level cost-ceiling block; .default({}) below fills if missing
      .object({                                                                        // ← object shape
        per_card_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),     // ← BUG #26: default is non-JSON-representable; round-trip via JSON returns null which fails z.number().positive()
        per_day_dollars: z.number().positive().default(Number.POSITIVE_INFINITY),      // ← BUG #26: same — second Infinity default
        halt_on_breach: z.boolean().default(false),                                    // ← unchanged: boolean default, JSON-safe
      })                                                                               // ← end object
      .default({}),                                                                    // ← unchanged: fills empty object if entire block missing
```

**After** (proposed change):
```ts
    cost_ceilings: z                                                                   // ← unchanged: top-level cost-ceiling block
      .object({                                                                        // ← unchanged: object shape
        per_card_dollars: z                                                            // ← per-card budget; field now accepts null as Infinity sentinel
          .preprocess(                                                                 // ← NEW: coerce input before z.number().positive() validates
            (v) => (v === null ? Number.POSITIVE_INFINITY : v),                        // ← NEW: null → Infinity; non-null pass through unchanged
            z.number().positive(),                                                     // ← unchanged inner constraint: positive number
          )
          .default(Number.POSITIVE_INFINITY),                                          // ← unchanged: default still Infinity (preprocess only fires on present-but-null inputs)
        per_day_dollars: z                                                             // ← per-day budget; same shape as above
          .preprocess(                                                                 // ← NEW: same coercion
            (v) => (v === null ? Number.POSITIVE_INFINITY : v),                        // ← NEW: null → Infinity
            z.number().positive(),                                                     // ← unchanged inner constraint
          )
          .default(Number.POSITIVE_INFINITY),                                          // ← unchanged: Infinity default
        halt_on_breach: z.boolean().default(false),                                    // ← unchanged: boolean default
      })                                                                               // ← unchanged: end object
      .default({}),                                                                    // ← unchanged: fills empty block
```

**Why**: Closes #26 root cause at the schema layer. The JSON round-trip `Infinity → null → Infinity` becomes transparent: `config_get` returns Infinity, JSON.stringify serializes it as `null` over the wire, and `config_set`'s zod parse now accepts `null` and transforms it back to Infinity. No changes needed in `config_get` (current behavior preserved). Foundation for Step 2's deep-merge — once disk reads can be cleanly re-serialized through JSON without scrubbing.

**Risk**: zod's `.preprocess(transform, innerSchema)` API is the standard idiom; verified against zod 3.23.8 docs (the project's pinned version per relay-config.md). One small subtlety: `.default()` on a `.preprocess(...)` wraps the preprocessed schema, so `default(Number.POSITIVE_INFINITY)` provides Infinity when the field is entirely missing (preprocess only fires on present-but-null values). Verified by mental-execution of the zod parse pipeline. The existing tests that don't supply `cost_ceilings` continue to receive Infinity defaults; no regression.

**Verify**:
- `npx vitest run tests/config/` — existing schema tests pass.
- New unit test `tests/config/schema-phase22.test.ts` (new file): `ProjectConfigSchema.parse({ cost_ceilings: { per_card_dollars: null } })` returns parsed object with `per_card_dollars === Infinity`.
- New unit test: round-trip `JSON.parse(JSON.stringify(parsed))` then re-parse — Infinity survives via null sentinel.

**Rollback**: Restore both fields to `z.number().positive().default(Number.POSITIVE_INFINITY)`. Single-file revert.

### Step 2: Server-side deep-merge in `config_set`

**File**: `src/rpc/methods.ts`, `config_set` handler (lines 225-232)

**Before** (current code):
```ts
async function config_set(ctx: MethodContext, raw: unknown) {                              // ← RPC handler entry
  const p = ConfigSetParams.parse(raw);                                                    // ← parse via ProjectConfigSchema (fills defaults for omitted fields — BUG #25 root)
  const yaml = yamlDump(p.config, { lineWidth: 100, noRefs: true });                       // ← serialize the fully-normalized object (which has defaults filling omitted fields)
  await writeFile(join(ctx.repo, '.conductor', 'config.yaml'), yaml, 'utf-8');             // ← BUG #25: writes full normalized object to disk, clobbering custom values in omitted fields
  Object.assign(ctx.config, p.config);                                                     // ← shallow update of daemon's in-memory copy
  ctx.bus?.publish({ kind: 'config-changed' });                                            // ← fan-out to SSE subscribers
  return { ok: true as const };                                                            // ← success response
}                                                                                          // ← end handler
```

**After** (proposed change — CORRECTED per /relay-review CRITICAL fix):
```ts
async function config_set(ctx: MethodContext, raw: unknown) {                                          // ← unchanged entry
  // Phase 22 (corrected per /relay-review CRITICAL fix): do NOT use                                    // ← NEW: comment
  // ConfigSetParams.parse here — it would fill defaults for omitted top-level                          // ← NEW
  // fields (cost_ceilings / confidence / run_log / brain_log / tracker), which                         // ← NEW
  // would then clobber disk-resident customizations during merge.                                       // ← NEW
  // Shape-check the wrapper but keep the inner config as Partial.                                       // ← NEW
  const raw_params = z.object({ config: z.record(z.unknown()) }).parse(raw);                            // ← NEW: shape check only, no defaults
  const partial = raw_params.config as Record<string, unknown>;                                         // ← NEW: typed alias for the user's partial body
  // Read disk baseline (full ProjectConfig with defaults filled from on-disk state, NOT from request). // ← NEW: comment
  let disk: ProjectConfig;                                                                               // ← NEW
  try {                                                                                                  // ← NEW: ENOENT guard for missing config.yaml
    disk = await loadProjectConfig(join(ctx.repo, '.conductor', 'config.yaml'));                         // ← NEW: parsed on-disk config
  } catch (err) {                                                                                        // ← NEW
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {                                             // ← NEW: missing-file branch
      disk = ProjectConfigSchema.parse({});                                                              // ← NEW: empty baseline → all defaults
    } else {                                                                                              // ← NEW
      throw err;                                                                                          // ← NEW: propagate other errors
    }                                                                                                     // ← NEW
  }                                                                                                       // ← NEW
  // Deep-merge USER's partial body over disk baseline (patch wins per-field; omitted                    // ← NEW
  // fields preserve disk state). Closes Relay #25.                                                       // ← NEW
  const merged = deepMergeConfig(disk, partial);                                                          // ← NEW: merge raw partial, NOT parsed-with-defaults
  // Re-validate the merged result via the strict schema. This catches user input                         // ← NEW
  // type errors (e.g., routing.default: 123) without scrubbing disk state.                                // ← NEW
  const validated = ProjectConfigSchema.parse(merged);                                                    // ← NEW: full schema validation
  const yaml = yamlDump(validated, { lineWidth: 100, noRefs: true });                                     // ← unchanged: serialize merged result
  await writeFile(join(ctx.repo, '.conductor', 'config.yaml'), yaml, 'utf-8');                            // ← unchanged: write to disk
  Object.assign(ctx.config, validated);                                                                   // ← updated: in-memory state aligned with merged disk state
  ctx.bus?.publish({ kind: 'config-changed' });                                                          // ← unchanged: fan-out
  return { ok: true as const };                                                                          // ← unchanged: success
}                                                                                                         // ← end handler

// Phase 22 helper: deep-merge plain-object configs. Arrays and discriminated                            // ← NEW helper at module scope
// unions (tracker) are REPLACED wholesale (patch wins); plain-object record                              // ← NEW: explains array semantics
// types are recursively merged at the second level. Sufficient for ProjectConfig's shape.                // ← NEW: scope note
function deepMergeConfig(base: ProjectConfig, patch: Record<string, unknown>): ProjectConfig {           // ← CORRECTED: patch is Partial, not full ProjectConfig
  const out: Record<string, unknown> = { ...base };                                                       // ← NEW: copy baseline
  for (const [key, patchVal] of Object.entries(patch)) {                                                  // ← NEW: iterate provided patch keys only — omitted keys preserve base
    const baseVal = (base as Record<string, unknown>)[key];                                               // ← NEW: lookup baseline value
    if (isPlainObject(patchVal) && isPlainObject(baseVal)) {                                              // ← NEW: only recurse for plain-object pairs
      // tracker is a discriminatedUnion: replace wholesale when `kind` differs                           // ← NEW: explain tracker semantics
      // so the patch's tracker shape doesn't get cross-pollinated with the base's.                       // ← NEW
      if (key === 'tracker' && (patchVal as { kind?: string }).kind !== (baseVal as { kind?: string }).kind) {
        out[key] = patchVal;                                                                              // ← NEW: kind changed → replace
      } else {                                                                                            // ← NEW
        out[key] = { ...baseVal, ...patchVal };                                                           // ← NEW: shallow per-field merge inside the block
      }                                                                                                   // ← NEW
    } else {                                                                                              // ← NEW
      // Primitive or array: patch wins wholesale.                                                        // ← NEW
      out[key] = patchVal;                                                                                // ← NEW
    }                                                                                                     // ← NEW
  }                                                                                                       // ← NEW
  return out as ProjectConfig;                                                                            // ← NEW
}                                                                                                         // ← NEW

function isPlainObject(v: unknown): v is Record<string, unknown> {                                        // ← NEW: type guard
  return typeof v === 'object' && v !== null && !Array.isArray(v);                                        // ← NEW: excludes arrays + null
}                                                                                                         // ← NEW
```

Add to the import block at the top of `src/rpc/methods.ts`:

```ts
import { z } from 'zod';                                                            // ← NEW: needed for inline shape-check schema (z.record(z.unknown()))
import { ProjectConfigSchema, type ProjectConfig } from '../config/schema.js';      // ← NEW: needed for merged-result validation + helper signature (ProjectConfig type may already be imported as type-only — adjust to import the value as well)
```

Remove the now-unused `ConfigSetParams` import (the handler bypasses it). Confirm `ConfigSetParams` is unused elsewhere in `src/rpc/methods.ts` via grep before removing.

**Why**: Closes #25 root cause. The textarea's narrow `{ routing, autonomy, verify_command }` body now deep-merges over the on-disk full config; omitted fields preserve disk state. **Critical /relay-review fix**: the handler bypasses `ConfigSetParams.parse` because that path fills schema defaults for omitted top-level fields, which would defeat the merge by overwriting disk customizations with defaults. The corrected flow shape-checks via `z.record(z.unknown())` (accepts any record), merges the raw partial over disk, then validates the merged result via the strict `ProjectConfigSchema.parse` — type errors in user input (e.g., `routing.default: 123`) still surface as ZodErrors. `conductor_set_autonomy` continues to work (it sends a full object built from `ctx.config`, so the merge is effectively a no-op for non-autonomy paths). The shallow merge inside each top-level block (`{ ...baseVal, ...patchVal }`) is sufficient because every second-level block (`routing`, `autonomy`, `cost_ceilings`, `run_log`, `brain_log`) is itself a flat record. `routing.functions` and `autonomy.transitions` are `Record<string, string>` maps — patch-wins replacement on the inner map is the right semantic (e.g., setting `routing.functions.analyze` while preserving `routing.functions.plan` from disk would require deeper merging, but the textarea always emits the COMPLETE functions map, so the shallow inner merge happens to be a non-issue in practice; documented as a caveat).

**Risk**:
- `tracker` discriminatedUnion: if patch and base have different `kind`, we replace wholesale — correct, otherwise the merged object would carry fields from both kinds (e.g., a `linear` base merged with a `github` patch would carry `project_slug` AND `owner/repo`, which `ProjectConfigSchema.parse` would reject under strict mode and surface as a confusing error). The `kind`-differs check prevents this. Verified via mental-execution of the discriminatedUnion's parse semantics.
- `routing.functions` and `autonomy.transitions` shallow inner merge — the textarea always emits the complete map (verified by reading `configToYaml` at `src/ui/views/routing.ts:19-35`). Programmatic clients could send a partial functions map and have it merged — DOCUMENTED as a caveat in impl doc; if undesirable, future plan can deepen the inner merge.
- `loadProjectConfig` is async (reads from disk); minor latency cost (~1ms file read) on every `config_set` call. Acceptable for a config-edit operation (already not on the hot path).
- **`loadProjectConfig` ENOENT race** (added per /relay-review MEDIUM fix): if `.conductor/config.yaml` was deleted between daemon boot and a `config_set` call, fall back to `ProjectConfigSchema.parse({})` as baseline. Equivalent to the pre-Phase-22 full-overwrite behavior on the missing-file path; never throws on the operator's race.
- The re-validation `ProjectConfigSchema.parse(merged)` catches user input type errors (the previous fail-fast role of `ConfigSetParams.parse`). Same rejection happens; just moves from line 1 to line 4 of the handler. The existing `config_set rejects invalid config` test (line 212-218) still passes because it uses `rejects.toThrow()` without message-shape assertion.

**Verify**:
- `npx vitest run tests/rpc/methods.test.ts` — existing tests pass (full-object config_set test continues to work — merge of full object over full object equals the patch).
- New regression test (extension to `tests/rpc/methods.test.ts`): pre-seed disk with `cost_ceilings: { per_card_dollars: 0.5, halt_on_breach: true }`; call `config_set` with partial body `{ routing, autonomy, verify_command }` only; reread disk; assert `cost_ceilings.per_card_dollars === 0.5` and `halt_on_breach === true` survive.
- `npx vitest run tests/rpc/conductor_methods.test.ts` — `conductor_set_autonomy` regression (full-object path still works).
- `npm test` full suite green.

**Rollback**: Revert `src/rpc/methods.ts` to the previous `config_set` body + remove `deepMergeConfig` + `isPlainObject` helpers + the new `z` + `ProjectConfigSchema` imports + restore `ConfigSetParams` import. Disk-side behavior reverts to full-overwrite; existing tests still pass.

### Step 3: Human-readable zod error in HTTP RPC handler

**File**: `src/daemon/http_server.ts`, RPC error catch block (lines 100-103)

**Before** (current code):
```ts
      try {                                                                              // ← invoke handler
        const result = await handler(ctx, parsed.params);                                // ← dispatch
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, result });          // ← success
      } catch (err) {                                                                    // ← any handler throw lands here
        const message = err instanceof Error ? err.message : String(err);                // ← BUG #28: ZodError.message is the JSON-stringified issues array
        const code = err instanceof ZodError ? -32602 : -32603;                          // ← code distinction stays — only message format changes
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code, message } });  // ← BUG #28: raw JSON-array message reaches the client
      }                                                                                  // ← end catch
```

**After** (proposed change):
```ts
      try {                                                                              // ← unchanged: invoke handler
        const result = await handler(ctx, parsed.params);                                // ← unchanged: dispatch
        writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, result });          // ← unchanged: success
      } catch (err) {                                                                    // ← unchanged: catch
        // Phase 22: format ZodError into a human-readable message; expose             // ← NEW: comment
        // structured issues in error.data for programmatic clients.                    // ← NEW
        // Closes Relay #28.                                                              // ← NEW
        if (err instanceof ZodError) {                                                   // ← NEW: branch on ZodError
          const message = err.issues                                                     // ← NEW: format each issue
            .map((i) => `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`)
            .join('; ');                                                                  // ← NEW: join with semicolons
          writeJson(res, 200, {                                                          // ← NEW: structured response
            jsonrpc: '2.0',                                                              // ← NEW
            id: parsed.id ?? null,                                                       // ← NEW
            error: { code: -32602, message, data: { issues: err.issues } },              // ← NEW: issues in data for tools
          });                                                                            // ← NEW
        } else {                                                                          // ← NEW: non-ZodError path unchanged
          const message = err instanceof Error ? err.message : String(err);              // ← unchanged: existing message extraction
          writeJson(res, 200, { jsonrpc: '2.0', id: parsed.id ?? null, error: { code: -32603, message } });  // ← unchanged: internal-error envelope
        }                                                                                 // ← NEW: end branch
      }                                                                                  // ← unchanged: end catch
```

**Why**: Closes #28. ZodError's `.message` getter (zod 3.x) returns `JSON.stringify(this.issues, null, 2)` — that's the unreadable JSON-array payload the UI surfaces. The new branch formats `issues` as `<path>: <message>` joined by `; `, exactly the human-readable shape #28's issue file specifies. Structured `issues` in `error.data` lets programmatic clients (tests, future tooling) still access the full structured zod payload without re-parsing the message string.

**Risk**: Existing tests that asserted on `error.message` containing JSON-array text would fail. Grep for `code: -32602` in tests — `tests/rpc/methods.test.ts:212-219` `config_set rejects invalid config with a validation error` asserts on the rejection happening (likely uses `rejects.toThrow` without specific message shape). Verify by reading that test before implementation; if it asserts shape, update to expect the new human-readable form.

**Verify**:
- `npx vitest run tests/daemon/` — daemon tests pass.
- `npx vitest run tests/rpc/methods.test.ts` — `config_set rejects invalid config` still passes (likely already passes since assertion is on the rejection itself, not message shape).
- New unit test in `tests/daemon/http_server.test.ts` if one exists, OR in `tests/rpc/methods.test.ts` via in-process invocation: throw a `ZodError` from a mock handler; assert the response envelope's `error.message` is `'<path>: <msg>'` shape (no leading `[{`), `error.data.issues` is the structured array, `error.code === -32602`.

**Rollback**: Restore the original two-line `const message` + `const code` + `writeJson` block. Single-file revert.

### Grouped Run Coverage

Closure obligation: **full** for all 3 entries.

| Target | Kind | Obligation | Plan Step(s) | Files / Symbols | Notes |
|--------|------|------------|--------------|-----------------|-------|
| ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults | run leader | full | 2 | `src/rpc/methods.ts::config_set` + `deepMergeConfig` helper | run leader; #25 server-side merge |
| ui-config-get-set-roundtrip-fails-on-infinity-serialization | existing item | full | 1 | `src/config/schema.ts::cost_ceilings.per_card_dollars` + `per_day_dollars` (z.preprocess null→Infinity) | #26 schema-layer fix unblocks the JSON roundtrip |
| ui-routing-save-error-renders-raw-zod-json | existing item | full | 3 | `src/daemon/http_server.ts:100-103` ZodError branch | #28 human-readable error format + structured `error.data.issues` |

## Test Changes

| File | New / Extended | Tests Added |
|------|---------------|-------------|
| `tests/config/schema-phase22.test.ts` | NEW | 3 — `cost_ceilings.per_card_dollars` accepts `null` as Infinity (preprocess); `per_day_dollars` accepts `null`; Infinity → JSON.stringify → null → re-parse round-trip survives |
| `tests/rpc/methods.test.ts` | EXTENDED | 2 — partial `config_set` preserves disk-resident `cost_ceilings.per_card_dollars` + `halt_on_breach`; `config_get → config_set` round-trip with no scrubbing returns `ok: true` (regression for #26) |
| `tests/rpc/methods.test.ts` (zod-error shape) | EXTENDED | 1 — invalid `config_set` throws with human-readable joined message (no `[{` prefix); ZodError instance check via try/catch since the in-process methods.test path doesn't traverse http_server's error handler — see note below |
| `tests/daemon/http_server.test.ts` (if exists) OR new fixture | EXTENDED / NEW | 1 — over-HTTP `conductor.config_set` with invalid body returns `error.code === -32602`, `error.message` joined readable, `error.data.issues` is the ZodError issues array |
| **Total** | | **~7 net new** → 592-ish (baseline 585) |

Note: the in-process `methods.test.ts` invokes `methods.config_set(ctx, raw)` directly — the http_server error formatter is NOT in that code path. So Step 3's coverage requires either an over-HTTP integration test or a unit test that constructs the error path manually. Plan ships both — methods.test.ts asserts the ZodError IS thrown (current behavior); http_server.test.ts (or a similar surface) asserts the formatted envelope.

Check whether `tests/daemon/http_server.test.ts` exists first; if not, add error-envelope assertions to an existing daemon integration test (e.g., `tests/integration/phase4-end-to-end.test.ts` already exercises the HTTP RPC surface).

## Post-Implementation Checks

1. `npm run typecheck` — both engine and UI tsconfigs clean.
2. `npx vitest run tests/config/` — schema tests (existing + new schema-phase22).
3. `npx vitest run tests/rpc/methods.test.ts` — RPC method tests including the new merge + roundtrip regressions.
4. `npx vitest run tests/daemon/` — daemon tests including the new error-envelope assertion.
5. `npm test` — full suite ~592 green.
6. Manual smoke: pre-seed `.conductor/config.yaml` with `cost_ceilings: { per_card_dollars: 0.50, halt_on_breach: true }`. Open UI Routing. Edit a `routing.functions.X` line. Commit. Re-read `.conductor/config.yaml`. Confirm `cost_ceilings` block intact. Confirm a deliberate bad value (`autonomy.default: typo`) surfaces as `config.autonomy.default: Invalid enum value. Expected '...', received 'typo'` (single readable line, no `[{`).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| zod `.preprocess` semantic differs from my mental model | Tests in Step 1 (`tests/config/schema-phase22.test.ts`) exercise `null → Infinity` directly; failure here surfaces before integration. |
| `routing.functions` and `autonomy.transitions` shallow inner merge surprises future clients | Documented as caveat in impl doc; UI always emits full functions map so currently moot. If dogfood surfaces deeper-merge need, file a follow-up. |
| `tracker` discriminatedUnion replace-on-kind-change | Verified via schema reading; `kind` differs → patch wins wholesale (avoids field cross-pollination). Tested via Step 2 regression suite. |
| ZodError formatting changes invalidate other tests | Grep before implementation: only `tests/rpc/methods.test.ts:212` tests rejection; assertion shape verified before edit. |
| `loadProjectConfig` async on every `config_set` adds ~1ms | Acceptable for an interactive config-edit RPC; not on the brain loop hot path. |
| `Object.assign(ctx.config, validated)` is still shallow at top-level | Sufficient because `validated` is a fully-merged canonical object; the shallow assign overlays each top-level key. No deeper merge needed for the in-memory copy. |
| `conductor_set_autonomy` builds `next` via `{ ...ctx.config, autonomy: {...} }` and calls config_set | Still works correctly under deep-merge: `next` includes all fields, so merge is effectively no-op for non-autonomy paths. Verified by reading the call site. |

## Rollback Plan

`git revert <commit-sha-of-feat(22.1)-Commit-A>..<commit-sha-of-feat(22.1)-Commit-C>` (real SHAs filled in after implementation). Each of the 3 commits is independently revertible:
- Commit A (schema preprocess) — schema reverts to pure `z.number().positive().default(Infinity)`. Independent of B; no callers broken if A reverted alone (`config_get → config_set` round-trip returns to broken state, which is the pre-Phase-22 baseline).
- Commit B (deep-merge) — `config_set` reverts to full-overwrite. Disk-resident customizations resume being clobbered — same as pre-Phase-22.
- Commit C (error format) — error envelope reverts to raw `.message`. UI continues to display JSON-array — same as pre-Phase-22.

No DB migrations, no config schema changes that require disk-side migration. The on-disk yaml format is unchanged; only the read/write path becomes merge-aware.

---

## Adversarial Review

*Reviewed: 2026-05-16*

### Issues Found

#### CRITICAL — Step 2 deep-merge defeated by upstream `ConfigSetParams.parse` filling defaults

**What's wrong**: The original Step 2 called `const p = ConfigSetParams.parse(raw)` BEFORE the merge. `ConfigSetParams` wraps `ProjectConfigSchema`; every top-level field has `.default(...)`. When the textarea sends `{ routing, autonomy, verify_command }`, zod fills `cost_ceilings` / `confidence` / `run_log` / `brain_log` / `tracker` with schema DEFAULTS at parse time. The subsequent merge then overlaid these defaults onto disk via `{ ...baseVal, ...patchVal }` → disk's customizations were clobbered. **The plan as originally written did not actually fix #25.**

Verified empirically: `z.object({ a: z.string(), b: z.string().default('B') }).parse({a:'x'})` returns `{a:'x', b:'B'}` — zod fills defaults on parse.

**Plan originally had** (Step 2 AFTER):
```ts
const p = ConfigSetParams.parse(raw);                                   // ← fills defaults — destroys merge
const disk = await loadProjectConfig(...);
const merged = deepMergeConfig(disk, p.config);                         // ← merge against defaults-filled patch
```

**Resolution applied (plan updated in-place)**: bypass `ConfigSetParams.parse` for the merge phase. Use `z.object({ config: z.record(z.unknown()) }).parse(raw)` for shape-check only; treat the inner config as `Record<string, unknown>` (partial); merge over disk; validate the merged result via `ProjectConfigSchema.parse`. Type errors (e.g., `routing.default: 123`) still surface — just at the validate-merged-result step instead of the up-front parse. Existing test at `tests/rpc/methods.test.ts:212` (`rejects.toThrow()` without message shape) still passes.

#### MEDIUM — `loadProjectConfig` ENOENT race on missing config.yaml

**What's wrong**: The original Step 2 unconditionally called `loadProjectConfig(...)` to read the disk baseline. If `.conductor/config.yaml` was deleted between daemon boot and a `config_set` call (e.g., operator running `rm` mid-session), `loadProjectConfig` throws ENOENT and the merge fails with a confusing error.

**Resolution applied**: wrap the load in try/catch with `err.code === 'ENOENT'` → `disk = ProjectConfigSchema.parse({})` (empty baseline → all defaults). This preserves the pre-Phase-22 behavior on the missing-file path (effectively re-creating the file from scratch with patch + defaults). Non-ENOENT errors still propagate. See updated Step 2 AFTER block above.

#### LOW — Step 3 formatter for top-level refine errors

**What's wrong**: ZodError's `issues[i].path` is `[]` for top-level `.refine` failures (e.g., `CardUpdateParams.refine(...)` at line 44-46 of `src/rpc/schema.ts`). The original Step 3 formatter would produce `: <message>` (empty path) which looks malformed.

**Resolution applied** (already in plan): formatter outputs `(root): <message>` when `i.path.length === 0`. The existing `tests/daemon/http_server.test.ts:83-88` assertion `expect(body.error.message).toMatch(/frontmatterPatch|bodyAppend/)` still matches because the refine message text `'card_update requires frontmatterPatch or bodyAppend'` is preserved verbatim.

### Edge Cases to Handle

- **Textarea sends partial body with disk-resident `cost_ceilings.per_card_dollars: 0.5`** — corrected merge preserves it; this is the keystone regression test.
- **`config.yaml` missing mid-session** — ENOENT fallback to empty baseline (defaults).
- **Full-shape round-trip (config_get → config_set unchanged)** — works under corrected logic (merge of full over full = identity).
- **`conductor_set_autonomy` calls `config_set` with `{ ...ctx.config, autonomy: {...} }`** — full object merge over disk = patch wins everywhere = identical result. ✓
- **Tracker `kind` change** — replace wholesale via kind-differs guard.
- **Invalid request body** — shape-check passes (`z.record(z.unknown())` accepts anything); merge succeeds; validate-merged-result throws ZodError. Same rejection, different code path.
- **ZodError with `path: []` (top-level refine)** — formatter outputs `(root): <message>`.
- **`per_card_dollars: null` from JSON.stringify(Infinity)** — Step 1 preprocess transforms back to Infinity.

### Regression Risk

- **`tests/rpc/methods.test.ts:187` `config_set validates the YAML and writes the file`** — sends full custom config; under corrected logic, merge of full over disk = patch wins; assertions on routing/autonomy still pass.
- **`tests/rpc/methods.test.ts:212` `config_set rejects invalid config with a validation error`** — `rejects.toThrow()` without message-shape assertion; still passes when the validation moves from up-front parse to validate-merged-result step.
- **`tests/rpc/methods.test.ts:220` `config_set publishes config-changed on the bus`** — full-object round-trip via `config_get → config_set`; merge is identity. Bus publish path unchanged. ✓
- **`tests/daemon/http_server.test.ts:83` `returns -32602 for card_update refine failure`** — Step 3 formatter preserves `'card_update requires frontmatterPatch or bodyAppend'` substring; regex assertion still matches.
- **Phase 14.1 `brain_log` block** — Phase 22 fix makes partial commits NO LONGER reset `brain_log` from disk. Improvement, not regression.
- **`conductor_set_autonomy` call path** — full-object emit; merge is identity for non-autonomy fields. ✓

### Verdict

**APPROVED WITH CHANGES** — modifications applied in-place above:

1. **CRITICAL** — Step 2 now bypasses `ConfigSetParams.parse` (replaced with `z.object({ config: z.record(z.unknown()) })` shape-check); merges raw partial over disk; validates merged result via `ProjectConfigSchema.parse`.
2. **MEDIUM** — Step 2 wraps `loadProjectConfig` in try/catch with ENOENT → `ProjectConfigSchema.parse({})` fallback.
3. **LOW** — Step 3 formatter handles top-level refine path `[]` → `(root): <msg>` (already in plan).

All revisions are in-place in the Implementation Plan section above; no duplicate plan exists.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order (Step 1 schema → Step 2 deep-merge → Step 3 ZodError format).
- After each step, run its VERIFY command before moving to the next.
- Commit after each logically complete step (3 commits + 1 step-close docs commit).
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]
- Do NOT make changes beyond what the plan specifies.

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 | `src/config/schema.ts` cost_ceilings preprocess `null → Infinity` (both fields) | YES | YES |
| 2 | `src/rpc/methods.ts` config_set: bypass ConfigSetParams.parse, shape-check via `z.record(z.unknown())`, ENOENT-guarded `loadProjectConfig`, `deepMergeConfig`, re-validate via `ProjectConfigSchema.parse`, `Object.assign(ctx.config, validated)` | YES | YES |
| 3 | `src/daemon/http_server.ts` ZodError branch with `(root)` path label + `error.data.issues` | YES | YES |

### Test Results

- **Full suite**: `npm test` → **596/596 pass** in ~16s across 102 test files. Baseline 585 → 596 (+11 net new).
- **Typecheck**: `npm run typecheck` → clean for both engine and UI tsconfigs.
- **Targeted**: `npx vitest run tests/config/ tests/rpc/ tests/daemon/http_server.test.ts` → 82/82 in ~2.8s.

Per-test-file delta:
- `tests/config/schema-phase22.test.ts` — NEW, 7 tests (undefined→Infinity default; null→Infinity both fields; finite values pass; Infinity→JSON→null→re-parse roundtrip; non-numeric rejected; zero/negative rejected — preserves `z.number().positive()`).
- `tests/rpc/methods.test.ts` — EXTENDED with +2 tests (`config_set preserves disk-resident customizations on partial commit (#25)` — pre-seeds disk with `cost_ceilings.per_card_dollars: 0.5, halt_on_breach: true`, sends partial body, asserts both survive; `config_set roundtrip with Infinity defaults works without scrubbing (#26)` — `config_get → JSON.parse(JSON.stringify) → config_set` returns ok=true). 24/24 total now (was 22).
- `tests/daemon/http_server.test.ts` — EXTENDED with +2 tests (`ZodError message is human-readable joined string with structured issues in error.data` — invalid `card_new` returns formatted message + `error.data.issues` array; `refine error formats top-level path as (root)` — `card_update` refine produces `^\(root\):` prefix). 8/8 total now (was 6).

### Grouped Run Coverage

Closure obligation: **full** for all 3 entries.

| Entry | Title | Files touched | Verification evidence |
|-------|-------|---------------|----------------------|
| **#25 (run leader)** | Routing yaml commit silently resets schema-defaulted fields | `src/rpc/methods.ts:config_set` + `deepMergeConfig` + `isPlainObject` helpers | `tests/rpc/methods.test.ts` "config_set preserves disk-resident customizations on partial commit (#25)" asserts `cost_ceilings.per_card_dollars: 0.5` + `halt_on_breach: true` survive a partial commit. **Full closure**. |
| **#26** | `config_get → config_set` roundtrip fails on Infinity | `src/config/schema.ts:cost_ceilings.per_card_dollars` + `per_day_dollars` (z.preprocess null→Infinity) | `tests/config/schema-phase22.test.ts` roundtrip test (`Infinity → JSON.stringify (null) → re-parse → Infinity`) + `tests/rpc/methods.test.ts` "config_set roundtrip with Infinity defaults works without scrubbing (#26)". **Full closure**. |
| **#28** | Routing config save error renders raw zod JSON | `src/daemon/http_server.ts:97-118` ZodError branch | `tests/daemon/http_server.test.ts` "ZodError message is human-readable joined string with structured issues in error.data" asserts message does NOT start with `[`, contains `slug:`, and `error.data.issues` is the structured array. Refine path test asserts `(root):` prefix for top-level refines. **Full closure**. |

### Issues Found

None. All 3 plan steps implemented per the corrected `/relay-review` plan. ConfigSetParams import removed from `src/rpc/methods.ts` (no longer used); the export in `src/rpc/schema.ts` retained for potential future callers. No test legacy assertions needed updating beyond the planned scope — existing `config_set rejects invalid config with a validation error` (line 212) and `card_update refine returns -32602` (http_server.test.ts:83) both survived under the new contract because (a) the first uses `rejects.toThrow()` without message-shape assertion, and (b) the second's regex `/frontmatterPatch|bodyAppend/` is a substring still preserved inside the formatted `(root): card_update requires frontmatterPatch or bodyAppend` message.

### Verification Fixes

None — no issues required mid-verify fixes. The `/relay-review` CRITICAL fix (bypass `ConfigSetParams.parse`) and MEDIUM fix (ENOENT guard) were incorporated into the plan before implementation began.

### Verdict

**COMPLETE** — all 3 plan steps implemented across 4 commits (c22cb0c, 9053529, cc86027, 9c2a8f6). Full suite 596/596 green (+11 net new tests; baseline 585). Typecheck clean. Grouped Run Coverage: 3 full closures (#25 + #26 + #28). PR-2 items (#24 + #27) remain deferred to Phase 23 per established ordering.

### Per-Entry Closure

| # | Target | Kind | Obligation | Final disposition | Citation |
|---|--------|------|------------|-------------------|----------|
| 1 | ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults (this — run leader) | run leader | full | **closed** | `src/rpc/methods.ts:227-281` (config_set deep-merge + deepMergeConfig helper) + `tests/rpc/methods.test.ts` "config_set preserves disk-resident customizations on partial commit (#25)". |
| 2 | ui-config-get-set-roundtrip-fails-on-infinity-serialization | existing item | full | **closed** | `src/config/schema.ts:64-78` (preprocess null→Infinity on both cost_ceilings fields) + `tests/config/schema-phase22.test.ts` roundtrip test + `tests/rpc/methods.test.ts` Infinity-roundtrip regression. |
| 3 | ui-routing-save-error-renders-raw-zod-json | existing item | full | **closed** | `src/daemon/http_server.ts:97-118` ZodError branch with `(root)` path label + `error.data.issues` + `tests/daemon/http_server.test.ts` two new tests (joined-message shape + refine `(root):` prefix). |

# Routing autonomy dropdown silently overwrites uncommitted yaml edits

## Summary

*Resolved: 2026-05-16*

Phase 23 closed Relay Phase 13 PR-2 as a **grouped run** of 2 entries (#24 leader + #27 sibling) sharing the routing UI + `config_set` boundary. The grouped run shipped as a single coordinated change with two pure-helper extractions.

**Problem**:

1. **#24 (P1, leader)** — `src/ui/views/routing.ts:110-124` autonomy dropdown change handler re-fetched config and unconditionally overwrote the textarea, silently destroying any uncommitted yaml edits the user had typed. The textarea is the user's authoritative working buffer for routing overrides; the dropdown change is a side-effect that should not perturb it.
2. **#27 (P2, sibling)** — `src/rpc/methods.ts:config_set` and `src/cli/commands/autonomy.ts:autonomySet` both wrote `.conductor/config.yaml` via `js-yaml`'s `dump()`, which has no comment-preserving mode. Every commit destroyed user-authored comments — including the multi-line preamble that `conductor init` writes for new projects.

**Approach**: two pure-helper extractions, no schema changes, no server-side merge changes.

- **Option B for #24**: surgical textarea patch via a new exported pure helper `replaceAutonomyDefault(yaml, mode): string | null` in `src/ui/views/routing.ts`. The autonomy `change` handler patches the `autonomy.default:` line in the textarea string in place — no `config_get` re-fetch, no destructive overwrite. The helper returns `null` on unrecognized buffer shapes (e.g., user re-indented the autonomy block); in that case the handler skips the textarea update and lets the server-side persistence (already done via `conductor_set_autonomy → config_set`) stand alone.
- **Option A for #27**: heuristic comment preservation via a new pure helper `preserveYamlComments(existingText, newDump): string` in `src/config/preserve_comments.ts`. Wired into BOTH the `config_set` RPC handler and the parallel `autonomy.ts` CLI write site (sibling-bug pair discovered during /relay-plan verification). Preserves three classes of comments: file-head preamble (omniforge `# Claude-subscription-only config — ...` case), section-leading comment blocks above top-level keys, and end-of-line annotations on key-value lines (both top-level scalars like `verify_command: x  # custom` and nested keys like `analyze: opus  # heavy reasoning` from `conductor init`'s template). Conservative — mid-section comments and unusual YAML shapes (anchors, multi-line scalars) are not preserved; documented as Option A limitations.

## Files Modified

**UI / client surface**
- `src/ui/views/routing.ts` — new exported pure helper `replaceAutonomyDefault(yaml, mode): string | null` (~20 lines). Autonomy dropdown `change` handler at lines 136-152 replaces the destructive `config_get → ta.value = configToYaml(r.config)` block with a surgical textarea patch; on helper-return-null, leaves textarea alone.

**Config helper module (new)**
- `src/config/preserve_comments.ts` — new file (~157 lines). Exports `preserveYamlComments(existingText: string | null, newDump: string): string`. Pure function, no I/O. Four-pass algorithm: (1) file-head preamble capture, (2) section-leading comment block capture per top-level key, (3) end-of-line comment capture by key path (uses a unified `KV_PATTERN` so top-level scalars get EOL preservation too — surfaced by /relay-review), (4) re-injection walk over `newDump`.

**RPC layer**
- `src/rpc/methods.ts` — `config_set` handler at lines 238-275 now reads the existing config.yaml text (ENOENT-safe via `.catch(err => err.code === 'ENOENT' ? null : Promise.reject(err))`), then runs the fresh `yamlDump` output through `preserveYamlComments` before writing. New import: `readFile` from `node:fs/promises`, `preserveYamlComments` from `../config/preserve_comments.js`.

**CLI sibling site**
- `src/cli/commands/autonomy.ts` — `autonomySet` at lines 14-31 wires the same `preserveYamlComments` helper before `writeFile`. Sibling-bug closure for #27 (the analysis flagged this as a candidate; planning confirmed YES and folded it into the implementation).

**Tests** (+16 net new; baseline 596 → 612)
- `tests/ui/routing-helpers.test.ts` — NEW, 6 cases on `replaceAutonomyDefault` (canonical shape patches; null on no autonomy block; routing.default not patched; uncommitted edits preserved; null on malformed input; CR-LF tolerance).
- `tests/config/preserve_comments.test.ts` — NEW, 8 cases on `preserveYamlComments` (ENOENT/null pass-through; empty-string pass-through; file-head preamble; section-leading blocks; nested EOL annotations; orphan-section drop after key removal; no-comments pass-through; top-level scalar EOL preservation — added during /relay-review).
- `tests/rpc/methods.test.ts` — EXTENDED with +1 test (`config_set preserves yaml comments on commit (#27)`). 25/25 total. Test seeds the omniforge-shaped preamble + EOL annotation, commits a partial body, asserts preamble + annotation + new value all present in the on-disk file.
- `tests/cli/autonomy.test.ts` — NEW, 1 case. Gives the `autonomySet` CLI command its first dedicated test. Seeds a `# project config — do not delete` comment, runs `autonomySet(repo, 'auto')`, asserts the comment survives.

## Verification

- Full suite: `npm test` → **612/612 pass across 105 test files** in ~18s. Baseline 596 → +16 net new as predicted by the plan exactly. Zero regressions.
- Typecheck: `npm run typecheck` → clean for both engine (`tsconfig.json`) and UI (`tsconfig.ui.json`).
- Targeted regression: `npx vitest run tests/ui/ tests/config/preserve_comments.test.ts tests/cli/autonomy.test.ts tests/rpc/methods.test.ts` → 40/40 in ~3s.
- Manual smoke (matches both issues' Reproduction steps):
  - **#24:** seed routing yaml in textarea with uncommitted edits (e.g., change `verify_command: pytest` → `verify_command: foo`); flip autonomy dropdown from `auto` to `assist`; observe textarea now shows `autonomy.default: assist` while `verify_command: foo` is intact. Prior behavior wiped both.
  - **#27:** `conductor init` a fresh project (or use the omniforge claude-sub template); verify `.conductor/config.yaml` contains the multi-line `#` preamble; click *Commit changes* in the UI Routing view; `git diff .conductor/config.yaml` shows ONLY the intended changes — preamble + any inline annotations intact.

## Caveats

- **Option A heuristic limitations** (documented in `preserveYamlComments`'s docstring): mid-section comments (`#` lines inside a top-level block, not immediately above another top-level key) are NOT preserved. Anchors (`&foo`/`*foo`), multi-line scalars (`|`/`>`), flow-style maps, and TAB-indented existing files are out of scope. None of these shapes appear in `ProjectConfigSchema`-valid configs today. Escalate to Option B (a comment-preserving YAML AST library, e.g., the `yaml` package) if dogfood surfaces a counterexample.
- **`replaceAutonomyDefault` returns null on unusual textarea shapes** — the handler skips the textarea update silently. Server-side persistence (`conductor_set_autonomy → config_set`) still succeeds; user's edits remain intact. The visible inconsistency is small (textarea's `autonomy.default` shows the OLD value, server has NEW) and self-corrects on the next *Reload from disk* click. Documented as known limitation in the helper's docstring; falls back to the safest possible behavior (no destructive write).
- **`autonomy.ts` CLI sibling-bug folded into this run** — the analysis flagged `src/cli/commands/autonomy.ts` as a candidate sibling site (same `yamlDump`-after-parse pattern). The /relay-plan verification confirmed YES and added the wiring as Step 5 of the plan; closure obligation for #27 expanded to cover both the RPC and CLI write paths. First dedicated test on the autonomy CLI command landed as part of this run (`tests/cli/autonomy.test.ts`).
- **Pattern precedents (n-count update)**: pure-helper extraction for testable contracts now at **n=6** (Phase 18 `formatDaemonStartedMessage`, Phase 20 `detectPythonVerifyCommand`, Phase 21 substrate helpers, Phase 22 `deepMergeConfig`/`isPlainObject`, Phase 23 `replaceAutonomyDefault`, Phase 23 `preserveYamlComments`). The promotion threshold for an ADR has long fired; ADR filing remains deferred per the standing operator decision (recorded in STATE.md § Recent decisions). Strong candidate slug if a future session authorizes: `0001-pure-helper-extraction-for-testable-cli-contracts.md`.
- **No schema changes** — `ProjectConfigSchema` untouched. The Phase 22 deep-merge `config_set` is unchanged; the new comment-preservation step layers on top of `yamlDump`'s output, AFTER merge and validation.

## Per-Entry Closure

| # | Target | Kind | Obligation | Disposition | Citation |
|---|--------|------|------------|-------------|----------|
| 1 | ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits (this — run leader) | run leader | full | closed | `src/ui/views/routing.ts:19-43` (helper) + lines 136-152 (handler) + `tests/ui/routing-helpers.test.ts` 6/6 pass |
| 2 | ui-config-set-strips-yaml-comments | existing item | full | closed | new `src/config/preserve_comments.ts` (157 lines) + `src/rpc/methods.ts:263-270` (wiring) + `src/cli/commands/autonomy.ts:13/27-29` (sibling wiring) + `tests/config/preserve_comments.test.ts` 8/8 + `tests/rpc/methods.test.ts` +1 (#27 regression) + `tests/cli/autonomy.test.ts` 1/1 |

Both grouped entries closed at **full** closure obligation. No partial closures, no follow-ups required.

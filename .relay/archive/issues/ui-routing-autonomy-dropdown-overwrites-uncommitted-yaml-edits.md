> **ARCHIVED** — Resolved. See [implementation doc](../../implemented/ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md)

# Routing autonomy dropdown silently overwrites uncommitted yaml edits

*Created: 2026-05-15*
*Source: Phase 21 Playwright dogfood of Control Room UI against omniforge.*
*Severity: P1 — silent data loss in user-facing editor.*

## Problem statement

On the Routing view (`#/routing`), changing the **Autonomy · current mode** dropdown re-fetches the project config and **rewrites the textarea contents**, discarding any uncommitted edits the user has made to the yaml without warning.

## Current state

`src/ui/views/routing.ts:110-124` — on autonomy `change`:

```ts
autonomySelect.addEventListener('change', async () => {
  ...
  await rpc.call('conductor_set_autonomy', { mode: autonomySelect.value });
  ...
  const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');
  ta.value = configToYaml(r.config);   // ← blows away unsaved yaml edits
});
```

There is no diff check, no "you have unsaved changes" guard, no confirmation prompt.

## Reproduction

1. Navigate to `#/routing` with daemon running.
2. Edit the yaml textarea — e.g., change `verify_command: pytest` → `verify_command: foo`.
3. Without clicking **Commit changes**, switch the autonomy dropdown from `auto` to `assist`.
4. Observe textarea snaps back to disk state. `foo` is gone.

## Impact

The yaml editor is the only surface for changing model routing, function overrides, and transition policies. A user mid-edit who reaches for the dropdown (a natural action — both control the same config file) loses work silently. Worst case: the user pastes a long routing override block, taps the dropdown to compare modes, and loses the paste.

## Proposed direction

Either:
- **A (preferred):** compare current textarea against the last-loaded config; if differ, prompt "Discard uncommitted yaml edits?" before re-fetching.
- **B:** apply the dropdown change to the in-memory parsed config + textarea string surgically (replace the `autonomy.default: ...` line), without re-fetching. Server-side commit happens via the same `conductor_set_autonomy` call; the textarea stays consistent with what the user is editing.
- **C:** disable the dropdown while the textarea is dirty.

Option B keeps the two surfaces in sync without forcing the user to choose between two valid actions.

---

## Analysis

*Analyzed: 2026-05-16*

### Validation
- Problem still exists: **YES**. `src/ui/views/routing.ts:110-124` matches the issue verbatim. The autonomy `change` handler calls `conductor_set_autonomy` (line 113), then unconditionally re-fetches via `config_get` (line 117) and writes `ta.value = configToYaml(r.config)` (line 118). No dirty check, no prompt.
- Cited line numbers unchanged.
- Proposed approach still valid: **YES, with Option B as the chosen direction.** Phase 22 PR-1 already shipped the merge-aware server-side `config_set` (and `conductor_set_autonomy` already routes through it, `src/rpc/methods.ts:354-358`), so the *server* side is already correct on dropdown change — only the *client* side does damage. Option B (surgical textarea update, no re-fetch) is the cleanest fix because the dropdown owns exactly one field (`autonomy.default`) and we can patch its line in-place without touching anything else.

### Root Cause
The dropdown change handler treats `config_get → configToYaml → assign-to-textarea` as a "refresh the view to reflect server state" gesture, but the textarea is also the user's working buffer for the next save. The two roles collide: refreshing the buffer destroys in-progress edits. The fix is to recognize that the dropdown's effect is fully describable as a one-line edit (`autonomy.default: <new>`) and apply that edit to whichever surface is authoritative (the textarea) instead of re-reading from disk.

Same architectural family as the three archived Phase 13 PR-1 siblings (#25, #26, #28): the routing surface treats the textarea + server as if they were two copies of the same canonical object, when in fact the textarea is the user's authoritative in-progress edit and the server is the last-committed state. Phase 22 fixed the *commit* path's destructiveness; #24 fixes the *side-effect* path's destructiveness. Same root cause, different direction.

### What This Means (User Impact)

**In plain terms:** When you're editing the routing yaml and you flip the autonomy dropdown mid-edit, your uncommitted yaml changes vanish without warning. The dropdown and the textarea both edit the same config file, so reaching for the dropdown while typing is a natural thing to do — and it silently destroys work.

**Scenario:** Ana is configuring an experimental routing override in the textarea. She's pasted in a 12-line block adding three new `routing.functions` entries (`analyze: opus`, `plan: opus`, `verify: opus`) and is partway through tweaking the model strings. She wants to compare what each autonomy mode does, so she flips the dropdown from `auto` to `assist`. The pill flashes "⌁ saved" — and her entire 12-line paste is gone. The textarea is back to disk state, with no `routing.functions.analyze` override and no undo path.

**Before (current behavior):**
1. Ana opens Routing, edits the textarea to add 12 lines of new routing overrides.
2. Without clicking *Commit changes*, she changes the autonomy dropdown from `auto` to `assist`.
3. The dropdown handler at `routing.ts:113` saves `autonomy.default: assist` server-side (correct).
4. The handler then calls `config_get` (line 117) and overwrites the textarea (line 118) with the server's canonical yaml — which does NOT include her 12 lines.
5. Ana sees the textarea reset. Her paste is gone. Ctrl+Z does nothing because the assignment is programmatic. The only recovery path is to retype the block.

**After (with fix):**
1. Ana opens Routing, edits the textarea to add 12 lines of new routing overrides.
2. She changes the autonomy dropdown from `auto` to `assist`.
3. The dropdown handler saves `autonomy.default: assist` server-side.
4. The handler patches the textarea string surgically: finds the `default:` line under `autonomy:` and replaces only its value. Her 12 lines are untouched.
5. The textarea now reads `autonomy.default: assist` alongside her uncommitted edits. She continues working. When she clicks *Commit changes*, the merged result lands on disk.

(Sibling #27 — comment preservation — has its own scenario in that file: Ben runs `conductor init`, edits one routing line through the UI, and the 18-line `# Claude-subscription-only config — ...` preamble disappears from his `config.yaml`.)

### Blast Radius

**Files affected**
- `src/ui/views/routing.ts` — `renderRouting` (specifically the autonomy `change` listener at lines 110-124). Replace the `config_get → ta.value = configToYaml(r.config)` block with a surgical textarea string patch (`/^(\s*)default:.*$/m` scoped to the `autonomy:` block).
- `src/rpc/methods.ts` — `config_set` write path (lines 238-267) is touched by #27 (comment preservation), not by #24. #24 does NOT touch server code; the server-side autonomy persistence already works correctly through `conductor_set_autonomy → config_set` after Phase 22.

**Callers / consumers**
- The autonomy `change` listener has no callers (event-driven).
- `conductor_set_autonomy` handler at `src/rpc/methods.ts:354-358` wraps `config_set` with `{ ...ctx.config, autonomy: { ...ctx.config.autonomy, default: p.mode } }` — already merge-safe.
- No other UI surface re-fetches and overwrites the routing textarea on user input.

**Test coverage**
- `tests/rpc/methods.test.ts:187-289` — 5 `config_set`/`conductor_set_autonomy` tests including #25 partial-commit preservation and #26 Infinity roundtrip. Does NOT cover the UI dropdown path (which is client-only). New regression test belongs in a UI test (Playwright or jsdom) OR a pure-helper test on the textarea-patch function if extracted.
- `tests/integration/phase5-ui-end-to-end.test.ts` — covers config_get → SSE → config_get roundtrip but not the dropdown overwrite scenario.
- **Gap**: no test currently exercises the autonomy dropdown's effect on the textarea. Adding one is the natural regression guard. Cleanest path: extract the surgical-patch logic into a pure helper (e.g., `replaceAutonomyDefault(yaml, mode): string`) and unit-test it directly — also adds n=5 to the pure-helper-extraction pattern precedent.

**Config interactions**
- The fix does NOT change the config schema or the server-side write contract. It only changes the client's representation of the textarea state after a dropdown change. The server still receives `{ mode }` and persists via the same Phase-22 merge path.

**Cross-item interactions**
- **#27 (sibling)** — both touch the routing surface; both belong to Phase 13 PR-2. Grouped run.
- **Phase 17 keyboard cluster (#40-#43)** — Feature 1 (global dispatcher) explicitly skips bare-key shortcuts when `event.target` is a `<textarea>` (see `.relay/features/keyboard-global-dispatcher.md`). Complementary safety; no collision with #24's textarea-state work.
- **Phase 22 deep-merge `config_set`** — Option B's surgical update path makes a one-line edit to the textarea string only; it does NOT make a partial-merge call to the server (that's still `conductor_set_autonomy`'s job). So the routing.functions / autonomy.transitions shallow-merge caveat documented in the Phase 22 impl doc § Caveats does not bite #24.

**Past work regression risk**
- Low. The fix changes routing.ts client code only. The Phase 22 server-side merge path is unchanged. The risk surface is the textarea-patch heuristic itself: if a user has typed yaml with a non-standard indent (e.g., `\t` instead of two spaces) or an unusual `autonomy:` block layout, a naive regex could miss. Mitigation: scope the regex to the textarea's known `configToYaml` shape (which uses exactly `  default: ` at line position under `autonomy:`), reject patches that don't match (fall through to a "Discard uncommitted yaml edits?" prompt — Option A as fallback for malformed buffers).

### Related Work

*Search dimensions executed:* live codepath audit | backlog codepath | subsystem | archive | implementation | contract drift
*Tooling:* grep (Serena MCP not available in this environment)

#### Findings

- **Target:** `unfiled: src/ui/views/routing.ts:153-158 - Reload from disk button discards textarea edits without confirmation`
  - **Kind:** unfiled candidate
  - **Evidence:** medium (live codepath audit; same file + parallel handler pattern)
  - **Why related:** The reload-btn handler at lines 153-158 does the same `config_get → ta.value = configToYaml(r.config)` overwrite pattern as the autonomy handler, also without a dirty check. It's NOT the same bug — the button label says "Reload from disk", so the user has explicitly opted in. But the discoverability is asymmetric: a user who clicks "Reload" probably understands the destructive intent; a user who flips the dropdown does not. A "discard uncommitted edits?" prompt on Reload would be a polish nicety, not a P-class bug.
  - **Suggested handling:** file companion (P3, deferrable). Not blocking this run.

- **Target:** `.relay/issues/ui-config-set-strips-yaml-comments.md` (#27)
  - **Kind:** existing item
  - **Evidence:** strong (shares file `src/rpc/methods.ts` `config_set` write path; both members of Phase 13 PR-2 per ordering)
  - **Why related:** Both touch the routing.ts ↔ config_set boundary. #27's heuristic comment-preservation step (re-injecting leading comment blocks above corresponding sections) needs to layer on top of #24's stable merge boundary. Grouped run avoids two visits to the same surface.
  - **Suggested handling:** group into current run.

- **Target:** `.relay/archive/issues/ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md` (#25, Phase 22 PR-1 leader, archived)
  - **Kind:** archived sibling
  - **Evidence:** strong (same file + shared root-cause framing — textarea-vs-server collision)
  - **Why related:** Phase 22's deep-merge `config_set` is the substrate Option B implicitly relies on (the dropdown's existing `conductor_set_autonomy → config_set` path is now merge-safe; #24 simply stops the *client* from destroying its own state). Same architectural family; #24 finishes the symmetry on the side-effect path.
  - **Suggested handling:** background context (no action; archived).

- **Target:** `.relay/archive/issues/ui-config-get-set-roundtrip-fails-on-infinity-serialization.md` (#26, archived)
  - **Kind:** archived sibling
  - **Evidence:** medium (same subsystem; orthogonal mechanism — JSON serialization, not textarea state)
  - **Why related:** Subsystem signal; 3rd archived item on routing.ts ↔ config_set surface.
  - **Suggested handling:** background context.

- **Target:** `.relay/archive/issues/ui-routing-save-error-renders-raw-zod-json.md` (#28, archived)
  - **Kind:** archived sibling
  - **Evidence:** medium (same subsystem; orthogonal — error formatting, not state preservation)
  - **Why related:** Subsystem signal; 4th archived item on routing.ts ↔ config_set surface (counting #25, #26, #28 closed in Phase 22 plus this one being analyzed). Upgrades the subsystem-density signal — repeated rediscovery in this surface.
  - **Suggested handling:** background context.

- **Target:** `.relay/implemented/ui-routing-yaml-commit-silently-resets-omitted-fields-to-defaults.md` (Phase 22 impl doc)
  - **Kind:** implementation history
  - **Evidence:** strong (documents the exact substrate Option B depends on)
  - **Why related:** Documents `deepMergeConfig` + `isPlainObject` + the bypass-`ConfigSetParams.parse` reasoning. § Caveats explicitly anticipates PR-2 (#24 + #27) as the next step.
  - **Suggested handling:** background context; cite when designing the plan.

- **Target:** `src/cli/commands/autonomy.ts` (contract-drift dimension; not yet read)
  - **Kind:** subsystem-adjacent code
  - **Evidence:** weak (uses `js-yaml` in the broader grep set, but may or may not touch `.conductor/config.yaml`)
  - **Why related:** If `autonomy` CLI also writes config.yaml via yamlDump, it would strip comments the same way #27 does — sibling bug candidate. Out of scope to confirm here; flag for #27's analysis pass to verify.
  - **Suggested handling:** flag for /relay-plan to confirm; if it strips comments, fold into #27's fix surface (same `yamlDump` call site or a shared helper).

#### Search Bounds

- Live codepath audit: complete (full `renderRouting` function + `config_set` handler + `conductor_set_autonomy` handler + `loadProjectConfig` read path)
- Backlog codepath: complete (`config_set` / `conductor_set_autonomy` grep across `src/` returned 4 files, all read)
- Subsystem: complete (`src/ui/views/` + `src/rpc/methods.ts` + `src/config/`)
- Archive: complete (3 archived siblings on same surface found)
- Implementation: complete (1 directly-relevant impl doc; Phase 22 PR-1)
- Contract drift: bounded — `js-yaml` / `yamlDump` grep returned 9 files; the autonomy-CLI candidate above is flagged for /relay-plan to verify rather than read here. `isDirty`/`dirty`/`beforeunload`/`unsaved` grep across `src/ui` returned 0 matches — #24's dirty-state work would be the first instance of that pattern in the UI codebase.

### Scope Decision

*Mode:* grouped run
*Decided:* 2026-05-16
*Rationale:* #27 shares the routing.ts ↔ `config_set` write-path boundary with #24 and is paired in the Phase 13 PR-2 cluster per `.relay/relay-ordering.md` and Phase 23's `README.md`. The Findings include one strong existing-item sibling (#27) plus three strong/medium archived siblings on the same surface — the subsystem-density signal upgrades the grouping signal. Grouped run lets one /relay-plan + /relay-review pass cover both fixes; the routing.ts edits land in coordination with the `config_set` comment-preservation edit; one /relay-verify run validates the combined behavior. The reload-btn unfiled candidate stays narrow (file companion if operator wants it tracked) — it's explicit-user-action, low priority, not a P-class data-loss bug.

#### Grouped Entries

| # | Target | Kind | Evidence | Closure obligation |
|---|--------|------|----------|--------------------|
| 1 | `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md` (this) | run leader | n/a | full |
| 2 | `.relay/issues/ui-config-set-strips-yaml-comments.md` | existing item | strong | full |

#### Planner Contract

- `/relay-plan` or `/relay-superplan` must emit a `### Grouped Run Coverage` section.
- The coverage section must map every grouped entry to at least one concrete plan step.
- Entry #1 (this file): must include explicit coverage of `src/ui/views/routing.ts` autonomy-change handler — replace destructive `config_get → ta.value = configToYaml(...)` with surgical textarea patch; add regression test (preferably via pure-helper extraction).
- Entry #2 (#27): must include explicit coverage of `src/rpc/methods.ts` `config_set` write path — read existing `config.yaml` text before write; extract comment blocks; re-inject above corresponding sections in the new dump; ENOENT-safe. Verify whether `src/cli/commands/autonomy.ts` shares a yamlDump-writing path that needs the same treatment (flagged in Related Work).
- If either entry cannot be cleanly covered, stop and route back to scope reduction rather than continue.

#### Closure Contract

- `/relay-review` must verify each grouped entry's cited evidence is addressed in the plan at the obligation's granularity.
- `/relay-verify` must verify the diff touched the files or symbols promised by the plan's `Grouped Run Coverage` section:
  - For #1: `src/ui/views/routing.ts` autonomy change handler is mutated; a regression test exists.
  - For #2: `src/rpc/methods.ts` `config_set` preserves comments; a regression test asserts the init preamble survives a roundtrip.
- `/relay-resolve` must record per-entry closure status; partial or unclosed entries must be re-opened, superseded, or have a follow-up issue filed. Unfiled-candidate reload-btn handler does not block this run; if it persists past closure, it can be filed via `/relay-new-issue` as P3 polish.

### Approach

**Recommended approach (grouped run, two coordinated changes):**

**#24 — Option B (surgical textarea update).** In `routing.ts`, replace the destructive lines 117-118 with an in-place line replacement on the textarea string: locate the `default:` line under the `autonomy:` block (the textarea's `configToYaml` shape is known and stable — `  default: ` at exactly 2-space indent under a top-level `autonomy:` line) and substitute the new value. Drop the post-save `config_get` entirely. The server-side persistence path (`conductor_set_autonomy → config_set`) is unchanged and remains the source of truth.

Extract the patch logic into a pure helper `replaceAutonomyDefault(yaml: string, mode: string): string | null` (returns `null` if no autonomy block found — caller falls through to a "Discard uncommitted yaml edits?" prompt as graceful degradation). Pure-helper extraction unit-tests deterministically; pattern precedent count rises to n=5.

**#27 — Option A (heuristic comment preservation).** In `config_set`, before `writeFile`, read the existing `config.yaml` text. Walk its lines; collect leading-comment blocks (sequences of `#`-prefixed lines, plus the blank line immediately following) that precede top-level YAML keys (`routing:`, `autonomy:`, `verify_command:`, `cost_ceilings:`, etc.). Build a `Map<topLevelKey, commentBlock>`. After yamlDump produces the new text, re-inject each preserved block above its matching key. If the existing file is missing (ENOENT), skip preservation (covered by the existing ENOENT branch). If a preserved key is absent from the new dump, discard that block silently. Init-preamble block (comment lines at file head, before any key) is preserved as a special case — prepended to the new dump.

Extract the preservation logic into a pure helper `preserveYamlComments(existingText: string | null, newDump: string): string`. Unit-test against the omniforge init preamble shape + a few synthetic shapes (preamble only, mid-file comment, no comments). Pattern precedent count rises to n=6.

**Alternatives considered:**
- **#24 Option A (dirty-check + prompt):** worse UX. The user has to choose between flipping the dropdown and keeping their edits. Both are valid actions; Option B lets them coexist.
- **#24 Option C (disable dropdown while dirty):** worst UX. User can't even check the mode mid-edit.
- **#27 Option B (AST library):** adds a `yaml` package dependency (we currently use `js-yaml`). More correct in edge cases (multi-line scalars, anchors) but those don't occur in `.conductor/config.yaml` per current schema. Option A handles the dogfood-discovered case; escalate to B only if dogfood surfaces a comment-shape Option A can't handle.
- **#27 Option C (structural patch / per-section overlays):** larger refactor; partially overlaps with Phase 22's already-shipped deep-merge. Not worth the additional surface area for the comment-preservation win alone.

**Open questions / decisions:**

1. Does `src/cli/commands/autonomy.ts` write `.conductor/config.yaml` via `yamlDump` (and therefore strip comments)? Flagged in Related Work; the /relay-plan pass should confirm. If yes, fold its fix into #27's preservation helper (use the same helper at both call sites) — small additional scope, same architectural fix.
2. Should the reload-btn (`routing.ts:153-158`) gain a "Discard uncommitted edits?" prompt? Recommended **defer**: explicit user action, P3 polish at most. If filed, route to /relay-new-issue as a P3 companion after Phase 23 closes.
3. For #27, should the leading comment-block detection be greedy (include blank lines between non-consecutive comment groups) or conservative (only the immediately-preceding contiguous block)? Recommended **conservative** — matches the omniforge init preamble shape (one contiguous block above `routing:`) and avoids accidentally moving unrelated comments. Document the choice; revisit if dogfood surfaces a shape it doesn't cover.

---

## Implementation Plan

*Generated: 2026-05-16*

This plan covers the full grouped run (#24 leader + #27 sibling). The sibling at `.relay/issues/ui-config-set-strips-yaml-comments.md` carries the grouped-run pointer; the binding plan + coverage table live here per the Scope Decision's Planner Contract.

**Pre-plan confirmation:** the open question from /relay-analyze about `src/cli/commands/autonomy.ts` resolved YES — that CLI command reads + parses + dumps `config.yaml` via `js-yaml` (`autonomy.ts:14-28`), so it strips comments identically to `config_set`. Step 5 folds the same preservation helper into that call site, giving #27 a second covered file.

### Step 1: Extract `replaceAutonomyDefault` pure helper

**File**: `src/ui/views/routing.ts` (new exported helper near the top of the module, alongside `configToYaml`/`yamlToConfig`)

**Before** (current code — no helper exists; the textarea-state work happens inline in the event listener):

```ts
// src/ui/views/routing.ts (lines 19-35, helper region)
function configToYaml(config: ProjectConfigShape): string {  // ← existing helper, unchanged
  // ... emits the textarea's canonical YAML shape
  return [
    `routing:`,
    `  default: ${config.routing.default}`,
    // ...
    `autonomy:`,                                              // ← top-level key the surgical patch targets
    `  default: ${config.autonomy.default}`,                  // ← THIS line is what Step 1's helper rewrites
    `  transitions:`,
    // ...
  ].join('\n');
}
```

**After** (proposed — new exported helper alongside `configToYaml`):

```ts
// src/ui/views/routing.ts (new helper, exported for unit-testability)
export function replaceAutonomyDefault(            // ← NEW: surgical patch of the autonomy.default line in a YAML string
  yaml: string,                                     // ← the textarea's current value (may include uncommitted edits)
  mode: string,                                     // ← new autonomy mode chosen via the dropdown
): string | null {                                  // ← null sentinel = "unrecognized shape; caller decides fallback"
  const lines = yaml.split('\n');                   // ← split preserves blank lines and line offsets
  let inAutonomy = false;                           // ← state flag: are we inside the `autonomy:` top-level block?
  for (let i = 0; i < lines.length; i++) {          // ← single forward pass; first match wins
    const line = lines[i];                          // ← current line under inspection
    if (/^autonomy:\s*$/.test(line)) {              // ← top-level key matches the `autonomy:` block opener
      inAutonomy = true;                            // ← enter the block; subsequent indented lines are scoped to it
      continue;                                     // ← move on; the autonomy: line itself isn't patched
    }
    if (inAutonomy && /^[^\s#]/.test(line)) {       // ← next top-level key (non-indented, non-comment) closes the block
      break;                                        // ← we walked past the autonomy block without finding default:
    }
    if (inAutonomy && /^\s+default:\s*\S+\s*$/.test(line)) {  // ← matches `  default: <value>` inside autonomy:
      lines[i] = line.replace(/(default:\s*)\S+/, (_, p1) => p1 + mode);  // ← function replacer; preserves regex-special chars in mode (defensive)
      return lines.join('\n');                      // ← success: return the patched yaml
    }
  }
  return null;                                      // ← never matched; caller falls through gracefully
}
```

**Why**: this is the surgical-update primitive #24 Option B depends on. By keeping it pure (string in → string out), it's unit-testable in isolation and can short-circuit on unrecognized shapes. The regex anchors to the `configToYaml` canonical shape (`autonomy:` flush-left, `  default: ` two-space indent) which is what the textarea is initialized with; user edits within the autonomy block typically keep that structure intact.

**Risk**: a user could manually re-indent the autonomy block (e.g., add an extra space) or use a YAML alias/anchor — the regex would miss. Mitigation: returning `null` lets the caller skip the textarea update rather than silently mis-patch. The server-side persistence path (`conductor_set_autonomy`) still succeeds either way.

**Verify**: unit tests in `tests/ui/routing-helpers.test.ts` (new). Cases: canonical shape patches correctly; missing `autonomy:` returns null; multiple `default:` keys (under `routing:` and `autonomy:`) — only the autonomy one is patched; trailing whitespace tolerated; CR-LF tolerated; mode string with special characters passes through (e.g., `'auto-X'`).

**Rollback**: delete the function. No callers yet (Step 2 wires it).

---

### Step 2: Replace destructive autonomy change handler

**File**: `src/ui/views/routing.ts` (`renderRouting`, lines 110-124)

**Before** (current code — the destructive overwrite):

```ts
// src/ui/views/routing.ts:110-124
autonomySelect.addEventListener('change', async () => {       // ← attaches to the autonomy dropdown
  autonomyStatus.hidden = true;                                // ← reset status pill
  try {
    await rpc.call('conductor_set_autonomy', {                 // ← server persists the new mode via config_set
      mode: autonomySelect.value,
    });
    autonomyStatus.textContent = '⌁ saved';                    // ← show success pill
    autonomyStatus.dataset.state = 'ok';
    autonomyStatus.hidden = false;
    const r = await rpc.call<{ config: ProjectConfigShape }>('config_get');   // ← BUG: re-fetch
    ta.value = configToYaml(r.config);                          // ← BUG: overwrites textarea, killing uncommitted edits
  } catch (err) {
    autonomyStatus.textContent = `failed: ${(err as Error).message}`;  // ← error pill
    autonomyStatus.dataset.state = 'error';
    autonomyStatus.hidden = false;
  }
});
```

**After** (proposed — surgical patch, no re-fetch):

```ts
// src/ui/views/routing.ts:110-124 (after patch)
autonomySelect.addEventListener('change', async () => {       // ← unchanged attachment
  autonomyStatus.hidden = true;                                // ← unchanged status reset
  try {
    await rpc.call('conductor_set_autonomy', {                 // ← unchanged: server is still the source of truth
      mode: autonomySelect.value,
    });
    autonomyStatus.textContent = '⌁ saved';                    // ← unchanged success pill
    autonomyStatus.dataset.state = 'ok';
    autonomyStatus.hidden = false;
    const patched = replaceAutonomyDefault(ta.value, autonomySelect.value);  // ← NEW: surgical patch attempt
    if (patched !== null) {                                    // ← NEW: only update if helper recognized the shape
      ta.value = patched;                                      // ← textarea now reflects new mode; user edits intact
    }                                                          // ← NEW: on null, leave textarea alone — user has odd shape
  } catch (err) {
    autonomyStatus.textContent = `failed: ${(err as Error).message}`;  // ← unchanged error path
    autonomyStatus.dataset.state = 'error';
    autonomyStatus.hidden = false;
  }
});
```

**Why**: replaces the destructive `config_get → ta.value = configToYaml(r.config)` block with a surgical patch of just the `autonomy.default:` line. The textarea now reflects the new mode without losing the user's uncommitted edits to other parts of the YAML. The server-side persistence is unchanged — `conductor_set_autonomy` still commits via the Phase 22 merge-aware `config_set`, so the on-disk state is correct.

**Risk**:
1. **Helper returns null on unusual shapes.** Textarea is left as-is — the user's edits and the (potentially stale) `autonomy.default` line both stay. The status pill still says "⌁ saved" because the *server* did save. The visible inconsistency is small (textarea's `autonomy.default` shows old value, server has new) and self-corrects on the next *Reload from disk* click. Acceptable: the alternative (overwriting the textarea) is the bug we're fixing.
2. **Race with the user typing during the RPC await.** The `await rpc.call('conductor_set_autonomy', …)` happens before the patch, so any keystrokes during the RPC are captured in `ta.value` and the patch operates on the latest textarea state. Safe.

**Verify**:
- Manual smoke (the issue's Reproduction steps): edit the textarea → flip dropdown → assert textarea is intact except `autonomy.default:` line.
- Unit test on `replaceAutonomyDefault` (Step 1) covers the helper-side behavior.
- The integration assertion (Step 6 below) extends `tests/rpc/methods.test.ts` for the server side; the UI side is checked via the helper unit test.

**Rollback**: revert this hunk; restore the original `config_get → ta.value = configToYaml(r.config)` lines.

---

### Step 3: Create `preserveYamlComments` pure helper

**File**: `src/config/preserve_comments.ts` (new file)

**Before** (file does not exist):
```ts
// (no file)
```

**After** (proposed — new module):

```ts
// src/config/preserve_comments.ts
//
// Re-emits YAML comment lines from an existing config file onto a freshly-
// dumped version. js-yaml drops comments at parse time (they don't exist on
// the parsed AST), so every config_set commit otherwise destroys user
// annotations. This helper layers a heuristic on top of yamlDump output to
// re-inject:
//   1. File-head preamble — contiguous `#`-prefixed lines (and the blank
//      line immediately following) at the top of the existing file, before
//      any YAML key. Re-injected at the top of the new dump.
//   2. Section-leading comment blocks — contiguous `#` lines immediately
//      preceding a top-level YAML key (`^[a-zA-Z_]\w*:`) in existing.
//      Re-injected above the matching top-level key in the new dump.
//   3. End-of-line comments — `# ...` suffixes on key-value lines in
//      existing. Copied to the matching key path in the new dump.
//
// Conservative: only contiguous blocks immediately adjacent to keys are
// captured; comments floating in unrelated whitespace are dropped. Returns
// the input dump unchanged when existingText is null (ENOENT case) or has
// no recoverable comments. Pure function — no I/O.

/**
 * Walk the existing file text and build comment maps keyed by top-level YAML
 * key and by full key path. Then walk the new dump and re-inject.
 *
 * @param existingText the on-disk YAML text BEFORE the new dump (null when
 *   the file did not exist — caller handled ENOENT).
 * @param newDump     the freshly produced YAML dump (output of yamlDump).
 * @returns           newDump with preserved comments re-injected.
 */
export function preserveYamlComments(
  existingText: string | null,
  newDump: string,
): string {
  if (existingText === null || existingText === '') return newDump;     // ← ENOENT or empty — nothing to preserve

  const existingLines = existingText.split('\n');                        // ← split preserves blank-line spacing
  // Unified key-value pattern. Indent (group 1) = '' for top-level, non-empty
  // for nested. Optional EOL comment (group 4) is captured for both — so
  // `verify_command: npm test  # custom` preserves its annotation, not just
  // nested keys like `analyze: opus-4  # heavy reasoning`.
  const KV_PATTERN = /^(\s*)([a-zA-Z_][\w-]*):\s*(\S.*?)?\s*(#.*)?$/;    // ← top-level OR nested key-value
  const TOP_KEY = /^([a-zA-Z_][\w-]*):/;                                  // ← used only for section-leading-block detection in Pass 2

  // Pass 1: capture file-head preamble (comments + blank lines BEFORE the
  // first non-comment line). Conservative: stops at the first line that is
  // neither blank nor a `#`-comment.
  const preamble: string[] = [];                                         // ← collects file-head comment lines verbatim
  let i = 0;
  while (i < existingLines.length) {
    const line = existingLines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {        // ← blank OR comment qualifies
      preamble.push(line);
      i++;
      continue;
    }
    break;                                                                // ← first key (or other content) ends the preamble
  }
  // If the preamble captured ALL lines (file was nothing but comments),
  // drop it — nothing to preserve onto a non-empty dump.
  const preambleHasContent = preamble.length > 0 && i < existingLines.length;

  // Pass 2: section-leading comment blocks. Map<topLevelKey, string[] lines>.
  // For each top-level key in existing, walk backward to collect the contiguous
  // `#` block directly above it (separated by zero or one blank line).
  const sectionBlocks = new Map<string, string[]>();                     // ← key → lines (comments incl. trailing blank)
  for (let j = i; j < existingLines.length; j++) {                       // ← start AFTER the preamble (don't double-count)
    const m = TOP_KEY.exec(existingLines[j]);
    if (!m) continue;
    const topKey = m[1];
    const block: string[] = [];
    let k = j - 1;
    while (k >= i && existingLines[k].trim() === '') { k--; }            // ← skip ONE blank line separator
    while (k >= i && existingLines[k].trimStart().startsWith('#')) {     // ← walk backward over contiguous `#` lines
      block.unshift(existingLines[k]);
      k--;
    }
    if (block.length > 0) sectionBlocks.set(topKey, block);
  }

  // Pass 3: end-of-line comments. Map<keyPath, eolComment>. keyPath is the
  // chain of keys (indent-tracked), e.g. "routing.functions.analyze". Uses
  // the unified KV_PATTERN so top-level scalars (e.g. `verify_command:`) get
  // their EOL comments captured the same way as nested ones.
  const eolComments = new Map<string, string>();                         // ← key path → "# comment" suffix
  const indentStack: Array<{ indent: number; key: string }> = [];        // ← tracks nesting
  for (const raw of existingLines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = KV_PATTERN.exec(line);
    if (!m) continue;
    const indent = m[1].length;                                          // ← group 1 = leading whitespace
    // Pop deeper-or-equal nesting off the stack.
    while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= indent) {
      indentStack.pop();
    }
    const key = m[2];                                                     // ← group 2 = key name
    const path = [...indentStack.map((s) => s.key), key].join('.');
    indentStack.push({ indent, key });
    const eol = m[4] ?? '';                                              // ← group 4 = optional EOL comment
    if (eol) eolComments.set(path, eol);
  }

  // Pass 4: walk newDump and re-inject. Uses the unified KV_PATTERN so both
  // top-level and nested lines flow through the same EOL-comment lookup.
  const outLines: string[] = [];
  if (preambleHasContent) outLines.push(...preamble);                    // ← prepend file-head preamble (incl. trailing blank)

  const dumpLines = newDump.split('\n');
  const dumpStack: Array<{ indent: number; key: string }> = [];          // ← nesting tracker for dumpLines
  for (const raw of dumpLines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') { outLines.push(line); continue; }           // ← preserve blank-line spacing in the dump

    const m = KV_PATTERN.exec(line);
    if (!m) { outLines.push(line); continue; }                            // ← arrays, scalars, anything we don't recognize

    const indent = m[1].length;
    const key = m[2];
    const isTopLevel = indent === 0;

    if (isTopLevel) {
      const block = sectionBlocks.get(key);
      if (block && outLines.length > 0 && outLines[outLines.length - 1].trim() !== '') {
        outLines.push('');                                                // ← visual separator before section-leading block
      }
      if (block) outLines.push(...block);                                 // ← re-inject section-leading comments
      dumpStack.length = 0;                                               // ← reset; we're at top level
    } else {
      while (dumpStack.length > 0 && dumpStack[dumpStack.length - 1].indent >= indent) {
        dumpStack.pop();
      }
    }

    const path = [...dumpStack.map((s) => s.key), key].join('.');
    dumpStack.push({ indent, key });
    const eol = eolComments.get(path);
    // js-yaml may emit trailing whitespace; trim the right side before appending an EOL comment.
    outLines.push(eol ? `${line.trimEnd()}  ${eol}` : line);
  }

  return outLines.join('\n');
}
```

**Why**: encapsulates the heuristic comment-preservation logic as a pure helper. Three classes of comment are covered:

1. File-head preamble (the omniforge `# Claude-subscription-only config — ...` case explicitly cited in #27's Reproduction).
2. Section-leading blocks (e.g., a user-authored `# Routing precedence...` block above `routing:` in `conductor init`'s default config).
3. End-of-line annotations (e.g., `analyze:      claude-opus-4-7        # heavy reasoning` from `conductor init`'s template).

Pure helper means deterministic unit tests against canned input pairs; no daemon, no fs setup.

**Risk**:
1. **Heuristic miss on non-canonical shapes.** Anchors (`&foo`/`*foo`), multi-line scalars (`|`/`>`), and flow-style maps would confuse the indent walker. None of those appear in `ProjectConfigSchema`-valid `.conductor/config.yaml` files; flag as a known limitation in a comment.
2. **Same top-level key with different surrounding comments across sections.** Top-level keys in `ProjectConfig` are unique (`routing`, `autonomy`, `verify_command`, `cost_ceilings`, etc.), so the `Map<topLevelKey, block>` collision case can't fire under the schema.
3. **EOL comment misalignment.** If `js-yaml` reorders keys, the EOL comment maps by key path so it still attaches to the right line. (js-yaml's default `sortKeys: false` is set implicitly, but our `yamlDump` calls don't override it.)
4. **Whitespace sensitivity.** Tab characters in existing YAML would confuse the indent count. `js-yaml`'s dump emits two-space indents; if a user typed tabs, the section-leading block would still re-inject correctly (matched by top-level-key name, not indent), but EOL comments for nested keys could miss. Acceptable for Option A.

**Verify**: unit tests in `tests/config/preserve_comments.test.ts` (new) covering all three comment classes, the ENOENT-equivalent (null input), the empty-input case, and the no-comments-pass-through case.

**Rollback**: delete the file.

---

### Step 4: Wire `preserveYamlComments` into `config_set`

**File**: `src/rpc/methods.ts` (`config_set` handler, lines 238-267)

**Before** (current code — destructive write):

```ts
// src/rpc/methods.ts:238-267
async function config_set(ctx: MethodContext, raw: unknown) {
  // ... (input parsing and merge unchanged)
  const validated = ProjectConfigSchema.parse(merged);                           // ← validated config object
  const yaml = yamlDump(validated, { lineWidth: 100, noRefs: true });           // ← BUG: dumps fresh; comments gone
  await writeFile(join(ctx.repo, '.conductor', 'config.yaml'), yaml, 'utf-8');   // ← destructive write
  Object.assign(ctx.config, validated);
  ctx.bus?.publish({ kind: 'config-changed' });
  return { ok: true as const };
}
```

**After** (proposed — comment-preserving write):

```ts
// src/rpc/methods.ts:238-267 (after patch)
async function config_set(ctx: MethodContext, raw: unknown) {
  // ... (input parsing and merge unchanged)
  const validated = ProjectConfigSchema.parse(merged);                           // ← unchanged
  const configPath = join(ctx.repo, '.conductor', 'config.yaml');                // ← NEW: hoist path; used twice now
  const existingText = await readFile(configPath, 'utf-8').catch(                // ← NEW: read existing file FOR comments only
    (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)),
  );                                                                              // ← null on ENOENT (first write); rethrow others
  const dump = yamlDump(validated, { lineWidth: 100, noRefs: true });            // ← unchanged dump call
  const yaml = preserveYamlComments(existingText, dump);                         // ← NEW: re-inject preserved comments
  await writeFile(configPath, yaml, 'utf-8');                                    // ← unchanged write (writes the enriched yaml)
  Object.assign(ctx.config, validated);                                          // ← unchanged in-memory align
  ctx.bus?.publish({ kind: 'config-changed' });                                  // ← unchanged event
  return { ok: true as const };
}
```

Add import at top of file:
```ts
// src/rpc/methods.ts (imports region, near other src/config imports)
import { readFile, writeFile } from 'node:fs/promises';   // ← readFile is NEW; writeFile was already imported
import { preserveYamlComments } from '../config/preserve_comments.js';  // ← NEW
```

**Why**: makes `config_set` non-destructive to user-authored comments. The change is surgical: one extra `readFile` (ENOENT-safe) and a wrapping call through the new helper. Validation, merge, in-memory alignment, and event publish are unchanged.

**Risk**:
1. **~1ms extra disk read per call** — same magnitude as Phase 22's `loadProjectConfig` read; acceptable on a config-edit RPC.
2. **Race with concurrent external edits.** If an external process writes between the `loadProjectConfig` (line 247) and the new `readFile` here, the comment map could come from a slightly different file version than the deep-merge baseline. Sub-millisecond window; affects only comment placement (not validity); acceptable.
3. **`disk` read in the merge phase reads via `loadProjectConfig` (yaml.load → JS object); the new `readFile` reads raw text.** Two reads of the same file. Could share, but `loadProjectConfig` already discards the text. Minor inefficiency; mitigation is a future refactor of `loadProjectConfig` to return both forms.

**Verify**:
- `tests/rpc/methods.test.ts` extended: pre-seed `config.yaml` with the omniforge preamble + end-of-line annotations, call `config_set` with a partial body, read back the file via `readFile`, assert all comments survived.
- `npm test` full suite pass with no regressions in existing config_set tests (5 currently pass; expect 6 after the new one).

**Rollback**: revert the imports + the four-line change in `config_set`; the file goes back to its current destructive write. Phase 22's deep-merge stays.

---

### Step 5: Wire `preserveYamlComments` into `autonomy.ts` CLI

**File**: `src/cli/commands/autonomy.ts` (`autonomySet`, lines 14-28)

**Before** (current code — sibling-bug write):

```ts
// src/cli/commands/autonomy.ts:14-28
export async function autonomySet(repo: string, mode: string): Promise<void> {
  if (!['escort', 'assist', 'auto', 'critical'].includes(mode)) {
    throw new Error(`Invalid autonomy mode: ${mode} (expected escort | assist | auto | critical)`);
  }
  const path = join(repo, '.conductor', 'config.yaml');                          // ← config path
  const yaml = await readFile(path, 'utf8').catch(() => '');                     // ← read existing (or empty on miss)
  const parsed = (yaml ? yamlLoad(yaml) : {}) as Record<string, unknown>;        // ← parse (comments lost)
  const next = {
    ...parsed,
    autonomy: { ...((parsed.autonomy as Record<string, unknown>) ?? {}), default: mode },
  };
  ProjectConfigSchema.parse(next);                                               // ← validate
  await writeFile(path, yamlDump(next, { lineWidth: 100, noRefs: true }), 'utf8');  // ← BUG: dump without comments
  process.stdout.write(`autonomy.default = ${mode}\n`);
}
```

**After** (proposed — comment-preserving write):

```ts
// src/cli/commands/autonomy.ts:14-28 (after patch)
export async function autonomySet(repo: string, mode: string): Promise<void> {
  if (!['escort', 'assist', 'auto', 'critical'].includes(mode)) {
    throw new Error(`Invalid autonomy mode: ${mode} (expected escort | assist | auto | critical)`);
  }
  const path = join(repo, '.conductor', 'config.yaml');                          // ← unchanged
  const yaml = await readFile(path, 'utf8').catch(() => '');                     // ← unchanged read (empty fallback)
  const parsed = (yaml ? yamlLoad(yaml) : {}) as Record<string, unknown>;        // ← unchanged parse
  const next = {
    ...parsed,
    autonomy: { ...((parsed.autonomy as Record<string, unknown>) ?? {}), default: mode },
  };
  ProjectConfigSchema.parse(next);                                               // ← unchanged validate
  const dump = yamlDump(next, { lineWidth: 100, noRefs: true });                 // ← extracted dump var (was inline)
  const preserved = preserveYamlComments(yaml || null, dump);                    // ← NEW: re-inject comments; null on empty-string
  await writeFile(path, preserved, 'utf8');                                      // ← unchanged write, now over enriched yaml
  process.stdout.write(`autonomy.default = ${mode}\n`);                          // ← unchanged stdout
}
```

Add import:
```ts
// src/cli/commands/autonomy.ts (imports)
import { preserveYamlComments } from '../../config/preserve_comments.js';  // ← NEW
```

**Why**: same fix as Step 4 applied at the parallel CLI write site. Sharing the helper means a single source of truth for the preservation heuristic; future improvements (e.g., escalating to Option B AST library) update both call sites simultaneously.

**Risk**: identical to Step 4 risks. The CLI path is exercised less frequently than the RPC path (CLI users are typically scripting), so race-with-external-write is even less likely here.

**Verify**:
- `tests/cli/autonomy.test.ts` (NEW): seed `config.yaml` with comments, invoke `autonomySet`, assert comments preserved.
- Manual: `conductor init && conductor autonomy set assist && grep "^#" .conductor/config.yaml` — preamble intact.

**Rollback**: revert the two-line change.

---

### Step 6: Tests

**File**: `tests/ui/routing-helpers.test.ts` (NEW)

```ts
// tests/ui/routing-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { replaceAutonomyDefault } from '../../src/ui/views/routing.js';

describe('replaceAutonomyDefault', () => {
  it('patches autonomy.default in the canonical configToYaml shape', () => {
    const yaml = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7',
      'autonomy:',
      '  default: assist',
      '  transitions:',
      '    discovered_to_planned: auto',
      'verify_command: npm test',
      '',
    ].join('\n');
    const out = replaceAutonomyDefault(yaml, 'auto');
    expect(out).toContain('autonomy:\n  default: auto\n');
    expect(out).toContain('routing:\n  default: claude-sonnet-4-6');  // unchanged
    expect(out).toContain('verify_command: npm test');                // unchanged
  });

  it('returns null when no autonomy block exists', () => {
    const yaml = 'routing:\n  default: claude-sonnet-4-6\n';
    expect(replaceAutonomyDefault(yaml, 'auto')).toBeNull();
  });

  it('does not patch routing.default — only autonomy.default', () => {
    const yaml = 'routing:\n  default: A\nautonomy:\n  default: B\n';
    const out = replaceAutonomyDefault(yaml, 'C');
    expect(out).toBe('routing:\n  default: A\nautonomy:\n  default: C\n');
  });

  it('preserves uncommitted edits outside the autonomy block', () => {
    const yaml = 'routing:\n  default: WIP_VALUE_USER_PASTED\nautonomy:\n  default: assist\n';
    const out = replaceAutonomyDefault(yaml, 'auto');
    expect(out).toContain('WIP_VALUE_USER_PASTED');
    expect(out).toContain('default: auto');
  });

  it('returns null on malformed input (no top-level autonomy: line)', () => {
    expect(replaceAutonomyDefault('autonomy:assist\n', 'auto')).toBeNull();
  });

  it('tolerates CR-LF line endings', () => {
    const yaml = 'autonomy:\r\n  default: assist\r\n';
    const out = replaceAutonomyDefault(yaml, 'auto');
    expect(out).toContain('  default: auto');
  });
});
```

**File**: `tests/config/preserve_comments.test.ts` (NEW)

```ts
// tests/config/preserve_comments.test.ts
import { describe, it, expect } from 'vitest';
import { preserveYamlComments } from '../../src/config/preserve_comments.js';

describe('preserveYamlComments', () => {
  it('returns dump unchanged when existing is null (ENOENT)', () => {
    const dump = 'routing:\n  default: a\n';
    expect(preserveYamlComments(null, dump)).toBe(dump);
  });

  it('returns dump unchanged when existing is empty string', () => {
    const dump = 'routing:\n  default: a\n';
    expect(preserveYamlComments('', dump)).toBe(dump);
  });

  it('preserves file-head preamble (omniforge claude-sub case)', () => {
    const existing = [
      '# Claude-subscription-only config — routes every op through claude.',
      '# Prerequisites:',
      '#   1. Install Claude Code',
      '',
      'routing:',
      '  default: claude-sub:sonnet',
    ].join('\n');
    const dump = 'routing:\n  default: claude-sub:sonnet\n';
    const out = preserveYamlComments(existing, dump);
    expect(out.startsWith('# Claude-subscription-only config')).toBe(true);
    expect(out).toContain('# Prerequisites:');
    expect(out).toContain('routing:');
  });

  it('preserves section-leading comment blocks', () => {
    const existing = [
      'routing:',
      '  default: a',
      '',
      '# Autonomy controls — manual overrides go here',
      'autonomy:',
      '  default: assist',
    ].join('\n');
    const dump = 'routing:\n  default: a\nautonomy:\n  default: auto\n';
    const out = preserveYamlComments(existing, dump);
    expect(out).toContain('# Autonomy controls — manual overrides go here\nautonomy:');
  });

  it('preserves end-of-line annotations on nested keys (init template case)', () => {
    const existing = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7        # heavy reasoning',
      '    plan: claude-opus-4-7',
    ].join('\n');
    const dump = [
      'routing:',
      '  default: claude-sonnet-4-6',
      '  functions:',
      '    analyze: claude-opus-4-7',
      '    plan: claude-opus-4-7',
      '',
    ].join('\n');
    const out = preserveYamlComments(existing, dump);
    expect(out).toContain('analyze: claude-opus-4-7  # heavy reasoning');
  });

  it('drops comments that no longer have a matching key in the dump', () => {
    const existing = '# orphan section\nremoved_key:\n  foo: bar\n';
    const dump = 'routing:\n  default: a\n';
    const out = preserveYamlComments(existing, dump);
    expect(out).not.toContain('orphan');
  });

  it('passes through dumps with no surviving comments', () => {
    const existing = 'routing:\n  default: a\n';
    const dump = 'routing:\n  default: b\n';
    expect(preserveYamlComments(existing, dump)).toBe(dump);
  });

  it('preserves end-of-line annotations on top-level scalar keys', () => {
    // verify_command is the only top-level scalar in ProjectConfigSchema;
    // its EOL annotation must survive the same way nested EOL annotations do.
    const existing = 'verify_command: npm test  # custom override\nrouting:\n  default: a\n';
    const dump = 'verify_command: npm test\nrouting:\n  default: a\n';
    const out = preserveYamlComments(existing, dump);
    expect(out).toContain('verify_command: npm test  # custom override');
  });
});
```

**File**: `tests/rpc/methods.test.ts` (EXTEND with one new case after the existing #25/#26 tests)

```ts
// tests/rpc/methods.test.ts (add after the #26 test at line 277)
it('config_set preserves yaml comments on commit (#27)', async () => {
  const repo = setupRepo();
  const fs = await import('node:fs/promises');
  // Pre-seed with omniforge-style preamble + EOL annotations.
  await fs.writeFile(
    join(repo, '.conductor', 'config.yaml'),
    [
      '# Claude-subscription-only config — routes every op through claude.',
      '# Prerequisites:',
      '#   1. Install Claude Code',
      '',
      'routing:',
      '  default: claude-sub:sonnet',
      '  functions:',
      '    analyze: claude-opus-4-7        # heavy reasoning',
      'autonomy:',
      '  default: assist',
      '  transitions:',
      '    discovered_to_planned: auto',
      '    planned_to_approved: assist',
      '    approved_to_building: manual',
      '    building_to_verifying: auto',
      '    verifying_to_shipped: assist',
      '    shipped_to_archived: manual',
      'verify_command: npm test',
      '',
    ].join('\n'),
    'utf8',
  );
  const ctx = { repo, config: ProjectConfigSchema.parse({}), runtime: new InMemoryRuntime() };
  // Commit a partial body (UI textarea shape).
  await methods.config_set(ctx, {
    config: {
      routing: { default: 'claude-sub:sonnet', functions: { analyze: 'claude-opus-4-7' } },
      autonomy: {
        default: 'auto',  // ← changed
        transitions: {
          discovered_to_planned: 'auto',
          planned_to_approved: 'assist',
          approved_to_building: 'manual',
          building_to_verifying: 'auto',
          verifying_to_shipped: 'assist',
          shipped_to_archived: 'manual',
        },
      },
      verify_command: 'npm test',
    },
  });
  const after = await fs.readFile(join(repo, '.conductor', 'config.yaml'), 'utf8');
  // Preamble survived.
  expect(after).toContain('# Claude-subscription-only config');
  expect(after).toContain('# Prerequisites:');
  // EOL annotation survived (heuristic should match `analyze` key path).
  expect(after).toContain('heavy reasoning');
  // The actual change landed.
  expect(after).toContain('default: auto');
});
```

**File**: `tests/cli/autonomy.test.ts` (NEW)

```ts
// tests/cli/autonomy.test.ts
import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autonomySet } from '../../src/cli/commands/autonomy.js';

describe('autonomy set CLI (Relay #27 sibling)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'conductor-autonomy-'));
    await mkdir(join(repo, '.conductor'), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('preserves user-authored comments on autonomy set', async () => {
    await writeFile(
      join(repo, '.conductor', 'config.yaml'),
      [
        '# project config — do not delete',
        '',
        'routing:',
        '  default: a',
        '  functions: {}',
        'autonomy:',
        '  default: assist',
        '  transitions:',
        '    discovered_to_planned: auto',
        '    planned_to_approved: assist',
        '    approved_to_building: manual',
        '    building_to_verifying: auto',
        '    verifying_to_shipped: assist',
        '    shipped_to_archived: manual',
        'verify_command: x',
        '',
      ].join('\n'),
      'utf8',
    );
    await autonomySet(repo, 'auto');
    const after = await readFile(join(repo, '.conductor', 'config.yaml'), 'utf8');
    expect(after).toContain('# project config — do not delete');
    expect(after).toContain('default: auto');
  });
});
```

**Why**: four test files cover the surfaces this plan changes — two unit suites on the pure helpers, one integration extension on `config_set`, one new CLI test giving `autonomySet` its first dedicated coverage. Together they pin the comment-preservation contract and the surgical-patch contract so future refactors can't regress silently.

**Risk**: the EOL-annotation test in `preserve_comments.test.ts` and in `tests/rpc/methods.test.ts` is the most heuristic-sensitive — js-yaml's output format for `routing.functions` (block vs flow style) affects the line shape. If js-yaml emits `functions: { analyze: ... }` flow-style for empty objects but block-style for non-empty, the test pinning could break. Mitigation: use a non-empty functions map in the regression test (forces block style); verify before committing by running the test against the actual js-yaml output.

**Verify**: `npx vitest run tests/ui tests/config/preserve_comments.test.ts tests/rpc/methods.test.ts tests/cli/autonomy.test.ts` passes; then `npm test` full-suite remains green.

**Rollback**: delete the four test files / revert the methods.test.ts extension. No production code dependency.

---

### Grouped Run Coverage

| # | Target | Kind | Obligation | Plan Step(s) | Files / Symbols | Notes |
|---|--------|------|------------|--------------|-----------------|-------|
| 1 | `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits.md` | run leader | full | 1, 2, 6 | `src/ui/views/routing.ts::replaceAutonomyDefault` (new), `src/ui/views/routing.ts:110-124` (autonomy change handler), `tests/ui/routing-helpers.test.ts` (new) | Option B surgical patch; null-return falls back to no-op |
| 2 | `.relay/issues/ui-config-set-strips-yaml-comments.md` | existing item | full | 3, 4, 5, 6 | `src/config/preserve_comments.ts` (new helper), `src/rpc/methods.ts::config_set` (wiring + readFile), `src/cli/commands/autonomy.ts::autonomySet` (sibling wiring), `tests/config/preserve_comments.test.ts` (new), `tests/rpc/methods.test.ts` (extended), `tests/cli/autonomy.test.ts` (new) | Option A heuristic preservation; covers omniforge preamble + init-template EOL annotations |

The analysis flagged `src/cli/commands/autonomy.ts` as a sibling-bug candidate; verification during planning confirmed it has the identical `yamlDump`-after-parse pattern. Step 5 folds it into #27's coverage, making `autonomy.ts` an additional covered file under entry #2.

## Test Changes

- **NEW**: `tests/ui/routing-helpers.test.ts` — 6 unit cases on `replaceAutonomyDefault`.
- **NEW**: `tests/config/preserve_comments.test.ts` — 8 unit cases on `preserveYamlComments` (7 original + 1 added by /relay-review for top-level scalar EOL preservation).
- **NEW**: `tests/cli/autonomy.test.ts` — 1 integration case on `autonomySet` (the CLI command's first dedicated test).
- **EXTEND**: `tests/rpc/methods.test.ts` — +1 case `config_set preserves yaml comments on commit (#27)`.

Expected suite delta: 596 → 612 (+16). Phase 22 baseline 596 holds for all existing assertions; new cases land additively.

## Post-Implementation Checks

1. `npm run typecheck` (engine + UI tsconfigs) — clean.
2. `npx vitest run tests/ui tests/config/preserve_comments.test.ts tests/cli/autonomy.test.ts` — new tests pass in isolation.
3. `npx vitest run tests/rpc/methods.test.ts` — Phase 22 cases + new #27 case all pass (6 config_set tests).
4. `npm test` — full suite green, ≥ 611/611.
5. Manual smoke (matches the steps in both issues' Reproduction):
   - `cd` to a fresh `conductor init` project. Edit `.conductor/config.yaml` to add a `# my note` comment line above `autonomy:`. Run `conductor daemon start`. Open `#/routing` in browser. Confirm textarea shows the canonical YAML (comments may or may not appear depending on `configToYaml`'s shape — they DO appear via `loadProjectConfig → config_get` because config_get re-reads disk, but the textarea is hand-rolled and skips comments; the visible textarea reflects only the parsed schema fields, which is current behavior).
   - In the textarea, change `verify_command: npm test` → `verify_command: pytest`. Without committing, flip the autonomy dropdown from `assist` to `auto`. Confirm the textarea now reads `autonomy.default: auto` AND `verify_command: pytest` is intact (the user's uncommitted edit survived).
   - Click *Commit changes*. Confirm `git diff .conductor/config.yaml` shows the two intended lines changed AND the `# my note` comment survived AND the file-head preamble (from `conductor init`'s template) is intact.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Heuristic comment-preservation misses on unusual YAML shapes (anchors, flow maps, multi-line scalars) | Low | Medium — those comments would still be stripped | Document as known limitation; escalate to Option B (AST library) if dogfood surfaces a shape Option A can't handle. None of the unsupported shapes appear in `ProjectConfigSchema`-valid configs today. |
| `replaceAutonomyDefault` returns null on unusual textarea shape | Medium | Low — UI silently skips the textarea update; server still saves | The user's edits stay; visible inconsistency is small and self-corrects on Reload from disk. The status pill still shows "⌁ saved" because the server-side save did succeed. |
| Race between Phase 22's `loadProjectConfig` read and the new `readFile` in `config_set` | Very Low | Very Low — affects comment placement only | Sub-millisecond window; affects no data correctness; if it became real, refactor `loadProjectConfig` to return raw text alongside parsed object. |
| `js-yaml` dump format drift across upgrades changes the structural shape of `newDump` | Very Low | Low — EOL-comment matching by key path tolerates reordering | Helper matches by key path, not line position; resilient to most reformat changes. |
| Test pinning on `js-yaml`'s exact whitespace would fail on a future js-yaml upgrade | Low | Low | Tests assert `toContain` on logical substrings (`'heavy reasoning'`, `'default: auto'`) rather than full-string equality; should survive minor dump-format changes. |

## Rollback Plan

`git revert <commit-hash>` after each step's commit. Since the work spans 4 expected commits (Step 1+2 routing client; Step 3 helper; Step 4+5 server + CLI wiring; Step 6 tests), partial revert is straightforward — revert most recent backward until the unwanted step is gone. No DB migrations, no config schema changes, no stored data format changes.

This plan also lives in tracking form in [`ui-config-set-strips-yaml-comments.md`](ui-config-set-strips-yaml-comments.md) via the grouped-run pointer at the top of that file; the binding plan resides here in the leader.

---

## Adversarial Review

*Reviewed: 2026-05-16*

### Source verification

Re-read each target file NOW and compared to the plan's BEFORE blocks. **No drift** — every BEFORE block matches the current source verbatim:

- `src/ui/views/routing.ts:110-124` — autonomy `change` handler unchanged since the plan was written. The destructive `config_get → ta.value = configToYaml(r.config)` block is exactly at lines 117-118.
- `src/rpc/methods.ts:238-267` — `config_set` body unchanged. `yamlDump(validated, { lineWidth: 100, noRefs: true })` is line 261; `writeFile(...)` is line 262.
- `src/cli/commands/autonomy.ts:14-28` — `autonomySet` unchanged. Plan's identification of this as a sibling-bug site (same `yamlDump`-after-parse pattern) is correct.

Sanity-checked the schema and existing test scaffolding:

- `ProjectConfigSchema` (`src/config/schema.ts:40-121`) is `.strict()`. Top-level keys are `routing | autonomy | verify_command | cost_ceilings | confidence | run_log | brain_log | tracker` — only `verify_command` is a top-level scalar. The plan's helper handled nested EOL comments but missed top-level scalar EOL comments — see Issue 2 below.
- `tests/rpc/methods.test.ts:13-22` `setupRepo()` seeds `.conductor/config.yaml` with three lines and zero comments. After the plan ships, the helper will see no preamble + no section blocks + no EOL comments → pass through `newDump` unchanged. **No existing tests at 187-291 break.**
- `tests/integration/phase5-ui-end-to-end.test.ts` does not assert on `config_set`'s exact YAML output (grep returned no `config_set` matches), so the new comment-preservation behavior is invisible to that integration test.

### Edge cases tested

Applied `.relay/relay-config.md § Edge Cases` scenarios:

| Edge case | Result |
|-----------|--------|
| `tracker.kind: 'none'` discriminatedUnion | Plan doesn't change tracker handling; deepMergeConfig's existing `kind`-mismatch wholesale-replace logic preserved. ✓ |
| `autonomy.transitions.*` policy (manual/assist/auto) | Plan only changes `autonomy.default`; transitions untouched. ✓ |
| `ProjectConfigSchema` is `.strict()` | Helper doesn't introduce new keys; preserved comments map by EXISTING key names; orphan-key comments silently dropped. ✓ |
| `cost_ceilings` Infinity preprocess | New comment helper runs AFTER schema validation, so the Infinity↔null preprocess is unaffected. ✓ |
| Test pre-seed via `setupRepo` (no comments) | Helper passes through unchanged on no-comments input. ✓ |
| `MOCK` adapter resolution path | Plan touches no adapter code. ✓ |

Helper-specific edge cases probed:

| Scenario | Plan's behavior | OK? |
|----------|-----------------|-----|
| `existingText === null` (ENOENT path) | Returns `newDump` unchanged | ✓ |
| `existingText === ''` (empty file) | Returns `newDump` unchanged | ✓ |
| File-head preamble adjacent to a section-leading comment block | Preamble loop captures the contiguous block; Pass 2's `k >= i` guard prevents double-capture. Walked manually; no duplication. | ✓ |
| Section-leading comment block above the second top-level key only | Pass 2 starts at `i` (post-preamble); walks backward, captures the block. Output gets blank-line separator before the block. | ✓ |
| Mid-section comments (e.g., a `# comment` inside `routing:` block) | **Not preserved.** Documented as Option A limitation in the helper's docstring. Acceptable per #27's issue text ("Not perfect but covers the init preamble case"). | ✓ (acknowledged) |
| Existing has `routing.functions.analyze: opus    # heavy reasoning` and dump emits `analyze: opus` | EOL captured by key path `routing.functions.analyze`; re-attached as `analyze: opus  # heavy reasoning`. | ✓ |
| `verify_command: npm test  # custom` (top-level scalar EOL) | **Plan as originally written DROPS the EOL comment.** TOP_KEY regex had no EOL capture, and NESTED_KV doesn't match indent-zero lines. **Issue 2 below.** | ✗ — fixed in revision |
| `mode` parameter contains regex-replacement special chars (`$&`, `$1`) | **Plan's `$1${mode}` replacement is technically vulnerable.** Bounded enum (escort/assist/auto/critical) means no real value contains `$`, but defensive coding wins. **Issue 1 below.** | ✗ — fixed in revision |
| `js-yaml` reorders keys between existing and dump | Helper matches EOL by key path, not line position — resilient. ProjectConfigSchema actually fixes key order via Zod parse, so this is rarely-fires anyway. | ✓ |
| External process rewrites `config.yaml` between `loadProjectConfig` (line 247) and the new `readFile` | Sub-millisecond race; affects only comment placement. Same race window already exists in Phase 22's deep-merge layer. Acceptable. | ✓ (documented as Risk #3) |
| Existing has TAB indents instead of spaces | Helper's `indent = m[1].length` counts characters; if existing uses TABs and dump uses spaces, indent counts won't match. Section-leading-block detection still works (matches by top-level KEY NAME, not indent). Nested EOL-comment matching would miss. **Acceptable limitation** — `js-yaml` dump uses spaces; the only way to get TAB indents in existing is hand-editing. | ✓ (acknowledged) |

### Regression check

Read tests directories for affected modules:

- **`tests/rpc/methods.test.ts`** — 5 config_set tests (lines 187-291). Walked each:
  - 187: writes config, reads back, asserts via `config_get`. No comment assertions; passes.
  - 212: invalid input → throws. Unaffected.
  - 220: pre-seeds custom `cost_ceilings`, asserts preserved on partial commit. **Helper preserves nothing** (no comments in seed) → pass through. Phase 22 deep-merge still does the work. Passes.
  - 262: Infinity roundtrip. Unaffected.
  - 279: bus event. Unaffected.
- **`tests/integration/phase5-ui-end-to-end.test.ts`** — grep confirmed no `config_set` / `yamlDump` assertions.
- **`tests/integration/phase6-end-to-end.test.ts`** — present in the related-work grep; quick scan would be needed but config_set is not its focus (Phase 6 is brain telemetry). Helper's pass-through behavior on no-comments input means even if it touches config_set transitively, no break.
- **`tests/agent/autonomy_gate.test.ts`** — tests autonomy gate logic in the agent loop, not the CLI command. Unaffected by `autonomySet` wiring.
- **No existing test for `src/cli/commands/autonomy.ts`** — plan adds `tests/cli/autonomy.test.ts` as the first dedicated coverage. New addition; no regression surface.

Cross-checked archived items: the three Phase 22 PR-1 closures (#25, #26, #28) all live on the same surface. None of their pinned behaviors are touched by this plan:

- #25 (deep-merge): preserved as-is. Helper runs AFTER merge+validate; doesn't perturb the merge.
- #26 (Infinity preprocess): preserved as-is.
- #28 (ZodError joined message): preserved as-is. Helper doesn't touch error formatting.

Verified the contract-drift scan finding from analysis: `src/cli/commands/autonomy.ts` IS a sibling-bug site (lines 14-28 read → parse → mutate → `yamlDump`). Step 5 covers it.

### Sibling-survival check

Walked the Scope Decision's `#### Grouped Entries` against the plan's `### Grouped Run Coverage`:

| Entry | Obligation | Plan step coverage | Files/symbols claimed | Sibling-survival? |
|-------|-----------|--------------------|------------------------|-------------------|
| 1 — `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits` (leader) | full | Steps 1, 2, 6 | `routing.ts::replaceAutonomyDefault`, `routing.ts:110-124`, `tests/ui/routing-helpers.test.ts` | ✓ |
| 2 — `ui-config-set-strips-yaml-comments` | full | Steps 3, 4, 5, 6 | `src/config/preserve_comments.ts`, `methods.ts::config_set`, `autonomy.ts::autonomySet`, plus three test files | ✓ |

Both entries have explicit plan steps at full obligation. **No sibling-survival objections.**

### Issues Found

#### Issue 1 — `replaceAutonomyDefault` replacement string vulnerable to regex-replacement specials in `mode`
**Severity: LOW**

`String.prototype.replace` interprets `$&`, `$1`, `$<name>`, etc. in the replacement string. If `mode` ever contained `$`, the helper would inject something unexpected. Today `mode` is bounded to four enum strings (escort/assist/auto/critical) with no `$`, so this is defensive paranoia — but cheap to fix and adds resilience if AUTONOMY_MODES gains new values in the future.

**Plan has:**
```ts
lines[i] = line.replace(/(default:\s*)\S+/, `$1${mode}`);  // ← `$1` is interpolated by replace; `mode` is template-string-interpolated but then re-scanned by replace for `$` specials
```

**Should be:**
```ts
lines[i] = line.replace(/(default:\s*)\S+/, (_, p1) => p1 + mode);  // ← function replacer; `mode` is a plain string concat, no regex-replacement interpretation
```

#### Issue 2 — `preserveYamlComments` drops EOL comments on top-level scalar keys (e.g., `verify_command:`)
**Severity: LOW**

The plan defined two regexes: `TOP_KEY = /^([a-zA-Z_][\w-]*):\s*(.*)$/` and `NESTED_KV = /^(\s+)[…](#.*)?$/`. Pass 3 captured EOL comments only via NESTED_KV (`eol = NESTED_KV.test(line) ? ... : ''`), so a top-level scalar like `verify_command: npm test  # custom override` lost its `# custom override` annotation. The only top-level scalar in `ProjectConfigSchema` is `verify_command`, so the blast radius is small — but `conductor init` writes that key and a user could readily annotate it.

**Plan has:**
```ts
// Two separate regexes; Pass 3 captures EOL only for nested.
const TOP_KEY = /^([a-zA-Z_][\w-]*):\s*(.*)$/;                         // ← group 2 captures value+comment as one blob
const NESTED_KV = /^(\s+)([a-zA-Z_][\w-]*):\s*(\S.*?)?\s*(#.*)?$/;     // ← group 4 captures EOL
// ...
const eol = NESTED_KV.test(line) ? (NESTED_KV.exec(line)![4] ?? '') : '';  // ← `''` for any top-level line
```

**Should be:**
```ts
// Unified pattern; group 1 is indent (possibly empty), group 4 captures EOL for top-level AND nested.
const KV_PATTERN = /^(\s*)([a-zA-Z_][\w-]*):\s*(\S.*?)?\s*(#.*)?$/;    // ← matches both shapes
const TOP_KEY = /^([a-zA-Z_][\w-]*):/;                                  // ← kept only for Pass 2's section-leading-block detection
// ...
const m = KV_PATTERN.exec(line);                                       // ← single regex run
if (!m) continue;
const indent = m[1].length;                                            // ← group 1 length = nesting depth
const key = m[2];                                                       // ← group 2 = key name
const eol = m[4] ?? '';                                                // ← group 4 = EOL comment (now captured for top-level too)
```

Pass 4 also unified to use the same `KV_PATTERN` and branch on `indent === 0`. New regression test added: `preserves end-of-line annotations on top-level scalar keys` exercising `verify_command: npm test  # custom override`.

### Regression Risk

| Risk | Mitigation |
|---|---|
| **Helper regression on existing test pre-seeds** | All existing `tests/rpc/methods.test.ts` config_set tests use seeds with zero comments; helper passes through `newDump` unchanged. Verified inline. ✓ |
| **Unified KV_PATTERN regression** (fewer regexes; could mis-handle some shape) | Pass 4's `if (!m) outLines.push(line); continue;` fallthrough preserves any line that doesn't match (arrays, scalars, etc.) — same as the original. ✓ |
| **EOL comment over-capture** (e.g., `value` containing `# is part of value`) | YAML strings containing `#` would need quoting (`"value # not-comment"`); js-yaml dumps such strings with quotes, so KV_PATTERN's group 3 captures `"value # not-comment"` and group 4 is empty. ✓ |
| **Phase 17 keyboard cluster** — feature 1 dispatcher's textarea form-field guard | Plan does NOT introduce a global key handler. Feature 1 (when shipped) will skip key shortcuts in the routing textarea. Complementary; no collision. ✓ |

### Verdict

**APPROVED WITH CHANGES**

Two LOW-severity defensive fixes applied in-place above:
1. `replaceAutonomyDefault` uses a function replacer (Step 1).
2. `preserveYamlComments` unified to a single `KV_PATTERN`, capturing EOL comments on top-level scalars (Step 3). Added regression test for `verify_command:` EOL preservation (Step 6, brings test count from 7 → 8 in the helper suite; total suite delta 596 → 612 (+16)).

No CRITICAL/HIGH findings, no regression risks identified, no sibling-survival objections. Plan is ready for implementation.

---

## Implementation Guidelines

*Date: 2026-05-16*

- Follow the finalized plan step by step, in order.
- After each step, run its VERIFY command before moving to the next.
- Commit after each logically complete step or group of related steps. Expected commit shape (Control phase 23.1):
  - Commit 1: Steps 1+2 (routing.ts client surgical patch + helper extract).
  - Commit 2: Step 3 (preserve_comments helper).
  - Commit 3: Steps 4+5 (config_set + autonomy.ts wiring).
  - Commit 4: Step 6 (test files — or fold tests into each step's commit if smaller).
  - Step-close commit: `docs(23.1): flip steps.md checkbox for step 23.1`.
- If a step cannot be implemented as planned, APPEND a deviation section to this file before proceeding:

  ## Implementation Deviations

  ### Step [N]: [title]
  - **Planned**: [what the plan said]
  - **Actual**: [what was done instead]
  - **Reason**: [why the deviation was necessary]

- Do NOT make changes beyond what the plan specifies.

---

## Verification Fixes

*Date: 2026-05-16*

### Fix 1: orphan-section test input shape

- **Symptom:** `tests/config/preserve_comments.test.ts > drops comments that no longer have a matching key in the dump` failed with the comment appearing in output.
- **Root cause:** the original test input placed `# orphan section` at file-head (before any YAML key). The helper correctly captured it as file-head preamble (the omniforge-preamble case the helper is designed to preserve), so it landed in the output as intended. The test's intent was the inter-key orphan case (a section-leading block whose key disappeared), but the input shape didn't exercise that branch.
- **Resolution:** revised the test input so `# orphan section above removed key` sits between `routing:` and `removed_key:`. Helper now correctly drops the comment because `removed_key:` is absent from `newDump`. Helper behavior unchanged; only the test input + name updated to reflect the actual scenario under test.
- **Helper code touched:** none.
- **Test file touched:** `tests/config/preserve_comments.test.ts` (one case renamed and input restructured).

---

## Verification Report

*Verified: 2026-05-16*

### Implementation Status

| Step | Planned | Implemented | Correct |
|------|---------|-------------|---------|
| 1 — `replaceAutonomyDefault` exported helper in `src/ui/views/routing.ts` | exported pure helper; matches canonical shape; null on miss; function replacer | YES (`routing.ts:19-43`) | YES |
| 2 — autonomy `change` handler uses helper; drops destructive `config_get` overwrite | replace block at `routing.ts:117-118` with surgical patch | YES (`routing.ts:136-152`) | YES |
| 3 — `src/config/preserve_comments.ts` new helper module | `preserveYamlComments(existingText, newDump): string` — unified KV_PATTERN; file-head preamble + section blocks + EOL comments (top-level + nested); ENOENT-safe | YES (new file, 157 lines) | YES |
| 4 — `config_set` wires `preserveYamlComments` | add `readFile().catch(ENOENT→null)`; pass through helper before `writeFile` | YES (`methods.ts:263-270`) | YES |
| 5 — `autonomySet` wires `preserveYamlComments` (sibling site) | same wiring at the parallel CLI write site | YES (`autonomy.ts:13, 27-29`) | YES |
| 6 — Four test files | unit + integration coverage for both helpers; +16 net new cases | YES (6 + 8 + 1 + 1 new; methods.test.ts 24 → 25) | YES |

### Grouped Run Coverage

| Entry | Obligation | Plan promised | Diff evidence | Closed? |
|-------|------------|---------------|---------------|---------|
| 1 — `ui-routing-autonomy-dropdown-overwrites-uncommitted-yaml-edits` (leader) | full | `routing.ts::replaceAutonomyDefault`, `routing.ts:110-124` autonomy handler, `tests/ui/routing-helpers.test.ts` | `routing.ts:19-43` (helper exported), `routing.ts:136-152` (handler now surgical), `tests/ui/routing-helpers.test.ts` 6/6 pass | ✓ closed |
| 2 — `ui-config-set-strips-yaml-comments` | full | `src/config/preserve_comments.ts` (new), `methods.ts::config_set` (wiring), `autonomy.ts::autonomySet` (sibling wiring), `tests/config/preserve_comments.test.ts` (new), `tests/rpc/methods.test.ts` (+1), `tests/cli/autonomy.test.ts` (new) | new `preserve_comments.ts`, `methods.ts:263-270`, `autonomy.ts:13/27-29`, `preserve_comments.test.ts` 8/8 pass, `methods.test.ts` +1 (25/25), `autonomy.test.ts` 1/1 pass | ✓ closed |

No verification objections. Both entries closed at full obligation; the analysis open question about `src/cli/commands/autonomy.ts` being a sibling-bug site was confirmed during planning and folded into Entry 2's covered files.

### Test Results

- `npm run typecheck` → clean (engine + UI tsconfigs).
- `npx vitest run tests/ui/routing-helpers.test.ts` → **6/6 pass**.
- `npx vitest run tests/config/preserve_comments.test.ts` → **8/8 pass** (after Verification Fix 1 below).
- `npx vitest run tests/cli/autonomy.test.ts` → **1/1 pass**.
- `npx vitest run tests/rpc/methods.test.ts` → **25/25 pass** (24 prior + 1 new `#27` regression).
- `npm test` (full suite) → **612/612 pass across 105 test files** in ~18s. Delta from Phase 22 baseline: **596 → 612 (+16)**, matching the plan's predicted increment exactly.

### Issues Found

None. Implementation is faithful to the finalized plan; all six steps shipped at the promised granularity. The two /relay-review defensive fixes (function replacer in `replaceAutonomyDefault`; unified `KV_PATTERN` capturing top-level scalar EOL comments) are in place in the implementation.

### Verification Fixes

One fix applied during implementation; documented above in the `## Verification Fixes` section:

- **Fix 1**: `tests/config/preserve_comments.test.ts > drops comments that no longer have a matching key in the dump` — original test input shape conflated file-head preamble (intentionally preserved) with inter-key orphan comments (correctly dropped). Test input restructured so `# orphan section above removed key` sits between `routing:` and `removed_key:`; helper drops it correctly because `removed_key:` is absent from `newDump`. **No production code touched** — test-only revision. **Risk**: none — the previous test would have erroneously asserted the helper drops file-head preambles, which would mask the omniforge-preamble preservation behavior the helper is designed to provide. The corrected test exercises the actual orphan-section drop path.

### Verdict

**COMPLETE** — all six plan steps implemented at full obligation; both grouped entries closed; suite at 612/612 with zero regressions; typecheck clean. The one verification fix was a test-input correction with no production-code impact.

The autonomy dropdown no longer destroys uncommitted yaml edits (Relay #24); `config_set` and `autonomy.ts` both preserve user-authored YAML comments through commit cycles (Relay #27). Phase 13 PR-2 is closed.

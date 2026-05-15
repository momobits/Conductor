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

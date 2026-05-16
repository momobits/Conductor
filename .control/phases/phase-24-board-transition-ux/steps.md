# Phase 24 Steps

- [ ] 24.1 — Board transition UX (Relay #29 forward-map validator extract + alert removal; #30 backward path approved→planned).

## Step detail

### 24.1 — Board transition UX cluster (Relay Phase 14: #29 + #30)

Grouped-run candidate on Relay #29 leader. At drop time, look up the forward-map (reuse `policyForExit`'s allowed-next-column logic) + the BACKWARD set; reject visually (shake on source tile, or status surface) instead of dialog + `alert()`. Replace remaining `alert()` calls with the existing in-app status surfaces. Extract the validator into `src/ui/views/board_validate.ts` so Phase 17 feature 2 (`keyboard-board-focus-and-move`) can import it directly. Item #30: add `'approved->planned'` to the `BACKWARD` set; rationale is sound (no work performed at `approved` yet; rollback is cheap). Optional companion `'shipped->verifying'` deferred (lower priority).

Ship as one PR — both items touch the same drag-drop layer; #29's pre-validation logic must agree with #30's expanded BACKWARD set.

**Verify command:** `npm test` + `npx vitest run tests/engine/lifecycle.test.ts` + UI smoke via `tests/integration/phase5-ui-end-to-end.test.ts` extension if a fixture path makes sense.

**Step-close commit:** `docs(24.1): flip steps.md checkbox for step 24.1`.

Commit message template per Control protocol: `<type>(24.1): <subject>`.

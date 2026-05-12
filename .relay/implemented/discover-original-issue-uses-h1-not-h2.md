# Implemented: Card body uses `# Original Issue` (H1) — promoted to `## Original Issue` (H2)

## Summary

*Resolved: 2026-05-12*

- **Problem.** Cards filed by `conductor discover` and created by `createCard()` led with a `# Original Issue` (H1) section while every later lifecycle section (Analysis, Implementation Plan, Adversarial Review, Implementation Guidelines, Verification Report) was appended at H2 by `appendSection`. This produced an unbalanced visual outline where the original-issue heading rendered 1.5–2× larger than every peer section, creating a misleading parent/child mental model. The `extractSection(body, heading)` helper at `src/engine/state/card.ts` only matches `## ${heading}`, so the H1 was also un-extractable by the existing helper.
- **Resolution.** Three single-line edits in `src/`: changed `# Original Issue` → `## Original Issue` at the discover write site, at `createCard`'s default-body fallback, and in the `card.ts` docstring's accretion-order example. Two test additions pin the new convention with positive + negative regression assertions.

## Files Modified

- `src/cli/commands/discover.ts:57` — discover op's body-template array: `'# Original Issue'` → `'## Original Issue'`.
- `src/engine/state/card.ts:6` — file-header docstring's accretion-order example: `//   # Original Issue` → `//   ## Original Issue`.
- `src/engine/state/card.ts:211` — `createCard`'s default-body fallback: `args.body ?? '# Original Issue\n\n'` → `args.body ?? '## Original Issue\n\n'`.
- `tests/cli/discover.test.ts` — added `expect(card).toContain('## Original Issue')` plus regression guard `expect(card).not.toMatch(/^# Original Issue/m)` to the existing "files a card per discovered item" test.
- `tests/engine/state/card.test.ts` — added a new `describe('createCard')` block with a default-body test asserting `/\n\n## Original Issue\n\n/` and the H1 regression guard `not.toMatch(/\n\n# Original Issue\n\n/)`. Added `createCard` and `readFile` to the existing imports.

## Verification

- `npm run typecheck` — clean (engine `tsconfig.json` + UI `tsconfig.ui.json` both pass).
- `npx vitest run tests/cli/discover.test.ts` — 2/2 pass.
- `npx vitest run tests/engine/state/card.test.ts` — 25/25 pass (was 24, +1 new test).
- `npm test` — **498/498 pass across 96 test files in 15.30s**; baseline 497 + 1 new test = expected 498. Zero regressions.

## Caveats

- **Adversarial-review finding documented in-place**: `createCard`'s default-body fallback is **dead code at runtime today**. The only production caller is `src/rpc/methods.ts:63-65` (`conductor.card_new` RPC handler), which always passes `body: p.body ?? ''`. Because `??` treats `''` as defined, the `'## Original Issue\n\n'` default is never reached. The CLI path `src/cli/commands/card-new.ts:79` bypasses `createCard` entirely with its own `writeFile` and uses the literal `\n# Original\n\n${args.title}\n\n...` (note `# Original`, not `# Original Issue`). The fix is still warranted: it keeps the docstring contract truthful, the new test pins the convention, and any future caller that opts into the default will get H2.
- **Related drift filed as follow-up candidate** (kept narrow per `### Scope Decision`): `src/cli/commands/card-new.ts:79` writes a different H1 (`# Original`) — same convention-drift root cause, separate string. Filed in the issue's `## Adversarial Review` Related Work as an unfiled candidate with suggested handling "file companion". Not addressed in this PR.
- **Doc drift**: `.relay/relay-readme.md:332`'s lifecycle ASCII diagram still shows `# Original Issue`. Flagged in the issue's analysis as a Related Work finding (suggested handling: bundle into the phase-7 docs PR per `.relay/relay-ordering.md`). Not addressed in this PR.
- **Migration**: existing deployed cards in `.conductor/cards/` continue to show `# Original Issue` (no read-time normalization in `readCard`). The issue's "Migration" section flagged this as optional; it remains optional. New cards adopt H2.
- **No regression risk to phase-9 work**: phase-9 added the typed-error classes (`CardNotFoundError`, `CardParseError`, `messageForReadCardError`) above `createCard`; this fix touches only the body-default string and the docstring, leaving error-handling paths untouched.

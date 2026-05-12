# Card body uses `# Original Issue` (H1) — inconsistent with H2 sections appended later

*Created: 2026-05-12*
*Source: docs/dogfood-log.md — Issue T2-2*
*Severity: P2 — quality*

## Problem statement

Cards filed by `conductor discover` and by `conductor card new` start with a
`# Original Issue` (H1) body section. Every section appended **after** that
by the lifecycle ops (`analyze`, `plan`, `review`, `implement`, `verify`,
`resolve`) uses H2 — `## Analysis`, `## Implementation Plan`,
`## Adversarial Review`, `## Implementation Guidelines`, etc.

Result: the original issue is visually over-prominent (an H1 typically renders
larger than every other heading on the card) and inconsistent with the rest
of the document outline. The section-extraction helper
`extractSection(body, heading)` in `src/engine/state/card.ts:85-92` only
looks for `## <heading>` — it could not extract `# Original Issue` even if a
downstream op needed to.

## Current state

H1 is written in **two** sites, not just discover:

- `src/cli/commands/discover.ts:57` — discover's filed-card body template:
  ```ts
  body: [
    '# Original Issue',
    '',
    item.rationale,
    ...
  ].join('\n'),
  ```
- `src/engine/state/card.ts:118` — `createCard()` default body for
  `conductor card new`:
  ```ts
  const body = args.body ?? '# Original Issue\n\n';
  ```
- `src/engine/state/card.ts:6` — the file's doc comment also documents the
  convention as `# Original Issue` followed by H2 sections for every op:
  ```
  //   # Original Issue
  //   ---
  //   ## Analysis
  ```

Subsequent appends through `appendSection()` (line 70-80) always use
`## ${heading}`, so the in-card outline is:

```
# Original Issue        ← H1 (only this heading)
## Analysis              ← H2
## Implementation Plan   ← H2
## Adversarial Review    ← H2
## Implementation Guidelines  ← H2
## Verification Report   ← H2
```

The dogfood log noted this on T2 specifically about `discover` — the same
inconsistency applies to manually-filed cards via `conductor card new`.

## Impact

- Visual hierarchy is wrong — H1 dwarfs every appended section.
- Markdown renderers and Table-of-Contents generators treat the original
  issue as the document title (H1 = page title in most conventions), which
  is misleading.
- `extractSection()` is keyed to H2 (`## ${heading}`). If any future op
  needs to programmatically read the original issue, the helper does not
  match it.
- Users who hand-write a card and follow the existing examples will perpetuate
  the inconsistency.

## Proposed fix

Promote `# Original Issue` to `## Original Issue` in both sites and update
the docstring.

1. `src/cli/commands/discover.ts:57` — change the first array element from
   `'# Original Issue'` to `'## Original Issue'`.
2. `src/engine/state/card.ts:118` — change the default body from
   `'# Original Issue\n\n'` to `'## Original Issue\n\n'`.
3. `src/engine/state/card.ts:6` — update the doc comment:
   ```
   //   ## Original Issue
   //   ---
   //   ## Analysis
   ```

Migration: existing cards in deployed `.conductor/cards/` directories still
have `# Original Issue`. A best-effort migration that rewrites `# Original Issue`
to `## Original Issue` on read could be added to `readCard()` but is not
required — the inconsistency does not break any read path.

### Verification

- Run `conductor card new test --title "test card"` and confirm the resulting
  file's body opens with `## Original Issue`.
- Add an assertion to `tests/engine/state/card.test.ts` that `createCard()`
  default body starts with `## Original Issue`.
- Add an assertion to `tests/cli/discover.test.ts` that filed-card bodies
  start with `## Original Issue`.

## Affected files

- `src/cli/commands/discover.ts`
- `src/engine/state/card.ts`
- `tests/cli/discover.test.ts`
- `tests/engine/state/card.test.ts`
- `tests/cli/card-new.test.ts` (verify default-body assertion still passes)

---
description: Verify done criteria, tag phase, and scaffold the next phase
---

For the current phase (from `.control/progress/STATE.md`):

1. **Check working tree is clean.** Run `git status --porcelain`. If non-empty, stop and ask the user to commit or stash. Do not advance.
2. Re-read the current phase's `README.md` done criteria.
3. Verify each criterion. For automated ones, run the commands and report results. For manual ones, ask the user to confirm.
4. Verify `.control/issues/OPEN/` has no items tagged `phase:<N>-blocker`.
5. Verify test / eval status in STATE.md is green.
6. **If any criterion fails, stop.** List what's missing. Do not advance.
7. If all pass:
   - Create the phase tag: `git tag phase-<N>-<name>-closed` with a message summarising what shipped.
   - Update `.control/progress/STATE.md`: current phase → `<N+1>`, step → `<N+1>.1`, Last-phase-tag → the new tag, reset "Attempts that didn't work" and "In-flight work", update next action.
   - Scaffold `.control/phases/phase-<N+1>-<name>/`:
     - Copy `.control/templates/phase-readme.md` → new phase's `README.md`.
     - Copy `.control/templates/phase-steps.md` → new phase's `steps.md`.
     - Fill in the copied scaffolds with content from `.control/architecture/phase-plan.md`'s Phase `<N+1>` entry — typically Goal, Outcome, and the sub-step list under Done criteria. **Do NOT fill the `## Why this phase exists` section from phase-plan.md** — that section is reserved for the carry-forward logic (next sub-bullet) plus the operator's post-scaffold edits.
   - **Carry forward deferred items.** From the current phase's `README.md`, read the section whose heading starts with `## Deferred to Phase` (F4 shipped this as the last section in the template; locate by heading prefix rather than file position, because the author may have added `## ` sections after Deferred). If no such heading is found (pre-F4 phase, or operator removed the section), treat as empty — no bullets to carry, skip the seeding entirely. Otherwise, for each bullet starting with `- ` under that heading:
     - If the bullet's item text is the literal `<item>` placeholder from the template, skip it.
     - If the bullet lacks a ` — ` em-dash (U+2014) separator between item text and reason text, emit `[carry-forward] skipped non-conforming bullet: <bullet-text>` and skip it.
     - Otherwise, collect the bullet verbatim for carry-forward.
   - If no bullets were collected (section missing, section present but empty, all placeholders, or all non-conforming), skip the seeding step — no error, no output line.
   - If one or more bullets were collected, open the new phase's `README.md`, locate the `## Why this phase exists` section (F3's destination). If the section is missing (template was broken or manually edited between scaffold-copy and this step), insert a fresh `## Why this phase exists` heading directly before `## Sub-steps`. Prepend into the section at column-0 (no leading indentation), above any existing content (preserving F3's `<Fill in during phase kickoff.>` placeholder and any post-scaffold author edits below), the following block written verbatim to the destination file:

         Carried forward from Phase <N>:
         - <first carried bullet verbatim from the Deferred section>
         - <second carried bullet verbatim>

     (The indentation of the example above is for readability in this command file only — when writing to the destination README, flush the block to column-0 with the `## Why this phase exists` heading.) Then tell the user: `Seeded Phase <N+1>'s 'Why this phase exists' with <count> carry-forward item<s> from Phase <N>. Review and edit before continuing.` — pluralize "item" → "items" at runtime when `<count>` ≥ 2; use "item" when `<count>` = 1.
   - Write the kickoff prompt to `.control/progress/next.md`.
   - Commit: `chore(phase-<N>): close phase <N>, kick off phase <N+1>`.
   - Append a journal entry: "Phase <N> closed (tag: `phase-<N>-<name>-closed`, commit: `<sha>`); Phase <N+1> kicked off."
   - Print the next-session prompt for the user.

## Output shape (v2.0)

**Default — narrative.** During verification (steps 2-6), narrate what you're checking in 1-2 sentences. After verification, narrate the verdict.

Examples:
> Phase 2 (DSPy QueryPlanner) done criteria: 4 of 5 pass. Smoke test still needs manual verification — please run it and confirm before re-running /phase-close.

> Phase 2 closed (tag `phase-2-dspy-queryplanner-closed`, commit `<sha>`). Phase 3 scaffolded with 1 carry-forward item from Deferred. Run /session-end next.

**Verbose (on request, or `--verbose`).** Show the full criteria checklist with per-item status:

```
Phase <N> done criteria:
[✓] All steps checked off
[✓] No phase:<N>-blocker issues open
[✓] Tests pass (47/0)
[✓] Eval score 0.84 ≥ baseline 0.80
[✗] Smoke test: needs manual verification
```

**Verification failure — always verbose.** If any criterion fails, show the full breakdown so the operator knows exactly what's missing. Don't proceed to step 7.

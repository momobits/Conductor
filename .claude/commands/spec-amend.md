---
description: Append a dated amendment section to .control/SPEC.md (v2.0 single-file spec)
argument-hint: <slug>
---

Append a dated amendment to `.control/SPEC.md`'s `## Artifacts (chronological)` section. Amendments are how the project spec grows over time without rewriting the canonical sections — newer amendments win over conflicting content above.

Use amendments for:
- **Addendums** extending the original spec with new sections
- **Pivots** revising a decision in the canonical sections
- **Deep-dives** on a subsystem not detailed in the original
- **Discovered constraints** that surfaced during implementation

## Process

1. Ask the operator:
   - **Title** — short descriptive name
   - **Kind** — addendum | pivot | deep-dive | constraint | other
   - **Scope** — which canonical section(s) this touches; if it supersedes anything, note it
   - **Summary** — one paragraph describing the amendment

2. **Locate the insertion point.** Open `.control/SPEC.md` and find the `## Artifacts (chronological)` heading. Append a new H3 subsection at the END of that section (after the most recent prior amendment, before EOF):

   ```markdown
   ### <today>: $ARGUMENTS

   **Kind:** <kind>
   **Scope:** <scope>
   **Supersedes:** <e.g. "## Tech choices section" or "(adds new content, supersedes nothing)">

   #### Summary
   <One paragraph from operator input.>

   #### Context
   <Forces that led to this amendment: what changed in reality, what was learned during implementation, what the original spec missed or got wrong.>

   #### Content
   <The actual new / revised material. Write decisively — "we use X because Y", not "we should consider X".>

   #### Impact on phase plan
   - Phase <N>: <impact> OR None
   - Phase <N>: <impact> OR None
   ```

   Use today's date in `YYYY-MM-DD` format (UTC).

3. **If the amendment supersedes a canonical section** (e.g. "Tech choices" was Postgres-only, now Postgres + Redis), do NOT delete the canonical section. The superseded content stays for historical record; the amendment is authoritative from its date forward. The `## Artifacts` ordering rule (newer wins over older) handles the resolution.

4. **If the amendment affects the phase plan** (new phase, changed outcome, dropped step), update `.control/architecture/phase-plan.md` to reference the amendment. Example:
   ```
   Phase 4 outcome updated by SPEC.md amendment 2026-05-01-pivot-central-store (was Postgres; now Postgres + Redis).
   ```

5. **Update `.control/progress/STATE.md`'s "Recent decisions"** to note the amendment with its date.

6. **Commit:** `docs(spec): SPEC.md amendment <today>-$ARGUMENTS -- <summary-short>`. Note the canonical commit format treats SPEC.md amendments as `docs(spec): ...` per the parens-allowlist.

7. **Journal entry:** `- SPEC.md amendment <today>-$ARGUMENTS -- <title> (<kind>)`.

## Guardrails

- **Do not delete content from canonical sections** when amending. The newer-wins rule preserves audit trail; deleting destroys it.
- **One amendment per concern.** Multiple unrelated changes go in separate amendments — don't bundle.
- **If an amendment invalidates a closed phase's done criteria**, flag it as a blocker — you may need to revisit that phase.
- **Use `git log .control/SPEC.md`** to see the full evolution; the `## Artifacts` section is the in-document view, but git log is authoritative.

## Relationship to /new-spec-artifact

`/new-spec-artifact` is a v1.3 alias kept for muscle memory; it now invokes the same logic as `/spec-amend`. The v1.3 layout (separate `.control/spec/artifacts/<date>.md` files) was collapsed in v2.0 — see README.md "Migration from v1.3" section. The alias will be removed in v2.1.

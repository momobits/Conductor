---
description: Create a new Architecture Decision Record
argument-hint: <short-title-slug>
---

Find the highest-numbered ADR in `.control/architecture/decisions/` (files named `NNNN-*.md`) and increment by 1. If the directory is empty, start at `0001`.

Create `.control/architecture/decisions/<NNNN>-$ARGUMENTS.md` from `.control/templates/adr.md`. For a model of production-depth filling (enumerated forces, tiered alternatives, scope bullets, post-shipping addenda), read `.control/templates/adr-example.md` — use it as a shape reference, not a content source.

Prompt the user for:
- Context (forces, constraints, problem)
- Decision (the choice)
- Alternatives considered (with rejection reasons)
- Consequences (positive, negative, follow-up)

Set Status to `proposed` initially. The user changes it to `accepted` once they confirm.

After it's accepted:
- Append a reference in the current phase's `README.md` under "ADRs decided in this phase".
- Update STATE.md's "Recent decisions" section.
- Commit: `docs(adr): ADR-<NNNN> $ARGUMENTS`.

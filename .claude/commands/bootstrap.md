---
description: Derive project-specific content from a spec file, or scan the codebase to create one
argument-hint: [<path-to-spec-file>]
---

Bootstrap Control's project-specific scaffolding. Has two modes depending on whether `$ARGUMENTS` is provided:

- **Spec mode** (`$ARGUMENTS` is a file path): copy the file into `.control/SPEC.md` and derive everything from it.
- **Scan mode** (`$ARGUMENTS` is empty): inspect the codebase, infer a starter spec, write it to `.control/SPEC.md`, then prompt the user to fill gaps before deriving.

Either way, the end state is identical: `.control/SPEC.md` is Control-managed and canonical; all derived docs reference it; the user is ready for `/session-start`.

---

## Step 0: Verify SPEC.md exists

`.control/SPEC.md` should exist as a v2.0 starter template after `setup.{sh,ps1}` ran. If missing (e.g., legacy v1.3 install pre-migration), create it from the template at `.control/SPEC.md` in the source repo, OR run setup again with `UPGRADE=1`. Both /bootstrap modes overwrite this file with operator-derived content.

*(v2.0 collapsed the v1.3 layout: `.control/spec/SPEC.md` + `.control/spec/artifacts/` + `.control/architecture/overview.md` → single `.control/SPEC.md`. Legacy installs can migrate via `UPGRADE=1 bash setup.sh`.)*

---

## Step 1a (Spec mode): user provided a spec

If `$ARGUMENTS` is a path and the file exists:

1. **Copy** (not move) the file at `$ARGUMENTS` to `.control/SPEC.md`.
2. Read `.control/SPEC.md` in full (multiple `Read` calls if >2000 lines).
3. Confirm with the user:
   - The project name you inferred
   - The phase count and ordering proposed (e.g. "8 phases: 1. foundation, 2. ...")
   - Whether any section should be emphasised or de-emphasised

## Step 1b (Scan mode): no spec provided

If `$ARGUMENTS` is empty or does not resolve to a file:

1. **Scan the codebase:**
   - Root files: `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `composer.json`, `Gemfile`, `requirements.txt`, `docker-compose.yml`, `Makefile`, `.env.example`, architectural docs (anything like `ARCHITECTURE.md`, `DESIGN.md`).
   - Directory tree: top-level directories (`src/`, `app/`, `server/`, `client/`, `tests/`, etc.). Use `Glob` to get a sense of structure, not an exhaustive listing.
   - Entry points: `main.*`, `index.*`, `app.*` at reasonable locations.
   - Commit history sample: `git log --oneline -20` for project narrative.

2. **Infer and draft** a starter `.control/SPEC.md` containing:
   - **Project name** (from package files or directory name)
   - **Problem statement** -- inferred from README if present; marked `[INFERRED -- please refine]` if unclear
   - **Tech stack** -- from package files
   - **Observed structure** -- brief tree of top-level dirs + what each appears to contain
   - **Detected conventions** -- formatter, linter, test framework, CI presence
   - **Open questions for the user** -- explicit list at the bottom

   Mark every inferred field clearly: `[INFERRED from <source>]`. The user will correct these.

3. **Interrogate the user interactively** for the things a codebase scan cannot answer. Ask one batch of 4-6 focused questions:
   - **Product vision:** "In one paragraph, what does this project do and for whom?" (so the problem statement is real, not inferred)
   - **Current state:** "What works today? What's the biggest gap right now?"
   - **Roadmap / phases:** "What are the next 3-6 major units of work? Even a rough list of milestones is enough -- I'll structure them as phases." (mandatory -- phases cannot be inferred from code)
   - **Locked-in invariants:** "Any strong 'never do X' or 'always use Y' rules specific to this project?"
   - **Out-of-scope:** "What's explicitly NOT in scope?"
   - **Tech choices to preserve:** "Any current tech decisions that should stay locked in? (e.g. 'always Postgres', 'no new frameworks')"

4. Take the user's answers and **rewrite** `.control/SPEC.md` replacing `[INFERRED]` placeholders with their input. Add any sections the user raised that weren't in the scan.

5. Show the user the final `.control/SPEC.md` and confirm: "OK to proceed with this as the project spec?"

---

## Step 2: Populate derived files

From here, spec mode and scan mode converge. Use `.control/SPEC.md` as the authoritative input.

All references to the spec in derived files must use the canonical path `.control/SPEC.md` (not any original filename).

1. **`CLAUDE.md`** -- keep the Control-managed header and session-start protocol. Replace `<PROJECT_NAME>`. Add a `### Project-specific invariants` subsection extracted from the spec (non-obvious architectural rules, locked-in tech, boundary lines). Under Key References, list `.control/SPEC.md` (and note that spec evolutions live in its git history; amend with `/spec-amend <slug>`).

2. **`.control/SPEC.md`'s `## Overview` section** -- distil the project identity into the Overview section in 1-2 paragraphs (problem, scope, tech table, pipeline description). The full canonical spec lives in the same file's other sections.

3. **`.control/architecture/phase-plan.md`** -- for each phase: ordinal+name, dependencies, session estimate, outcome, key steps, done criteria highlights. Top line: "Derived from `.control/SPEC.md`." Include sub-phases (4a, 4b) when the spec has them.

4. **`.control/phases/phase-1-<name>/README.md` and `steps.md`** -- scaffold ONLY Phase 1 from templates. Each step in `steps.md` should reference a specific section of `.control/SPEC.md` where applicable (e.g. "per `.control/SPEC.md` §X").

5. **`.control/progress/STATE.md`** -- overwrite. Include the `## Project spec` field (canonical = `.control/SPEC.md`; evolutions in its git history). Set Current phase=1, step=1.1, Next action=first step. Populate Git state from `git log -1` and `git rev-parse HEAD`. Environment snapshot from spec.

---

## Step 3: Finalise

1. Run `git status` -- show what changed.
2. Propose the commit message:
   - Spec mode: `chore: bootstrap <project-name> project docs from <original-spec-filename>`
   - Scan mode: `chore: bootstrap <project-name> project docs (scanned from codebase)`
3. Wait for user approval, then commit.
4. After commit, tell the user:
   - **Spec mode:** "Spec copied to `.control/SPEC.md`. Your original `<spec-filename>` is no longer referenced -- delete it when verified `.control/SPEC.md` matches."
   - **Scan mode:** "Inferred spec at `.control/SPEC.md`. Review it carefully -- scan-mode starters often miss nuance. Add detail via `/new-spec-artifact <slug>` as the project clarifies."
   - Both: "Use `/new-spec-artifact <slug>` to grow the spec as the project evolves. Run `/session-start` to begin Phase 1."

---

## Guardrails

- **Never move the user's original spec** -- copy it. User deletes the original after verification.
- **Do not fabricate phases.** If spec/scan doesn't lay out phases explicitly, the scan-mode questionnaire is mandatory. A bad phase plan wastes months.
- **Scan mode is a starter, not a final spec.** Be explicit with the user that the inferred spec needs refinement.
- **Canonical paths only.** All references in derived files use `.control/SPEC.md`.
- **Only scaffold Phase 1.** Phases 2+ get their directories from `/phase-close`.
- **Ask before overwriting** files with substantive user edits beyond Control's template placeholders.

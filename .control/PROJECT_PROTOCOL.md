# Phased Session Protocol for Claude Code Projects

A reusable protocol for running multi-phase, multi-session software projects with Claude Code without context rot or session drift. Portable — copy this file to any new project as a starting point.

The core idea in one line: **`.control/progress/STATE.md` is the single source of truth. Every session starts by reading it; every session ends by updating it. Everything else hangs off that.**

## Control in 60 seconds

**Problem.** AI sessions are stateless. Software projects are stateful. Without a contract that survives session boundaries, every conversation re-explains the project from scratch.

**Architecture (the only diagram you need).**

```
        STATE.md   ← single source of truth (working memory)
        ↑      ↓
     reads   writes
        │      │
     slash    hooks (PreCompact / SessionStart / SessionEnd / Stop)
     commands  │
        │      │
        └─ git log + tags ─┘   (permanent record)
                  │
                  └── snapshots (recovery)
```

**Three layers — every operation updates exactly one, atomically:**

- **Working memory** — `.control/progress/STATE.md`. Overwritten at every session end. Single source of truth.
- **Permanent record** — git history. Commits = step narrative. Tags = phase boundaries. Rollback = `git reset --hard phase-N-closed`.
- **Recovery** — snapshots. PreCompact saves before context compaction; Stop checkpoints between turns; SessionEnd records the close.

**The five invariants Control enforces:**

1. **Read STATE.md first**, every session.
2. **Commit per step** — git log is the narrative.
3. **Tag per phase** — rollback works.
4. **Update STATE.md atomically** at session end.
5. **Detect drift mechanically** — never trust LLM self-report.

Everything else — slash commands, hooks, templates, ADRs, issues, autonomy stages, config knobs — is **machinery enforcing these five invariants**. Understand STATE.md + the three layers + the five invariants, and you understand Control. The rest of this document is reference detail.

## Why these invariants (the failure modes they prevent)

Each invariant exists for a specific failure mode. Knowing the WHY helps you decide when to bend the rule (rarely) versus hold the line (usually).

### 1. Read STATE.md first, every session

- **Failure mode it prevents.** Cold-start sessions where Claude re-derives state from scratch by reading random files; operators waste time re-explaining what shipped last week; decisions are made against stale memory.
- **Why STATE.md is the answer.** A single overwritten file is faster to scan than a log; a single source of truth eliminates "which doc is current?" guesswork. Every other operational file (journal, next.md, snapshots) defers to STATE.md.

### 2. Commit per step (git log is the narrative)

- **Failure mode it prevents.** "WIP" commits hide what changed when; `git bisect` becomes useless; rollback is all-or-nothing; reviewers six months later can't reconstruct intent.
- **Why per-step + the commit-msg hook.** Each commit corresponds to one verifiable unit (one row in `steps.md`). `git log --oneline` becomes the project narrative — readable in one screen. The `commit-msg` hook (`.githooks/commit-msg`) enforces the `<type>(<phase>.<step>): <subject>` shape mechanically so the log stays clean even when authors get sloppy. Rejected commits force the discipline.

### 3. Tag per phase

- **Failure mode it prevents.** Phase boundaries invisible in `git log`; rollback needs SHAs not human-readable names; "what shipped in phase 3?" requires log-spelunking; phase-level rollback is a multi-step ritual instead of a one-liner.
- **Why tags.** `git reset --hard phase-3-foo-closed` is the recovery primitive. A phase rollback is one command. The tag format (`phase-<N>-<name>-closed`) is operator-readable; tags survive even if commit messages get squashed or rewritten downstream.

### 4. Update STATE.md atomically at session end

- **Failure mode it prevents.** Half-updated STATE.md from a crashed or interrupted session leaves the next session confused about what's true. Worse: split-brain where journal.md says step 3.4 closed but STATE.md still claims step 3.3.
- **Why atomic.** `/session-end` updates every STATE.md field in one commit. The SessionEnd hook regenerates derived artifacts (next.md from STATE.md via `regenerate-next-md.sh`) so they can't fall out of sync. The PreCompact hook snapshots pre-update state for recovery. Either you committed a coherent STATE.md, or you didn't — no half-state.

### 5. Detect drift mechanically (never trust LLM self-report)

- **Failure mode it prevents.** Asking Claude "does STATE.md match reality?" is asking the agent that wrote STATE.md to grade its own work. It will say yes. Then a real divergence (operator manually edited git but forgot STATE.md, or vice versa) goes unnoticed for sessions until it surfaces as confusion.
- **Why mechanical.** `.claude/hooks/session-start-load.{sh,ps1}` does field-by-field comparison of STATE.md (parser-contract bullets) vs `git status` / `git log -1` / `git describe --tags --abbrev=0`. Mismatches emit `[control:drift]` blocks BEFORE Claude reads anything. Claude can't ignore the signal — it's data in the SessionStart prompt context. The check is fast (file read + a few git commands), runs on every session start, and fails loud not silent.

### Bonus invariant: severity-gated issues

Not in the cover's "five" because it's a *policy* about issue management, not a foundational rule. But it's worth knowing:

- **Failure mode it prevents.** Filing a full issue file for every typo creates documentation bankruptcy ("are these still relevant?"). Not filing major issues loses institutional memory ("why did we add that workaround?").
- **Why severity-gated.** `minor` → journal line only (cheap, scannable). `major`/`blocker` → file in `.control/issues/OPEN/` + regression-test gate at `/close-issue` (refuses to close without the test). The cost matches the stake. Configurable via `CONTROL_ISSUE_FILE_REQUIRED_FOR` and `CONTROL_ISSUE_JOURNAL_ONLY` in `.control/config.sh`.

---

## Table of contents

1. [When to use this](#when-to-use-this)
2. [Directory layout](#directory-layout)
3. [Quick-start scaffold commands](#quick-start-scaffold-commands)
4. [File templates](#file-templates)
5. [Slash commands](#slash-commands)
6. [Session protocol (start / during / end)](#session-protocol)
7. [State persistence layer (hooks)](#state-persistence-layer)
8. [Documentation layers](#documentation-layers)
9. [Autonomy model](#autonomy-model)
10. [Phase structure](#phase-structure)
11. [Issue flow](#issue-flow)
12. [Per-project customisation knobs](#per-project-customisation)
13. [Common pitfalls](#common-pitfalls)

---

## When to use this

**Use it when:** the project will span multiple sessions over weeks or months, has ≥3 distinct phases, involves complex architectural decisions you want to preserve, or requires handoffs between people.

**Skip it when:** one-shot fix, weekend spike, or small feature work. The overhead is ~20 files of process infrastructure — real weight.

**Hard requirement:** the project must be a git repo. The protocol assumes commits map to steps and tags map to phases. No git = no rollback, no bisect, no history-as-narrative, no protocol. `git init` before anything else.

---

## Directory layout

```
<project-root>/
├── CLAUDE.md                         # Auto-loaded every session — tight pointers only
├── .control/PROJECT_PROTOCOL.md      # This reference doc
├── .control/                         # Framework-managed area (installed by control-workflow init)
│   ├── VERSION                       # Installed framework version
│   ├── config.sh                     # Tunables: iteration budget, retention, formats
│   ├── snapshots/                    # Hook-written state snapshots (gitignored)
│   ├── architecture/
│   │   ├── overview.md               # Stable; the "what" of the system
│   │   ├── phase-plan.md             # All phases + steps + dependencies
│   │   ├── decisions/                # ADRs — append-only, immutable once accepted
│   │   │   └── 0001-<title>.md
│   │   └── interfaces/               # Module contracts, DB schemas, API shapes
│   ├── phases/
│   │   └── phase-1-<name>/
│   │       ├── README.md             # Goal, outcome, done criteria, rollback
│   │       ├── steps.md              # Checklist (3-8 verifiable items)
│   │       └── kickoff-prompt.md     # Paste-to-start-this-phase prompt
│   ├── progress/
│   │   ├── STATE.md                  # ← Current phase/step/blockers/next action
│   │   ├── journal.md                # Append-only, newest on top
│   │   └── next.md                   # Handoff prompt, overwritten each session end
│   ├── issues/
│   │   ├── OPEN/                     # One file per issue (major/blocker only)
│   │   └── RESOLVED/                 # Moved here after regression test exists
│   ├── runbooks/
│   │   ├── session-start.md          # Full protocol: session start
│   │   └── session-end.md            # Full protocol: session end
│   ├── templates/                    # Blank templates for issue / phase / ADR
│   │   ├── issue.md
│   │   ├── phase-readme.md
│   │   ├── phase-steps.md
│   │   └── adr.md
│   └── spec/                         # Canonical project spec home
│       ├── README.md                 # Scaffold (installed from .control/templates/spec-readme.md)
│       ├── SPEC.md                   # Canonical spec (created by /bootstrap; copied or scanned-and-drafted)
│       └── artifacts/                # Spec evolutions (addenda, pivots, deep-dives)
├── .claude/
│   ├── settings.json                 # Hook config (PreCompact / SessionStart / SessionEnd / Stop)
│   ├── commands/                     # Slash commands (session-start, work-next, etc.)
│   └── hooks/                        # Hook scripts (bash, POSIX)
└── docs/                             # Project-owned: long-form narrative, deep-dive architecture (see "Documentation layers")
```

### Purpose of `.control/` vs `.claude/` vs `docs/`

| Path | Purpose | Who writes |
|---|---|---|
| `.control/` | Framework-managed area — operational state (STATE/journal/next), phases, ADRs, issues, runbooks, templates, spec, hook snapshots | Framework on install/upgrade; operator + Claude during sessions |
| `.claude/` | Claude Code standard area — settings, slash commands, hook scripts | Framework (setup updates) |
| `docs/` | Project-owned long-form documentation — narrative progress log, architecture deep-dives, design notes (see "Documentation layers") | You + Claude per project (NOT scaffolded by the installer) |
| `CLAUDE.md`, `.control/PROJECT_PROTOCOL.md` | Root-level, visible | Installed by setup; project-specific tweaks allowed in `CLAUDE.md` |

The split lets `npx control-workflow upgrade` refresh framework files (`.claude/*`, templates, runbooks) without touching project content.

---

## Quick-start: install via `npx control-workflow init`

**Git and Node.js 18+ are required** — the protocol depends on commits per step and tags per phase; the installer is a Node CLI.

```bash
# Install into the current directory
cd /path/to/target-project
npx control-workflow init

# Or install into a different directory
npx control-workflow init /path/to/target-project
```

The installer:
1. Verifies `git` is available
2. Initialises git in the target if not already a repo
3. Copies `.control/` (framework-managed area: operational state, phases, ADRs, issues, runbooks, templates, spec scaffold), `.claude/{settings.json,commands,hooks}`, `CLAUDE.md`, `.control/PROJECT_PROTOCOL.md`, `.githooks/commit-msg`. Does NOT touch `docs/` — that namespace is project-owned (see "Documentation layers")
4. Detects bash availability (`bash -c 'exit 0'`) and wires `.claude/settings.json` to either bash or PowerShell hook ports
5. Appends Control entries to `.gitignore` (snapshots, local settings, source-repo sentinel)
6. Creates an initial commit + `protocol-initialised` tag
7. Sets `core.hooksPath = .githooks` for commit-msg shape enforcement (skipped if already set, e.g. husky)
8. Prints the next steps

### Upgrade an existing install

```bash
npx control-workflow upgrade
```

Upgrade mode refreshes **framework files** (commands, hooks, runbooks, templates, `PROJECT_PROTOCOL.md`, `.githooks/commit-msg`) without touching **project content** (STATE.md, journal, phases, issues, ADRs, SPEC.md, CLAUDE.md, config.sh). Preserves `CONTROL_HOOK_RUNTIME` choice from initial install.

### Manual scaffold (no installer)

If you can't run the installer, mirror its actions by hand:

```bash
git init
mkdir -p .control/{snapshots,architecture/{decisions,interfaces},phases,progress,issues/{OPEN,RESOLVED},runbooks,templates} \
         .claude/{commands,hooks}

# Copy each framework file from control/ to its target path
# (see the Directory layout section for where everything goes)

# Add gitignore entries
cat >> .gitignore <<'EOF'

# --- Control framework ---
.control/snapshots/
.claude/settings.local.json
# --- /Control ---
EOF

git add -A
git commit -m "chore: scaffold project protocol"
git tag protocol-initialised
```

Then fill `CLAUDE.md`, `.control/progress/STATE.md`, `.control/architecture/phase-plan.md`, and Phase 1 docs for the project specifics.

---

## File templates

Copy-paste these into the scaffolded files. Replace placeholders in `<angle-brackets>`.

### `CLAUDE.md` (project root)

Keep this small — it loads every session. Use pointers, not content.

```markdown
# Project: <name>

This project follows the **phased session protocol** — see `.control/runbooks/session-start.md`.

## At session start
1. Read `.control/progress/STATE.md`
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md)
3. Check `.control/issues/OPEN/` for blockers
4. Report: phase, step, blockers, proposed next action
5. **Wait for user confirmation before editing code**

## Invariants
- **Git is not optional.** Every step closes with a commit. Every phase closes with a tag (`phase-<N>-<name>-closed`). Never advance a step with uncommitted work unless STATE.md's "In-flight work" section explains why.
- **Commit message shape:** `<type>(<phase>.<step>): <subject>` — e.g. `feat(2.3): add DSPy QueryPlanner signature`, `fix(2.3): ISSUE-2026-04-19-themes-parse`, `test(2.3): eval regression for theme discovery`.
- Never edit accepted ADRs in `.control/architecture/decisions/` — they're immutable. New decisions get a new ADR that supersedes the old one (and mark the old as `superseded by ADR-<M>`).
- Never close a phase without running `/phase-close` (done-criteria verification + tag).
- Regression test required before any blocker/major issue moves to `RESOLVED/`.
- <add project-specific invariants here>

## Key references
- Full architecture: `.control/SPEC.md (Overview section)`
- Phase plan: `.control/architecture/phase-plan.md`
- Current state: `.control/progress/STATE.md`
```

### `.control/progress/STATE.md`

**The single most important file in the protocol.** Overwritten (not appended) at every `/session-end` and by the `PreCompact` hook. Read first at every session start. Every field exists to defeat a specific failure mode — don't prune.

```markdown
# Project State

> Single source of truth. Read this first every session. Updated at every
> `/session-end` and by the `PreCompact` hook. Every field has a purpose — fill each.

**Last updated:** <YYYY-MM-DD HH:MM UTC> by <session-id or "hook:pre-compact">
**Current phase:** <N> — <name>  (see `.control/phases/phase-<N>-<name>/`)
**Current step:** <N.M> — <short name>
**Status:** in-progress | blocked | done-criteria-pending | ready-to-close

---

## Next action
<One or two sentences. The very next concrete thing to do. If blocked, state the
blocker and what has to clear to unblock. No vagueness — if you can't articulate
the next action in a sentence, the step is wrong.>

---

## Git state
- **Branch:** <branch-name>
- **Last commit:** <short-sha> — <commit subject>
- **Uncommitted changes:** <yes — one-line summary of what / why uncommitted> | <none>
- **Last phase tag:** <tag-name> — <date>  (e.g. `phase-1-foundation-closed`)

*(If `Uncommitted changes: yes` at session start, that's a flag — either finish and commit, or document why it's intentional in "In-flight work" below.)*

---

## Open blockers
- None
  *or*
- [ISSUE-<YYYY-MM-DD>-<slug>] severity:<blocker|major> — <one-line> — `.control/issues/OPEN/...`

---

## In-flight work
Files currently mid-edit, partially implemented, or in-review. Empty if the last
session ended with everything committed.

- `path/to/file.py` — <what's done, what's missing, what to do next>
- ...

---

## Test / eval status
- **Last test run:** <YYYY-MM-DD HH:MM> — <pass | fail (N failing)> — `<test command>`
- **Eval score** (agent phases only): <current> — baseline: <baseline>, target: <target>
- **Regression tests:** all green | <N> failing — see `<path>`

*(If any are failing, they block phase-close. Fix or open an issue.)*

---

## Recent decisions (last 3 ADRs)
- ADR-<NNNN>: <title> — <YYYY-MM-DD> — status: <accepted|proposed>
- ...

Full context in `.control/architecture/decisions/`.

---

## Recently completed (last 5 steps)
- <N.M> — <action> — <YYYY-MM-DD> — commit `<short-sha>`
- <N.M-1> — <action> — <YYYY-MM-DD> — commit `<short-sha>`

---

## Attempts that didn't work (current step only)
Approaches tried and ruled out for the *current* step. Stops the next session
re-trying the same dead-end. Cleared when the step closes. If a rejected
approach is structurally important, write an ADR instead.

- <approach> — rejected because <reason>

---

## Environment snapshot
Only update when it changes. Helps diagnose "it worked yesterday" failures.

- **Language / runtime:** <e.g. Python 3.12.1>
- **Key pinned deps:** <packages whose version matters to current work>
- **Model in use** (if relevant): <backend / model-id>
- **Other:** <anything non-default that affects behaviour — OS-specific flags, env vars>

---

## Notes for next session
<Catchall — unresolved debates, quirks discovered mid-session, user preferences
that came up in chat, things worth keeping an eye on. Anything that would make
a cold-start session say "wait, what?">
```

**Why each field exists:**

| Field | Defeats |
|---|---|
| Last updated / Current phase-step / Status | Cold-start "where are we?" |
| Next action | "What do I do first?" paralysis |
| Git state | Divergence between what's in files vs what's committed |
| Open blockers | Forgetting about a known-broken thing |
| In-flight work | Losing mid-edit context across sessions |
| Test / eval status | Pushing forward while tests are red |
| Recent decisions | Rehashing settled arguments |
| Recently completed | "What just changed?" confusion |
| Attempts that didn't work | Re-trying the same dead-end |
| Environment snapshot | "Worked yesterday" regressions |
| Notes for next session | Everything else that doesn't fit a field |

### `.control/progress/journal.md`

Append-only, newest on top. One entry per session, short. Minor-fix bugs (severity-gated — see Issue flow) also land here as one-line entries instead of getting their own file.

```markdown
# Journal

## <YYYY-MM-DD> — Session <short-id>
- Phase <N>, steps <N.M> → <N.M+1>  (commits: <sha-range>)
- <key decisions made, with ADR refs>
- Issues opened: <IDs with severity>
- Issues closed: <IDs>
- Minor fixes: <symptom> in <file> — commit <sha>
- <significant blockers hit>

## <earlier date> — Session <earlier-id>
- ...
```

### `.control/progress/next.md`

Overwritten each session end. Self-contained prompt the user pastes into a fresh session.

```markdown
# Next session — paste this to start

Continue the <project name> build.

Read `CLAUDE.md`, then `.control/progress/STATE.md`, then the current phase README
and steps file referenced in STATE.md. Check `.control/issues/OPEN/` for blockers.

Report back a 4-line status: phase / step / open blockers / proposed next action.
Then wait for me to confirm before editing code.

Current context (as of <session-end-date>):
- Phase <N> — <name>, at step <N.M>
- <one-line note on where work is mid-flight, if applicable>

## Decisions awaiting your input

*(Optional — populate when an upcoming step has a design choice that needs operator
judgment. Empty when there are none. The session-start protocol expands every entry
here into full option detail before asking for go. Do NOT shorthand options as
labeled footnotes — the next session's reader needs the full context up front.)*

- **<short title of the decision>**
  - Context: <one or two sentences on why the decision is open>
  - Options: <list each option with what concretely changes, what the operator sees,
    cost / scope impact, and the trade-off being accepted — the shape the
    session-start protocol will expand to>
  - Recommendation: <preferred option with the trade-off named, or "no lean">
```

### `.control/phases/phase-N-<name>/README.md`

```markdown
# Phase <N> — <Name>

**Dependencies:** Phase <N-1> closed
**Estimated duration:** ~<X> sessions

## Goal
<One sentence — what problem does this phase solve?>

## Outcome
<What exists / works at the end that didn't before? User-visible when possible.>

## Steps
See `steps.md` for the detailed checklist.

## Done criteria
All must be verified before `/phase-close` advances:

- [ ] All items in `steps.md` checked off, each with a commit reference
- [ ] `.control/issues/OPEN/` contains no items tagged `phase:<N>-blocker`
- [ ] Automated tests pass: `<exact command>`
- [ ] <Phase-specific verifiable criterion — e.g. eval score ≥ baseline>
- [ ] Smoke test: <specific manual action and expected result>
- [ ] Working tree is clean (`git status` shows nothing to commit)
- [ ] All commits follow the `<type>(<phase>.<step>): <subject>` convention
- [ ] Phase will be tagged `phase-<N>-<name>-closed` by `/phase-close`

## Rollback plan
If this phase's changes need to be undone: `git reset --hard phase-<N-1>-<prev-name>-closed`
then force-push if applicable. Document any state that doesn't roll back with git
(external resources created, migrations applied, etc.).

## ADRs decided in this phase
- <will be filled in as decisions are made>
```

### `.control/phases/phase-N-<name>/steps.md`

```markdown
# Phase <N> Steps

- [ ] <N>.1 — <concrete action>
- [ ] <N>.2 — <concrete action>
- [ ] <N>.3 — <concrete action>

## Step detail

### <N>.2 — <action>
<What exactly to do. What to verify. Links to interface/decision docs.>

### <N>.3 — <action>
...
```

### `.control/templates/issue.md`

Only used for **major** and **blocker** severity. Minor bugs never create a file — they get a one-line entry in `journal.md` and an inline fix.

```markdown
# ISSUE-<YYYY-MM-DD>-<slug>

**Severity:** blocker | major   *(minor bugs don't get a file)*
**Discovered:** <YYYY-MM-DD>
**Phase/step:** <N.M>
**Status:** open | in-progress | fix-pending-test | resolved
**Tags:** `phase:<N>-blocker` if blocking current phase | <other>

## Symptom
<What's wrong, concretely observable.>

## Repro
1. <steps>
2. ...

## Hypothesis
<Best guess at cause. Update as investigation proceeds.>

## Resolution
*(Filled in when fixed — refuses close without all three.)*
- **Fix commit:** `<sha>` — <one-line>
- **Regression test:** `<path>` — covers <specific failure mode>
- **Diff summary:** <what changed and why>
```

### `.control/templates/adr.md`

```markdown
# ADR-<NNNN>: <Decision title>

**Date:** <YYYY-MM-DD>
**Status:** proposed | accepted | superseded by ADR-<M>
**Phase when decided:** <N>

## Context
<The forces at play, the problem, the constraints.>

## Decision
<The choice made.>

## Alternatives considered
- <Option A> — rejected because <reason>
- <Option B> — rejected because <reason>

## Consequences
- Positive: <...>
- Negative: <...>
- Follow-up work: <...>
```

### `.control/runbooks/session-start.md`

```markdown
# Session start protocol

1. **Read state** — `.control/progress/STATE.md`. Note every field: phase, step, next action, git state, blockers, in-flight work, test/eval status, recent decisions, attempts that didn't work, notes.
2. **Read phase context** — the README and steps files for the phase path in STATE.md.
3. **Scan open issues** — list every file in `.control/issues/OPEN/`. Identify items tagged as blockers for the current phase.
4. **Verify git** — run `git status --porcelain`, `git log -1 --oneline`, `git rev-parse --abbrev-ref HEAD`, `git describe --tags --abbrev=0`. Compare against STATE.md's Git state section. Any mismatch is a drift signal — flag it, don't silently proceed.
5. **Report to user**, in this exact shape:
   ```
   Phase <N> — <name>, step <N.M>
   Last action: <what was done last>
   Git: branch=<...>, last=<sha> <subject>, uncommitted=<yes/no>, tag=<last phase tag>
   Git sync: ✓ matches STATE.md  OR  ⚠ drift: <details>
   Open blockers: <count, with IDs> OR None
   Test/eval status: <from STATE.md>
   Proposed next action: <from STATE.md>
   Ready to proceed?
   ```
5b. **Design decisions awaiting operator input.** If `.control/progress/next.md` surfaces a `## Decisions awaiting your input` section, or STATE.md's "Notes for next session" / "Next action" flags an open design choice for the upcoming step, expand it inline before asking for go. For each option present: **(i) what concretely changes** (schema additions, code shape, file additions), **(ii) what the operator sees** (sample CLI output, sample data shape, sample error), **(iii) cost / scope impact** (how it affects the current step's budget and surrounding work), **(iv) trade-off being accepted** (what each option costs, not just what it gains). End with a recommendation that names the trade-off, not just the lean. Do not shorthand design choices as labeled footnotes (`(a)` / `(b)` with one-line summaries) — that forces the operator to ask for the detail in a second turn, wasting context.
6. **Wait for confirmation.** Do not edit code before the user says go.
```

### `.control/runbooks/session-end.md`

```markdown
# Session end protocol

Trigger: phase boundary, context getting heavy, or user says wrap up.

1. **Check git.** Run `git status --porcelain`. If dirty, either commit now (propose a message following `<type>(<phase>.<step>): <subject>`) or record the reason in STATE.md's In-flight work section. Uncommitted-without-explanation is a protocol violation.

2. **Update `.control/progress/STATE.md`** — overwrite every section:
   - Last updated (UTC timestamp + session id)
   - Current phase / step / status
   - Next action (concrete and actionable)
   - Git state (branch, last commit, uncommitted, last phase tag)
   - Open blockers (with issue IDs)
   - In-flight work (files mid-edit with what's left)
   - Test / eval status (last run, score)
   - Recent decisions (last 3 ADRs)
   - Recently completed (last 5 steps with commit shas)
   - Attempts that didn't work (current step's dead-ends)
   - Environment snapshot (if changed)
   - Notes for next session

3. **Append to `.control/progress/journal.md`** (newest on top):
   - Date + session id
   - Phase / step range (with commit sha range)
   - Decisions made (with ADR refs)
   - Issues opened / closed
   - Minor fixes (severity-gated — inline per the Issue flow section)
   - Significant blockers hit

4. **Write `.control/progress/next.md`** — self-contained prompt for the next session. Must reference STATE.md + current phase docs so a cold-start bootstrap works.

5. **Commit the docs updates** — `docs(state): session end for step <N.M>`.

6. **Print the next prompt** — "Paste this to start your next session."
```

---

## Slash commands

Save each as a file in `.claude/commands/`. They become invocable as `/session-start`, `/new-issue foo`, etc.

### `.claude/commands/session-start.md`

```markdown
---
description: Run the session bootstrap protocol
---

Follow `.control/runbooks/session-start.md` exactly:

1. Read `.control/progress/STATE.md`.
2. Read the current phase's `README.md` and `steps.md` (path in STATE.md).
3. List files in `.control/issues/OPEN/` and identify blockers for the current phase.
4. **Verify git state matches STATE.md.** Run `git status --porcelain`, `git log -1 --oneline`, `git rev-parse --abbrev-ref HEAD`, `git describe --tags --abbrev=0`. Compare against STATE.md's "Git state" section. If any mismatch (last commit sha differs, uncommitted changes STATE.md doesn't mention, branch differs, etc.), flag it before reporting status.
5. Report a status block:
   ```
   Phase <N> — <name>, step <N.M>
   Last action: <from STATE.md's recently completed[0]>
   Git: branch=<...>, last=<sha> <subject>, uncommitted=<yes/no>, tag=<last phase tag>
   Git sync: ✓ matches STATE.md  OR  ⚠ drift detected: <what>
   Open blockers: <count, with IDs> OR None
   Test/eval status: <from STATE.md>
   Proposed next action: <from STATE.md>
   Ready to proceed?
   ```
5b. **Design decisions awaiting operator input.** If `.control/progress/next.md` surfaces a `## Decisions awaiting your input` section, or STATE.md's "Notes for next session" / "Next action" flags an open design choice for the upcoming step, expand it inline before asking for go. For each option present: **(i) what concretely changes** (schema additions, code shape, file additions), **(ii) what the operator sees** (sample CLI output, sample data shape, sample error), **(iii) cost / scope impact** (how it affects the current step's budget and surrounding work), **(iv) trade-off being accepted** (what each option costs, not just what it gains). End with a recommendation that names the trade-off, not just the lean. Do not shorthand design choices as labeled footnotes (`(a)` / `(b)` with one-line summaries) — that forces the operator to ask for the detail in a second turn, wasting context.
6. Wait for the user's go before editing any code.
```

### `.claude/commands/session-end.md`

```markdown
---
description: Close the session — update STATE.md, check git, write next-session prompt, journal
---

Follow `.control/runbooks/session-end.md`:

1. **Check git state.** Run `git status --porcelain` and `git log -1 --oneline`.
   - If working tree is dirty, ask the user: commit now? If yes, help compose a commit message following the `<type>(<phase>.<step>): <subject>` convention. If no, record the reason in STATE.md's "In-flight work" section.

2. **Update `.control/progress/STATE.md`** — overwrite with:
   - Last updated: current UTC timestamp + session id
   - Current phase / step / status
   - Next action (concrete, one or two sentences)
   - Git state: branch, last commit sha + subject, uncommitted yes/no, last phase tag
   - Open blockers: list with issue IDs, or "None"
   - In-flight work: any files mid-edit and what's left
   - Test / eval status: last run result, score, any failures
   - Recent decisions: last 3 ADRs with numbers + dates
   - Recently completed: last 5 steps with commit shas
   - Attempts that didn't work: current-step dead-ends (cleared when step closes)
   - Environment snapshot: only if it changed
   - Notes for next session: catchall

3. **Append to `.control/progress/journal.md`** (newest on top):
   - Date + session id
   - Phase / step range covered
   - Key decisions (with ADR refs)
   - Issues opened (IDs) and closed (IDs)
   - Minor fixes made inline (per severity-gated flow)
   - Significant blockers hit

4. **Write `.control/progress/next.md`** — self-contained prompt for the next session that references STATE.md and the current phase README.

5. **Print the next prompt** with "Paste this to start your next session."
```

### `.claude/commands/new-issue.md`

```markdown
---
description: Open a new issue — severity-gated (minor = journal line, major/blocker = file)
argument-hint: <slug>
---

Before creating anything, ask the user two questions:

1. **Symptom** — one-line description of what's wrong.
2. **Severity** — blocker | major | minor.
   - *blocker*: prevents phase advancement
   - *major*: needs tracking + regression test, but not blocking
   - *minor*: typo / obvious fix / cosmetic — no file, no regression test required

**If minor:**
- Do NOT create a file.
- Fix it inline in this session.
- Commit the fix.
- Append a journal line: `- Minor fix: <symptom> in <file> — commit <short-sha>`.
- Done.

**If major or blocker:**
- Create `.control/issues/OPEN/<today>-$ARGUMENTS.md` from `.control/templates/issue.md`.
- Fill: Discovered (today), Phase/step (from STATE.md), Symptom, Severity, Tags (`phase:<N>-blocker` if blocker).
- Append journal: `- Opened ISSUE-<today>-$ARGUMENTS (severity:<sev>) — <symptom>`.
- If blocker, update `.control/progress/STATE.md` open blockers list.
```

### `.claude/commands/close-issue.md`

```markdown
---
description: Close a major/blocker issue after verifying a regression test exists
argument-hint: <issue-id>
---

This command is for **blocker and major** issues only. Minor bugs are fixed inline via `/new-issue` and never create a file — nothing to close.

Given issue ID `$ARGUMENTS`:

1. Read `.control/issues/OPEN/$ARGUMENTS.md`.
2. **Verify a regression test exists** that would have caught this bug — grep tests for the issue ID or the specific failure mode. If none, stop and ask the user to add one before closing. Do not proceed without it.
3. Verify the fix and test have been committed. Record the fix commit sha.
4. Fill in the Resolution section: commit refs (fix + regression test), diff summary, regression test path.
5. Move the file from `.control/issues/OPEN/` to `.control/issues/RESOLVED/`.
6. Commit the move: `docs(issues): resolve $ARGUMENTS`.
7. If this was a blocker, update `.control/progress/STATE.md` to remove it from the open blockers list.
8. Append a journal entry: "Closed $ARGUMENTS — fix `<sha>`, regression test at `<path>`".
```

### `.claude/commands/phase-close.md`

```markdown
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
     - Fill in the copied scaffolds with content from `.control/architecture/phase-plan.md`'s Phase `<N+1>` entry — typically Goal, Outcome, and the step list under Done criteria. **Do NOT fill the `## Why this phase exists` section from phase-plan.md** — that section is reserved for the carry-forward logic (next sub-bullet) plus the operator's post-scaffold edits.
   - **Carry forward deferred items.** From the current phase's `README.md`, read the section whose heading starts with `## Deferred to Phase` (F4 shipped this as the last section in the template; locate by heading prefix rather than file position, because the author may have added `## ` sections after Deferred). If no such heading is found (pre-F4 phase, or operator removed the section), treat as empty — no bullets to carry, skip the seeding entirely. Otherwise, for each bullet starting with `- ` under that heading:
     - If the bullet's item text is the literal `<item>` placeholder from the template, skip it.
     - If the bullet lacks a ` — ` em-dash (U+2014) separator between item text and reason text, emit `[carry-forward] skipped non-conforming bullet: <bullet-text>` and skip it.
     - Otherwise, collect the bullet verbatim for carry-forward.
   - If no bullets were collected (section missing, section present but empty, all placeholders, or all non-conforming), skip the seeding step — no error, no output line.
   - If one or more bullets were collected, open the new phase's `README.md`, locate the `## Why this phase exists` section (F3's destination). If the section is missing (template was broken or manually edited between scaffold-copy and this step), insert a fresh `## Why this phase exists` heading directly before `## Steps`. Prepend into the section at column-0 (no leading indentation), above any existing content (preserving F3's `<Fill in during phase kickoff.>` placeholder and any post-scaffold author edits below), the following block written verbatim to the destination file:

         Carried forward from Phase <N>:
         - <first carried bullet verbatim from the Deferred section>
         - <second carried bullet verbatim>

     (The indentation of the example above is for readability in this command file only — when writing to the destination README, flush the block to column-0 with the `## Why this phase exists` heading.) Then tell the user: `Seeded Phase <N+1>'s 'Why this phase exists' with <count> carry-forward item<s> from Phase <N>. Review and edit before continuing.` — pluralize "item" → "items" at runtime when `<count>` ≥ 2; use "item" when `<count>` = 1.
   - Write the kickoff prompt to `.control/progress/next.md`.
   - Commit: `chore(phase-<N>): close phase <N>, kick off phase <N+1>`.
   - Append a journal entry: "Phase <N> closed (tag: `phase-<N>-<name>-closed`, commit: `<sha>`); Phase <N+1> kicked off."
   - Print the next-session prompt for the user.
```

### `.claude/commands/new-adr.md`

```markdown
---
description: Create a new Architecture Decision Record
argument-hint: <short-title-slug>
---

Find the highest-numbered ADR in `.control/architecture/decisions/` and increment.

Create `.control/architecture/decisions/<NNNN>-$ARGUMENTS.md` from `.control/templates/adr.md`.

Prompt the user for:
- Context, Decision, Alternatives considered, Consequences.

Set Status to `proposed` initially. The user changes it to `accepted` once they confirm.

After it's accepted, append a reference in the current phase README under "ADRs decided in this phase".
```

### `.claude/commands/work-next.md`

The prioritizer — picks the next item without being told. This is the command that enables autonomous operation when combined with `/loop`.

```markdown
---
description: Autonomously pick and execute the next item per the protocol's priority rules
---

Read `.control/progress/STATE.md`. Apply this priority order — do the first one that matches, then stop:

1. **Any open blocker in STATE.md's "Open blockers" list?**
   - If yes and a clear hypothesis exists in the issue file → investigate + fix + regression test + `/close-issue`.
   - If yes and no clear hypothesis → **HALT** (see pause conditions below).

2. **Tests or eval failing per STATE.md's "Test / eval status"?**
   - If the fix is obvious and contained → fix + commit + re-run.
   - If ambiguous or requires domain knowledge → **HALT**.

3. **Unchecked item in the current phase's `steps.md`?**
   - Implement the next unchecked step.
   - Respect pause-for-human conditions during the work.
   - Commit: `<type>(<phase>.<step>): <subject>`.

4. **All steps checked but phase not yet closed?**
   - Run `/phase-close`. If criteria fail, surface what's missing.

5. **Phase closed, next phase scaffolded?**
   - Pick step 1 of the new phase and start.

6. **All phases complete per phase-plan.md?**
   - **HALT** with: "All phases complete. No work queued."

After executing the chosen action:
- Update STATE.md (every field, per session-end protocol).
- Append `journal.md`.
- Commit the docs updates.

### Pause-for-human conditions — HALT the loop

Stop immediately, run `/session-end`, and surface to the user when any of these hit:

- **New ADR needed** — a non-trivial architectural choice came up. Don't silently decide; prompt `/new-adr`.
- **Blocker with no clear hypothesis** — investigation exhausted.
- **Ambiguous failing test** — multiple plausible fixes, no clear winner.
- **Manual smoke test** in a phase's done criteria.
- **User-acceptance** criterion.
- **Secret or credential needed** — API key, auth token, anything outside the repo.
- **Destructive action required** — delete, force-push, drop table, migration rollback.
- **Iteration budget hit** — see Autonomy model section.

Halt format:

\`\`\`
[HALT] <reason>
Current step: <N.M>
What's needed from you: <concrete ask>
STATE.md updated. Resume with /work-next or /loop /work-next when ready.
\`\`\`
```

### `.claude/commands/bootstrap.md`

Derives project-specific content from a spec/PRD file and populates Control's scaffolding. One-shot at project start — reads the spec, produces project-specific invariants for CLAUDE.md, a distilled `overview.md`, a full `phase-plan.md` with all phases, and the Phase 1 scaffold. Argument: path to the spec file (e.g. `/bootstrap insights_engine_new.md`).

**When to run:** immediately after `npx control-workflow init` completes, before any code work begins. Replaces the manual "edit CLAUDE.md, fill overview, enumerate phases, scaffold phase-1" ritual with one command + a review cycle.

**What it does not do:** scaffold phases 2+. Those come from `/phase-close` as each phase ships — just-in-time, so detailed steps reflect lessons from earlier phases.

```markdown
---
description: Derive project-specific content from a spec file and populate Control's scaffolding
argument-hint: <path-to-spec-file>
---

(See `.claude/commands/bootstrap.md` in an installed project for the full instructions.)
```

### `.claude/commands/validate.md`

Sanity-checks the protocol scaffolding for consistency — STATE.md fields populated, phase paths resolve, ADR numbering contiguous, issue files well-formed, git tags align with claimed phase closes. Reports; does not auto-fix.

```markdown
---
description: Sanity-check Control protocol files for consistency
---

Run all checks defined in `control/.claude/commands/validate.md`. Report a summary; halt if errors.
```

Run it: before autonomy graduation, before a long `/loop /work-next`, and whenever STATE.md feels off.

---

## Session protocol

### Start

User types `/session-start` (or pastes the prompt from `.control/progress/next.md`). Claude bootstraps from state files, reports a 4-line status, waits for go.

### During

- TaskCreate/TaskUpdate for the session's in-flight checklist (ephemeral — session-scoped).
- Journal entries appended at **significant** events only: major decisions, issues opened, issues closed, steps completed. Not at every file edit.
- Issues opened as they're discovered via `/new-issue`.
- ADRs created via `/new-adr` for any non-trivial architectural choice.

### End

User types `/session-end` — or Claude proactively suggests it when context gets heavy or a phase boundary is reached. Claude updates STATE.md, appends journal, writes `next.md`, prints the prompt.

---

## State persistence layer

The manual protocol requires discipline — remember to `/session-end`, remember to update STATE.md. Claude Code's hook system automates the critical pieces so state persistence isn't opt-in. This is where the real anti-drift automation lives.

### Hook events that matter

Control uses four hook events, each tackling a specific failure mode:

| Hook | Fires | Defeats | Script |
|---|---|---|---|
| **`PreCompact`** | Before Claude Code compacts the conversation to free context | "Lost what we were doing when context collapsed" | `.claude/hooks/pre-compact-dump.sh` |
| **`SessionStart`** | At the beginning of every session | "Cold start with no context" | `.claude/hooks/session-start-load.sh` |
| **`SessionEnd`** | When a session shuts down (user quits, terminal closed) | "Session ended without running /session-end" | `.claude/hooks/session-end-commit.sh` |
| **`Stop`** | After each Claude response completes | "STATE.md drifted between session end calls" | `.claude/hooks/stop-snapshot.sh` |

Configured in `.claude/settings.json` (project-scoped) or `~/.claude/settings.json` (global).

**Layering rationale:**
- `PreCompact` + `SessionEnd` = reactive capture at the two points where state is at risk.
- `SessionStart` = cold-boot bootstrap.
- `Stop` = per-turn snapshot into a rolling window (default 10; cheap — cmp-deduped per turn). Mechanical insurance against slow drift between session-end calls; remove if per-turn overhead becomes noticeable.

All snapshots land in `.control/snapshots/` (gitignored) with timestamped filenames. Pruned automatically to the last N snapshots (default 50) or N days (default 14), configurable via `.control/config.sh`. Each PreCompact / SessionEnd / Stop event also appends a one-line marker to `.control/snapshots/markers.log` (`<ISO8601>  <event>  snapshot_id=<TS>  ...`) for chronological discovery without scanning multiple file timestamps.

### Drift detection contract

The `SessionStart` hook does mechanical drift detection: it parses STATE.md and compares the four Git-state fields against live git, emitting structured `[DRIFT]` lines BEFORE the bootstrap prompt when reality disagrees with the claim. Claude reads the markers as a signal, not free text — drift detection no longer depends on Claude remembering to compare.

**Emission shape:** each line begins with the literal token `[DRIFT]`. The hook emits one of:
- `[DRIFT] STATE.md missing -- run /bootstrap` (file absent)
- `[DRIFT] STATE.md is in template form -- run /bootstrap` (placeholders like `<short-sha>` / `<YYYY-MM-DD>` still present)
- `[DRIFT] STATE.md Git state section unparseable (parser-contract fields absent) -- run /validate` (none of the four field labels can be matched — schema rename, section deletion, or other structural breakage)
- One or more `[DRIFT] STATE.md says <field>=<claimed>, actual=<observed>` lines (field-level mismatch)
- A trailing `[DRIFT] Verify and update STATE.md before proceeding.` summary line when any field-level drift is emitted

**Parser contract.** The hook parses these four bullet lines from STATE.md's `## Git state` section:
- `- **Branch:** <value>` (string equality against `git rev-parse --abbrev-ref HEAD`)
- `- **Last commit:** <value>` (live SHA prefix from `git log -1 --oneline` is checked as a substring of the claimed value, so the `<sha> -- <subject>` shape stored in STATE.md is supported without an exact-line match)
- `- **Uncommitted changes:** <value>` (special-case: literal `none` ⇔ tree clean; any other value is treated as operator-described in-flight work and matches automatically)
- `- **Last phase tag:** <value>` (backticks stripped; first whitespace-token compared against `git describe --tags --abbrev=0`)

Renaming or removing any of these field labels silently disables that compare. If ALL four are absent, the hook emits the `unparseable` line above so the breakage is visible. The `/validate` command also checks for their presence — see `.claude/commands/validate.md` Check 1.

**Emission timing.** The drift block runs after git capture (lines 8–23 of the hook script) and before the `cat <<EOF` heredoc, so `[DRIFT]` lines appear at the top of the bootstrap message — where Claude attends most strongly. The hook always exits 0; drift is a signal, not a failure.

### `.claude/settings.json` (installed by setup.{sh,ps1})

The `command` field is templated by the installer based on detected runtime (`CONTROL_HOOK_RUNTIME` in `.control/config.sh`). On install, the Node CLI runs a behavioral bash check (`bash -c 'exit 0'`) and writes the bash form if bash works, else the PowerShell form. `npx control-workflow upgrade` preserves the operator's runtime choice via `CONTROL_HOOK_RUNTIME` (kind=project, not refreshed automatically).

```json
{
  "hooks": {
    "PreCompact":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "<runtime-prefix>.claude/hooks/pre-compact-dump.<ext>" }] }],
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<runtime-prefix>.claude/hooks/session-start-load.<ext>" }] }],
    "SessionEnd":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "<runtime-prefix>.claude/hooks/session-end-commit.<ext>" }] }],
    "Stop":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "<runtime-prefix>.claude/hooks/stop-snapshot.<ext>" }] }]
  }
}
```

Where `<runtime-prefix>` is `bash ` (POSIX) or `powershell -NoProfile -File ` (Windows native PS 5.1+), and `<ext>` is `sh` or `ps1`.

> Verify the exact hook-config shape against current Claude Code docs before shipping — event names are stable, but matcher/envelope syntax has evolved across versions.

### Bootstrap-pathway quadruplication contract

Session-start protocol Step 5c (apply work-priority decision tree after the status block) is defined in **four** files that MUST stay byte-equivalent in semantic content:

1. `.control/runbooks/session-start.md` — canonical
2. `.claude/commands/session-start.md` — slash-command mirror
3. `.claude/hooks/session-start-load.sh` — bash hook heredoc
4. `.claude/hooks/session-start-load.ps1` — PowerShell hook heredoc (post-I5)

Any change to 5c (or analogous post-status-block instruction) MUST update all four files in the same diff. Cross-consistency contract extends F12's triplication (which preceded the PS port). Verifiable via `tests/i5-parity.sh --only t7` (heredoc byte-equivalence diff). The PS hook normalizes CRLF → LF before stdout so the byte-cmp is meaningful on Windows.

### Hook scripts

All scripts live in `.claude/hooks/`. Each event hook ships in twin runtimes — `*.sh` (POSIX bash) and `*.ps1` (PowerShell 5.1+). `setup.{sh,ps1}` detects bash availability and writes `.claude/settings.json` to invoke the appropriate runtime. The helper `prune-snapshots.{sh,ps1}` is called from PreCompact / SessionEnd / Stop hooks within the same runtime. PS hooks honor `CONTROL_FAIL_ON_HOOK_ERROR` (config.sh tunable) and soft-fail by default. The four main hooks and one helper:

**`pre-compact-dump.sh`** — snapshots `.control/progress/{STATE,journal,next}.md` to `.control/snapshots/` with a timestamp. Appends a marker line to `.control/snapshots/markers.log`. Triggers `prune-snapshots.sh`.

**`session-start-load.sh`** — emits a bootstrap prompt referencing STATE.md + git state. Claude reads it on session start and follows the protocol automatically.

**`session-end-commit.sh`** — snapshots state at actual session shutdown. Appends a marker line to `.control/snapshots/markers.log`. Writes a `sessionend-dirty-<ts>.flag` file if the working tree is uncommitted at shutdown, so the next session sees the warning.

**`stop-snapshot.sh`** — per-turn snapshot into a rolling window of `CONTROL_STOP_SNAPSHOT_RETENTION_COUNT` (default 10) timestamped `stop-<ts>.md` files. Only writes if STATE.md content changed since the most recent snapshot. Restore from drift with `cp .control/snapshots/stop-<ts>.md .control/progress/STATE.md`.

**`prune-snapshots.sh`** — helper: removes snapshots older than `snapshot_retention_days` (default 14) or beyond `snapshot_retention_count` (default 50). Called by PreCompact and SessionEnd.

For the full hook script contents, see `control/.claude/hooks/*.sh` in the framework source, or look at `.claude/hooks/*.sh` in an installed project.

### Why multiple layers (reactive + proactive)

`PreCompact` alone is insufficient — compaction triggers are unreliable and can fire at times that don't align with session boundaries (tracked in `anthropics/claude-code#43733`). Control uses four:

- **`SessionStart`** (cold-boot) — reads STATE.md + git state, emits the bootstrap prompt so Claude starts the session already oriented.
- **`PreCompact`** (reactive, context-collapse) — snapshots state before compaction runs, so nothing is lost when history is compressed.
- **`SessionEnd`** (reactive, shutdown) — final snapshot when the session closes, plus an uncommitted-tree flag if the shutdown was dirty.
- **`Stop`** (proactive, per-turn) — snapshots STATE.md after every Claude response into a rolling window (default 10), but only if content changed. Mechanical insurance against slow drift between session-end calls; restore by `cp .control/snapshots/stop-<ts>.md .control/progress/STATE.md`.

The four together cover: cold start, catastrophic context loss, voluntary shutdown, and slow drift. Remove `Stop` if per-turn overhead becomes noticeable.

### Prior art

**ClaudeFast's Code Kit** packages a similar pattern — their `ContextRecoveryHook` auto-backs up architectural decisions, patterns, and progress before compaction fires; their status-line approach is a stronger proactive variant. Worth reviewing if Control's `Stop` hook isn't sufficient.

### Enforcement lattice

| Layer | Mechanism | Example | Installed by |
|---|---|---|---|
| Manual | User discipline | Remembers to run `/session-end` | — |
| Semi-automated | Slash commands + templates | `/close-issue` refuses without regression test | `control-workflow init` |
| **Reactive hooks** | `PreCompact`, `SessionEnd` | Snapshot state before compaction / on shutdown | `control-workflow init` (settings.json + scripts) |
| **Proactive hooks** | `SessionStart`, `Stop` | Auto-bootstrap; per-turn snapshot when STATE.md changes | `control-workflow init` (settings.json + scripts) |

All layers ship wired up in Control v1+. The progressive-adoption story now lives in the **Autonomy model** section (stages 0→3) — once the framework is installed, you decide how much autonomy to grant, not whether to install the persistence.

Don't skip the underlying STATE.md discipline — hooks without it just dump garbage at high frequency.

---

## Documentation layers

Two complementary layers; Control manages one, the project owns the other.

### Operational (Control-managed, under `.control/`)

- `progress/STATE.md` — current cursor; replaced every session
- `progress/journal.md` — one-liner per session; terse log
- `progress/next.md` — auto-written handoff prompt
- `phases/phase-N-<name>/` — active step checklists
- `architecture/decisions/` — ADRs (if the project uses Control's ADR home)
- `issues/{OPEN,RESOLVED}/` — issue files (if the project uses Control's issue home)
- `runbooks/{session-start,session-end}.md` — full-shape session protocols (framework-shipped; refreshes on `UPGRADE=1`)
- `templates/{issue,phase-readme,phase-steps,adr}.md` — blank templates for new phases / issues / ADRs (framework-shipped)
- `SPEC.md` — canonical project spec (v2.0 single-file layout; created by `/bootstrap` from a spec file or codebase scan; amend with `/spec-amend <slug>`)

### Long-form (project-owned, under `docs/` or equivalent)

- Narrative progress log (`docs/PROGRESS.md` or similar) — appended at every session-end alongside `journal.md`'s one-liner
- Architecture / contracts / skills docs — the *what* of the system
- Phase-level retrospectives — per-phase narrative
- ADRs and issues if the project prefers project-owned shape over Control's

**When to use which:**

- Projects expected to live past ~20 ADRs or ~10 phases: keep ADRs and issues under `docs/` with project-specific shape. Use `.control/` for the operational cursor only.
- Smaller or shorter-lived projects: keeping ADRs and issues under `.control/` is fine — one less doc tree.
- Long-form progress (`docs/PROGRESS.md`) is worth keeping for any project expected to last more than ~5 sessions, regardless of size. Control's `journal.md` is a *cursor* (one line per session, scannable); the long-form log is *narrative* (decision rationale, what was tried, why a tradeoff was made).
- `docs/PROGRESS.md` is one path convention (factory5's). Other names work — `docs/JOURNAL.md`, `docs/SESSION-LOG.md`. Pick one and stay consistent.

### Operational captures: journal vs git log vs ADRs vs issues

Control's operational layer has four distinct capture mechanisms. They overlap in what they *could* record, but each has a primary role. Picking the right one matters: writing a journal line for an architectural decision means it gets lost; writing an ADR for a one-off debugging session means ADR-search becomes noisy.

| Capture | What it holds | Primary write moment | Primary read moment |
|---|---|---|---|
| **git log** (commit messages) | Atomic changes that shipped. Step-level narrative driven by the `<type>(<phase>.<step>):` format. | Every step closes with a commit (invariant). | "What changed when?" — `git log --oneline` for progress; `git show <sha>` for detail. |
| **`journal.md`** | Operational decisions and explorations that *don't* result in commits — ruled-out approaches, mid-session discoveries, "we tried X and Y, went with Z." | At `/session-end` (one terse line) or mid-session when a notable non-commit decision is made. | When commit messages alone don't explain *why* a direction was chosen. |
| **ADRs** (`architecture/decisions/`) | Architectural decisions — choices that constrain the codebase going forward. Immutable once accepted; superseded by new ADRs. | When a decision is non-trivial and would affect future sessions or operators. Use `/new-adr`. | At session start ("Recent decisions" in STATE.md) and during architectural debates. |
| **Issues** (`issues/OPEN/`, `issues/RESOLVED/`) | Bugs, gaps, blockers. Severity-gated: `minor` → journal line only; `major`/`blocker` → file + regression-test gate. | When a failure or gap is discovered. Use `/new-issue`. | At session start (OPEN/) and during `/work-next` priority resolution. |

**Decision rule of thumb.** If it ships → commit. If it shapes future work → ADR. If it's a problem to fix → issue. Otherwise → journal line at session-end (or skip if the commit message already captures it).

**Anti-pattern: duplication.** Don't journal what the commit message already says. Don't ADR a one-off implementation choice. Don't file an issue for something fixed in the same session — that's a `fix(<phase>.<step>):` commit, not an issue. The four captures partition the space; overlap creates noise.

---

## Autonomy model

The protocol + `/work-next` + Claude Code's `/loop` skill together let Claude run the build autonomously — picking the next item, working on it, committing, updating state, and moving on — with explicit halt conditions for human judgment.

### Why `/loop /work-next` is the answer to "I can't /clear myself"

Claude Code intentionally reserves `/clear` for the user — a model that could wipe its own session could also erase unfinished work mid-task. You don't actually need `/clear` for autonomous operation:

- `/loop /work-next` keeps Claude working **within one session**, iterating through steps.
- The `PreCompact` hook handles the context-fills-up case automatically — state dumps to disk before compaction, and post-compaction Claude resumes by reading STATE.md.
- The `SessionStart` hook handles the truly-new-session case — if you close the terminal, starting again auto-bootstraps from STATE.md.

Result: paste `/loop /work-next` once, walk away, come back to progress. The `/clear` limit never bites in practice.

### Staged rollout

**Do not flip to full autonomy on day one.** Earn trust stage by stage.

| Stage | Trigger | What runs autonomous | What you do |
|---|---|---|---|
| **0. Manual** | You type each command | Nothing — you drive | Run `/session-start`, `/work-next`, `/session-end` manually. Validate the priority logic. |
| **1. Semi-auto** | You say "go" / "continue" | `/work-next` picks + executes one item, then stops | Review after each step. One word per step. |
| **2. Step-loop** | `/loop /work-next` | Claude self-paces step → step → step within one session until a HALT | Review at natural breakpoints (typically phase close). |
| **3. Phase-loop** | `/loop /work-next` with phase-close auto-approved | Claude advances across phases; halts only on ADRs, blockers, manual criteria | Review at end of each phase. |

**Move up only when the previous stage felt solid.** Skipping to stage 3 on a greenfield project is how you wake up to 100 commits of confidently wrong work.

### The `/loop` invocation

Once at stage 2+:

```
/loop /work-next
```

No interval — Claude self-paces, scheduling the next iteration via `ScheduleWakeup` when the current one completes. The loop runs until a HALT condition fires or the iteration budget is exhausted.

### Iteration budget

Hard cap on autonomous iterations per `/loop` invocation. Belt and suspenders against runaway loops or priority-logic bugs.

- **Default:** 20 iterations.
- **Configurable:** set `MAX_AUTO_ITERATIONS` near the top of `.claude/commands/work-next.md` and reference it in the halt logic.

On budget exhaustion, Claude:
1. Runs `/session-end` (updates STATE.md, commits docs).
2. Surfaces: `[BUDGET] Hit iteration cap of N. Review progress; restart with /loop /work-next when ready.`
3. Stops.

This ensures a check-in at least every N iterations even when nothing else halts the loop.

### What autonomous mode is and isn't for

**Good fit:**
- Executing a phase plan that's already designed
- Grinding through routine steps (scaffolding, plumbing, tests)
- Fixing blocker issues where a hypothesis is already written down
- Running through the done-criteria of a phase

**Bad fit:**
- Before the protocol is proven — run stage 0 manually through at least one phase first
- Destructive or irreversible work — migrations, force-pushes, production changes; always human-gated
- Exploratory / research work — autonomy executes a plan, it doesn't design one
- Thin eval/test coverage — without regression protection, bad fixes compound silently

### Interrupt anytime

Autonomy is opt-in per session and interruptible. Whatever Claude is doing:
- Send any message to interrupt the loop.
- `/session-end` cleanly halts, commits state, prepares the next prompt.
- Ctrl+C at the CLI stops the current turn.

You're never locked in. The loop is a convenience, not a contract.

---

## Phase structure

Each phase is a self-contained unit with:

| Element | Purpose |
|---|---|
| **Goal** (1 sentence) | What problem this phase solves |
| **Outcome** | What exists after that didn't before (user-visible) |
| **Steps** (3-8) | Concrete, verifiable items |
| **Done criteria** | Tests pass, no open blockers, manual smoke |
| **Rollback plan** | How to undo if needed |
| **Dependencies** | Which prior phases must be closed |

**A phase cannot close** until done criteria verify via `/phase-close`. This is the primary enforcement point of the protocol. If you skip it, everything else degrades.

### Git discipline

The protocol only works if git history mirrors the phase/step structure. Conventions:

| Event | Git action |
|---|---|
| Step closed | Commit with message `<type>(<phase>.<step>): <subject>` |
| ADR accepted | Commit alone: `docs(adr): ADR-<NNNN> <title>` |
| Issue closed (major/blocker) | Commit with fix + regression test: `fix(<phase>.<step>): ISSUE-<id>` |
| Phase closed | Tag: `phase-<N>-<name>-closed` — set by `/phase-close` |
| Protocol bootstrap | Tag: `protocol-initialised` |

**Why per-step commits:**
- `git log` becomes a readable progress narrative parallel to the journal.
- `git bisect` works across step boundaries when a regression sneaks in.
- Rollback to `phase-<N-1>-<name>-closed` is a real escape hatch, not a hope.
- STATE.md's "Last commit" field becomes a cross-check that the session actually shipped what it claims.

**Checkbox discipline.** In the same commit that closes step `<N>.<M>`, flip the matching `- [ ]` → `- [x]` on the corresponding line in `.control/phases/phase-<N>-<name>/steps.md`. The commit is the authoritative signal; the checkbox is the one-glance cursor a resumed session reads before opening `git log`. Drift between the two means the steps.md file is stale — treat it as a bug, fix it in the next commit.

**HALT marker discipline.** Operators flag pause-for-human steps inline with `- [ ] N.M [HALT] <reason>` in `steps.md`. The token `[HALT]` must appear as the first non-checkbox token after the step number; the reason text is emitted verbatim by `/session-start`. **Currently honored by `/session-start` only** — `/work-next` routes pause-for-human conditions through `${CONTROL_HALT_CONDITIONS}` (config.sh runtime conditions), not steps.md inline markers. Use this convention when authoring steps that need explicit operator gating discoverable by `/session-start`; use `CONTROL_HALT_CONDITIONS` when extending `/work-next`'s autonomous halts.

**Uncommitted work at session end is a protocol violation** unless STATE.md's "In-flight work" explains why (e.g. mid-refactor, paused for user review). `/session-end` flags uncommitted changes and prompts to commit or document.

**Branching:** trunk-based works fine for single-developer Claude-driven work. Use feature branches only when the phase is large enough that you want parallel lines of work — otherwise overhead doesn't pay back. Tag the branch's merge commit as the phase close.

### Commit-msg contract

The `.githooks/commit-msg` hook does mechanical commit-shape enforcement: it rejects any commit subject that doesn't match the canonical `<type>(<phase>.<step>): <subject>` shape declared in `CLAUDE.md` and `CONTROL_COMMIT_FORMAT`. The "git log = readable progress narrative" guarantee is now hook-enforced, not LLM-enforced.

**Subject regex** (assembled from `.control/config.sh` `CONTROL_COMMIT_TYPES` at hook-fire time):

    ^(<types>)\((<N>(\.<M>[a-z]?)?|phase-<slug>|adr|issues|state|spec|install)\): .{3,}$

The parens content admits:
- `<N>(.<M>[a-z]?)` — step (with optional letter suffix for follow-up commits within the same step: `feat(3.4)`, `feat(3.4b)`)
- `phase-<slug>` — phase-close commits (`chore(phase-3): close phase 3`, per `/phase-close`); slug character class is `[a-z0-9.-]+` to admit version-flavored names like `phase-1-v1.4.0`
- `adr` — ADR commits (`docs(adr): ADR-<NNNN> ...`, per `/new-adr`)
- `issues` — issue ops (`docs(issues): open ISSUE-...`, `docs(issues): resolve ...`, per `/new-issue` and `/close-issue`)
- `state` — session-end commits (`docs(state): session end for step ...`, per `/session-end`)
- `spec` — spec amendments (`docs(spec): amend ...`, per `/spec-amend`)
- `install` — installer's own commit (`chore(install): install Control framework v...`)

**Bypass cases** (skipped automatically — git defines these shapes, not Control):
- Merge commits — `Merge ...` subject OR `MERGE_HEAD` exists
- Revert commits — `Revert "..."` subject (matches `git revert`'s default)
- Fixup / squash / amend — `fixup! `, `squash! `, `amend! ` subjects (preserves `git commit --fixup` interactive-rebase workflows)

**Manual bypass.** `git commit --no-verify` skips the hook entirely. Legitimate uses: vendor-import commits, conflict-resolved squashes, rebases that produce non-step commits. Step / phase-close / issue / ADR commits MUST conform — `--no-verify` for those is a protocol violation. `CLAUDE.md`'s "Never skip hooks (--no-verify) unless the user has explicitly asked for it" continues to apply.

**Wiring.** `npx control-workflow init` sets `core.hooksPath = .githooks` on fresh install, only if the value is unset. If `core.hooksPath` is already set (e.g., husky / pre-commit / lefthook), the installer logs a warning and does NOT auto-wire — operators chain the hook into their existing hooksPath dir manually, or unset and rerun init. `npx control-workflow uninstall` unsets `core.hooksPath` only if the current value is `.githooks` — preserving operator setups that pre-existed.

**Override path.** Projects override `CONTROL_COMMIT_TYPES` in `.control/config.sh` to add or remove allowed types; the hook rebuilds the type alternation at fire time. **Type-name constraint:** type names must be alphanumeric (no whitespace, no regex metacharacters) — the hook word-splits the list and embeds each name verbatim into a regex. The parens allowlist (step / phase / adr / issues / state / spec / install) is hardcoded — projects that need a different parens prefix should use `--no-verify` for the unusual case OR fork `.githooks/commit-msg`. **Phase-tag-format constraint:** the hardcoded `phase-<slug>` allowlist assumes `CONTROL_PHASE_CLOSE_TAG_FORMAT='phase-{n}-{name}-closed'`; projects that change this format must fork the hook OR `--no-verify` their phase-close commits.

**Limitations.** This hook validates the commit-message SHAPE only — it does NOT verify that the `<phase>.<step>` parens content matches the cursor in `.control/phases/<phase>/steps.md`. A commit with `feat(3.4): ...` lands cleanly even when the actual cursor is at `5.2`. Cursor-match enforcement (the `/validate --strict` deferral from I7) remains a future follow-up — not delivered by I4.

---

## Issue flow

Severity drives flow — the OPEN/ directory is for things that need tracking, not every typo.

### Severity rules

| Severity | Flow | Regression test | Blocks phase-close? |
|---|---|---|---|
| **blocker** | Full file in `.control/issues/OPEN/` | Required before close | Yes |
| **major** | Full file in `.control/issues/OPEN/` | Required before close | If tagged `phase:<N>-blocker` |
| **minor** | **Journal line only, fix inline** | Not required (but encouraged) | Never |

A **minor** bug is: a small, contained fix (typo, obvious off-by-one, a cosmetic UI nit) that doesn't change architecture, doesn't need investigation, and can be fixed and committed in the same action. A brief line in `journal.md` is enough:

```
- Minor fix: <what was wrong> in <file> — commit <short-sha>
```

Anything that requires investigation, a hypothesis, or touches more than one file is not minor — file it.

### Full flow (blocker / major)

```
Discovered → /new-issue <slug> → .control/issues/OPEN/<date>-<slug>.md
              │
              ├─ fix in progress  (update Status field)
              │
              ├─ regression test written  (this is the gate)
              │
              └─ /close-issue <id> → .control/issues/RESOLVED/
```

The **regression test gate** is load-bearing for blocker/major. A fix without a test is a patch, not a resolution — the bug will come back. `/close-issue` refuses without one.

### Why severity-gating matters

Without it, the OPEN/ directory fills with noise (typo fixes, imports in wrong order) and the signal-to-noise drops until people stop reading it. Severity makes the OPEN/ list a real worklist.

---

## Per-project customisation

Fill these in when you spin up a new project:

1. **Phase plan** — in `.control/architecture/phase-plan.md`. Enumerate N phases with one-sentence goals and dependency edges.
2. **Done-criteria patterns** — some phases might need eval scores, load tests, security reviews. Bake into the phase README template.
3. **Invariants in CLAUDE.md** — project-specific "never do X" rules (e.g. "never import `openai` directly", "no migrations without an ADR").
4. **Tags** — extend `phase:<N>-blocker` with project-specific tags like `security`, `performance` if you need cross-cutting views.
5. **SessionEnd hook (optional)** — configure via Claude Code settings to block session end until STATE.md's `Last updated` timestamp changes. Stronger enforcement, slightly annoying. Worth it for larger builds.

---

## Common pitfalls

**STATE.md not updated at session end.** The single biggest failure mode. Next session boots with stale state, drifts. Mitigation: the `/session-end` command + optional hook; make it a non-optional step, not a nice-to-have.

**CLAUDE.md bloat.** Every session reads it. Keep it under 50 lines. Long prose belongs in runbooks, pointed to by CLAUDE.md.

**Journal as scratchpad.** Journal entries should be short and event-driven, not a stream-of-consciousness log. If it grows past ~200 entries, archive the oldest half to `.control/progress/journal-archive-<year>.md`.

**ADR revisionism.** ADRs are immutable once accepted. If a decision changes, write a new ADR that **supersedes** the old one (and mark the old one superseded in its Status field). Do not edit accepted ADRs.

**Skipping `/phase-close`.** "We're basically done, let's just move on." No. If done criteria aren't verifiable, they're not met. The protocol's value is precisely the forced verification. Skip it once and you'll skip it always.

**Issue files without regression tests.** Closing an issue without a regression test means that bug will come back, and worse — you'll have to re-investigate from scratch. `/close-issue` enforces this; don't bypass it by moving files manually.

**Memory vs. operational docs confusion.** Auto memory (`~/.claude/projects/...`) is for durable user/project facts — "user is a senior data engineer", "prefers Postgres over MySQL". `.control/progress/STATE.md` and the rest of `.control/` are for this project's operational state — current phase, open issues, ADRs, phase scaffolding. (See "Documentation layers" for the operational vs long-form split.) Don't put operational state in memory; it's hard to update atomically and doesn't survive memory clears.

**Over-scaffolding small projects.** If the project is <2 weeks of work, skip this whole thing. Use a single `NOTES.md` and move on. The overhead only pays back on multi-phase, multi-session builds.

**Commits that don't match steps.** A 500-line commit titled "WIP" breaks the whole git-as-progress-narrative idea. Commits should close steps or atomic units within a step. If a commit spans two steps, split it or change the step boundary — don't pretend it's fine.

**Skipping the phase tag.** `phase-<N>-closed` tags are the rollback escape hatch and the regression bisection anchor. Skip them and you lose both. `/phase-close` creates the tag; do not close a phase manually.

**Filing everything as major.** Severity gating only works if you're honest — a typo is minor even if it annoyed you. If `.control/issues/OPEN/` grows faster than you close, you're probably over-filing.

**STATE.md fields left `<placeholder>`.** An unfilled placeholder in STATE.md reads as "the last person didn't know either." Every session-end must fill every field — if a field is genuinely inapplicable, write "n/a" with a one-word reason, not the template placeholder.

**Jumping straight to stage 3 autonomy.** Running `/loop /work-next` across phases on day one means trusting a priority logic you haven't validated. You'll wake up to commits that look right and aren't. Stay at stage 0 until at least one phase closes cleanly; stage 1 until the priority picks feel right; stage 2 until the HALT conditions catch everything they should.

**Fake HALT conditions.** If `/work-next` treats every minor uncertainty as a HALT, autonomy is useless — you're back to driving. If it never HALTs, you're at risk of confidently-wrong work. The line is: HALT when a human brings information Claude can't derive (domain knowledge, acceptance criteria, credentials, irreversibility). Don't HALT on "I'm not 100% sure" — that's what tests and the regression gate are for.

---

## One-page cheat sheet

```
INSTALL             →  npx control-workflow init [TARGET]
UPGRADE             →  npx control-workflow upgrade [TARGET]
UNINSTALL           →  npx control-workflow uninstall [TARGET]
BOOTSTRAP FROM SPEC →  /bootstrap <spec-file>     (one-shot: invariants + overview + phase-plan + phase-1)

DO THE NEXT THING   →  /work-next                 (protocol picks; halts on human-needed)
AUTONOMOUS MODE     →  /loop /work-next           (self-paced; halts on HALT conditions)
START SESSION       →  /session-start             (also verifies git matches STATE.md)
NEW BUG FOUND       →  /new-issue <slug>          (asks severity first; minor = journal line, no file)
NEW ARCH DECISION   →  /new-adr <slug>
STEP DONE           →  commit <type>(<phase>.<step>): <subject>
BUG FIXED (maj/blk) →  write regression test → commit → /close-issue <id>
PHASE COMPLETE      →  /phase-close               (runs done criteria + creates tag)
END SESSION         →  /session-end               (commits if dirty, updates STATE.md)
SANITY CHECK        →  /validate                  (reports inconsistencies; does not fix)

LOST CONTEXT        →  read .control/progress/STATE.md
LAST HANDOFF NOTES  →  read .control/progress/next.md
WHY DID WE DO X     →  read .control/architecture/decisions/
WHAT HAPPENED WHEN  →  git log --oneline + .control/progress/journal.md
RECOVER FROM COMPAC →  ls -t .control/snapshots/STATE-*.md | head -1

TAGS TO KNOW
  protocol-initialised        — scaffolding committed
  phase-<N>-<name>-closed     — phase N verified + shipped

AUTONOMY STAGES (earn trust in order)
  0. Manual            — you type every command
  1. Semi-auto         — "go" → /work-next runs one step
  2. Step-loop         — /loop /work-next within a phase
  3. Phase-loop        — /loop /work-next across phases

CONFIG FILE            .control/config.sh       (iteration budget, retention, formats)
```

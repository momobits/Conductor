# Session start protocol

1. **Read state** — `.control/progress/STATE.md`. Note every field: phase, step, next action, git state, blockers, in-flight work, test/eval status, recent decisions, attempts that didn't work, notes.
2. **Read phase context** — the README and steps files for the phase path in STATE.md.
3. **Scan open issues** — list every file in `.control/issues/OPEN/`. Identify items tagged as blockers for the current phase.
4. **Respond to drift signals.** The SessionStart hook (`.claude/hooks/session-start-load.{sh,ps1}`) emits zero or more `[control:drift]` blocks. Each block has a `type:` field; mismatch types also have `expected:` / `actual:` fields. **If any `[control:drift]` block is present**, narrate the drift to the operator in plain English and pause for reconciliation. **Do NOT** paste the raw block. **Do NOT** silently proceed.

   **Drift narration cheat sheet** (one suggested narration per type — Claude may rephrase to match conversational context):

   | type | suggested narration | reconciliation |
   |------|---------------------|----------------|
   | `state-md-missing` | "STATE.md is missing — the project isn't initialized." | Run `/bootstrap`. |
   | `state-md-template` | "STATE.md still has template placeholders (`<short-sha>`, `<YYYY-MM-DD>`, `<sha>`) — bootstrap hasn't run." | Run `/bootstrap`. *(Source-repo exception: see C.5 sentinel.)* |
   | `state-md-unparseable` | "STATE.md's Git state section is unparseable (parser-contract fields renamed or removed)." | Run `/validate` to identify the broken field. |
   | `branch-mismatch` | "STATE.md says branch=`<expected>` but actual is `<actual>` — sync before proceeding." | Update STATE.md's Git state, or check out the expected branch. |
   | `commit-mismatch` | "STATE.md says last commit=`<expected>` but actual is `<actual>` — STATE.md hasn't caught up." | Update STATE.md's "Last commit" + "Recently completed" to reflect actual git log. |
   | `uncommitted-mismatch` | "STATE.md says uncommitted=none but tree is dirty (`<paths>`) — either commit or note the in-flight reason." | Commit, OR add an entry to STATE.md's "In-flight work" with the reason. |
   | `tag-mismatch` | "STATE.md says last tag=`<expected>` but actual is `<actual>` — tag added/removed since last STATE.md update." | Update STATE.md's "Last phase tag", and verify the phase boundary is what STATE.md believes. |

   **Self-reference exception for `commit-mismatch`.** The hook suppresses `commit-mismatch` when HEAD is a `docs(state): session end ...` commit AND HEAD's parent short SHA appears in STATE.md's "Last commit" value. This is the expected post-`/session-end` shape: STATE.md commits itself with a fresh SHA, naturally lagging behind by exactly one docs commit. Flagging it as drift was a recurring nuisance that operators always reconciled the same way. Real commit drift (HEAD changed for any reason other than this) still fires.

   After narrating, ask the operator how they want to reconcile. Don't decide for them — STATE.md is operator-owned.

   **If the `[control:SessionStart]` block is NOT present** (hook absent or runbook invoked manually outside the hook flow), do a manual compare: `git status --porcelain`, `git log -1 --oneline`, `git rev-parse --abbrev-ref HEAD`, `git describe --tags --abbrev=0` against STATE.md's Git state section. Any mismatch is drift — flag it, don't silently proceed.

4b. **Respond to validation signals** (v2.0 / C.4). The hook also emits `[control:validate]` blocks for cheap filesystem-coherence checks beyond drift. Each block has `severity: warning|error`, `check: <kebab-name>`, and `detail:` fields. **If any `[control:validate]` block is present**, narrate the issue to the operator and:
   - **`error` severity** — pause and ask how to reconcile (e.g. `phase-dir-missing` means STATE.md cursor disagrees with the filesystem; the operator either authors the missing dir or fixes STATE.md).
   - **`warning` severity** — surface in the session-start narrative but proceed if operator says go (e.g. `phase-plan-missing` is a warning because some projects haven't bootstrapped phases yet).

   **Validate type catalog** (v2.0 hook):

   | check | severity | detail | reconciliation |
   |-------|----------|--------|----------------|
   | `phase-plan-missing` | warning | `.control/architecture/phase-plan.md` not found | run `/bootstrap`, OR author the file manually |
   | `phase-dir-missing` | error | STATE.md cursor phase=N but no `.control/phases/phase-N-*/` dir | author the missing phase dir from templates, OR fix STATE.md cursor |

   `/validate` (manual command) does deeper checks not yet automated by the hook (issue file shape, ADR sequence, hook installation completeness). Run it explicitly if the operator suspects deeper drift.
5. **Report to operator.** Default is narrative; verbose is structured. The operator sees the narrative unless they ask for the verbose block ("show me the status block", "show full state", or pass `--verbose` to a slash command).

   **Narrative (default).** 2–4 plain-English sentences. Derive from the `[control:state]` hook block + STATE.md. Lead with the phase/step continuation, then current health (working tree, blockers, last test), then the proposed next action. Do NOT paste the raw `[control:state]` block at the operator.

   Example:
   > **Continuing Phase 2 (DSPy QueryPlanner), step 2.3.**
   > Last session implemented 2.2 base classes (`abc123`). Working tree clean, no blockers, last test green.
   >
   > **Next:** define the QueryPlanner signature per spec §3.2.
   >
   > Ready?

   **Verbose (on request, OR forced by drift).** Canonical structured shape, used by all status-emitting commands (`/session-start`, `/work-next`, `/phase-close`):

   ```
   Phase <N> — <name>, step <N.M>
   Last action: <from STATE.md "Recently completed[0]">
   Git: branch=<...>, last=<sha> <subject>, uncommitted=<yes|no>, tag=<last phase tag>
   Git sync: matches STATE.md  OR  drift: <type-and-detail per [control:drift] blocks>
   Open blockers: <count, with IDs> OR None
   Test/eval status: <from STATE.md>
   Proposed next action: <from STATE.md>
   ```

   **Drift forces verbose.** If step 4 surfaced any `[control:drift]` block, narrate the drift first AND show the verbose block. Don't proceed until the operator confirms reconciliation.

5b. **Design decisions awaiting operator input.** If `.control/progress/next.md` surfaces a `## Decisions awaiting your input` section, or STATE.md's "Notes for next session" / "Next action" flags an open design choice for the upcoming step, expand it inline before asking for go. For each option present: **(i) what concretely changes** (schema additions, code shape, file additions), **(ii) what the operator sees** (sample CLI output, sample data shape, sample error), **(iii) cost / scope impact** (how it affects the current step's budget and surrounding work), **(iv) trade-off being accepted** (what each option costs, not just what it gains). End with a recommendation that names the trade-off, not just the lean. Do not shorthand design choices as labeled footnotes (`(a)` / `(b)` with one-line summaries) — that forces the operator to ask for the detail in a second turn, wasting context.

5c. **Recommend next action.** If Step 5b expanded a design decision, SKIP this step (the decision takes precedence over a generic recommendation). Otherwise, after the status report, apply the priority decision tree from `.control/runbooks/work-priority.md` (read the file, walk the priority order against current state, emit the recommendation) and append: `Recommended next: <recommendation>` followed by `(Add --why to see the state inputs behind this recommendation.)`. Recommendation only — wait for the operator's go before executing.

6. **Wait for confirmation.** Do not edit code before the operator says go.

If `SessionStart` hook is installed, steps 1-5 run automatically and prefix the session with the structured `[control:*]` data blocks for Claude to read. Claude turns the data into the narrative the operator sees.

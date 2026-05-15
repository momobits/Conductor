# `work_card` permanently appends analyze/plan output into the card body file

*Created: 2026-05-15*
*Source: Phase 21 Playwright behavior test of "Work this card" against omniforge `2026-05-12-t6-imported`.*
*Severity: P1 — destructive write to user-owned dossier; accumulates across runs.*

## Problem statement

When **Work this card** runs on a card, the task agent appends the rendered output of each operation (analyze, plan, …) into the card's own `.md` file. Each subsequent invocation re-appends, so the card body grows monotonically with every run.

Observed (single click of **Work this card** on omniforge's `2026-05-12-t6-imported.md`):

- Pre-state, body was 8 lines: title + stub "Edit this card to add detail before running `conductor work`."
- Post-state, body is **114 lines**, with appended `## Chat`, `## Analysis` (full analyze op output wrapped in ` ```markdown ` fence), and `## Implementation Plan` (full plan op output with multiple subsections) sections.
- Each section is separated by `---` rulers. Re-running would add more.

## Current state

- `src/rpc/methods.ts:170-194` (the `work_card` handler) invokes `TaskAgent.run()` which executes ops; each op's textual output is written back somewhere — appears to land in the card body. Verify via `Grep "appendBody\|appendToCard\|writeCard.*append"` in `src/agent/task_agent.ts` and `src/engine/ops/{analyze,plan,review,implement,verify}.ts`.
- The card body is the dossier the next operator (human or agent) reads. Conflating it with operation output makes the card body un-grepable for "what is this card about" content and unbounded in size.

## Impact

- **Destructive accumulation**: every retry of `work_card` adds to the file. There is no truncation, dedup, or section-replace.
- **Dossier pollution**: the card's intent (what problem to solve) is buried under increasingly long generated text.
- **Run-log redundancy**: `.conductor/runs/<runId>/events.jsonl` already stores the structured op output. Persisting it twice (in jsonl AND in the card body markdown) wastes disk and creates two sources of truth.
- **Card detail UI**: the rendered body now contains `## Chat`, `## Analysis`, and `## Implementation Plan` sections. The Chat panel below it duplicates the `## Chat` heading visually (two "Chat" headers on one page).

## Reproduction

1. Pick any placeholder card (`2026-05-12-t6-imported` in omniforge works — short body, no real issue).
2. Capture file line count.
3. Click **Work this card** on its detail page.
4. Wait for the LIVE FEED to show `■ done` and the work button to re-enable.
5. Re-read the card file. Body now contains the analysis + plan transcript.

## Proposed direction

Three options, in preference order:

- **A (preferred):** persist op output only to `.conductor/runs/<runId>/`. The card body is left alone. The card-detail UI loads op output for display by reading the run dir, not the body. This separates intent (card body) from outcome (run artifacts).
- **B:** if op output must live in the card, store it in a YAML frontmatter `op_outputs:` field rather than the body. Frontmatter is structured, can be replaced wholesale per run, and doesn't bleed into the rendered dossier.
- **C:** append to a sibling file `cards/<id>.runs.md` instead of the card itself. Cheapest fix.

Whichever path is chosen, **truncate or replace** instead of append. Today's "append every time" guarantees pollution.

## Related

- `[[ui-card-chat-renders-markdown-as-plaintext]]` — chat-pane history is already persisted into the card body via a similar append. See `[[ui-card-chat-history-not-loaded-on-revisit-but-pollutes-card-body]]`.
- `[[ui-plan-op-cannot-see-analyze-output-it-just-wrote]]` — symptom of the same persistence-via-body anti-pattern.

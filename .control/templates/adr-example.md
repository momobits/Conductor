<!-- Filled example ADR. See .control/templates/adr.md for the skeleton. -->
<!-- Archetype: a CLI tool processing episodic session data. Treat this as a shape reference, not a content source. -->

# ADR-0003: Choosing the on-disk format for persistent tool state

**Date:** 2026-01-15
**Status:** accepted
**Phase when decided:** 1

## Context

A CLI tool processing episodic session data needs to persist state across invocations — session cursors, activity logs, blocker flags, in-flight work — so an interrupted or resumed session can pick up where the previous one left off. The on-disk format choice shapes every downstream workflow: editability, git behavior, atomicity guarantees, and portability across operating systems.

**Current state:** no persistence — tool state lives in memory and is lost on exit. A regression three weeks ago (commit `a1c8f72`) reintroduced silent state-loss on mid-run interrupts, which is what prompted this decision.

Forces in play:

1. **Diffability** — the operator reviews what changed between sessions at a glance. Non-text formats force a diff tool or a dump-and-compare workflow. Plain-text is the baseline.
2. **Atomicity** — state updates must be crash-safe. An interrupt mid-write must not leave the file corrupt; resume must find either the old state or the new state, never a truncated one.
3. **Git-friendliness** — the state directory is committed. Merge conflicts on state updates happen in multi-operator workflows and must resolve in any three-way merge tool without special tooling.
4. **Human editability** — the operator should be able to open the file(s) in any editor and hand-correct a value without fear of breaking a binary format or a schema checksum.
5. **Portability** — the tool runs on macOS, Linux, and Windows. No format should require OS-specific tooling to read or write.
6. **Concurrent-write safety** — while the tool is single-process, adjacent tools (editors, git, backup agents) open files. Lock contention must not be a normal failure mode.

## Decision

**Adopt a directory of markdown files under a single top-level folder** (`.state/`) as the canonical on-disk state format. Each state domain (progress, architecture, issues, runbooks) gets a subdirectory; each entity within a domain gets a file.

Rationale per-force:

1. **Diffability** — markdown is plain text; `git diff` surfaces semantic changes line by line.
2. **Atomicity** — write-to-temp-then-rename is sufficient for single-file updates; POSIX rename is atomic on all supported filesystems.
3. **Git-friendliness** — conflicts land inside specific sections of specific files, not across a monolithic blob. Human-resolvable.
4. **Human editability** — any editor. No schema, no checksum.
5. **Portability** — markdown and plain directories work identically on all three operating systems.
6. **Concurrent-write safety** — file-per-entity keeps the contention surface tiny; no whole-state lock.

### Scope

**In:**
- Flat directory of markdown files under the top-level state root
- One file per entity (progress snapshot, ADR, issue, runbook)
- Subdirectories per domain (`progress/`, `architecture/`, `issues/`, `runbooks/`)
- Line-ending normalization enforced via `.gitattributes`

**Out:**
- Central index files maintained alongside the markdown (consumers derive indices by reading the directory)
- Per-file locking infrastructure (rely on the rename contract)
- Format-level schema enforcement (validation lives in the tooling layer, not the format)

## Alternatives considered

### Tier 1 — Directory of markdown files (chosen)

One top-level state root with domain subdirectories; one file per entity. Low per-update cost; natural fit for human editors and git; atomicity via tmp-rename.

*Cost:* larger file count (dozens, eventually hundreds of files). *Complexity:* very low — no schema, no index, no locks.

### Tier 2 — Single structured JSON file (rejected)

All state in one `state.json` at the root; updates replace the whole file atomically.

*Rejected because:*
- **Diffability** degrades once nested maps cross ~three levels; `git diff` of a large JSON shows noisy whitespace churn on unrelated keys.
- **Merge conflicts** on JSON are notoriously painful — conflicts land on `}` and `,` lines and humans can't resolve them without re-parsing.
- **Human editability** is fragile — one missed quote or misplaced comma corrupts the whole state.

*Cost:* low initial, high ongoing. *Complexity:* moderate — schema versioning needed once the file crosses a few hundred lines.

### Tier 3 — SQLite database (rejected)

Single `.sqlite` file storing all state in tables; atomic via WAL mode.

*Rejected because:*
- **Diffability** is nil — binary file, `git diff` shows "binary differs."
- **Human editability** requires the `sqlite` CLI, defeating the "any editor" baseline.
- **Portability** is nominally fine but introduces a transitive dependency (the sqlite binary) the tool otherwise doesn't need.
- Concurrent-write guarantees are strong — the one force SQLite wins on — but unused, since the tool is single-process.

*Cost:* moderate (dependency management, schema migrations). *Complexity:* high — query layer, migration story, backup story.

## Consequences

### Positive

- Every state change is a line-level diff a human reads directly in `git log -p`.
- Rollback to a previous phase tag restores state exactly — no schema mismatch, no replay.
- Operators hand-edit state during incident response without risk of corrupting a binary format.
- Merge conflicts resolve in any three-way merge tool that handles text.

### Negative

- No atomic cross-file transactions — updates that logically span two files (closing an issue and updating a progress cursor) can commit one and fail the other. Mitigate via ordered writes + idempotent retry.
- File count grows unboundedly — a long-running project accumulates hundreds of files. Mitigate by treating closed entities as archivable (move to `archive/`; git history preserves them).
- Directory listing becomes the index — no `SELECT ... WHERE` equivalent. Mitigate with filename conventions (`ISSUE-<date>-<slug>.md`) and grep-friendly headers.

### Follow-up work

- **Compaction policy** (Phase 3) — decide when and how to archive closed entities. Current plan: operator-driven via an `archive` command. A lint pass may be warranted once the open set reaches ~50 entities.
- **Line-ending discipline** — `.gitattributes` rules for `*.md` to pin `text=auto` so Windows operators don't introduce CRLF drift.

## Implementation notes

- 2026-02-04: Line-ending drift (CRLF vs LF) observed in a Windows operator's commits — enforced via `.gitattributes` per commit `b3f4d21`.
- 2026-02-19: Renamed `state/` → `.state/` to match hidden-directory convention for tool-managed data. Migration via commit `c94ae0e`; no backward-compat shim since the directory had shipped to two internal users only.
- 2026-03-11: Added a lint rule for filename-to-header-title mismatch after three issues in a week shipped with the wrong `# ISSUE-<slug>` tag. Rule lives in the tooling layer, not the format.

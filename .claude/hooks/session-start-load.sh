#!/usr/bin/env bash
# Control hook: SessionStart
# Fires at the beginning of every Claude Code session.
#
# v2.0: data-only output. Emits structured [control:*] blocks for Claude to
# read; the runbook at .claude/commands/session-start.md tells Claude what
# to do with them. The "Before accepting user input, run the session-start
# protocol: 1. Read STATE.md ..." prose has moved into the runbook.
#
# Quadruplication contract: this hook + .ps1 sibling + runbook + slash
# command stay byte-equivalent on the [control:*] data blocks. Future
# changes update all four files in the same diff.

set -euo pipefail

LATEST_SNAP=$(ls -t .control/snapshots/precompact-STATE-*.md .control/snapshots/STATE-*.md 2>/dev/null | head -1 || echo "")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "not-a-git-repo")

if git rev-parse HEAD >/dev/null 2>&1; then
    GIT_LAST=$(git log -1 --oneline 2>/dev/null)
    GIT_LAST_SHA=$(echo "$GIT_LAST" | awk '{print $1}')
    GIT_LAST_SUBJECT=$(echo "$GIT_LAST" | cut -d' ' -f2-)
    if git diff-index --quiet HEAD -- 2>/dev/null && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
        GIT_DIRTY="clean"
    else
        GIT_DIRTY="dirty"
    fi
    LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")
else
    GIT_LAST_SHA="none"
    GIT_LAST_SUBJECT=""
    GIT_DIRTY="n/a"
    LAST_TAG="none"
fi

# --- Drift detection (mechanical compare against STATE.md) -----------------
# Emits zero or more [control:drift] blocks with a `type` field. Claude reads
# the blocks, narrates to the operator, and pauses for reconciliation. Exit 0
# always -- drift is a signal, not a hook failure.
#
# Source-repo sentinel: if .control/.is-source-repo exists, skip ALL drift
# checks. This is the Control framework's own dev repo where STATE.md is
# intentionally template-shaped. The sentinel is gitignored so it never
# propagates to consumer projects.

STATE_FILE=".control/progress/STATE.md"
SOURCE_REPO_SENTINEL=".control/.is-source-repo"
DRIFT_BLOCKS=""

extract_field() {
    grep -m1 -E "^- \*\*${1}:\*\*" "$STATE_FILE" 2>/dev/null \
        | sed -E "s/^- \*\*${1}:\*\* *//" \
        | tr -d '\r' \
        || true
}

emit_drift() {
    # $1 = type, $2 = optional inner-field lines (empty for flag-only drifts)
    if [ -n "${2:-}" ]; then
        DRIFT_BLOCKS="${DRIFT_BLOCKS}[control:drift]
type: $1
$2
[/control:drift]

"
    else
        DRIFT_BLOCKS="${DRIFT_BLOCKS}[control:drift]
type: $1
[/control:drift]

"
    fi
}

if [ -f "$SOURCE_REPO_SENTINEL" ]; then
    : # Control source/dev repo -- skip all drift checks; STATE.md is intentionally template-shaped
elif [ ! -f "$STATE_FILE" ]; then
    emit_drift "state-md-missing"
elif grep -qE '<short-sha>|<YYYY-MM-DD>|<sha>' "$STATE_FILE"; then
    emit_drift "state-md-template"
else
    STATE_BRANCH=$(extract_field "Branch")
    STATE_LAST_COMMIT=$(extract_field "Last commit")
    STATE_UNCOMMITTED=$(extract_field "Uncommitted changes")
    STATE_LAST_TAG_RAW=$(extract_field "Last phase tag")

    if [ -z "$STATE_BRANCH" ] && [ -z "$STATE_LAST_COMMIT" ] && [ -z "$STATE_UNCOMMITTED" ] && [ -z "$STATE_LAST_TAG_RAW" ]; then
        emit_drift "state-md-unparseable"
    else
        STATE_LAST_TAG=$(echo "$STATE_LAST_TAG_RAW" | sed -E 's/`//g' | cut -d' ' -f1)

        if [ -n "$STATE_BRANCH" ] && [ "$STATE_BRANCH" != "$GIT_BRANCH" ]; then
            emit_drift "branch-mismatch" "expected: $STATE_BRANCH
actual: $GIT_BRANCH"
        fi
        if [ -n "$STATE_LAST_COMMIT" ] && [ -n "$GIT_LAST_SHA" ] && [ "$GIT_LAST_SHA" != "none" ] && ! echo "$STATE_LAST_COMMIT" | grep -qF "$GIT_LAST_SHA"; then
            # Self-reference exception: /session-end commits STATE.md as
            # `docs(state): session end ...`, so HEAD becomes that commit while
            # STATE.md still references its parent (the last work commit it
            # summarized). That's the expected post-/session-end shape, not
            # drift. Suppress when HEAD's subject matches AND HEAD's parent
            # short SHA appears in STATE.md's "Last commit" value.
            SELF_REF_OK=0
            if echo "$GIT_LAST_SUBJECT" | grep -qE '^docs\(state\): session end'; then
                PARENT_SHA=$(git rev-parse --short HEAD~1 2>/dev/null || echo "")
                if [ -n "$PARENT_SHA" ] && echo "$STATE_LAST_COMMIT" | grep -qF "$PARENT_SHA"; then
                    SELF_REF_OK=1
                fi
            fi
            if [ "$SELF_REF_OK" -eq 0 ]; then
                emit_drift "commit-mismatch" "expected: $STATE_LAST_COMMIT
actual: $GIT_LAST_SHA $GIT_LAST_SUBJECT"
            fi
        fi
        if [ "$STATE_UNCOMMITTED" = "none" ] && [ "$GIT_DIRTY" != "clean" ]; then
            emit_drift "uncommitted-mismatch" "expected: none
actual: $GIT_DIRTY"
        fi
        if [ -n "$STATE_LAST_TAG" ] && [ "$STATE_LAST_TAG" != "$LAST_TAG" ]; then
            emit_drift "tag-mismatch" "expected: $STATE_LAST_TAG
actual: $LAST_TAG"
        fi
    fi
fi
# --- End drift detection ---------------------------------------------------

# --- Lightweight validation checks (v2.0 / cycle 5d / C.4) ----------------
# Fast file-existence and filesystem-coherence checks beyond drift detection.
# Emits zero or more [control:validate] blocks. The full sanity check is
# /validate (operator-invokable). Skipped when source-repo sentinel present
# (template-shape STATE.md has placeholder cursor values that won't resolve).

VALIDATE_BLOCKS=""

emit_validate() {
    # $1=severity (warning|error), $2=check, $3=detail
    VALIDATE_BLOCKS="${VALIDATE_BLOCKS}[control:validate]
severity: $1
check: $2
detail: $3
[/control:validate]

"
}

if [ ! -f "$SOURCE_REPO_SENTINEL" ] && [ -f "$STATE_FILE" ]; then
    # Check: phase-plan.md exists
    if [ ! -f .control/architecture/phase-plan.md ]; then
        emit_validate "warning" "phase-plan-missing" ".control/architecture/phase-plan.md not found -- run /bootstrap or author manually"
    fi

    # Check: cursor phase dir resolves
    CURSOR_PHASE=$(grep -m1 -E "^\*\*Current phase:\*\*" "$STATE_FILE" 2>/dev/null | sed -E 's/^\*\*Current phase:\*\* *//' | tr -d '\r' || true)
    if [ -n "$CURSOR_PHASE" ] && [ "$CURSOR_PHASE" != "not-yet-defined" ]; then
        # Numeric phase prefix (e.g. "3 -- foo" -> "3"). Empty if non-numeric (e.g. "test").
        PHASE_NUM=$(echo "$CURSOR_PHASE" | grep -oE '^[0-9]+' | head -1 || true)
        if [ -n "$PHASE_NUM" ] && ! ls -d .control/phases/phase-${PHASE_NUM}-* >/dev/null 2>&1; then
            emit_validate "error" "phase-dir-missing" "STATE.md cursor phase=${PHASE_NUM} but no .control/phases/phase-${PHASE_NUM}-*/ directory exists"
        fi
    fi
fi

# Append validate blocks to the drift blocks stream (output together below)
if [ -n "$VALIDATE_BLOCKS" ]; then
    DRIFT_BLOCKS="${DRIFT_BLOCKS}${VALIDATE_BLOCKS}"
fi
# --- End validation checks -------------------------------------------------

# --- Emit data blocks ------------------------------------------------------
cat <<EOF
[control:SessionStart]

[control:state]
branch: $GIT_BRANCH
last-commit-sha: $GIT_LAST_SHA
last-commit-subject: $GIT_LAST_SUBJECT
working-tree: $GIT_DIRTY
last-tag: $LAST_TAG
[/control:state]

[control:snapshot]
latest-precompact: ${LATEST_SNAP:-none}
[/control:snapshot]

EOF

if [ -n "$DRIFT_BLOCKS" ]; then
    printf '%s' "$DRIFT_BLOCKS"
fi

cat <<EOF
-> Follow .claude/commands/session-start.md to bootstrap. Read STATE.md and
the current phase docs, narrate the status from the [control:state] data
above (plain English, not the raw block), surface any [control:drift] as a
narrative warning, and propose the next action. Wait for operator go before
editing code.
EOF

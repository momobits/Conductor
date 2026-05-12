#!/usr/bin/env bash
# Control helper: regenerate .control/progress/next.md from STATE.md.
# Idempotent and side-effect-free (no snapshots, no commits, no prune).
# Called by:
#   - .claude/hooks/session-end-commit.sh (after snapshotting, before prune)
#   - /session-end slash command runbook step 4 (so the commit includes
#     a fresh next.md before the SessionEnd hook fires)
#
# next.md is a derived view of STATE.md's "Next action" + "Notes for next
# session" sections plus a kickoff-prompt boilerplate. Operators never write
# next.md by hand in v2.0+ -- edit STATE.md to influence the kickoff.

set -euo pipefail

STATE_FILE=".control/progress/STATE.md"
NEXT_FILE=".control/progress/next.md"

if [ ! -f "$STATE_FILE" ]; then
    echo "[regenerate-next-md] STATE.md not found at $STATE_FILE -- skipping" >&2
    exit 0
fi

# Extract content of "## $1" section: prints lines after the heading until
# the next "## " heading or "---" separator (whichever comes first).
extract_state_section() {
    local label="$1"
    awk -v lbl="## $label" '
        BEGIN { printing = 0 }
        $0 == lbl { printing = 1; next }
        /^## / { if (printing) exit }
        /^---$/ { if (printing) exit }
        printing { print }
    ' "$STATE_FILE"
}

# Strip leading/trailing blank lines from a string
trim_blank() {
    sed -e '/./,$!d' -e :a -e '/^\s*$/N;/\n\s*$/ba' -e 's/\n\s*$//' <<< "$1"
}

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NEXT_ACTION=$(extract_state_section "Next action")
NOTES=$(extract_state_section "Notes for next session")

# Defaults if sections missing
NEXT_ACTION="${NEXT_ACTION:-(See STATE.md "Next action" — section missing or empty.)}"
NOTES="${NOTES:-(See STATE.md "Notes for next session" — section missing or empty.)}"

cat > "$NEXT_FILE" <<EOF
# Next session kickoff

> Auto-generated from \`.control/progress/STATE.md\` at $TS by
> \`.claude/hooks/regenerate-next-md.sh\`. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read \`.control/progress/STATE.md\` -- the single source of truth.
2. Read the current phase's \`README.md\` and \`steps.md\` (path in STATE.md).
3. Check \`.control/issues/OPEN/\` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured \`[control:state]\` block instead of doing them by hand.

## Next action
$NEXT_ACTION

## Notes for next session
$NOTES
EOF

echo "[regenerate-next-md] wrote $NEXT_FILE from $STATE_FILE at $TS" >&2

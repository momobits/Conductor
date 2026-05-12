#!/usr/bin/env bash
# Control hook: SessionEnd
# Fires when a Claude Code session ends (user quits or session closed).
# Final safety net -- snapshot state, warn about uncommitted changes.
#
# This does NOT auto-commit or auto-update STATE.md -- those are work for the
# /session-end command (runs before this hook, in the active session).
# This hook only snapshots what's on disk at the moment of shutdown.

set -euo pipefail

SNAP_DIR=".control/snapshots"
TS=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$SNAP_DIR"

# Snapshot state files
for f in STATE.md journal.md next.md; do
    [ -f ".control/progress/$f" ] && cp ".control/progress/$f" "$SNAP_DIR/sessionend-${f%.md}-$TS.md" || true
done

# Append a marker line to the chronological event stream (parallel to PreCompact)
printf '%s  sessionend  snapshot_id=%s  files=STATE.md,journal.md,next.md\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TS" >> "$SNAP_DIR/markers.log"

# Record whether the working tree was clean at shutdown (only if HEAD exists)
DIRTY_FLAG="$SNAP_DIR/sessionend-dirty-$TS.flag"
if git rev-parse HEAD >/dev/null 2>&1; then
    if ! git diff-index --quiet HEAD -- 2>/dev/null || [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        {
            echo "Session ended with uncommitted changes."
            echo "Session ended at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            echo ""
            echo "--- git status ---"
            git status --short 2>/dev/null || true
        } > "$DIRTY_FLAG"
        echo "[control:SessionEnd] WARNING: session ended with uncommitted changes -- see $DIRTY_FLAG" >&2
    fi
fi

# Regenerate next.md from STATE.md (v2.0 / cycle 5c / C.3) -- safety net so
# next.md never falls out of sync if /session-end didn't refresh it.
if [ -x .claude/hooks/regenerate-next-md.sh ]; then
    bash .claude/hooks/regenerate-next-md.sh || true
fi

# Prune old snapshots
bash .claude/hooks/prune-snapshots.sh || true

echo "[control:SessionEnd] snapshot $TS written to $SNAP_DIR" >&2

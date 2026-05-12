#!/usr/bin/env bash
# Control hook: PreCompact
# Fires BEFORE Claude Code compacts the conversation history to free context.
# Snapshots live state to disk so nothing is lost when context is compressed.

set -euo pipefail

SNAP_DIR=".control/snapshots"
TS=$(date -u +%Y%m%d-%H%M%S)

mkdir -p "$SNAP_DIR"

# Snapshot the live progress files -- quietly skip missing ones
for f in STATE.md journal.md next.md; do
    [ -f ".control/progress/$f" ] && cp ".control/progress/$f" "$SNAP_DIR/precompact-${f%.md}-$TS.md" || true
done

# Append a marker line to the chronological event stream
# (admin log under .control/snapshots/, gitignored alongside snapshots)
printf '%s  precompact  snapshot_id=%s  files=STATE.md,journal.md,next.md\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TS" >> "$SNAP_DIR/markers.log"

# Trigger pruning so snapshots don't grow unbounded
bash .claude/hooks/prune-snapshots.sh || true

echo "[control:PreCompact] snapshot $TS written to $SNAP_DIR" >&2

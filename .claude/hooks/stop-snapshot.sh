#!/usr/bin/env bash
# Control hook: Stop
# Fires after each Claude response completes.
# Per-turn snapshot into a rolling window -- mechanical insurance against slow drift.
# Cheap: only writes if STATE.md changed (cmp dedup vs newest snapshot in the window).
#
# Restore from drift: cp .control/snapshots/stop-<ts>.md .control/progress/STATE.md
# If Stop hook overhead becomes an issue, remove it and rely on PreCompact + SessionEnd only.

set -euo pipefail

SNAP_DIR=".control/snapshots"
STATE_FILE=".control/progress/STATE.md"

[ ! -f "$STATE_FILE" ] && exit 0

mkdir -p "$SNAP_DIR"

# Load retention config defensively (.control/config.sh is kind=project; older installs
# may not have CONTROL_STOP_SNAPSHOT_RETENTION_COUNT yet, so default in-script).
# shellcheck disable=SC1091
[ -f .control/config.sh ] && . .control/config.sh
RETENTION_COUNT="${CONTROL_STOP_SNAPSHOT_RETENTION_COUNT:-10}"

# Skip if STATE.md content unchanged since the most recent stop snapshot
# shellcheck disable=SC2012
newest=$(ls -t "$SNAP_DIR"/stop-*.md 2>/dev/null | head -n1 || true)
if [ -n "$newest" ] && cmp -s "$STATE_FILE" "$newest"; then
    exit 0
fi

TS=$(date -u +%Y%m%d-%H%M%S)
cp "$STATE_FILE" "$SNAP_DIR/stop-$TS.md"

# Append a marker line to the chronological event stream (parallel to PreCompact / SessionEnd)
printf '%s  stop  snapshot_id=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TS" >> "$SNAP_DIR/markers.log"

# Bucketed prune (independent budget from PreCompact / SessionEnd global pool)
bash .claude/hooks/prune-snapshots.sh stop "$RETENTION_COUNT" || true

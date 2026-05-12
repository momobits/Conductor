#!/usr/bin/env bash
# Control hook helper: prune old snapshots
# Two forms:
#   - Arg-less (PreCompact + SessionEnd): global-pool prune. Excludes
#     bucketed snapshot prefixes (e.g., stop-*.md) which have separate
#     retention budgets.
#   - Bucketed (Stop): prune-snapshots.sh <bucket-prefix> <count>
#     Keeps the N most-recent <bucket-prefix>-*.md files; ignores the
#     global pool.

set -euo pipefail

SNAP_DIR=".control/snapshots"
[ ! -d "$SNAP_DIR" ] && exit 0

# Bucketed form: prune-snapshots.sh <bucket-prefix> <count>
if [ "$#" -eq 2 ]; then
    BUCKET="$1"
    COUNT="$2"
    # shellcheck disable=SC2012
    over_bucket=$(ls -t "$SNAP_DIR"/"$BUCKET"-*.md 2>/dev/null | tail -n +$((COUNT + 1)) || true)
    if [ -n "$over_bucket" ]; then
        echo "$over_bucket" | while IFS= read -r f; do
            [ -n "$f" ] && rm -f "$f"
        done
    fi
    exit 0
fi

# Global-pool form (arg-less; existing PreCompact + SessionEnd callers)
# Load config (if present) so retention values come from .control/config.sh
# shellcheck disable=SC1091
[ -f .control/config.sh ] && . .control/config.sh

# Apply defaults for any unset values
RETENTION_COUNT="${CONTROL_SNAPSHOT_RETENTION_COUNT:-50}"
RETENTION_DAYS="${CONTROL_SNAPSHOT_RETENTION_DAYS:-14}"

# Delete snapshots older than RETENTION_DAYS (excludes bucketed prefixes -- they're pruned by count)
find "$SNAP_DIR" -type f -name '*.md' -not -name 'stop-*.md' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
find "$SNAP_DIR" -type f -name '*.flag' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

# Keep only the most recent RETENTION_COUNT timestamped snapshots
# (exclude current.md -- no dash; exclude bucketed stop-*.md -- pruned independently).
# Use a loop instead of xargs -r for portability.
# shellcheck disable=SC2012
over_retention=$(ls -t "$SNAP_DIR"/*-*.md 2>/dev/null | grep -v '/stop-[0-9]' | tail -n +$((RETENTION_COUNT + 1)) || true)
if [ -n "$over_retention" ]; then
    echo "$over_retention" | while IFS= read -r f; do
        [ -n "$f" ] && rm -f "$f"
    done
fi

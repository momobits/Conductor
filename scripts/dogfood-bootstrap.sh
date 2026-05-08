#!/usr/bin/env bash
# Bootstrap a fresh repo for autonomous Conductor dogfood.
# Idempotent: re-runnable to add missing pieces without clobbering state.
#
# Usage:
#   scripts/dogfood-bootstrap.sh [path-to-repo]
#
# Default path is the current directory.

set -euo pipefail

REPO="${1:-.}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="$HERE/../dist/cli/index.js"

if [ ! -f "$CLI" ]; then
  echo "Conductor CLI not built. Run \`npm run build\` first." >&2
  exit 1
fi

cd "$REPO"

if [ ! -d .conductor ]; then
  node "$CLI" init
fi

if [ ! -f .conductor/config.yaml ]; then
  cp "$HERE/../examples/minimal/.conductor/config.yaml" .conductor/config.yaml
  echo "wrote .conductor/config.yaml from examples/minimal"
fi

# Discover cards from existing TODO/FIXME comments (best-effort)
node "$CLI" discover || true

# Order them
node "$CLI" order || true

# Start the daemon (foreground)
node "$CLI" daemon start --port 7180 &
DAEMON_PID=$!

trap 'kill $DAEMON_PID 2>/dev/null || true' EXIT

# Wait for daemon endpoint to land
for _ in 1 2 3 4 5; do
  if [ -f .conductor/daemon.endpoint ]; then break; fi
  sleep 1
done

ENDPOINT="$(cat .conductor/daemon.endpoint 2>/dev/null || echo '?')"

cat <<EOF

Conductor dogfood ready. Open: $ENDPOINT/

Brain control: conductor brain start
Cost:          conductor cost show
Run logs:      conductor run list

Press Ctrl-C to stop the daemon.
EOF

wait $DAEMON_PID

#!/bin/bash
# Spawn a swarm session in the current shell.
#
# Usage:
#   ~/project/accordingly/swarm/spawn.sh coordinator-claude  # start the Claude coordinator session
#   ~/project/accordingly/swarm/spawn.sh coordinator-codex   # start the Codex coordinator session
#   ~/project/accordingly/swarm/spawn.sh accordingly-5            # task loop with fresh context per task

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
  coordinator-claude)
    cd "$SWARM_DIR/coordinator"
    exec claude
    ;;
  coordinator-codex)
    cd "$SWARM_DIR/coordinator"
    exec codex
    ;;
  "")
    echo "Usage: spawn.sh <coordinator-claude|coordinator-codex|accordingly-N>" >&2
    exit 1
    ;;
  *)
    exec "$SWARM_DIR/runner.sh" "$1"
    ;;
esac

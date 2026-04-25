#!/bin/bash
# Launch or attach to the queue-mode tmux swarm session.
#
# Queue mode: first pane is the Claude coordinator, the rest are runner.sh
# agent loops that pick tasks off swarm/queue/.
#
# Usage:
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh              # launch all accordingly-N worktrees found
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh 12           # launch accordingly-1 through accordingly-12 (create if needed)
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh 4-12         # launch accordingly-4 through accordingly-12
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh coordinator-claude  # open Claude coordinator in a new full-size window
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh coordinator-codex   # open Codex coordinator in a new full-size window
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh accordingly-3     # open one agent in a new full-size window
#   ~/project/accordingly/coordinator/swarm/tmux-queue.sh kill         # kill the swarm session
#
# Flags (can appear anywhere):
#   --iterm       force iTerm native pane/tab rendering (tmux -CC)
#   --no-iterm    force classic tmux rendering even inside iTerm

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SWARM_DIR/../.." && pwd)"
SESSION="swarm"
SPAWN="$SWARM_DIR/spawn.sh"

die() { echo "error: $*" >&2; exit 1; }
session_exists() { tmux has-session -t "$SESSION" 2>/dev/null; }

USE_CC=""
[[ "${TERM_PROGRAM:-}" == "iTerm.app" ]] && USE_CC=1

args=()
for a in "$@"; do
  case "$a" in
    --iterm)    USE_CC=1 ;;
    --no-iterm) USE_CC="" ;;
    *)          args+=("$a") ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

tmux_attach() { exec tmux ${USE_CC:+-CC} attach-session -t "$SESSION"; }

if [[ "${1:-}" == "kill" ]]; then
  session_exists && tmux kill-session -t "$SESSION" && echo "Killed session '$SESSION'." || echo "No session '$SESSION' running."
  exit 0
fi

arg="${1:-}"
range_start=""
range_end=""

if [[ "$arg" =~ ^([0-9]+)-([0-9]+)$ ]]; then
  range_start="${BASH_REMATCH[1]}"
  range_end="${BASH_REMATCH[2]}"
  [[ "$range_start" -le "$range_end" ]] || die "Invalid range: $arg"
elif [[ "$arg" =~ ^[0-9]+$ ]]; then
  range_start=1
  range_end="$arg"
fi

# Zoom: open one named pane in a dedicated window (coordinator-* or accordingly-N)
if [[ -n "$arg" && -z "$range_start" ]]; then
  name="$arg"
  session_exists || die "Session '$SESSION' not running. Launch it first with: tmux-queue.sh"
  tmux new-window -t "$SESSION" -n "$name" "$SPAWN $name"
  tmux select-window -t "$SESSION:$name"
  tmux_attach
fi

if session_exists; then
  echo "Session '$SESSION' already running — attaching."
  tmux_attach
fi

if [[ -n "$range_start" ]]; then
  agents=()
  for i in $(seq "$range_start" "$range_end"); do
    agents+=("accordingly-$i")
  done
else
  agents=()
  while IFS= read -r d; do
    agents+=("$(basename "$d")")
  done < <(find "$REPO_DIR" -maxdepth 1 -type d -name 'accordingly-[0-9]*' | sort -V)
fi

[[ ${#agents[@]} -gt 0 ]] || die "No existing worktrees found. Run 'tmux-queue.sh <count>' to create them (e.g. tmux-queue.sh 12)"

git -C "$REPO_DIR" fetch origin
git -C "$REPO_DIR" worktree prune 2>/dev/null || true
git -C "$REPO_DIR" config gc.auto 0 2>/dev/null || true

echo "Launching swarm queue session with coordinator + ${#agents[@]} agents..."

tmux new-session -d -s "$SESSION" -n "overview"

# First pane: coordinator
tmux send-keys -t "$SESSION:overview" "$SPAWN coordinator-claude" Enter
tmux select-pane -t "$SESSION:overview.0" -T "coordinator"

# Agent panes
for name in "${agents[@]}"; do
  tmux split-window -t "$SESSION:overview" "$SPAWN $name"
  tmux select-pane -t "$SESSION:overview" -T "$name"
  tmux select-layout -t "$SESSION:overview" tiled
done

tmux_attach

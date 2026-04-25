#!/bin/bash
# Launch or attach to the session-mode tmux swarm session.
#
# Session mode: every pane is identical — an interactive session.sh loop in
# its own accordingly-N worktree, with /claude ↔ /codex handoff and /done reset.
# No coordinator pane.
#
# Usage:
#   ~/project/accordingly/coordinator/swarm/tmux-session.sh              # launch all accordingly-N worktrees found
#   ~/project/accordingly/coordinator/swarm/tmux-session.sh 4            # launch accordingly-1 through accordingly-4 (create if needed)
#   ~/project/accordingly/coordinator/swarm/tmux-session.sh 4-12         # launch accordingly-4 through accordingly-12
#   ~/project/accordingly/coordinator/swarm/tmux-session.sh accordingly-3     # open one agent in a new full-size window
#   ~/project/accordingly/coordinator/swarm/tmux-session.sh kill         # kill the swarm session
#
# Flags (can appear anywhere):
#   --iterm       force iTerm native pane/tab rendering (tmux -CC)
#   --no-iterm    force classic tmux rendering even inside iTerm

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SWARM_DIR/../.." && pwd)"
SESSION="swarm"
SESSION_SH="$SWARM_DIR/session.sh"

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

# Zoom: open one named agent in a dedicated window. No coordinator concept.
if [[ -n "$arg" && -z "$range_start" ]]; then
  name="$arg"
  [[ "$name" == coordinator-* ]] && die "session mode has no coordinator — use accordingly-N or tmux-queue.sh"
  session_exists || die "Session '$SESSION' not running. Launch it first with: tmux-session.sh"
  tmux new-window -t "$SESSION" -n "$name" "$SESSION_SH $name"
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

[[ ${#agents[@]} -gt 0 ]] || die "No existing worktrees found. Run 'tmux-session.sh <count>' to create them (e.g. tmux-session.sh 4)"

git -C "$REPO_DIR" fetch origin
git -C "$REPO_DIR" worktree prune 2>/dev/null || true
git -C "$REPO_DIR" config gc.auto 0 2>/dev/null || true

echo "Launching swarm session with ${#agents[@]} agents..."

tmux new-session -d -s "$SESSION" -n "overview"

# First pane: first agent
first="${agents[0]}"
rest=("${agents[@]:1}")
tmux send-keys -t "$SESSION:overview" "$SESSION_SH $first" Enter
tmux select-pane -t "$SESSION:overview.0" -T "$first"

# Agent panes
for name in "${rest[@]+"${rest[@]}"}"; do
  tmux split-window -t "$SESSION:overview" "$SESSION_SH $name"
  tmux select-pane -t "$SESSION:overview" -T "$name"
  tmux select-layout -t "$SESSION:overview" tiled
done

tmux_attach

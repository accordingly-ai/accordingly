#!/bin/bash
# Launch or manage a swarm session using AeroSpace tiling window manager.
#
# Each agent runs in its own Terminal.app window, tiled automatically
# by AeroSpace in a dedicated workspace.
#
# Usage:
#   ~/project/accordingly/swarm/aerospace.sh              # launch all accordingly-N worktrees found
#   ~/project/accordingly/swarm/aerospace.sh 12           # launch accordingly-1 through accordingly-12 (create if needed)
#   ~/project/accordingly/swarm/aerospace.sh 4-12         # launch accordingly-4 through accordingly-12
#   ~/project/accordingly/swarm/aerospace.sh accordingly-3     # open one agent in a new window (current workspace)
#   ~/project/accordingly/swarm/aerospace.sh coordinator-claude  # open Claude coordinator in a new window
#   ~/project/accordingly/swarm/aerospace.sh coordinator-codex   # open Codex coordinator in a new window
#   ~/project/accordingly/swarm/aerospace.sh kill         # close all windows in the swarm workspace

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SWARM_DIR/../.." && pwd)"
WORKTREE_DIR="$REPO_DIR"
WORKSPACE="${SWARM_WORKSPACE:-S}"
SPAWN="$SWARM_DIR/spawn.sh"

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

check_aerospace() {
  aerospace list-workspaces --all >/dev/null 2>&1 \
    || die "AeroSpace is not running. Start AeroSpace.app first."
}

# Open a new Terminal.app window running a command.
# The window lands in whichever AeroSpace workspace is currently focused.
open_terminal() {
  local title="$1"
  local cmd="$2"
  osascript <<EOF
tell application "Terminal"
  activate
  do script "printf '\\\\033]0;${title}\\\\007'; ${cmd}"
end tell
EOF
  sleep 0.4
}

# ── kill ─────────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "kill" ]]; then
  check_aerospace
  count=0
  while IFS= read -r wid; do
    [[ -n "$wid" ]] || continue
    aerospace close --window-id "$wid" 2>/dev/null && ((count++)) || true
  done < <(aerospace list-windows --workspace "$WORKSPACE" --format '%{window-id}')
  echo "Closed $count window(s) in workspace '$WORKSPACE'."
  exit 0
fi

# ── parse argument: range, count, agent name, or nothing ─────────────────────

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

# ── zoom: open one named agent in the current workspace ─────────────────────

if [[ -n "$arg" && -z "$range_start" ]]; then
  check_aerospace
  open_terminal "$arg" "$SPAWN $arg"
  echo "Opened '$arg' in the current workspace."
  exit 0
fi

# ── check for existing windows in the workspace ─────────────────────────────

check_aerospace

existing=$(aerospace list-windows --workspace "$WORKSPACE" --count 2>/dev/null || echo "0")
if [[ "$existing" -gt 0 ]]; then
  echo "Workspace '$WORKSPACE' already has $existing window(s)."
  echo "Run 'aerospace.sh kill' first, or switch to workspace '$WORKSPACE'."
  aerospace workspace "$WORKSPACE"
  exit 0
fi

# ── build agent list ──────────────────────────────────────────────────────────

if [[ -n "$range_start" ]]; then
  agents=()
  for i in $(seq "$range_start" "$range_end"); do
    agents+=("accordingly-$i")
  done
else
  mapfile -t agents < <(
    find "$WORKTREE_DIR" -maxdepth 1 -type d -name 'accordingly-[0-9]*' \
      | sort -V \
      | xargs -I{} basename {}
  )
fi

[[ ${#agents[@]} -gt 0 ]] || die "No existing worktrees found. Run 'aerospace.sh <count>' to create them (e.g. aerospace.sh 12)"

# One-time setup: fetch, prune stale worktrees, disable auto-gc
git -C "$REPO_DIR" fetch origin
git -C "$REPO_DIR" worktree prune 2>/dev/null || true
git -C "$REPO_DIR" config gc.auto 0 2>/dev/null || true

echo "Launching swarm in AeroSpace workspace '$WORKSPACE' with ${#agents[@]} agents..."

# ── focus swarm workspace so new windows land here ───────────────────────────

aerospace workspace "$WORKSPACE"

# ── coordinator ──────────────────────────────────────────────────────────────

open_terminal "coordinator" "$SPAWN coordinator-claude"

# ── agent windows ────────────────────────────────────────────────────────────

for name in "${agents[@]}"; do
  open_terminal "$name" "$SPAWN $name"
done

# ── balance the tiled layout ─────────────────────────────────────────────────

aerospace balance-sizes

echo "Swarm launched in workspace '$WORKSPACE' (${#agents[@]} agents + coordinator)."
echo "  Switch:  aerospace workspace $WORKSPACE"
echo "  Kill:    $0 kill"

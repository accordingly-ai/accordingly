#!/usr/bin/env bash
# dispatcher.sh — move unblocked tasks from staging/ → pending/
#
# A task is unblocked when all its depends_on IDs appear in done/.
# Runs once by default; use --watch [SECS] to poll continuously.
#
# Usage:
#   ./dispatcher.sh               # run once (called from runner.sh on task completion)
#   ./dispatcher.sh --watch       # poll every 15s (run in a spare tmux pane)
#   ./dispatcher.sh --watch 30    # poll every 30s

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
QUEUE="$SWARM_DIR/queue"

mkdir -p "$QUEUE/staging" "$QUEUE/pending" "$QUEUE/done"

# Extract numeric IDs from the depends_on frontmatter field.
# Handles: depends_on: []  depends_on: [006]  depends_on: [003, 006]
_parse_deps() {
  awk '
    NR==1 && /^---$/ { in_fm=1; next }
    in_fm && /^---$/ { exit }
    in_fm && /^depends_on:/ { print }
  ' "$1" | grep -oE '[0-9]+' || true
}

# Decimal IDs of all tasks present in done/, one per line.
_completed_ids() {
  shopt -s nullglob
  for f in "$QUEUE/done"/[0-9]*.md; do
    name=$(basename "$f")
    num="${name%%[^0-9]*}"
    [[ -n "$num" ]] && printf '%d\n' "$((10#$num))"
  done | sort -n
  shopt -u nullglob
}

_dispatch_once() {
  shopt -s nullglob
  local files=("$QUEUE/staging"/*.md)
  shopt -u nullglob

  local moved=0 completed
  completed=$(_completed_ids)

  for file in "${files[@]}"; do
    local name deps satisfied dep dep_dec
    name=$(basename "$file")
    deps=$(_parse_deps "$file")

    if [[ -z "$deps" ]]; then
      echo "[dispatcher] releasing $name (no deps)"
      mv "$file" "$QUEUE/pending/$name"
      (( moved++ )) || true
      continue
    fi

    satisfied=true
    for dep in $deps; do
      dep_dec=$(( 10#$dep ))
      if ! echo "$completed" | grep -qx "$dep_dec"; then
        satisfied=false
        echo "[dispatcher] blocked: $name (waiting on $dep_dec)"
        break
      fi
    done

    if $satisfied; then
      echo "[dispatcher] releasing $name"
      mv "$file" "$QUEUE/pending/$name"
      (( moved++ )) || true
    fi
  done

  [[ $moved -gt 0 ]] && echo "[dispatcher] moved $moved task(s) to pending/"
  return 0
}

case "${1:-}" in
  --watch)
    interval="${2:-15}"
    echo "[dispatcher] polling every ${interval}s — Ctrl-C to stop"
    while true; do
      _dispatch_once
      sleep "$interval"
    done
    ;;
  *)
    _dispatch_once
    ;;
esac

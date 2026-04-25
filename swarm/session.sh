#!/bin/bash
# Interactive swarm session with CLI handoff (claude ↔ codex) and worktree reset.
#
# Usage:
#   ~/project/accordingly/coordinator/swarm/session.sh <agent-dir> [claude|codex]
#
# Side-channel tombstones (at the worktree root):
#   .done    — kill signal. Written by every handoff/reset skill.
#   .handoff — switch CLI, keep worktree. Written by /claude and /codex skills.
#   .reset   — rebuild worktree from origin/main, then relaunch CLI. Written by /done.
#
# The body of .handoff / .reset is passed verbatim as the relaunched CLI's
# opening prompt. On first launch the CLI starts with no prompt.
#
# A clean CLI exit (Ctrl+D / /exit) without .done ends the loop.

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SWARM_DIR/../.." && pwd)"
COORDINATOR_DIR="$SWARM_DIR/.."

name="${1:?Usage: session.sh <agent-dir> [claude|codex]}"
initial_agent="${2:-claude}"
dir="$REPO_DIR/$name"
tombstone="$dir/.done"
handoff="$dir/.handoff"
reset_file="$dir/.reset"
GIT_LOCK="$REPO_DIR/.git/swarm-lock"

# ── helpers ──────────────────────────────────────────────────────────────────

validate_agent() {
  case "$1" in
    claude|codex) return 0 ;;
    *) echo "error: agent must be 'claude' or 'codex' (got '$1') [$2]" >&2; return 1 ;;
  esac
}

validate_agent "$initial_agent" "argv" || exit 1

acquire_git_lock() {
  if [[ -d "$GIT_LOCK" ]]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$GIT_LOCK") ))
    (( lock_age > 120 )) && rmdir "$GIT_LOCK" 2>/dev/null || true
  fi
  while ! mkdir "$GIT_LOCK" 2>/dev/null; do sleep 1; done
}

release_git_lock() { rmdir "$GIT_LOCK" 2>/dev/null || true; }

# Frontmatter parsers: .handoff / .reset use `key: value` lines until a `---`
# separator, then free-form body.
fm_field() {
  awk -v k="$2" '/^---$/{exit} $0 ~ "^"k":[[:space:]]*" { sub("^"k":[[:space:]]*",""); print; exit }' "$1"
}
fm_body() { awk 'body; /^---$/{body=1}' "$1"; }

# Per-worktree setup: copy .worktreeinclude files. Safe to call repeatedly.
apply_worktree_setup() {
  if [[ -f "$dir/.worktreeinclude" ]]; then
    while IFS= read -r pattern; do
      [[ -z "$pattern" || "$pattern" == \#* ]] && continue
      for src in $COORDINATOR_DIR/$pattern; do
        [[ -f "$src" ]] || continue
        rel="${src#"$COORDINATOR_DIR"/}"
        mkdir -p "$(dirname "$dir/$rel")"
        cp "$src" "$dir/$rel"
      done
    done < "$dir/.worktreeinclude"
  fi
}

# Full reset: mirrors runner.sh's per-task worktree rebuild. Stash node_modules
# to avoid re-hardlinking ~900 packages, remove + re-add at origin/main,
# restore, re-run setup, reinstall deps.
reset_worktree() {
  echo "[$name] resetting worktree to origin/main..."
  acquire_git_lock
  git -C "$REPO_DIR" fetch origin 2>/dev/null || true
  nm_stash="$REPO_DIR/.git/wt-nm-$name"
  [[ -d "$dir/node_modules" ]] && mv "$dir/node_modules" "$nm_stash" || true
  git -C "$REPO_DIR" worktree remove "$dir" --force 2>/dev/null || rm -rf "$dir"
  git -C "$REPO_DIR" worktree add --detach "$dir" origin/main
  [[ -d "$nm_stash" ]] && mv "$nm_stash" "$dir/node_modules" || true
  release_git_lock

  cd "$dir"  # worktree remove invalidated cwd
  apply_worktree_setup
  pnpm install --frozen-lockfile || true
}

AGENT_LOG="/tmp/swarm-$name-agent.log"

launch_agent() {
  local agent="$1" prompt="$2"
  : > "$AGENT_LOG"
  case "$agent" in
    claude)
      local args=(--effort high --permission-mode plan)
      [[ -n "$prompt" ]] && args+=("$prompt")
      claude "${args[@]}" 2> "$AGENT_LOG"
      ;;
    codex)
      local args=(
        --cd "$dir"
        --sandbox workspace-write
        --ask-for-approval on-request
        --model "${CODEX_MODEL:-gpt-5.4}"
        -c model_reasoning_effort="high"
        --add-dir "$REPO_DIR/.git"
        --add-dir "/tmp"
        --add-dir "/private/tmp"
        --add-dir "$HOME/.cache"
        --add-dir "$HOME/.android/avd"
      )
      [[ -n "$prompt" ]] && args+=("$prompt")
      codex "${args[@]}" 2> "$AGENT_LOG"
      ;;
  esac
}

# ── Bootstrap worktree (fresh origin/main on every session start) ────────────

reset_worktree

GH_TOKEN=$(gh auth token 2>/dev/null || echo "")
export GH_TOKEN

tmux select-pane -t "${TMUX_PANE:-}" -T "$name" 2>/dev/null || true
tmux set-option -p -t "${TMUX_PANE:-}" allow-set-title off 2>/dev/null || true

# Clean any stale side-channel files from a prior crash
rm -f "$tombstone" "$handoff" "$reset_file"

echo "=== $name interactive session — starting $initial_agent ==="

# ── Session loop ─────────────────────────────────────────────────────────────

next_agent="$initial_agent"
next_prompt=""

while true; do
  if [[ -f "$reset_file" ]]; then
    rs_agent=$(fm_field "$reset_file" agent)
    rs_body=$(fm_body "$reset_file")
    rm -f "$reset_file"

    [[ -z "$rs_agent" ]] && rs_agent="$next_agent"
    validate_agent "$rs_agent" ".reset" || break

    next_agent="$rs_agent"
    reset_worktree
    next_prompt="$rs_body"
  elif [[ -f "$handoff" ]]; then
    ho_agent=$(fm_field "$handoff" agent)
    ho_plan=$(fm_field "$handoff" plan)
    ho_body=$(fm_body "$handoff")
    rm -f "$handoff"

    validate_agent "$ho_agent" ".handoff" || break

    next_agent="$ho_agent"
    next_prompt="$ho_body${ho_plan:+ (plan: $ho_plan)}"
  fi

  rm -f "$tombstone"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [$(date +%H:%M:%S)] $name — launching $next_agent"
  echo "  Exit the CLI (Ctrl+D / /exit) to drop to a shell in the worktree."
  echo "  Close the pane to end the session."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Watcher kills the foreground CLI by comm name when the tombstone appears.
  # claude has comm=claude; codex is a node wrapper so comm=node. Match either
  # — the watcher subshell itself is comm=bash, so it can't self-kill.
  (
    while [[ ! -f "$tombstone" ]]; do sleep 2; done
    pkill -TERM -P $$ -x claude 2>/dev/null || true
    pkill -TERM -P $$ -x node 2>/dev/null || true
    sleep 2
    pkill -KILL -P $$ -x claude 2>/dev/null || true
    pkill -KILL -P $$ -x node 2>/dev/null || true
  ) &
  watcher_pid=$!

  agent_rc=0
  launch_agent "$next_agent" "$next_prompt" || agent_rc=$?
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true

  reset

  if [[ -f "$tombstone" ]]; then
    # /claude, /codex, or /done was invoked — let .handoff/.reset drive next iter.
    rm -f "$tombstone"
    next_prompt=""
    continue
  fi

  # CLI exited without a tombstone. If it crashed (non-zero) or exited within
  # a couple seconds, surface stderr — otherwise the user just /exit'd cleanly.
  if (( agent_rc != 0 )) && [[ -s "$AGENT_LOG" ]]; then
    echo ""
    echo "[$(date +%H:%M:%S)] $name — $next_agent exited rc=$agent_rc. stderr:"
    echo "────────────────────────────────────────────────────────────"
    cat "$AGENT_LOG"
    echo "────────────────────────────────────────────────────────────"
  fi

  echo ""
  echo "[$(date +%H:%M:%S)] $name — shell in $dir. Ctrl+D to relaunch $next_agent."
  cd "$dir"
  "${SHELL:-/bin/bash}" -i || true
  next_prompt=""
done

rm -f "$handoff" "$tombstone" "$reset_file"

tmux select-pane -t "${TMUX_PANE:-}" -T "$name" 2>/dev/null || true
echo "[$name] session loop ended"

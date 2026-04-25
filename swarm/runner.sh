#!/bin/bash
# Continuously pick up tasks from the queue, running each in a fresh interactive agent session.
#
# Usage:
#   ~/project/accordingly/coordinator/swarm/runner.sh <agent-dir>
#   ~/project/accordingly/coordinator/swarm/runner.sh accordingly-1
#
# Each task gets a clean context window. The session ends when the agent exits
# (or is exited manually). Polls every 30s when the queue is empty.

set -euo pipefail

SWARM_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SWARM_DIR/../.." && pwd)"
WORKTREE_DIR="$REPO_DIR"
QUEUE="$SWARM_DIR/queue"
INSTRUCTIONS="$SWARM_DIR/agent-instructions.md"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

name="${1:?Usage: runner.sh <agent-dir>}"
dir="$WORKTREE_DIR/$name"
tombstone="$dir/.done"
GIT_LOCK="$REPO_DIR/.git/swarm-lock"

acquire_git_lock() {
  # Break stale locks older than 120s (crashed agent)
  if [[ -d "$GIT_LOCK" ]]; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$GIT_LOCK") ))
    if (( lock_age > 120 )); then
      echo "  breaking stale git lock (${lock_age}s old)"
      rmdir "$GIT_LOCK" 2>/dev/null || true
    fi
  fi

  while ! mkdir "$GIT_LOCK" 2>/dev/null; do
    sleep 1
  done
}

release_git_lock() {
  rmdir "$GIT_LOCK" 2>/dev/null || true
}

frontmatter_value() {
  local file="$1"
  local key="$2"

  awk -v key="$key" '
    NR == 1 {
      if ($0 != "---") {
        exit
      }
      in_frontmatter = 1
      next
    }
    in_frontmatter && $0 == "---" {
      exit
    }
    in_frontmatter && $0 ~ ("^" key ":[[:space:]]*") {
      sub("^" key ":[[:space:]]*", "", $0)
      gsub(/^["'"'"']|["'"'"']$/, "", $0)
      print $0
      exit
    }
  ' "$file"
}

mkdir -p "$QUEUE/pending" "$QUEUE/in-progress" "$QUEUE/done" "$QUEUE/staging"
echo "=== $name runner started — polling $QUEUE/pending/ ==="

while true; do
  # Grab the lowest-numbered pending task
  task=$(find "$QUEUE/pending/" -maxdepth 1 -type f -exec basename {} \; 2>/dev/null | sort | head -1)

  if [[ -z "$task" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  # Claim it
  if ! mv "$QUEUE/pending/$task" "$QUEUE/in-progress/$task" 2>/dev/null; then
    # Another agent grabbed it first
    continue
  fi

  # Show task id/title in the tmux pane title and prevent the agent from overwriting it
  task_label="${task%.md}"
  tmux select-pane -t "$TMUX_PANE" -T "$name: $task_label" 2>/dev/null || true
  tmux set-option -p -t "$TMUX_PANE" allow-set-title off 2>/dev/null || true

  task_path="$QUEUE/in-progress/$task"
  agent="$(frontmatter_value "$task_path" "agent")"
  model="$(frontmatter_value "$task_path" "model")"

  if [[ -z "$agent" ]]; then
    agent="claude"
  fi

  case "$agent" in
    claude)
      if [[ -z "$model" ]]; then
        model="sonnet"
      fi
      ;;
    codex)
      if [[ -z "$model" ]]; then
        model="gpt-5.4"
      fi
      ;;
    *)
      echo "  unsupported agent '$agent' in $task"
      mv "$task_path" "$QUEUE/done/$task" 2>/dev/null || true
      cat >> "$QUEUE/done/$task" <<EOF

---
## Agent Status
- **Result:** no-op
- **Branch:** n/a
- **PR:** n/a
- **Issue:** n/a
- **Changed:** none
- **Notes:** Unsupported agent '$agent' in task frontmatter.
EOF
      tmux set-option -p -t "$TMUX_PANE" allow-set-title off 2>/dev/null || true
      tmux select-pane -t "$TMUX_PANE" -T "$name" 2>/dev/null || true
      sleep 2
      continue
      ;;
  esac

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  [$(date +%H:%M:%S)] $name claimed: $task"
  echo "  Agent: $agent ($model)"
  echo "  Session ends automatically when done, or exit the session"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Reset worktree to a clean state at latest origin/main
  # Serialize git operations — all agents share one .git and contend on locks
  acquire_git_lock

  git -C "$REPO_DIR" fetch origin 2>/dev/null || true
  # Preserve node_modules across worktree reset to avoid re-hardlinking ~900 packages
  nm_stash="$REPO_DIR/.git/wt-nm-$name"
  [[ -d "$dir/node_modules" ]] && mv "$dir/node_modules" "$nm_stash" || true
  git -C "$REPO_DIR" worktree remove "$dir" --force 2>/dev/null || rm -rf "$dir"
  worktree_ok=true
  if ! git -C "$REPO_DIR" worktree add --detach "$dir" origin/main; then
    worktree_ok=false
  fi
  [[ -d "$nm_stash" ]] && mv "$nm_stash" "$dir/node_modules" || true

  release_git_lock

  if [[ "$worktree_ok" != "true" ]]; then
    echo "  worktree add failed — returning task to pending"
    mv "$QUEUE/in-progress/$task" "$QUEUE/pending/$task" 2>/dev/null || true
    sleep 10
    continue
  fi
  cd "$dir"

  # Copy gitignored files listed in .worktreeinclude
  # Source from the coordinator worktree (where the operator maintains credentials)
  coordinator_dir="$SWARM_DIR/.."
  if [[ -f "$dir/.worktreeinclude" ]]; then
    while IFS= read -r pattern; do
      [[ -z "$pattern" || "$pattern" == \#* ]] && continue
      for src in $coordinator_dir/$pattern; do
        [[ -f "$src" ]] || continue
        rel="${src#"$coordinator_dir"/}"
        mkdir -p "$(dirname "$dir/$rel")"
        cp "$src" "$dir/$rel"
      done
    done < "$dir/.worktreeinclude"
  fi

  # Bootstrap agent settings from the default template
  if [[ -f "$dir/.claude/settings.default.json" ]]; then
    cp "$dir/.claude/settings.default.json" "$dir/.claude/settings.json"
  fi

  pnpm install --frozen-lockfile || true

  # Override Claude's auto-memory directory to the agent's own swarm/memory pool.
  # All worktrees share one git common dir, so Claude Code would otherwise map every
  # session to the same project key and write memories to the coordinator's directory.
  # autoMemoryDirectory in settings.local.json overrides that per-session.
  AGENT_MEMORY="$dir/swarm/memory"
  python3 -c "
import json, sys
path = '$dir/.claude/settings.local.json'
try:
    with open(path) as f:
        s = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    s = {}
s['autoMemoryDirectory'] = '$AGENT_MEMORY'
with open(path, 'w') as f:
    json.dump(s, f, indent=2)
    f.write('\n')
"

  # Write breadcrumb so the agent can re-orient after context clears
  echo "$QUEUE/in-progress/$task" > .current-task

  # Clean up any stale tombstone from a previous run
  rm -f "$tombstone"

  GH_TOKEN=$(gh auth token)
  export GH_TOKEN

  prompt="Read $INSTRUCTIONS, then read .current-task to find and execute your assigned task."

  case "$agent" in
    claude)
      claude --model "$model" --effort high --permission-mode plan \
          "$prompt" \
          --add-dir "$QUEUE/in-progress" \
          --add-dir "$QUEUE/done" &
      agent_pid=$!

      # Watcher: kill agent when tombstone appears, letting the runner loop continue
      (
        while [[ ! -f "$tombstone" ]]; do sleep 2; done
        rm -f "$tombstone"
        kill "$agent_pid" 2>/dev/null || true
      ) &
      watcher_pid=$!

      wait "$agent_pid" || true
      ;;
    codex)
      codex --cd "$dir" \
          --sandbox workspace-write \
          --ask-for-approval on-request \
          --model "$model" \
          -c model_reasoning_effort="high" \
          --add-dir "$REPO_DIR/.git" \
          --add-dir "/tmp" \
          --add-dir "/private/tmp" \
          --add-dir "$HOME/.cache" \
          --add-dir "$QUEUE" \
          --add-dir "$HOME/.android/avd" \
          "$prompt" < /dev/tty &
      agent_pid=$!

      # Watcher: kill agent when tombstone appears, letting the runner loop continue
      (
        while [[ ! -f "$tombstone" ]]; do sleep 2; done
        rm -f "$tombstone"
        kill "$agent_pid" 2>/dev/null || true
      ) &
      watcher_pid=$!

      wait "$agent_pid" || true
      ;;
  esac

  # Restore terminal state — agent processes can leave terminal in raw mode
  reset

  # Clean up watcher
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
  rm -f "$tombstone"

  # Move task to done (unless the agent already moved it)
  if [[ -f "$QUEUE/in-progress/$task" ]]; then
    mv "$QUEUE/in-progress/$task" "$QUEUE/done/$task"
  fi

  # Unblock any staged tasks that depend on the completed task
  "$SWARM_DIR/dispatcher.sh" 2>/dev/null || true

  echo "[$(date +%H:%M:%S)] session ended for $task"

  # Force the worktree back to a neutral state so no branch remains checked out.
  acquire_git_lock
  git -C "$dir" reset --hard >/dev/null 2>&1 || true
  git -C "$dir" clean -fd >/dev/null 2>&1 || true
  git -C "$dir" switch --detach >/dev/null 2>&1 || true
  release_git_lock

  # Reset pane title to just the agent name
  tmux set-option -p -t "$TMUX_PANE" allow-set-title off 2>/dev/null || true
  tmux select-pane -t "$TMUX_PANE" -T "$name" 2>/dev/null || true

  # Clear pane screen and scrollback — completed task output is noise
  clear && tmux clear-history
  echo "  $name idle — waiting for next task"
done

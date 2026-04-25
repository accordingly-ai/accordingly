---
name: done
description: Reset the interactive-session worktree back to a clean origin/main checkout and relaunch the current CLI. Use when a piece of work is finished and you want a fresh setup for the next task. Typically invoked at the end of /ship.
---

# /done — Reset Worktree

Arguments: $ARGUMENTS (optional — opening prompt after reset; leave blank if there's nothing to say)

Interactive-session only. In queue-mode runs (`.current-task` exists), `.done` means "task complete" — do not invoke this skill.

The session loop fetches origin, removes and re-adds the worktree at `origin/main` (preserving `node_modules`), re-applies `.worktreeinclude`, bootstraps settings, and runs `pnpm install --frozen-lockfile`. Same procedure as the swarm runner's per-task reset.

## Steps

1. **Write `.reset`** at the worktree root. Quoted HEREDOC so `$` in the message is literal:

   ```bash
   cat > .reset <<'RESET'
   agent:
   ---
   <$ARGUMENTS verbatim, or blank>
   RESET
   ```

   Leave `agent:` blank to keep the current CLI; set `agent: claude` or `agent: codex` to switch on reset.

2. `touch .done`

Say "Resetting worktree." and stop — this CLI is about to be terminated.

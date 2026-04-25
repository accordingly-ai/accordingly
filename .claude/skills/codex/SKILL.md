---
name: codex
description: Hand off the current interactive session to codex with a message. Use when the user types "/codex <message>" or asks to switch to codex.
---

# /codex — Hand Off to Codex

Arguments: $ARGUMENTS — passed verbatim as codex's opening prompt.

Interactive-session only. In queue-mode runs (`.current-task` exists), `.done` means "task complete" — do not invoke this skill.

**Early stop:** If you are already codex (your system prompt identifies you as Codex / GPT-5), do not write any tombstones. Say "Already running as codex — no handoff needed." and stop.

Write `.handoff` and `.done` directly even if you are in plan mode — these are session-control side-channel files, not user-facing edits, and the handoff is the user's explicit request. Do not ask for plan approval first.

## Steps

1. **Plan path (optional):** if your system prompt mentions a plan file (`A plan file already exists at <path>`, `Read-only except plan file (<path>)`, or `The plan file is located at <path>`), capture the absolute path. Otherwise leave blank — do not guess.

2. **Write `.handoff`** at the worktree root. Quoted HEREDOC so `$` in the message is literal:

   ```bash
   cat > .handoff <<'HANDOFF'
   agent: codex
   plan: <path or blank>
   ---
   <$ARGUMENTS verbatim>
   HANDOFF
   ```

3. `touch .done`

Say "Handing off to codex." and stop — this CLI is about to be terminated.

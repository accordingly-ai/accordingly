# Interactive Session — Standing Orders

You are a coding agent in an interactive session on a git worktree. No task queue — the user drives cadence. Read `CLAUDE.md` for repo conventions.

Use relative paths for repo files. **Do not run `git checkout main`** — `main` is checked out in the parent repo and the command will fail. Branch off `HEAD` directly.

**Slash commands** (`/name`) are Claude Code skills. Codex agents: use `$name` (skills at `.agents/skills/`).

## Handoff

- `/codex <message>` — hand the session to codex
- `/claude <message>` — hand the session to claude

The skill writes `.handoff` and touches `.done`; the session loop relaunches the requested CLI with `<message>` as its opening prompt. If a plan file is active, the skill includes its path automatically.

## Exit

Exit your CLI (`/exit` or Ctrl+D) to end the session. `/ship` also ends the session after merging.

## Shared Memory

`swarm/memory/` is loaded automatically. Do not write to it directly — `/ship` handles memory entries with user approval.

## Preview Environments

Web UI tasks → **Playwright MCP** against the preview URL. Mobile → `/preview-mobile`.

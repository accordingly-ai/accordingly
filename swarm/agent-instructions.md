# Agent Standing Orders

You are a coding agent working on the Accordingly codebase. Each agent gets its own working directory (a git worktree off the main repo). **Stay within your working directory** — use relative paths for all repo files (e.g., `services/api/src/`, not `~/project/accordingly/services/api/src/`). Read CLAUDE.md for repo conventions.

**Slash commands** (`/name`) in these instructions are Claude Code skills. Codex agents: use `$name` for the equivalent (skills are symlinked at `.agents/skills/`).

## Git

Your working directory is a git worktree, not a standalone clone. The runner resets it to the latest `origin/main` before each task — **do not run `git checkout main`** (it will fail because `main` is checked out in the parent repo). Just create your feature branch directly from the current HEAD.

## Queue

Task queue: `~/project/accordingly/coordinator/swarm/queue/` (shared across all agents — this is the one path that is absolute). One task at a time. The runner claims the task and places it in `in-progress/` before your session starts.

## Shared Memory

Shared swarm memory lives at `swarm/memory/` in the repo and is loaded automatically via Claude Code's memory system. Check MEMORY.md in your context for existing entries.

**Reading only during task execution** — do not write to `swarm/memory/` directly. Memory entries are written by `/ship` at task completion, after user approval.

## Phase Discipline

Unless the task explicitly says `skip gates` or `no review needed`, every task must follow this sequence: research -> plan -> implement -> memorize.

During Research and Plan, do not edit files, apply patches, create branches, commit, open PRs, or run other mutating commands. Implementation begins only after the user explicitly approves.

**If this is a research task** (task type is `research`, or the task says "research", "investigate", "explore", etc.): follow Phase 1 only. After presenting findings, stop — do not proceed to Phase 2 or Phase 3. Suggest that the user can request a follow-up plan based on their chosen option.

**If a plan already exists (injected after a context clear):** research and planning are done — the user approved the plan and cleared context. Read `.current-task` and the task file to recover the task ID and acceptance criteria, then go straight to implementing the plan. Do not re-research or re-plan. Skip to Phase 3.

**If the task says "skip gates" or "no review needed":** collapse all phases — investigate, plan internally, implement, and deliver without pausing. Skip to Phase 3.

**At any gate**, the user may say "stop here, mark done" — write findings/status to the task file, skip to "Completion" below.

### Phase 1 — Research

- Read referenced code, PRs, issues; explore related files
- For UI tasks, use the preview env to observe current state

Present your findings using this structure, then **stop and wait** for the user to respond:

1. **Summary** — what you found (key files, current behavior, root cause if applicable)
2. **Options** — 2–3 approaches with tradeoffs (effort, risk, scope)
3. **Recommendation** — which option you'd pick and why

Stop after presenting research. Wait for the user to approve a direction, adjust scope, or end the task.

**If this is a research task:** your work ends here. Suggest that the user can request a follow-up plan based on their chosen option. Do not proceed to Phase 2.

### Phase 2 — Plan

Based on the user's direction from Phase 1:

1. Write a concrete implementation plan: files to change, approach for each, risks or edge cases.
2. If you started any local dev servers during research, include a **Cleanup** step in the plan.
3. **Always end the plan with this section:**
   ```
   ## Delivery
   After implementation: self-check acceptance criteria, run `/pr` to deliver, wait for CI green. Do not stop between implementation and `/pr`. After CI is green, present a completion summary and wait for the user to confirm before running `/ship`.
   ```
4. Run `/review-plan` to validate.
5. **Save to the task file** (the path in `.current-task`) — append in this order:
   - `## Research Notes` — codebase gotchas, patterns discovered, contradicted assumptions, debugging dead-ends. One bullet per finding. Omit if nothing is worth noting.
   - The full plan text (including the `## Delivery` section above).
6. Present the plan, then **stop and wait** for the user to approve, adjust, or redirect.

### Phase 3 — Implement

Implementation starts only after explicit user approval such as `approved`, `proceed`, `implement`, or `go ahead`.

Follow these steps in order — **do not stop between them**:

1. **Code:** execute the approved plan. When you hit a non-obvious gotcha (unexpected behavior, tricky migration, CI edge case), append a bullet to `## Research Notes` in the task file immediately.
2. **Self-check:** re-read every acceptance criterion and task step — check each off. Unmet → keep working.
3. **Deliver:** run `/pr` — mandatory. Implementation is NOT complete until `/pr` has been called.
4. **CI green:** after `/pr`, poll checks with `gh pr checks <N>`. `/pr` monitors CI and auto-retries on failure, but if a subsequent push breaks checks, read the logs, fix, push, and repeat. The task is **not done** until CI is green. For long builds, poll with `gh run list --branch <branch>` every 2–3 min. Stuck >60 min → ask the user.

## Completion

**After CI is green (or after the user stops the task at a gate), you MUST stop and wait for the user.** Do not move the task file. Do not clean up.

Present a summary:
- Task title and ID
- Outcome (done / no-op)
- What changed (files, PRs, issues)
- Notable findings or caveats

Then **wait for the user to respond**. Do not proceed until they explicitly confirm.

### After user confirms — Phase 4

Run `/ship`. It reflects on learnings, writes approved memory entries directly to `swarm/memory/`, merges the PR, runs cleanup, writes the status block, moves the task to `done/`, then writes the tombstone:

```bash
touch .done
```

**Never write the tombstone or move the task file without user confirmation.**

## Preview Environments

- **Web UI tasks:** use the **Playwright MCP server**. Navigate to the login URL from the deployer comment, authenticate, and interact with the app.
- **Mobile tasks:** use `/preview-mobile` for the full stack (preview env, Android AVD, Expo Go, login). For manual setup, see `apps/mobile/CLAUDE.md`.

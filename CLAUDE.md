# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm**.

- `pnpm dev` — Vite dev server with the `@cloudflare/vite-plugin`, so the Worker (`src/index.ts`) and the React app are served together on port 8000.
- `pnpm build` — production build into `dist/`.
- `pnpm deploy` — `vite build && wrangler deploy`.
- `pnpm typecheck` — `tsc --noEmit` (strict mode, includes `@cloudflare/workers-types`).
- `pnpm test` / `pnpm test:watch` — Vitest. Run a single file with `pnpm test path/to/file.test.ts`; a single name with `pnpm test -t "name"`.

## Architecture

Single Cloudflare Worker that serves both the API and the SPA from one origin.

- **Worker** (`src/index.ts`): itty-router. Only `/api/*` is handled here; everything else falls through to static assets.
- **SPA** (`src/app/`): React 19 + `react-router` v7 + Tailwind v4 (via `@tailwindcss/vite`, imported in `globals.css` with `@import 'tailwindcss'`). Entry is `src/app/main.tsx` (referenced from `index.html`).
- **Routing split** is configured in `wrangler.toml`:
  - `[assets] directory = "./dist"` with `not_found_handling = "single-page-application"` so client routes resolve to `index.html`.
  - `run_worker_first = ["/api/*"]` ensures API requests hit the Worker before the static-assets handler.
- API error shape: `{ error: { code, message } }` with appropriate status. Match this in new endpoints.

## Swarm tooling (`swarm/`)

This repo contains multi-agent orchestration scripts (`runner.sh`, `dispatcher.sh`, `session.sh`, etc.) and a file-based task queue at `swarm/queue/{pending,in-progress,staging,done}/`. Shared agent memory lives at `swarm/memory/` and is loaded automatically by Claude Code's memory system — **do not write to `swarm/memory/` directly**; `/ship` handles that with user approval. See `swarm/agent-instructions.md` and `swarm/session-instructions.md` for the full agent protocol.

When operating inside a swarm-spawned worktree: do **not** run `git checkout main` — `main` is checked out in the parent repo and the command will fail. Branch off the current `HEAD` directly. Use relative paths for repo files; the queue path (`~/project/accordingly/coordinator/swarm/queue/`) is the one absolute path that's shared across agents.

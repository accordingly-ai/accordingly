# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Accordingly is an **iterative form-filling agent for commercial insurance**. A
business owner uses it to incrementally fill and refine an insurance application
across multiple sessions. The agent integrates with external data sources
(business registries, prior policy data, the user's own documents) to pre-fill
fields, ask focused follow-up questions, and surface what's still missing.

### Supported forms

The blank source PDFs live under `public/forms/pdfs/` (so Vite serves them at
`/forms/pdfs/<id>.pdf` for the SPA to overlay):

- `public/forms/pdfs/acord-125.pdf` — Commercial Insurance Application
  (applicant, premises, prior coverage, nature of business).
- `public/forms/pdfs/acord-126.pdf` — Commercial General Liability Section
  (exposures, coverage selections, additional interests).

For each PDF we commit a JSON field manifest at `src/forms/<id>.json` produced
by `scripts/extract-acord-fields.ts`. Each manifest entry has:
`{ name, type, label, page, rect: [x, y, w, h], options?, maxLength? }`. The
SPA uses these manifests both as the input schema for an application and to
overlay user answers on top of the rendered PDF page.

To regenerate after editing the script or swapping in a new PDF: `pnpm forms:extract`.

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
- **Form data** lives in `src/forms/` (manifests + types, importable by both Worker and SPA). Re-extraction scripts live in `scripts/`.

## Swarm tooling (`swarm/`)

This repo contains multi-agent orchestration scripts (`runner.sh`, `dispatcher.sh`, `session.sh`, etc.) and a file-based task queue at `swarm/queue/{pending,in-progress,staging,done}/`. Shared agent memory lives at `swarm/memory/` and is loaded automatically by Claude Code's memory system — **do not write to `swarm/memory/` directly**; `/ship` handles that with user approval. See `swarm/agent-instructions.md` and `swarm/session-instructions.md` for the full agent protocol.

When operating inside a swarm-spawned worktree: do **not** run `git checkout main` — `main` is checked out in the parent repo and the command will fail. Branch off the current `HEAD` directly. Use relative paths for repo files; the queue path (`~/project/accordingly/coordinator/swarm/queue/`) is the one absolute path that's shared across agents.

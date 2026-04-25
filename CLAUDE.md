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

## External integrations

### Google Drive

The agent can pull from the user's own documents to pre-fill fields. We use
the `drive.file` scope via the **Google Picker** — the app only ever sees
files the user explicitly selects, no full-Drive access, no sensitive-scope
consent screen, no Google verification required.

- **Auth flow:** browser-only PKCE via Google Identity Services
  (`src/app/drive/useDrive.ts`). The Worker never sees a Drive token.
- **File handling:** Google Docs/Sheets export to text/csv; plain text/markdown
  download as bytes; PDFs and images are sent to OpenAI through the Worker
  (`POST /api/extract-document`) so `OPENAI_API_KEY` stays server-side and
  scanned PDFs get OCR.
- **Agent surface:** when the user has connected Drive, `list_drive_files` and
  `read_drive_file` are appended to the model's tool list (executed
  client-side in `useChatAgent.ts` since the Drive token lives in the browser).

GCP setup (one-time, outside code) — in your GCP project:
1. Enable **Google Drive API** and **Google Picker API**.
2. **OAuth consent screen** — External user type (unless on Workspace);
   add the `.../auth/drive.file` scope. `drive.file` is non-sensitive, so no
   app verification is needed.
3. Create an **OAuth Web Client ID** with `http://localhost:8000` as an
   authorized JS origin → `VITE_GOOGLE_CLIENT_ID`.
4. Create an **API key** (restrict to Picker API + HTTP referrers in prod) →
   `VITE_GOOGLE_API_KEY`.
5. Copy the **project number** (numeric, top of GCP dashboard) →
   `VITE_GOOGLE_PICKER_APP_ID`.
6. While the consent screen is in "Testing", add yourself as a test user.

These three `VITE_GOOGLE_*` values are public (the OAuth flow happens entirely
in the browser); set them in `.env.local` for dev, committed `.env.production`
for prod. See `.env.example`.

## Swarm tooling (`swarm/`)

This repo contains multi-agent orchestration scripts (`runner.sh`, `dispatcher.sh`, `session.sh`, etc.) and a file-based task queue at `swarm/queue/{pending,in-progress,staging,done}/`. Shared agent memory lives at `swarm/memory/` and is loaded automatically by Claude Code's memory system — **do not write to `swarm/memory/` directly**; `/ship` handles that with user approval. See `swarm/agent-instructions.md` and `swarm/session-instructions.md` for the full agent protocol.

When operating inside a swarm-spawned worktree: do **not** run `git checkout main` — `main` is checked out in the parent repo and the command will fail. Branch off the current `HEAD` directly. Use relative paths for repo files; the queue path (`~/project/accordingly/coordinator/swarm/queue/`) is the one absolute path that's shared across agents.

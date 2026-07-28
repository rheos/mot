# AGENTS.md

Public-safe contributor and agent notes for M.O.T.

If `AGENTS.local.md` exists, read it as local operator context. That file is ignored by git and must never be committed.

## Project Shape

M.O.T. is a single-process Next.js app backed by SQLite. It provides:

- a ticket intake and triage UI
- REST routes for ticket, auth, memory, and conversation operations
- an MCP-style JSON-RPC endpoint for agent access
- Drizzle migrations and real-DB integration tests
- FTS5 and optional vector retrieval for memory/search surfaces

Runtime data is local-only and must not be committed.

## Commands

- Dev server: `npm run dev -- -p 3399`
- Typecheck: `npm run typecheck`
- Integration tests: `npm test`
- E2E tests: `npm run test:e2e`
- Build: `npm run build`
- Generate migrations: `npm run db:generate`
- Run migrations: `npm run db:migrate`

## Environment

Copy `.env.local.example` to `.env.local` for local work.

Required local values:

- `MOT_API_KEY`
- `MOT_UI_USERNAME`
- `MOT_UI_PASSWORD`
- `MOT_SESSION_SECRET`
- `DATABASE_URL`
- `BACKUP_PATH`

Optional embedding, surfacing, and maintainer-worker settings are documented in `.env.local.example`.

## Architecture Notes

- `instrumentation.ts` runs server boot work: migrations, config validation, credential bootstrap, and scheduled maintenance.
- `db/client.ts` owns the single SQLite handle.
- `lib/tickets.ts` is the ticket data-layer contract. Route handlers should use it rather than writing direct ticket SQL.
- `lib/dedup.ts` owns ticket deduplication behavior.
- `lib/validation.ts` owns the API boundary schemas.
- `lib/mcp-tools.ts` exposes supported agent-facing tools.
- `lib/conversation.ts`, `lib/digest.ts`, `lib/memory.ts`, `lib/graph.ts`, `lib/procedural.ts`, and `lib/topics.ts` make up the memory layer.

## Safety Rules

- Do not commit `.env*`, SQLite databases, WAL/SHM files, backups, model caches, entity graphs, or private operator notes.
- Do not add production hostnames, SSH paths, API keys, OAuth details, or personal intake rules to tracked files.
- Keep generated/runtime data under ignored paths.
- Preserve the ticket privacy boundary: API-key-only callers must not be able to infer private ticket existence.
- Prefer focused tests for changes to lifecycle, deduplication, auth, search, or memory behavior.

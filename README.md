# M.O.T.

M.O.T. is a self-hosted operations desk that turns messages, agent activity, and loose obligations into durable tickets. It gives one operator a searchable history of what arrived, what changed, and what still needs attention.

This repository is a public-safe view of a system in active use at [Novadiem Studio](https://novadiem.com). It includes the application, architectural decisions, and tests, but no production data, personal routing rules, credentials, or deployment details.

## What it does

- Accepts tickets through an API with deduplication, status transitions, comments, snoozing, and private-ticket controls
- Provides a single-user triage interface built with the Next.js App Router
- Stores data locally in SQLite with Drizzle migrations, WAL mode, FTS5 search, and backup hooks
- Exposes JSON-RPC tools so agents and automations can read and update tickets
- Maintains a memory layer for conversation logs, session digests, an entity/procedural graph, and hybrid keyword/vector retrieval — see [docs/memory-architecture.md](docs/memory-architecture.md) for how it's put together
- Tests integration and end-to-end behavior against real SQLite databases

## Architecture

M.O.T. runs as a single Next.js process with a local SQLite database. The same application serves the operator interface, ticket API, agent tools, scheduled maintenance, and memory features.

The main stack is Next.js 15, React 19, TypeScript, Drizzle ORM, `better-sqlite3`, FTS5, `sqlite-vec`, Vitest, and Playwright.

## Local development

```bash
npm install
cp .env.local.example .env.local
npm run dev -- -p 3399
```

Open [http://localhost:3399](http://localhost:3399).

Before exposing the application beyond a local development machine, set strong values for `MOT_UI_PASSWORD` and `MOT_SESSION_SECRET`. Set `MOT_API_KEY` when agents or automations need API access. The default database path is `./mot.db`.

## Checks

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Operating boundary

M.O.T. is designed for a single trusted operator, not as a multi-tenant service. Runtime data, environment files, model caches, private operator notes, and backups are ignored by git. Production deployments should add their own TLS, access controls, backup policy, and secret management at the hosting boundary.

## License

This repository does not currently include an open-source license. Public visibility does not grant permission to copy, redistribute, or reuse its code or documentation.

Built at [Novadiem Studio](https://novadiem.com).

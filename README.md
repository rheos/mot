# M.O.T.

M.O.T. is a self-hosted operations desk that turns messages, agent activity, and loose obligations into durable tickets. It gives one operator a searchable history of what arrived, what changed, and what still needs attention.

This repository is a public-safe view of a system in active use at [Novadiem Studio](https://novadiem.com). It includes the application, architectural decisions, and tests, but no production data, personal routing rules, credentials, or deployment details.

## What it does

- Accepts tickets through an API with deduplication, status transitions, comments, snoozing, and private-ticket controls
- Provides a single-user triage interface built with the Next.js App Router
- Stores data locally in SQLite with Drizzle migrations, WAL mode, FTS5 search, and backup hooks
- Exposes JSON-RPC tools so agents and automations can read and update tickets
- Maintains experimental memory layers for conversation logs, session digests, entity notes, topic threads, and vector-backed retrieval
- Tests integration and end-to-end behavior against real SQLite databases

## Architecture

M.O.T. runs as a single Next.js process with a local SQLite database. The same application serves the operator interface, ticket API, agent tools, scheduled maintenance, and memory features.

The main stack is Next.js 14, React, TypeScript, Drizzle ORM, `better-sqlite3`, FTS5, `sqlite-vec`, Vitest, and Playwright.

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
# M.O.T.

M.O.T. is a self-hosted personal operations tracker: a small system for turning inbound signals into durable tickets, searching them, and keeping lightweight memory around the work that matters.

It is built as a single-process Next.js application with SQLite, designed to be easy to run locally and simple to operate.

## What It Shows

- Ticket intake API with deduplication, status transitions, comments, snoozing, and private-ticket gating.
- Single-user triage UI built with Next.js App Router and TypeScript.
- SQLite persistence with Drizzle migrations, WAL mode, FTS5 search, and backup hooks.
- API-key and session-cookie authentication paths with separate authorization behavior.
- MCP-style JSON-RPC tools for agents and automations to read and write tickets.
- Experimental memory layers: conversation logging, session digests, entity/procedural notes, topic threads, and vector-backed retrieval.
- Integration and end-to-end tests against real SQLite databases.

## Stack

- Next.js 14, React, TypeScript
- SQLite via `better-sqlite3`
- Drizzle ORM
- FTS5 and `sqlite-vec`
- `iron-session` for UI sessions
- `@node-rs/argon2` for credential hashing
- Vitest and Playwright

## Local Development

```bash
npm install
cp .env.local.example .env.local
npm run dev -- -p 3399
```

Open `http://localhost:3399`.

The default local database path is `./mot.db`. Runtime data, local environment files, model caches, private operator notes, and backups are ignored by git.

## Checks

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Notes

This public repository contains the application and public-safe project documentation. Private deployment details, production data, credentials, and personal intake rules are intentionally excluded.

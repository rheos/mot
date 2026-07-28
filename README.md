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

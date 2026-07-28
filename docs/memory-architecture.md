# Memory Architecture

M.O.T. includes an experimental memory layer intended for local assistants and automations.

The core idea is simple: agents are stateless between calls, but the application database is not. Conversation turns, session digests, topic threads, entity records, and procedural notes give an assistant a durable context surface without requiring everything to live in prompt history.

## Layers

- **Conversation ledger:** append-only turn storage grouped into sessions.
- **Session digests:** compact summaries of completed sessions.
- **Topic threads:** recurring topics linked to the sessions that mention them.
- **Entity graph:** append-only JSONL records for people, projects, deadlines, preferences, and facts.
- **Procedural notes:** candidate and confirmed notes about how work should be handled.
- **MCP surface:** JSON-RPC tools that let agents retrieve and update context.

## Persistence Model

The memory layer prefers append-only records and explicit supersession over deletion. Runtime graph data lives outside git under ignored paths, so public source code stays separate from private memory.

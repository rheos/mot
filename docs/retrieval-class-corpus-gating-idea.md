# Idea: `retrieval_class` as a Schema-Level Corpus Gate

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/db.ts` schema block.

## The problem

Several kinds of row in M.O.T. are supposed to be durable and readable but absent from default
retrieval. Today each one is enforced by a `WHERE` clause that every query has to remember:

- unconfirmed entity candidates, which the profile layer gates on but `entity_search` traverses
- superseded records, which `loadGraph()` folds away at read time
- `archived` tickets, excluded from dashboard counts
- private tickets, excluded whenever the caller has no session
- the sensitive ministries (`commerce` / `plenty` / `education`), restricted to metadata-only
  classifier input

The private-ticket gate is the one that is done properly: it lives in the SQL inside
`lib/tickets.ts`, the data layer is the only thing route handlers may call, and the invariant is
documented as living in the SQL and never in post-fetch JS. That works because there is exactly
one chokepoint.

The others have no such chokepoint. Every new retrieval path is a fresh opportunity to forget one,
and the failure is silent: a forgotten clause does not error, it just returns rows that were
supposed to be invisible. FTS5 makes this worse, because an external-content FTS table indexes
whatever you feed it regardless of what your `SELECT` later filters, so a row can be excluded from
results while still skewing every relevance score computed against the index.

## What crispy-recall does

They turn the question "is this row in the retrievable corpus?" into a column, then push the gate
down into the FTS layer so it cannot be forgotten.

```sql
CREATE VIEW searchable_messages AS
  SELECT rowid, message_text FROM messages WHERE retrieval_class = 'hot';

CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_text,
  content=searchable_messages,      -- external content is the FILTERED view
  content_rowid=rowid,
  tokenize='porter unicode61'
);
```

Two classes: `hot` (in the corpus) and `agent` (durable, readable by explicit ID, invisible to
default search, lists, and vectors). Their case is subagent transcripts, where the parent thread's
narration is the canonical memory and the leaf is kept only for explicit lookup.

The external-content source is the *filtered view*, not the base table. That single choice means
`rebuild` repopulates only hot rows and the FTS integrity check compares against the filtered
corpus, so the index and the intended corpus cannot drift.

Transitions are handled by four-state triggers, which is the part that is easy to get wrong:

```
insert hot   → add          | insert agent  → no-op
delete hot   → delete       | delete agent  → no-op
update hot→hot   → delete old + add new
update hot→agent → delete old only
update agent→hot → add new only
update agent→agent → no-op
```

## The non-obvious consequence

Their `query-sanitizer.ts` carries this comment:

> HOT-only denominator: the fts5vocab numerator is derived from the filtered (hot-only)
> messages_fts index, so counting agent rows here would deflate every document frequency and skew
> the IDF filter.

Any statistic computed over the corpus has to use the same definition of "corpus" that the index
uses. Mix them and your term frequencies are wrong by whatever fraction of the table is cold. This
is directly relevant to [IDF query filtering](retrieval-idf-query-filtering-idea.md) and is the
kind of bug that never announces itself.

## What it would buy here

The honest answer is: less than it looks, today. M.O.T. has one FTS chokepoint and a small number
of retrieval paths, and the private-ticket gate is already correct. This is not a fire.

It gets more valuable in three directions:

1. **More retrieval paths.** Every new MCP search tool is another place to forget a clause. The
   tool list is already at 30-plus and growing.
2. **Subagent and tool-output turns.** If `conversation` ever ingests turns that should be kept
   but not searched (the Rheo bot's own tool narration, for instance), this is the mechanism that
   makes "durable but not retrieved" a property of the row rather than a convention.
3. **Recallatron multi-tenancy.** A hosted store needs per-tenant archival, soft delete, and
   retention tiers. Those are all the same question with a different answer per row, and they want
   one column and one view rather than a clause per query per tenant.

## Where it conflicts with ratified design

Carefully: this must not become a confirmation gate.

The memory design principles are explicit that `relatedEntities` traverses **unconfirmed** edges
by default, and that re-adding a `confirmed !== true` skip to edge traversal is forbidden because
it collided with the ambient-not-administered rule and left the relation backfill inert.

So `confirmed` is **not** a candidate for `retrieval_class`. Nor is "unused" or "old". The only
legitimate members of the cold class are rows that are genuinely not the canonical memory:
superseded records, explicit archives, and duplicated leaf narration. If a proposal for this
column ever includes "unconfirmed", that is the same bug as the Track-6 FR7 BFS and should be
rejected on sight.

## Possible next step

Do not build it yet. Write down the inventory first: every place in `lib/` that filters rows out
of a retrieval result, and what it filters on. If that list is four clauses across two files, keep
the clauses. If it is a dozen across six, the column has earned itself, and the inventory doubles
as the migration spec.

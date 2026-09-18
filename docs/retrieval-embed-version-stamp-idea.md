# Idea: Stamp an Embed Version on Every Vector

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/recall/embed-config.ts`
and `src/recall/vector-search.ts`.

## The problem

The four vec0 tables in `db/migrations/0007_vec.sql` store `(id, embedding FLOAT[384])`. There is
no record of *how* any given vector was computed. That is fine while exactly one rule has ever
applied, and it becomes a silent-corruption hazard the moment a second one does.

The rule is not just the model. It is the whole input representation:

- which embedding model produced the vector (MiniLM-L6-v2 today)
- whether a task-instruction prefix was applied (MiniLM is symmetric, so none today; a swap to
  Nomic or E5 would require `search_document:` / `search_query:` prefixes)
- whether the input was the raw text or something derived from it (see
  [context enrichment](retrieval-embed-context-enrichment-idea.md))
- the pooling strategy

Change any one of those and old vectors and new vectors stop living in the same space. Cosine
distance between them is still a number, sqlite-vec still returns a ranked list, and nothing
anywhere errors. Retrieval just gets quietly worse, in a way that shows up as "Rheo seems dumber
lately" rather than as a stack trace.

`lib/embedding.ts` already carries a comment warning about exactly this class of failure for the
normalization case:

> If you swap this model for one that does not normalize, KNN ordering silently corrupts.

The comment is right and the schema does nothing to enforce it.

## What crispy-recall does

Two pieces.

**A version constant, bumped on any input-representation change.** Theirs is currently at 3, and
the comment records the history: `1 = legacy bare (pre-prefix) vectors. 2 = prefixed. Current = 3
(prefixed + adjacency context-enriched embed input).` Every stored vector carries the version it
was computed under.

**Tolerant scoring during the migration window.** This is the part that makes it usable rather
than merely correct:

```
const embedCoverage = getEmbedVersionStats().coverage;
const tolerant = embedCoverage < 0.95;
```

Below 95% coverage, the semantic arm scores stale-version vectors too. The reasoning is in their
own comment: a strict version filter would blank the semantic arm the instant you bump the
constant, and keep it blank for the entire re-embed. A corpus the size of M.O.T.'s takes a while
to drain. Scoring slightly-wrong vectors beats scoring none.

The coverage fraction is then surfaced on every result set, so a caller can tell the difference
between "semantic search is healthy" and "semantic search is mid-migration and these rankings are
provisional".

## Why it matters more for Recallatron than for M.O.T.

For M.O.T. this is insurance on a single-user box. Worst case, Robin notices retrieval got worse
and someone re-embeds.

For Recallatron as a hosted product it is closer to load-bearing. You will change the embedding
model at some point, because the open-weight embedding frontier moves and because MiniLM-L6 is
already the small, cheap, slightly-dated option. Doing that across live tenants without a version
column means either taking semantic search down for everyone during the re-embed, or leaving a
mixed corpus in place and hoping. Neither is a thing you can do twice.

The migration also has to be resumable. A hosted re-embed will be interrupted, by a deploy, a
restart, or a rate limit, and it needs to pick up where it stopped rather than start over. A
version column gives you the work queue for free: `WHERE embed_version != CURRENT`.

## Shape of the change

sqlite-vec's vec0 tables take auxiliary columns, but the simpler and more portable option is a
plain sidecar table keyed the same way:

```sql
CREATE TABLE vec_meta (
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  embed_version INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
```

That avoids recutting four vec0 tables, keeps the version readable without loading the extension,
and makes the coverage query a single indexed scan. The cost is a second write per embed and a
join on the tolerant-scoring path.

Either way the pieces are: a `EMBED_VERSION` constant beside `embed()`, a write of that version on
every `vecInsert` / `vecReplace`, a coverage query, a tolerant branch in the vector arm, and a
backfill worker that drains stale rows. The backfill can ride the existing nightly cron in
`lib/backup.ts` alongside the maintainer workers, with the same per-worker try/catch so a stalled
re-embed never blocks compaction.

## What this does not do

It does not make a model swap free. You still pay the full re-embed, and during it your rankings
are a blend of two spaces. What it buys is that the blend is **visible, bounded, and finite**
instead of permanent and undetectable.

It also should not gate retrieval. The never-reject degrade contract ratified 2026-07-06 still
holds: a missing or stale vector degrades toward the FTS arm, it never produces an error. Version
awareness is a scoring input and a work queue, not a new rejection path.

## Possible next step

Add the constant and the sidecar write first, with the version hardcoded to 1 and no behaviour
change anywhere. That is a no-risk migration that makes every subsequent representation change
cheap. Ship the tolerant-scoring branch and the backfill worker only when there is a second
version to migrate to, which is likely to be
[context enrichment](retrieval-embed-context-enrichment-idea.md).

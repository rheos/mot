# Idea: Corpus-Adaptive Query Term Filtering (IDF via `fts5vocab`)

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT),
`src/recall/query-sanitizer.ts`.

## The problem

`lib/fts.ts` is three lines:

```ts
export function ftsPhrase(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}
```

That escapes user input into one quoted phrase, which is safe and which makes every multi-word
query an exact phrase match. "why did we move off the lightsail box" matches only rows containing
that exact string, which is approximately none of them. The FTS arm contributes nothing to those
queries, and hybrid search silently becomes vector-only.

The obvious fix, splitting on whitespace and OR-ing the terms, has the opposite failure. In a
personal memory store, a large fraction of rows contain "Robin", "M.O.T.", "ticket", "the",
"deploy". OR-ing those in means the FTS arm returns a few hundred rows ranked mostly by BM25 noise,
and RRF then fuses a garbage list with a good one.

Both failures come from the same missing piece: the query builder has no idea which of the user's
words actually discriminate in *this* corpus.

## What crispy-recall does

For queries of three or more words, look up each term's document frequency in the FTS5 vocabulary
table and drop anything appearing in more than 15% of indexed rows.

```
const IDF_PERCENTILE_THRESHOLD = 0.15;
```

`fts5vocab` is a virtual table that exposes FTS5's own term dictionary, so the document counts come
from the index itself rather than from a separate statistics pass that could drift.

The clever part is the stemming. A query term has to be stemmed the same way the index stemmed the
document, or the vocab lookup misses and every term looks rare. Rather than reimplement Porter in
JS and hope it matches SQLite's C implementation, they push the word through a scratch FTS5 table
using the identical tokenizer and read back what it produced:

```sql
CREATE VIRTUAL TABLE temp._stem USING fts5(t, tokenize='porter unicode61');
CREATE VIRTUAL TABLE temp._stem_vocab USING fts5vocab(temp, _stem, 'row');
```

Insert the word, read the term, get the exact stem the index would have stored. No drift is
possible because it is the same code path. The tables are `temp.`-qualified and per-connection,
which the source notes was a deliberate fix for a race on a shared persistent scratch table.

Two guards worth copying:

- **A fallback when the filter eats everything.** A query made entirely of common words would
  otherwise produce an empty MATCH. They keep the five rarest terms instead.
- **A bypass flag.** `--no-idf` preserves common-but-meaningful terms ("when", "before", "after")
  for queries where the stopwords are the point. Escaping is unchanged either way, so the bypass
  is not a security hole.

## The separator trap

Their header documents a bug that M.O.T. would hit the moment it stops quoting whole phrases:

> unicode61 treats hyphens and underscores as token separators, so `claude-transcript` is indexed
> as two tokens. Worse, FTS5 query syntax interprets `-` as the NOT operator, so a raw
> `claude-transcript` query means "claude WITHOUT transcript" — the exact opposite of the intent.

For this corpus that means `mot-intake`, `rheo-bot`, `sqlite-vec`, `better-sqlite3` and every
kebab-case identifier in the project inverts its own query. Normalizing hyphens and underscores
between word characters into spaces has to happen before any FTS5 parsing, not after.

The current whole-phrase quoting hides this, because a quoted phrase is not parsed for operators.
Any move to term-level queries has to fix the separators in the same change.

## Dependency

The denominator must count only rows that are actually in the FTS index. If M.O.T. ever adopts
[`retrieval_class`](retrieval-class-corpus-gating-idea.md) or otherwise feeds FTS5 a filtered
view, the total-row count used for the percentage has to use the same filter, or every document
frequency is deflated by whatever fraction of the table is excluded and the threshold stops
meaning what it says.

## Sizing and risk

Medium, and the risk is real. This changes what the FTS arm returns for every query, which changes
what RRF fuses, which changes what Rheo reads. It is not a behind-the-scenes optimization.

Mitigations: it only engages at three or more terms, so short keyword lookups are untouched; the
rarest-five fallback means it can never produce an empty match; and the threshold is one constant,
so it can be tuned or set to 1.0 to disable the filter entirely without a deploy if it is read at
call time.

## Possible next step

Run the measurement before writing any code. Query `messages_fts_vocab`'s equivalent for the
M.O.T. FTS tables and list the terms above 15% document frequency. That list answers the whole
question. If it is "the, and, robin, ticket", the filter is clearly right. If it contains something
load-bearing, the threshold needs to move before this ships.

Pair it with a handful of real queries from the conversation log, run three ways: current quoted
phrase, naive OR, and IDF-filtered OR. That comparison is cheap and settles the design.

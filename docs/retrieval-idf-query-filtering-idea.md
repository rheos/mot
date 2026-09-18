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

## Outcome (2026-09-18, issue #37 / built)

The measurement was run and it changed the design, so this section records what was learned rather
than what to try.

**The bug was worse than "suboptimal ranking".** Whole-phrase quoting meant natural-language
queries matched *nothing at all*. Against live prod:

```
"why did we move off the lightsail box"  ->  0 hits
"lightsail"                              ->  3 solid hits
```

Since `mode: 'hybrid'` RRF-merges this arm with the vector arm, hybrid had been silently
vector-only for every real question. The keyword half of retrieval was not contributing.

**The corpus-adaptive filter alone under-filters on a small corpus, and lowering the threshold is
not the fix.** On 1,034 documents only 23 terms exceed 15% document frequency. `the` (54%) is
correctly dropped, but `why`, `did`, `we` and `off` all sit *below* the line and survive, because
there are not yet enough documents for them to cross it. And the threshold cannot simply be lowered:

```
we    10.6%      <- function word, want it gone
mcp   11.1%      <- domain term, must keep
tool  11.3%      <- domain term, must keep
```

Any cut aggressive enough to catch the function words eats the vocabulary that actually
discriminates.

**So the shipped design is the union of two filters**, which is a divergence from crispy-recall:

- a short list of structurally contentless English function words, dropped regardless of frequency;
- the corpus-adaptive DF filter, which catches words that become common in *this* corpus over time
  (`mot`, `ticket`, `rheo` eventually) and which a static list could never keep up with.

Neither half is sufficient. crispy-recall gets away with the adaptive half alone because its corpus
is large enough that function words cross the threshold on their own.

Effect on the expression built for the sample query: `"why" OR "did" OR "we" OR "move" OR "off" OR
"lightsail" OR "box"` became `"move" OR "lightsail" OR "box"`.

**Confirmed as designed:** `fts5vocab` works on these contentless (`content=''`) tables, since it
reads the index rather than the content. And index-native stemming earns its keep — `deployed`
stems to `deploi`, which a JS Porter implementation may well render differently.

**Still open:** whether OR is the right join. It buys recall and lets BM25 rank, but a query like
"what did we decide about the database" still returns one off-topic row matching only `decide`. In
hybrid that is diluted by the vector arm; in `mode: 'fts'` it is visible. Worth revisiting if
keyword-only search gets used in anger.

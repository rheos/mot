# Idea: Context-Enriched Embed Input for Short Turns

Status: idea / not scheduled. Captured 2026-09-17 after reading
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), which ships this as
`buildEmbedText()` in `src/recall/embed-config.ts`.

## The problem

`lib/embedding.ts` embeds a turn's text exactly as stored. That is correct for a long turn and
close to useless for a short one. Consider the turns that actually fill a Telegram conversation
with Rheo:

- "ok ship it"
- "yes"
- "no, the other one"
- "that worked"

Each of these embeds to a point in vector space determined entirely by its own words, which
carry no topic. "ok ship it" sits near every other approval in the corpus and near nothing that
was being approved. The vector arm cannot retrieve it for any query a human would actually ask,
and worse, it can retrieve it for the wrong one: a KNN search for "did we ship the maintainer
fix" will happily return three unrelated "ok ship it" turns because they are the nearest
neighbours of the approval concept.

The FTS arm has the same blind spot but fails honestly. A keyword search for "maintainer" simply
does not match "ok ship it", so the row never surfaces. The vector arm always returns its k
nearest neighbours whether or not any of them are relevant, so short turns become active noise
rather than absent signal.

## What crispy-recall does

Messages shorter than 200 characters get the tail of the preceding turn prepended to their
**embed input** only:

```
ENRICH_MAX_CHARS  = 200   // below this, enrich
ENRICH_PREV_CHARS = 512   // how much preceding context to prepend
ENRICH_SEP        = '\n'
```

Long messages embed as-is. The stored text and the FTS index are never touched, so the row a
caller reads back is unchanged and keyword search behaves exactly as before. Only the vector
gets the extra context.

That asymmetry is the whole trick. "ok ship it" stays "ok ship it" on disk and in FTS, while its
vector encodes "...so the fix is the provider seam plus the alert ticket / ok ship it". The turn
becomes retrievable by what it was about instead of only by what it literally said.

## Why it fits here

M.O.T. has four vec0 tables and this applies cleanly to two of them:

- `conversation_vec`: the clearest win. Chat turns are exactly where short, context-dependent
  utterances live, and `lib/conversation.ts` already sessionizes turns so the preceding turn is
  trivially available at write time.
- `memory_items_vec`: memory facts are usually self-contained sentences written by the
  extraction pass, so most will exceed the threshold and embed unchanged. Enrichment would be a
  no-op for them most of the time, which is the correct outcome, not a wasted change.

It does **not** apply to `entity_vec` or `session_digest_vec`. An entity label has no preceding
turn, and a digest is already a synthesis. Leave both alone.

## The cost, stated honestly

Three things get worse or riskier:

1. **Embed input is no longer derivable from the stored row.** Today you can recompute any
   vector from `conversation.content` alone. After this change you need the row *and* its
   predecessor. That matters for backfill correctness and for debugging a bad retrieval.
2. **A bad predecessor poisons a good turn.** If turn N-1 is off-topic, turn N's vector drifts
   toward it. The 512-char cap bounds the damage but does not eliminate it.
3. **It is an embed-input representation change**, which means every existing
   `conversation_vec` row is now computed under a different rule than new rows. Mixing the two
   silently degrades ranking with no signal that anything happened.

Point 3 is the important one and it is exactly what
[embed version stamping](retrieval-embed-version-stamp-idea.md) exists to solve. Shipping
enrichment without a version column means a re-embed you cannot verify and a mixed corpus you
cannot detect. These two ideas are separable in principle and should land together in practice.

## Sizing

Small. One pure function in `lib/embedding.ts` or beside it, one extra read at the
`logTurn` call site in `lib/conversation.ts` to fetch the previous turn's text, and a backfill
pass over `conversation_vec`.

The `logTurn` p95 note in `CLAUDE.local.md` is the thing to watch: the inline embed path already
has a documented latency budget (~300ms before flipping `EMBED_INLINE=false`), and this adds one
indexed SELECT per turn. That is cheap, but it is not free, and the deferred-embed path via the
digest sweep would need the same predecessor lookup.

## Possible next step

Measure before building. Query `conversation` for the distribution of `length(content)` to find
what fraction of turns fall under 200 characters. If it is a few percent, this is a rounding
error and not worth a migration. If it is a third of the corpus, the vector arm is currently
carrying a large block of near-random neighbours and this is the highest-value retrieval fix
available.

Set the threshold from that measurement rather than inheriting crispy-recall's 200, which was
tuned against coding-agent transcripts, not Telegram chat.

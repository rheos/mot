# Idea: A Verbatim Episodic Layer as the Backstop to Extraction

Status: idea / product-level, not scheduled. The strategic conclusion of the 2026-09-17 review of
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT). Read this one first; the other
docs in this set are its parts.

## The gap

Recallatron's extraction pass is deliberately conservative. Entities are written only when
explicitly stated and only above confidence 0.85, and that gate is load-bearing: it is what makes
the system ambient rather than administered, because quality control happens invisibly at extraction
instead of via a review queue Robin has to work.

The gate is right. It also means everything below it is gone. There is no record of what extraction
declined to keep, no way to ask about it later, and no recovery when the gate's judgement was wrong.
A conservative extractor is a lossy compressor with no original.

This is not hypothetical. It already happened, and the incident is in memory as
`rheo-recall-search-rule`: Rheo could not recall a cross-session detail because digests carry gist
and the detail lived in the raw turns. The fix was a rule in the bot's system prompt telling it to
run `chat_search(mode:hybrid)` proactively. That worked, and it is a prompt-level patch over a
structural hole.

## What crispy-recall is

An entire product built in that hole. Local hybrid search over verbatim conversation transcripts.
No extraction, no summarization, no LLM calls in the product path at all. It keeps the user and
assistant turns word for word and searches them on demand.

Their framing of the relationship is better than anything I would write:

> Auto-memory saves what you knew to keep. recall finds what you didn't know you'd need. They
> complement each other: one keeps selected facts close; the other searches the verbatim
> conversation record on demand.

And on why verbatim matters:

> That distinction matters when you need the exact constraint, command, promise, rejected idea, or
> one-line fix that a summary would reasonably discard.

"Reasonably discard" is the key phrase. The summarizer is not malfunctioning when it drops the
detail you later need. It is doing its job correctly with information it did not have.

## The three-layer shape this suggests

Recallatron currently has two memory types plus a planned third:

1. **Entity graph**: who and what exists, and how they relate. Structured, queryable, extracted.
2. **Procedural notes**: how the user operates. Structured, extracted.
3. **Episodic timeline**: planned, date-indexed events keyed on `event_date`.

The planned episodic layer is described in the product notes as date-indexed *events*, which implies
extraction: something decides what counts as an event and writes a record. That inherits the same
lossiness as the entity layer.

The alternative is that the episodic layer is the **verbatim conversation record itself**, indexed
and searchable, with no extraction step. Events are not written; they are found. A query for "what
happened in March" is a date-bounded hybrid search over the raw turns rather than a lookup against a
table of things an extractor judged event-worthy.

That gives three layers with genuinely different characters:

- **Entity graph**: what is true now, structured, correctable via supersede.
- **Procedural notes**: how the user works, structured, correctable.
- **Verbatim episodic**: what was actually said, immutable, searchable, never summarized.

The third one has a property the other two cannot have: it is the only layer where being wrong is
impossible, because it makes no claims. It records that something was said, not that it is true.
That is the read-side counterpart to the epistemics point in
[the skill contract doc](retrieval-skill-epistemics-idea.md).

## The competitive argument

The current positioning is structured-and-queryable against Mem0, Zep, and LangMem, which use
embedding-based fuzzy retrieval. That differentiation is real but it is a narrow ledge, because
"add structure" is a roadmap item for every one of them.

The three-layer position is harder to copy and easier to explain:

> Other tools pick one. Fuzzy embeddings lose precision. Extracted facts lose everything they
> didn't extract. Recallatron keeps the structure and the original.

It also answers the objection that kills structured memory products: "what if your extractor misses
something?" Today the honest answer is that it is gone. With this layer the answer is that the
conversation is still there and searchable, and the extractor missing something costs convenience
rather than the fact.

## The economics, which are unusually clean

crispy-recall makes zero LLM calls. Indexing is local embedding plus SQLite. Search is FTS5 plus a
quantized vector scan. Their README puts it plainly: indexing and search consume no model tokens,
and retrieved text costs context tokens only when the agent chooses to read it.

Recallatron's structured layers are the opposite: extraction is an LLM call per digest, and the
nightly resolution, dedup, and profile workers are LLM calls per batch. That cost is already real
enough to have forced batch sizing and a provider swap to OpenRouter.

So the two layers have different marginal cost curves, which is the natural shape of a pricing tier:

- **Verbatim episodic** is near-pure compute. Storage and CPU scale with volume; no per-query model
  cost. Viable as the cheap or entry tier, or as the thing that stays working when a tenant exhausts
  their allocation.
- **Structured extraction** costs model tokens per unit of memory written. That is the paid
  differentiator, and metering it against a capacity allocation is straightforward.

A tenant who runs out of extraction budget should degrade to verbatim search rather than to nothing.
That is the same never-reject instinct as the ratified Track-5 degrade contract, applied to billing
instead of to a missing extension.

## What M.O.T. already has

Most of the substrate. `conversation` stores turns, `lib/conversation.ts` sessionizes them,
`chat_search` does hybrid FTS-plus-vector retrieval with RRF, and `conversation_vec` holds the
embeddings. The verbatim layer largely exists; it is just framed as plumbing under the digest
pipeline rather than as a memory type in its own right.

What is missing is mostly quality and contract, which is what the rest of this doc set covers:
[context enrichment](retrieval-embed-context-enrichment-idea.md) so short turns are findable,
[IDF filtering](retrieval-idf-query-filtering-idea.md) so multi-word queries work at all,
[score-gap cutoff](retrieval-score-gap-cutoff-idea.md) and
[RRF tuning](retrieval-rrf-tuning-idea.md) so results are sized and ranked sensibly, and
[the skill contract](retrieval-skill-epistemics-idea.md) so an agent knows how to use and disbelieve
what it gets back.

That is the argument for doing the retrieval work: it is not incidental polish on a logging table.
It is building out the third memory type.

## The honest counter-argument

Verbatim storage is unbounded. Extraction's lossiness is also its cost control: a digest is small
and a conversation is not. A hosted product storing every tenant's raw turns forever has a storage
bill that grows monotonically and a deletion-request surface much larger than a graph of extracted
facts.

There is also a privacy asymmetry. An entity record says "Robin lives in BC". A transcript says
everything that was in the room. Those are different things to be responsible for, and the second
one is harder to promise about. See the upload friction discussed in
[install-time backfill](install-time-backfill-idea.md).

Neither kills the idea. Both mean the retention policy, the deletion primitives, and the storage
tiering have to be designed at the start rather than added, because a verbatim layer is exactly the
kind of thing that is easy to start keeping and very hard to start keeping selectively.

## Possible next step

Decide whether the planned episodic layer is extracted events or indexed verbatim conversation.
That is a fork, not a detail: it determines the storage model, the cost model, the privacy posture,
and whether the retrieval-quality work in this doc set is infrastructure or polish.

If the answer is verbatim, the retrieval docs stop being a backlog of small improvements and become
the build plan for a product layer.

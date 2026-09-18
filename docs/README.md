# M.O.T. docs

Design notes and idea docs. Per the standing convention, production and dev-work follow-ups live
here as idea docs rather than as M.O.T. tickets, which are life-admin only.

## Architecture

- [memory-architecture.md](memory-architecture.md): how the memory layer is put together — the
  conversation/entity/procedural stores, the persistence and confirmation principles, the nightly
  self-organizing workers, and where it's headed (planned extraction as its own product).

## Idea docs

Each is a captured follow-up, not a scheduled plan. Status is on line 2 of each file.

**From the crispy-recall review (2026-09-17)**

[crispy-recall](https://github.com/TheSylvester/crispy-recall) is an MIT tool doing local hybrid
search over verbatim Claude Code / Codex transcripts. It is the complement to Recallatron rather
than a competitor, and reviewing it surfaced one strategic question and ten concrete borrows.

Start here:

- [verbatim-episodic-layer-idea.md](verbatim-episodic-layer-idea.md): the strategic conclusion.
  Should the planned episodic memory layer be extracted events or indexed verbatim conversation?
  Everything below is downstream of that answer.

Retrieval quality, applicable to M.O.T. today:

- [retrieval-embed-context-enrichment-idea.md](retrieval-embed-context-enrichment-idea.md):
  prepend preceding-turn context to the embed input for short turns, so "ok ship it" is findable.
- [retrieval-embed-version-stamp-idea.md](retrieval-embed-version-stamp-idea.md): record which
  embedding rule produced each vector, so a model swap is a visible finite migration rather than
  silent corruption.
- [retrieval-idf-query-filtering-idea.md](retrieval-idf-query-filtering-idea.md): drop
  high-frequency query terms using the FTS5 vocabulary table, stemmed by FTS5 itself.
- [retrieval-score-gap-cutoff-idea.md](retrieval-score-gap-cutoff-idea.md): size result sets from
  the score distribution instead of a fixed top-K.
- [retrieval-rrf-tuning-idea.md](retrieval-rrf-tuning-idea.md): over-fetch per arm before fusing,
  keep recency off by default, boost semantic-only discoveries.
- [retrieval-class-corpus-gating-idea.md](retrieval-class-corpus-gating-idea.md): make "durable but
  not retrieved" a column and a filtered FTS view rather than a clause every query must remember.

Contracts and operations:

- [retrieval-skill-epistemics-idea.md](retrieval-skill-epistemics-idea.md): what the agent-facing
  skill file has to say about disbelieving retrieval. Most valuable of the set for Recallatron,
  since the product ships as an MCP server plus a skill file.
- [write-path-failure-discipline-idea.md](write-path-failure-discipline-idea.md): never block the
  user, never be silent about it. Bounded busy retries, memory-floor gating, thresholded jobs.

Recallatron product-level:

- [hub-satellite-topology-idea.md](hub-satellite-topology-idea.md): their self-hosted split is the
  SaaS topology with the server left out. What transfers and what does not.
- [install-time-backfill-idea.md](install-time-backfill-idea.md): index the history already on
  disk at signup, so the product is useful on day one.
- [code-provenance-blame-idea.md](code-provenance-blame-idea.md): from a line of code back to the
  conversation that produced it. Hardest to build, sharpest positioning.

**Other**

- [ontology-guardrails-idea.md](ontology-guardrails-idea.md): neurosymbolic guardrails for the
  memory layer, captured from a 2026-07-23 talk.

## Dependency between the retrieval docs

Four of them want `rrfMerge` to expose the scores it already computes instead of mapping them away:
score-gap cutoff, all three RRF tuning changes, and any future relevance work. That refactor is the
shared prerequisite and should happen once.

Two of them are an embed-input representation change and want to land together: context enrichment
changes how vectors are computed, and the version stamp is what makes that change verifiable.

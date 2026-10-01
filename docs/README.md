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

**From the EverAlgo review (2026-09-18)**

[EverAlgo](https://github.com/EverMind-AI/EverAlgo) (Apache 2.0, EverMind-AI) is the algorithm
library behind EverOS: business-stateless, persistence-free, extraction and ranking only. Where
crispy-recall covers the verbatim half, this covers the structured half, the layer M.O.T. had no
reference implementation for.

Read under the decision recorded in rheo.stream's 1a card: **build the product, borrow the
algorithms, attribute properly.** Same method as the crispy-recall pass: port techniques, not
constants, and measure against the real corpus before adopting any number.

- [everalgo-staged-dedup-idea.md](everalgo-staged-dedup-idea.md): the highest-value item. Hand
  the dedup model a ranked vector neighbourhood instead of an insertion-order chunk, and skip it
  only where a measurement says skipping is safe. The OOM that motivated the first draft was on
  the retired Lightsail box; the live reasons are a ~9-minute nightly app outage, the OpenRouter
  bill, and a chunking blind spot that the code comments say never heals.
- [everalgo-agentic-retrieval-idea.md](everalgo-agentic-retrieval-idea.md): a sufficiency check
  and query expansion. Two failure classes, not one: the relevance floor detects "nothing near"
  for free; only a model can detect "near but not the answer". EverAlgo has the second and does
  nothing on an empty first round, so the two are not the same loop at different prices.
- [everalgo-boundary-detection-idea.md](everalgo-boundary-detection-idea.md): session boundaries
  as a judgement that can be *deferred*. The contrast in the title is softer than it reads (their
  top-priority rule is a calendar-date split), and the measurement that decides it is a gap
  histogram, not a vector comparison.
- [everalgo-fusion-comparison-idea.md](everalgo-fusion-comparison-idea.md): mostly reassurance.
  Their RRF is identical to ours, formula and default `k`. Their `lr` ships three fitted constants
  and no learner, and their `score_propagation` is a parent-to-child blend with no caller. Records
  that `lib/rrf.ts` is not provisional.

**Not yet read.** The review covered `everalgo-clustering`, `everalgo-rank` and
`everalgo-boundary`. Four packages were not studied: `everalgo-user-memory` (Episode / Foresight /
AtomicFact / Profile extractors, 4,184 LOC), `everalgo-agent-memory` (AgentCase / AgentSkill /
AgentProfile, 3,122), `everalgo-knowledge` (2,090) and `everalgo-parser` (1,632). Counts are `.py`
under each package's `src/`. The extractors in particular map onto M.O.T.'s digest, entity
extraction and procedural notes, and are the obvious next read.

A quick look during the review pass, not a read, found three things worth knowing before that
read: `everalgo-knowledge/_batch_merge.py` handles duplicates that straddle a batch split with a
second LLM pass over the flattened outputs, which is the other cure for the dedup blind spot above;
the user-memory extractors carry no confidence gate (the only mention of `confidence` in
`everalgo-core`'s memory types is as an optional extra field), so M.O.T.'s "quality control lives at
extraction, gated at 0.85" has no counterpart there; and `cluster_by_llm` is exercised by nothing
in the repo's examples or pipelines, so its `0.85` skip threshold has no visible track record.

**Other**

- [ontology-guardrails-idea.md](ontology-guardrails-idea.md): neurosymbolic guardrails for the
  memory layer, captured from a 2026-07-23 talk.

## Dependency between the retrieval docs

Four of them want `rrfMerge` to expose the scores it already computes instead of mapping them away:
score-gap cutoff, all three RRF tuning changes, and any future relevance work. That refactor is the
shared prerequisite and should happen once.

Two of them are an embed-input representation change and want to land together: context enrichment
changes how vectors are computed, and the version stamp is what makes that change verifiable.

## Attribution

The crispy-recall review above, and several of the changes it produced, draw on
**[crispy-recall](https://github.com/TheSylvester/crispy-recall)** by Sylvester Wong — MIT
licensed, Copyright (c) 2026 Sylvester Wong.

Most of what came across is *ideas*, reimplemented against this codebase and re-measured against
this corpus, which is why several of the constants here differ from the originals. Two functions
are closer than that and carry the notice in their own file headers:

- `lib/embed-input.ts` — `buildEmbedText` is a close paraphrase of the original in
  `src/recall/embed-config.ts`.
- `lib/fts.ts` — `fts5Stem` is a close paraphrase of the original in
  `src/recall/query-sanitizer.ts`.

Not from crispy-recall, and noted here so the line stays clear if any of this ports onward: the
vector relevance floor (`lib/vec.ts`, issue #43 — crispy-recall has no equivalent), the structural
stopword union in `lib/fts.ts`, the session-boundary rule on enrichment, the per-call retrieval
provenance, and the tool-call log.

If any of this moves into another repository, the notice moves with those two files.


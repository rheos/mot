# Idea: Score-Gap Cutoff Instead of a Fixed Top-K

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/cli/recall.ts`.

## The problem

Every search path in M.O.T. returns a fixed number of rows. `rrfMerge` takes a `limit` and
truncates to it; `chat_search`, `memory_recent`, and `entity_search` each pass one down. The
number is a guess made at the call site, before anyone knows what the corpus contained.

That guess is wrong in both directions, and the two failures cost different things:

- **Too many.** A query with two genuinely relevant rows returns twenty. The eighteen extras are
  the tail of the ranking, which in a hybrid system means whatever the vector arm coughed up to
  fill its k. Rheo reads all twenty, spends context on eighteen irrelevant ones, and its answer is
  diluted by the noise it was handed.
- **Too few.** A query that legitimately matches forty rows returns twenty, and the cut lands in
  the middle of a flat run of equally-relevant results. There is no signal that anything was
  dropped.

The second failure is rarer and more annoying. The first happens on nearly every query, and it is
the one that quietly makes an agent worse.

## What crispy-recall does

Let the score distribution decide where to stop.

```
Scan from position 10 onward. Find the largest relative drop between
consecutive scores. If > 15%, truncate there.
```

The logic in full: starting at index 10, compute `(curr - next) / curr` for each adjacent pair,
track the largest, and if that largest drop exceeds 15%, cut immediately after it.

The reasoning is that a good ranking is usually not a smooth gradient. It is a cluster of things
that actually match, then a cliff, then a long flat tail of things that scored above zero for
incidental reasons. The cliff is the answer. Finding it costs one linear pass over a list you have
already sorted.

Starting at position 10 rather than 0 is deliberate: the top of a ranking is often steep by nature
(rank 1 to rank 2 is frequently the biggest relative drop in the whole list), and cutting there
would return a single result for every query.

Two things they pair with it:

- **Deduplicate by session after the cut, keeping the highest-ranked hit** and counting the rest
  as a `hits` column. Twelve matching messages in one conversation become one row that says
  "twelve hits here", rather than twelve rows crowding out other conversations.
- **Report the cut.** `Cutoff: position 47 of 200 (score gap detected)` is printed with the
  results. The caller can tell truncation happened and roughly how aggressive it was.

## Why this fits an agent consumer specifically

The output of M.O.T.'s search tools is read by a model with a context budget, not by a human
scrolling a page. A human tolerates a long list because skipping a bad result is free. For a model
every returned row is paid for twice: once in tokens, once in the attention it pulls away from the
rows that mattered.

That makes adaptive sizing worth more here than in a normal search UI. A query with one good answer
should return one row, and today it cannot.

It also composes with the [skill epistemics](retrieval-skill-epistemics-idea.md) idea. Telling an
agent "judge relevance yourself" is necessary but weak; models are agreeable and will find a way to
use whatever they were handed. Not handing over the tail is the stronger version of the same
instruction.

## Caveats

**It needs scores, and `rrfMerge` currently throws them away.** The function returns `T[]`, mapping
away the `{ item, score }` pairs it computed internally. A cutoff needs that score list, so this
change requires `rrfMerge` to expose scores, which is also the prerequisite for the
[RRF tuning](retrieval-rrf-tuning-idea.md) ideas. Do that refactor once.

**RRF scores are not comparable across queries.** They are a function of rank positions and the
number of lists, not of absolute relevance. That is fine here, because the cutoff only ever compares
scores *within* one result set. It would not be fine as a global relevance threshold, and nobody
should later add one.

**It can cut too early on a genuinely flat ranking.** A query where forty rows are equally relevant
has no cliff, so the largest drop is small, and the 15% floor correctly declines to cut. That is the
designed behaviour, but it means the cutoff does nothing on exactly the queries where the caller
most wants a cap. Keep the existing `limit` as a ceiling; the gap cut is a floor-finder, not a
replacement.

## Possible next step

Land it as an opt-in first. Expose scores from `rrfMerge`, add the cutoff as a pure function with
unit tests over synthetic score lists, and wire it to one tool (`chat_search` is the best candidate,
since it has the noisiest tail) behind a parameter. Compare real queries with and without before
making it the default anywhere.

## Outcome (2026-09-18, issue #40 / built)

Shipped as `scoreGapCutoff` in `lib/rrf.ts`, applied to all three hybrid paths.

The prerequisite this doc flagged was real: `rrfMerge` computed `{item, score}` internally and
mapped it away. It now has a `rrfMergeScored` sibling returning scores plus which input lists
contributed, with `rrfMerge` kept as a thin wrapper so no existing caller churned. That same
refactor is what any future recency or confidence work needs.

**Honest sizing of the benefit here.** crispy-recall runs a default limit of 200 and lets the gap
cut do the real work. M.O.T.'s limits are around 20, and the scan starts at position 10, so on most
queries against a 1,034-turn corpus the cutoff is a no-op. That is correct behaviour, not a defect:
it shrinks a list only when there is a genuine cliff, and the caller's `limit` remains the ceiling.

So this is infrastructure ahead of need rather than an immediate win. It earns its keep when limits
grow, and it ports to Rheo Stream phase 2 as a finished, tested pure function rather than a design
note. Both of those were worth the small cost; a bigger claim would be overstating it.


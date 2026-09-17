# Idea: Three RRF Tuning Changes

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT),
`src/recall/vector-search.ts`.

## Context

`lib/rrf.ts` already implements Reciprocal Rank Fusion correctly: score per item is the sum of
`1/(k + rank)` across lists, k defaults to 60, output is sorted, deduped on id, and truncated.
crispy-recall uses the same formula with the same k. The algorithm is not in question.

What differs is three choices around it. All three are small, and two of them are arguably bugs in
the current setup rather than tuning.

## 1. Fetch more than you need from each arm

Today each arm is asked for exactly `limit` rows, and the merged output is truncated to `limit`.
crispy-recall fetches `limit * 3` from each arm before fusing:

```
const FETCH_MULTIPLIER = 3; // fetch more from each path to improve union quality
```

The reason fusion needs headroom: a row that ranks 25th in FTS and 25th in vector is a strong
agreement signal and should beat a row that ranks 3rd in one arm and nowhere in the other. With
both arms cut at 20, that agreement is invisible, because neither list contains the row. Fusion can
only reward overlap it can see.

This is the change that most looks like a latent bug. RRF's whole advantage over a single ranker is
that it rewards consensus, and cutting both inputs to the output size removes most of the consensus
before the merge runs.

Cost is one over-fetch per arm. The FTS arm is a `LIMIT` change. The vector arm already over-fetches
for a different reason (`lib/conversation.ts` notes uniform over-fetch to compensate for the
post-KNN `chat_id` filter drop), so the pattern is established.

## 2. Keep recency off by default

crispy-recall's recency decay is off unless the caller passes `--recent`, and the comment states the
position plainly: retrieval relevance is not re-weighted by age. When enabled it is
`1 / (1 + ageDays * decay)` with `decay = 0.10`, applied as a multiplier on the RRF score, and
future-dated rows are clamped to age zero so clock skew cannot boost anything.

M.O.T. does not currently apply recency at all, so this is less a change than a decision to write
down and defend. It is worth writing down because the pressure to add recency weighting to a memory
system is constant and mostly wrong here.

The reason it is wrong here is the ratified persistence invariant: memory is forever, and a fact
Robin stated once must survive indefinitely even if never referenced again. A ranking that
systematically demotes old rows is a soft version of the decay the design rejects. The fact does not
get deleted, it just stops being findable, which produces the same user-visible outcome for a worse
reason.

The right shape is what crispy-recall has: off by default, available per query. "What did we decide
about the deploy lately" is a legitimate recency-weighted query. "Why did we choose this approach"
is not, and should be able to reach three years back without penalty.

## 3. Boost results only the semantic arm found

```
const SEMANTIC_DISCOVERY_BOOST = 1.05;
```

Applied to any result whose session was not in the FTS result set at all. A 5% lift, which is
deliberately gentle: enough to break ties in favour of genuine discovery, not enough to float
irrelevant vector noise above solid keyword matches.

The argument: if FTS already found a row, the vector arm confirming it adds little. If the vector
arm found something FTS could not see, that is the entire reason the semantic arm exists. The
wording-mismatch case ("we solved this before" against a transcript that never used those words) is
the one hybrid search is for, and unmodified RRF treats it as merely equal.

This is the most speculative of the three and the easiest to get wrong. 1.05 is a magic number with
no derivation behind it, and the failure mode is subtle: over-boosting turns the vector arm's
inevitable noise into top-ranked results. It should land last, behind a constant that can be set to
1.0, and only after the first two changes have been evaluated.

## Prerequisite

All three want `rrfMerge` to expose the scores it already computes rather than mapping them away.
The discovery boost needs to modify scores before the sort; recency needs to multiply them; and
[score-gap cutoff](retrieval-score-gap-cutoff-idea.md) needs to read them. One refactor unlocks all
four ideas.

Keep the current `T[]`-returning signature as a thin wrapper so existing callers do not churn.

## Possible next step

Ship the fetch multiplier alone. It is the smallest change, it has the clearest argument, and it
requires no new parameters or constants. Measure whether merged results actually change before
touching anything else; if fusion output is identical with 3x over-fetch, the other two are not
worth the risk either.

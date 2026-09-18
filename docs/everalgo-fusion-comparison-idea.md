# Idea: What EverAlgo's Fusion Toolkit Says About Ours

Status: reference note / mostly no action. Captured 2026-09-18 from
[EverAlgo](https://github.com/EverMind-AI/EverAlgo) (Apache 2.0, EverMind-AI),
`packages/everalgo-rank/src/everalgo/rank/fusion.py`, with `weight.py` and `hybrid.py` read for
the review pass the same day. Two attributions in the first draft were wrong and are corrected
below: `lr` does not ship a learner, and `score_propagation` is not a graph operation.

## The headline is reassurance, not a gap

Before reading this package the working assumption was that `rrfMergeScored` in `lib/rrf.ts`
(about twenty-five lines of a 138-line file that also holds the retrieval stats type and the
score-gap cutoff) was a thin stand-in for a proper ranking toolkit, and that a library with "4
composable retrieval strategies + 4 business rankers + fusion / weight / rerank" must be doing
something more sophisticated at the fusion step.

It is not:

```python
def rrf(*sources: Sequence[Candidate], k: int = 60) -> list[Candidate]:
    """Reciprocal Rank Fusion over N ranked lists; score = Σ 1/(k+rank_i)."""
```

Same formula, rank 1-indexed, same default `k`. The only differences are housekeeping: theirs
skips candidates with an empty id, ours records which lists each item appeared in and truncates
to the caller's limit. Two systems that never saw each other's code arrived at the same fusion
because the published algorithm is the right one.

Worth recording explicitly, because "their library is bigger, therefore ours is behind" is an easy
and wrong inference, and it would have justified work that buys nothing.

## What they have beyond RRF, and what it actually is

`fusion.py` exports four more entry points. Read precisely, they are smaller than their names:

| | what it is | what the first draft said |
|---|---|---|
| `lr` | `sigmoid(emb*6.27 + bm25*0.094 - 4.86)`. Three constants in a `NamedTuple` labelled "trained"; no fitting code anywhere in the repo. | "learned coefficients" |
| `cosine_to_lr_score` | The same sigmoid applied to one cosine value, to put it on the `lr` scale. | correct |
| `vector_anchored` | `0.7*cosine + 0.3*saturated_bm25`, a convex blend, with a missing arm filled in at that arm's minimum score. | "anchored on the vector arm" (fair, but it is a weighted sum) |
| `score_propagation` | `alpha*child + (1-alpha)*parent`, looked up through `metadata["parent_id"]`. One level, parent to child. Default `alpha=1.0`, which disables it. **No caller in the repo.** | "propagates score across related records" |

**`lr`** is still the interesting one, as a shape: fuse by learned weight rather than by rank
position. But EverAlgo ships only the inference half, and its three constants were fitted on
their embedding model's cosine scale and their BM25 scale. Copying them would be the same mistake
as copying a threshold, and the bm25 coefficient of 0.094 against 6.27 for cosine says the fitted
model nearly ignores the keyword arm on whatever corpus it was fitted on, which is not obviously
true here.

**RRF's strength is that it needs no training data.** It fuses ranked lists knowing nothing about
what a good result looks like, which is exactly right for a system with no relevance labels. That
described M.O.T. completely until #47.

**It no longer quite does.** `tool_call_log` records `query`, `mode`, `result_count` and
`duration_ms` on every read-tool call. That is not relevance labelling, but it is the first half:
a record of what was asked and what came back. Pair it with any weak signal about whether the
answer was used (a follow-up search on the same words within a minute is the only one the log can
see today, since it carries no chat or session id) and there is the beginning of a training set.

That is a real possibility and it is also months away and speculative. Recorded so the connection
is not lost, not proposed.

## Two things not worth borrowing

`hybrid.py`'s `ahybrid_retrieve` has a `min_score` knob: an absolute filter on the *fused* score,
applied after truncation. RRF scores are comparable only within one result set (a query with two
long lists produces bigger numbers than a query with two short ones), so an absolute cut on them
is the wrong tool. `lib/rrf.ts`'s `scoreGapCutoff` compares neighbours instead, for that reason.
Keep ours.

EverAlgo has no relevance floor on the vector arm. `dense_retrieve` is caller-supplied, so a floor
would be the caller's job. Nothing to take; #43 already did the work.

## `score_propagation` and the entity graph

The graph idea survives the correction, but it is ours, not theirs. M.O.T. has an entity graph
with a typed edge vocabulary and `relatedEntities` already traverses it. Propagating retrieval
score across edges, a strongly matching entity lending some relevance to its neighbours, is the
graph-aware retrieval the structured layer exists to make possible, and nothing currently does it.
EverAlgo's ten-line parent-to-child blend gives no guidance on how: no hop decay, no edge-type
weighting, no cycle handling.

It is also exactly where an unmeasured change would do damage: a propagation factor that is too
generous turns every search into a neighbourhood sweep. It needs the same treatment as the
relevance floor, which means a ground-truth population before a constant.

## Possible next step

None immediately. Two things to carry forward:

- Stop treating `lib/rrf.ts` as provisional. It implements the same algorithm a dedicated ranking
  library does, and the gap to close is data, not mathematics.
- If ranking work is ever revisited, edge-propagated scoring over the entity graph is the
  candidate with the most headroom, and it will have to be designed here. Learned fusion becomes
  possible only once `tool_call_log` has something to be joined against.

# Idea: Stop Sending Every Entity to the LLM

Status: idea / not scheduled. Captured 2026-09-18 from
[EverAlgo](https://github.com/EverMind-AI/EverAlgo) (Apache 2.0, EverMind-AI),
`packages/everalgo-clustering/src/everalgo/clustering/algorithm.py`. Reviewed against both
codebases the same day; the history, the EverAlgo control flow and the measurement design were all
corrected in that pass.

This is the highest-value item in the EverAlgo read, but not for the reason the first draft gave.
The OOM it cited happened on hardware that no longer exists. The live costs are a nightly app
outage, a per-night model bill, and a blind spot in the batching that never heals.

## The problem, with history

`dedupWorker` and `resolutionWorker` (`lib/maintainer.ts`) send entities to the model in chunks,
sequentially. The sizing has been fought over twice, and the record needs the dates attached:

- The v1 single-batch send (the whole graph, ~182 entities, in one prompt) was killed with exit 143
  on the **Lightsail** box, which had 1.9GB of RAM. Batching to 25 fit dedup; resolution's heavier
  prompts still timed out on about a third of batches, so production went to 10. That is the
  "~12 minutes for resolution" figure in the memory notes, and it is a Lightsail number.
- M.O.T. moved to the Contabo box on 2026-07-26. It has 23GB. `MAINTAINER_BATCH_SIZE=10` is still
  set (read live from the Coolify env on 2026-09-18) and is now a leftover, not a constraint.
- The verified run on 2026-09-12 was 52 resolution batches, 53 dedup, 16 profile: ~9 minutes end
  to end, through OpenRouter. For that whole window `/api/status`, the ticket API and the MCP
  endpoint did not answer, because `identifyViaProvider` uses `spawnSync` on the main thread. The
  nightly 02:00 UTC cron has the same property.

So the memory pressure is gone and the batch size could simply be raised. What that would not fix:

**The stable-chunk blind spot.** The code comment at the dedup LLM pass says it plainly: a fuzzy
(non-exact-label) duplicate pair split across two chunks of one type-group "is never seen together
by one call, so it is missed, and because `loadGraph()` returns stable insertion order, the chunk
boundaries are identical every run, so it stays missed (not just 'next pass')." `CLAUDE.local.md`
still says the next nightly pass catches it. The code says otherwise. Every night the same pairs
straddle the same boundary.

That is the design-level problem, and batch size is not the lever for it. Chunking by insertion
order means the candidates an entity is compared against are decided by *when it was written*,
not by *what it resembles*.

## What EverAlgo does

Two operators, not a ladder. The first draft of this doc described "three rungs"; the library does
not compose them, and nothing in the repo's examples or pipelines calls the LLM one (the docs list
it; only `cluster_by_geometry` is exercised). Read them separately.

```python
def cluster_by_geometry(new, existing, *, threshold=0.65, time_window_days=7.0):
    """Cosine + time-window assignment. Sync pure-compute, no I/O."""
    # top-1 by cosine among clusters whose last_ts is within the window;
    # returns the merged cluster if sim >= threshold, else None.

async def cluster_by_llm(new, existing, *, llm, k_candidates=30, llm_skip_threshold=0.85):
    candidates = _find_top_k_clusters(existing, new.centroid, k_candidates)  # no time window
    top_idx, top_sim = candidates[0]
    if top_sim >= llm_skip_threshold:
        return _merge(existing[top_idx], new)     # <- no LLM call
    ...  # LLM sees [{idx, count, preview[]}] for the K candidates, returns one idx or -1
```

Three things about the shape matter more than the constants:

1. **It is one new item against the existing set.** Both operators take a size-1 cluster and
   answer "which existing cluster, or none". That is an ingest-time, online decision. M.O.T.'s
   dedup is a nightly pass over everything, which is a different problem with a different cost
   curve.
2. **The model's input is a short ranked list of previews, not a corpus.** The prompt gets the top
   30 by cosine, each as an index, a count and up to five preview strings. It ranks; it does not
   scan.
3. **`None` from the geometry operator is ambiguous.** It means "no cluster within the window
   cleared 0.65", which covers both "confidently new" and "not sure". There is no escalation path
   built in, and the fast path in the LLM operator checks only that top-1 clears 0.85, never the
   margin over top-2. Anyone composing these into a ladder has to add both.

The `cluster_by_llm` prompt is written for agent *task intents* ("group cases that would produce a
specific, actionable skill"). The geometry operator is the one their user-memory pipeline uses,
for episodes. Neither is an entity dedup prompt.

## Why this fits M.O.T. anyway

**The embeddings already exist.** `entity_vec` holds one vector per entity and `vecKnn` does KNN
over it; vectors are unit-normalized MiniLM, so vec0's L2 ranking is cosine ranking. Two things to
know before leaning on them:

- The entity vector is `label + ' ' + JSON.stringify(properties)` (`lib/graph.ts`,
  `appendEntity`). It is not a label vector. Two records for the same person with different
  property sets can sit further apart than two different people with similar property keys.
- `vecKnn` applies the 0.76 relevance floor from issue #43 to every call. That floor was measured
  on query-to-turn distances. An entity-to-entity KNN has to either bypass it or re-measure it, or
  the candidate list will be silently truncated by a constant tuned for something else.

**There is already a slot for the ingest-time shape.** `scanForDuplicates` in `lib/extraction.ts`
runs on every extracted entity and flags `probable_duplicate_of` when a same-type label is within
Levenshtein 2 or is a prefix/suffix. That is EverAlgo's "new item vs existing set" step, done with
string distance instead of vectors. Swapping in a KNN top-K there is a small change. One gap to
close on the way: the autoconfirm worker defers on the flag, but `dedupWorker` never reads it. It
runs its LLM pass over type-group chunks regardless, so today the flag is a hint nobody acts on.

**KNN candidates fix the blind spot by construction.** If the nightly LLM pass is fed "this entity
and its K nearest by vector" instead of "this chunk of the type-group by insertion order", a
straddling pair is straddling nothing. That is the argument for this idea that survives the RAM
upgrade.

**Resolution is a different shape.** It asks the model to find the named subject that several
descriptive Facts share, across the whole active set. Top-K around one item does not obviously
decompose that. This doc is about dedup; resolution keeps its batches until someone designs
something else for it.

## What does NOT transfer

**The seven-day time window.** Only `cluster_by_geometry` has it; `_find_top_k_clusters` in the
LLM path explicitly does not. It is right for episodic clustering, where recency is evidence, and
wrong for entities: two mentions of the same person a year apart are the same person, and a
window would stop merging exactly the long-lived entities the graph exists to accumulate.

**The thresholds.** `0.65` and `0.85` are cosine similarities on their model and their corpus.
M.O.T.'s only measured distances are query-to-turn, from #43: relevant answers at p50 0.543 (n=37,
max 0.733), irrelevant at p50 0.816 (n=60, min 0.599), overlapping. Nothing has been measured
entity-to-entity, and the first draft's "0.13 vs 0.78" was one anecdotal pair from a different
measurement, not a distribution. These numbers must be measured before use, the same way the
enrichment threshold and the relevance floor were.

**The LLM prompt.** It is for clustering task intents by reusable skill. The existing `DEDUP_PROMPT`
already asks the right question for entities and returns groups by id; keep it, change what it is
handed.

## The measurement to run first

The ground truth that exists is the dedup worker's own past decisions. Using it is sound for the
question "would geometry have made the same call the LLM made", and unsound if the result is ever
reported as accuracy: a merge the model got wrong is baked into the label set as "should merge".
Keep the two apart.

What is actually recoverable, checked against `lib/graph.ts` and `lib/maintainer.ts`:

- **Merged pairs: yes, with drift.** Every merge is a `supersede` patch in `graph.jsonl`, and
  `appendSupersede` does not delete the loser's `entity_vec` row, so loser and survivor vectors
  both exist. But the survivor is re-indexed after its properties are unioned, so its vector today
  is not the vector the model saw. The comparison is loser-then vs survivor-now. State that.
- **Losers embedded: only if they were.** `indexAsync` fires on append when embedding is on; the
  backfill covers the rest. Any loser appended during an embed-off window and never backfilled has
  no row. Count the misses before trusting the population.
- **Declined pairs: no.** Nothing records what the model was shown and chose not to merge. The
  "should not merge" population has to be constructed, and the honest construction is "same-type
  nearest-neighbour pairs that have survived N nightly passes as distinct entities". That is
  weaker (a straddling pair looks identical to a declined one) and it must be said.
- **The sample is small.** The 2026-09-12 run merged 27 entities, most of them a three-week
  backlog. The nightly rate since is what it is.

The data is on the box: `/opt/mot/ontology/graph.jsonl` and the `entity_vec` table in
`/opt/mot/mot.db`. The local `mot.db` is a stale snapshot with no graph beside it, so the script
runs against a fresh pull (memory note `local-dev-data-from-prod` has the recipe).

The measurement: distance for every recoverable (loser, survivor) pair; distance for every
top-1 nearest-neighbour pair among survivors; plot both. If they separate, the crossover is a
candidate fast-path threshold. If they overlap, which the #43 distributions suggest is likely, the
fast path is off and the value of this idea is entirely in the candidate narrowing.

## Honest counter-argument

Entity dedup is harder than clustering. "Arowyn" and "my daughter" should merge and are not close
in embedding space; "Contabo box" and "Lightsail box" are close and must not. Geometry is wrong in
both directions on exactly the cases that matter most, which is why the model rung exists.

So the claim is not "replace the LLM with cosine". It is "stop chunking by insertion order, hand the
model a ranked neighbourhood instead of a slice, and skip it only where a measurement says
skipping is safe". If the measurement shows the populations overlap, the fast path is set
conservatively or not at all, and the top-K narrowing is still worth having because it is the only
thing here that closes the stable-chunk blind spot.

One more thing EverAlgo does that is worth knowing: `everalgo-knowledge/_batch_merge.py` handles
duplicates that straddle a batch split with a *second* LLM pass over the flattened outputs of all
batches, deterministic code rebuilding the structure afterwards. That is the other cure for the
same disease, and it is closer to M.O.T.'s existing identify-then-execute pattern than a KNN
rewrite is. It does not reduce the number of calls; it adds one.

## Possible next step

Two, in order:

1. Run the measurement above against a prod snapshot. It needs one script and no code changes,
   and it decides whether a no-model fast path exists at all.
2. Independently of the answer, swap `scanForDuplicates`'s Levenshtein for a KNN top-K over
   `entity_vec` (bypassing the #43 floor), and have the nightly dedup pass consume flagged
   entities with their candidates instead of type-group chunks. That is the smallest change that
   removes the blind spot, and it is worth doing even if the fast path never ships.

// Track 5, Phase 2 — Reciprocal Rank Fusion (FR 14). No imports: this is the single,
// dependency-free place hybrid retrieval fuses an FTS list with a vector list.

/** One fused result, with the score and which input lists contributed to it. */
export interface ScoredResult<T> {
  item: T;
  /** Sum of 1/(k + rank) across the lists that contained this item. Higher is better. */
  score: number;
  /** Indices of the input lists this item appeared in. Length > 1 means the arms agreed. */
  lists: number[];
}

/**
 * How much MORE than the caller's limit each arm should fetch before fusion (issue #40).
 *
 * Fusion's whole advantage over a single ranker is rewarding rows both arms found. A row at rank
 * 25 in FTS and rank 25 in vector is strong agreement, but if both arms are cut at the output
 * size it appears in neither list and the agreement is invisible. Over-fetching gives fusion
 * something to agree about; the merge truncates back to the caller's limit afterwards.
 */
export const FUSION_FETCH_MULTIPLIER = 3;

/**
 * Merge ranked lists by Reciprocal Rank Fusion, returning scores.
 *
 * Score per item = sum of 1/(k + rank) across lists, rank 1-indexed. Items in multiple lists
 * have their scores summed, which is the entire point.
 *
 * Deliberately NOT applied here:
 *
 * - **Recency weighting.** A ranking that systematically demotes old rows is a soft form of the
 *   decay the memory design rejects: the fact is not deleted, it just stops being findable, which
 *   is the same user-visible outcome for a worse reason. If a per-query recency option is ever
 *   added it must default to off.
 * - **Semantic-discovery boost.** crispy-recall lifts rows only the vector arm found by 1.05, on
 *   the argument that a wording-mismatch hit is the reason the semantic arm exists. Plausible,
 *   but it is an unmeasured constant whose failure mode (floating vector noise above solid
 *   keyword matches) is subtle. Left out until something measures it.
 */
export function rrfMergeScored<T extends { id: string | number }>(
  lists: T[][],
  opts: { k?: number; limit: number },
): ScoredResult<T>[] {
  const k = opts.k ?? 60;
  const scores = new Map<string, ScoredResult<T>>();

  lists.forEach((list, listIndex) => {
    list.forEach((item, index) => {
      // String(id) assumes all merged lists share ONE id-space (true for every current
      // caller — each merge is within a single store); merging two id-spaces where
      // numeric 42 and "42" collide would need a compound key.
      const key = String(item.id);
      const contribution = 1 / (k + index + 1); // rank is 1-indexed
      const existing = scores.get(key);
      if (existing) {
        existing.score += contribution;
        existing.lists.push(listIndex);
      } else {
        scores.set(key, { item, score: contribution, lists: [listIndex] });
      }
    });
  });

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit);
}

/**
 * Merge ranked lists by RRF and return just the items.
 *
 * Thin wrapper over rrfMergeScored so existing callers keep their signature.
 */
export function rrfMerge<T extends { id: string | number }>(
  lists: T[][],
  opts: { k?: number; limit: number },
): T[] {
  return rrfMergeScored(lists, opts).map((e) => e.item);
}

/** Scan for the cliff starting here. */
const CUTOFF_SCAN_FROM = 10;
/** A drop must exceed this fraction of the current score to count as the cliff. */
const CUTOFF_MIN_DROP = 0.15;

/**
 * Truncate a ranked list at its largest relative score drop.
 *
 * A good ranking is usually not a smooth gradient: it is a cluster of rows that actually match,
 * then a cliff, then a long flat tail of rows that scored above zero for incidental reasons. The
 * cliff is where the answer ends. Finding it costs one linear pass over an already-sorted list.
 *
 * Scanning starts at position 10 on purpose. The top of a ranking is often steep by nature (rank
 * 1 to rank 2 is frequently the biggest relative drop in the whole list), so scanning from zero
 * would cut nearly every query down to a single result.
 *
 * No-ops on lists too short to have a meaningful tail, and on genuinely flat rankings where no
 * drop clears the threshold — in both cases the caller's own limit remains the only bound. RRF
 * scores are comparable only WITHIN one result set, never across queries, which is why this
 * compares neighbours rather than testing an absolute threshold.
 */
export function scoreGapCutoff<T>(scored: ScoredResult<T>[]): ScoredResult<T>[] {
  if (scored.length <= CUTOFF_SCAN_FROM) return scored;

  let maxDrop = 0;
  let cutAt = -1;
  for (let i = CUTOFF_SCAN_FROM; i < scored.length - 1; i++) {
    const curr = scored[i].score;
    if (curr <= 0) continue;
    const drop = (curr - scored[i + 1].score) / curr;
    if (drop > maxDrop) {
      maxDrop = drop;
      cutAt = i + 1;
    }
  }
  return maxDrop > CUTOFF_MIN_DROP ? scored.slice(0, cutAt) : scored;
}

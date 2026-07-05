// Track 5, Phase 2 — pure Reciprocal Rank Fusion merge helper (FR 14). No imports: this is
// the single, dependency-free place hybrid retrieval fuses an FTS list with a vector list.

/**
 * Merge two or more ranked result lists using Reciprocal Rank Fusion (FR 14).
 * Score per item = sum of 1/(k + rank) across lists, where rank is 1-indexed.
 * Items appearing in multiple lists have their scores summed.
 * Output is sorted descending by score, de-duped on id, and truncated to limit.
 *
 * All item types must have an `id: string | number` field.
 */
export function rrfMerge<T extends { id: string | number }>(
  lists: T[][],
  opts: { k?: number; limit: number },
): T[] {
  const k = opts.k ?? 60;
  const scores = new Map<string, { item: T; score: number }>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const key = String(item.id);
      const contribution = 1 / (k + index + 1); // rank is 1-indexed
      const existing = scores.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(key, { item, score: contribution });
      }
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit)
    .map((e) => e.item);
}

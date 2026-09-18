// Issue #40 — RRF scores, over-fetch, and the score-gap cutoff.
// Pure functions, no DB: these assert the fusion maths and the truncation rule directly.

import { describe, it, expect } from 'vitest';
import {
  rrfMerge,
  rrfMergeScored,
  scoreGapCutoff,
  FUSION_FETCH_MULTIPLIER,
  type ScoredResult,
} from '../../lib/rrf';

const row = (id: number) => ({ id });
const ids = (rs: { id: number }[]) => rs.map((r) => r.id);

describe('rrfMergeScored', () => {
  it('ranks a row both lists found above a row only one list found', () => {
    // 7 is rank 3 in both arms; 1 is rank 1 in one arm and absent from the other.
    const a = [row(1), row(2), row(7)];
    const b = [row(4), row(5), row(7)];
    const out = rrfMergeScored([a, b], { limit: 10 });
    expect(out[0].item.id).toBe(7);
    expect(out[0].lists).toEqual([0, 1]);
  });

  it('records which lists contributed, so agreement is inspectable', () => {
    const out = rrfMergeScored([[row(1)], [row(1)], [row(2)]], { limit: 10 });
    const one = out.find((e) => e.item.id === 1)!;
    expect(one.lists).toEqual([0, 1]);
    expect(out.find((e) => e.item.id === 2)!.lists).toEqual([2]);
  });

  it('sums 1/(k + rank) with rank 1-indexed', () => {
    const out = rrfMergeScored([[row(1)]], { k: 60, limit: 1 });
    expect(out[0].score).toBeCloseTo(1 / 61, 10);
  });

  it('truncates to limit after sorting, not before', () => {
    const a = [row(1), row(2), row(3)];
    const b = [row(3), row(4), row(5)];
    expect(ids(rrfMergeScored([a, b], { limit: 2 }).map((e) => e.item))).toEqual([3, 1]);
  });
});

describe('rrfMerge stays a thin wrapper', () => {
  it('returns the same order as rrfMergeScored, items only', () => {
    const a = [row(1), row(2), row(7)];
    const b = [row(4), row(7)];
    expect(ids(rrfMerge([a, b], { limit: 10 }))).toEqual(
      rrfMergeScored([a, b], { limit: 10 }).map((e) => e.item.id),
    );
  });
});

describe('over-fetch is what makes agreement visible', () => {
  it('finds the consensus row only when the arms fetch past the output size', () => {
    // A row agreed on at rank 12 in both arms, against a row at rank 1 in one arm alone.
    const a = [row(99), ...Array.from({ length: 11 }, (_, i) => row(i)), row(50)];
    const b = [row(98), ...Array.from({ length: 11 }, (_, i) => row(100 + i)), row(50)];
    const limit = 5;

    // Truncated arms (the old behaviour): 50 is in neither list, so fusion cannot see it.
    const narrow = rrfMergeScored([a.slice(0, limit), b.slice(0, limit)], { limit });
    expect(ids(narrow.map((e) => e.item))).not.toContain(50);

    // Over-fetched arms: 50 appears in both and wins.
    const wide = rrfMergeScored(
      [a.slice(0, limit * FUSION_FETCH_MULTIPLIER), b.slice(0, limit * FUSION_FETCH_MULTIPLIER)],
      { limit },
    );
    expect(wide[0].item.id).toBe(50);
  });
});

describe('scoreGapCutoff', () => {
  const mk = (scores: number[]): ScoredResult<{ id: number }>[] =>
    scores.map((score, i) => ({ item: { id: i }, score, lists: [0] }));

  it('leaves short lists alone — no meaningful tail to cut', () => {
    const s = mk([9, 8, 7, 6, 5]);
    expect(scoreGapCutoff(s)).toHaveLength(5);
  });

  it('cuts at the cliff', () => {
    // Twelve solid scores, then a collapse.
    const s = mk([...Array(12).fill(1), 0.1, 0.09, 0.08]);
    expect(scoreGapCutoff(s)).toHaveLength(12);
  });

  it('leaves a flat ranking intact, since no drop clears the threshold', () => {
    const s = mk(Array.from({ length: 30 }, (_, i) => 1 - i * 0.001));
    expect(scoreGapCutoff(s)).toHaveLength(30);
  });

  it('never cuts before position 10, so a steep top does not collapse the list', () => {
    // Biggest relative drop is rank 1 -> 2; scanning from 0 would return a single row.
    const s = mk([100, 1, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94, 0.93, 0.92, 0.91, 0.9]);
    expect(scoreGapCutoff(s).length).toBeGreaterThan(1);
  });

  it('only ever shrinks, so the caller limit stays the ceiling', () => {
    const s = mk([...Array(12).fill(1), 0.01]);
    expect(scoreGapCutoff(s).length).toBeLessThanOrEqual(s.length);
  });

  it('tolerates zero and negative scores without dividing by zero', () => {
    const s = mk([...Array(11).fill(1), 0, 0, 0]);
    expect(() => scoreGapCutoff(s)).not.toThrow();
  });
});

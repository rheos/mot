import { describe, it, expect, vi } from 'vitest';

// Recallatron Track 4 — AC-3: the four branch reads overlap (Promise.all), they do not run
// serially. This file vi.mock()s the four source modules so each branch function returns a
// Promise that resolves after ~50ms. memoryContext builds all four promises before awaiting
// Promise.all, so the wall-clock time is ~50ms (the longest single branch), NOT ~200ms (the
// sum). A plain sync shim cannot produce this difference — the shims MUST be async.
//
// Kept in its own file: these module mocks are hoisted and would otherwise replace the real lib
// functions for the real-data tests in memory-context.test.ts.

const DELAY_MS = 50;

function delayed<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), DELAY_MS));
}

// memory-context imports listThreads from ./topics, searchEntities from ./graph,
// listNotes from ./procedural, getActiveMemory + searchActiveMemory from ./memory.
// Each mock returns an awaitable Promise (memoryContext awaits a Promise.all over them).
vi.mock('../../lib/topics', () => ({
  listThreads: vi.fn(() => delayed([])),
}));
vi.mock('../../lib/graph', () => ({
  searchEntities: vi.fn(() => delayed([])),
}));
vi.mock('../../lib/procedural', () => ({
  listNotes: vi.fn(() => delayed({})),
}));
vi.mock('../../lib/memory', () => ({
  getActiveMemory: vi.fn(() => delayed([])),
  searchActiveMemory: vi.fn(() => delayed([])),
}));

const { memoryContext } = await import('../../lib/memory-context');

describe('memoryContext — parallel-branch timing (AC-3)', () => {
  it('four 50ms async branches overlap: completes in ≤100ms, not ~200ms', async () => {
    const start = performance.now();
    const ctx = await memoryContext();
    const elapsed = performance.now() - start;

    // Sequential would be ~4 × 50ms = 200ms. Promise.all overlap → ~50ms; allow headroom to 100ms.
    expect(elapsed).toBeLessThanOrEqual(100);

    // The shape still resolves to the four keys (the mocks return empties).
    expect(Array.isArray(ctx.topics)).toBe(true);
    expect(Array.isArray(ctx.entities)).toBe(true);
    expect(Array.isArray(ctx.procedural)).toBe(true);
    expect(Array.isArray(ctx.recent_memory)).toBe(true);
  });
});

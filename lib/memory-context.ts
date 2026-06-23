// Recallatron Track 4 — the one-call session boot bundle (FR-1).
//
// memoryContext reads the four Recallatron stores in one shot: recent topic threads, active
// entities, confirmed procedural notes, and recent memory items. With a non-empty `q` each
// section is relevance-filtered; with an empty/absent `q` each returns recency-ordered items.
//
// The four branch lib functions are all synchronous today, so the Promise.all does NOT
// parallelise anything at runtime — it is not a production speedup over a sequential read of
// sync functions. The Promise.all shape exists to satisfy FR-1.3 / AC-3 (whose test swaps in
// async 50ms shims and asserts the four overlap) and to forward-guard if any branch later
// becomes genuinely async. Each branch is an async fn that AWAITS its lib call (a no-op for a
// sync return, real overlap for an async one); all four promises are built before the await.

import { listThreads, type TopicThreadWithCount } from './topics';
import { searchEntities, type EntityRecord } from './graph';
import { listNotes, type ProceduralNote } from './procedural';
import { getActiveMemory, searchActiveMemory, type MemoryRow } from './memory';

export interface MemoryContext {
  topics: TopicThreadWithCount[];
  entities: EntityRecord[];
  procedural: ProceduralNote[];
  recent_memory: MemoryRow[];
}

export async function memoryContext(
  q?: string,
  chatId?: string,
  limit?: number,
): Promise<MemoryContext> {
  const needle = q?.trim() ?? '';
  const hasQuery = needle !== '';

  // TOPICS — listThreads takes no q arg; filter + limit in-memory.
  const topicsBranch = async (): Promise<TopicThreadWithCount[]> => {
    let threads = await listThreads();
    if (hasQuery) {
      const lc = needle.toLowerCase();
      threads = threads.filter((t) =>
        `${t.title} ${t.slug} ${t.notes ?? ''}`.toLowerCase().includes(lc),
      );
    }
    return threads.slice(0, limit ?? 3);
  };

  // ENTITIES — searchEntities('') matches all active entities (empty needle, graph.ts:227).
  const entitiesBranch = async (): Promise<EntityRecord[]> => {
    const entities = await searchEntities(q ?? '');
    return entities.slice(0, limit ?? 5);
  };

  // PROCEDURAL — listNotes(undefined, false) returns confirmed notes grouped by category
  // (Record<string, ProceduralNote[]>, procedural.ts:69); flatten to a flat array. No limit
  // (spec: all confirmed).
  const proceduralBranch = async (): Promise<ProceduralNote[]> => {
    const grouped = (await listNotes(undefined, false)) as Record<string, ProceduralNote[]>;
    let notes = Object.values(grouped).flat();
    if (hasQuery) {
      const lc = needle.toLowerCase();
      notes = notes.filter((n) => n.note.toLowerCase().includes(lc));
    }
    return notes;
  };

  // RECENT_MEMORY — a non-empty/non-whitespace q goes to FTS search; otherwise recency.
  // CRITICAL: an empty/whitespace q MUST route to getActiveMemory, never searchActiveMemory('')
  // — searchActiveMemory short-circuits to [] on an empty needle (memory.ts:259), which would
  // silently drop every recency result.
  const recentBranch = async (): Promise<MemoryRow[]> =>
    hasQuery
      ? searchActiveMemory(needle, chatId, limit ?? 10)
      : getActiveMemory(chatId, limit ?? 10);

  // Build all four promises before any await — Promise.all overlaps them (AC-3).
  const [topics, entities, procedural, recent_memory] = await Promise.all([
    topicsBranch(),
    entitiesBranch(),
    proceduralBranch(),
    recentBranch(),
  ]);

  return { topics, entities, procedural, recent_memory };
}

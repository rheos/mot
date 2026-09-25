// Adjacency-enriched embed input, and the version stamp that records which rule produced a
// stored vector.
//
// ATTRIBUTION. The technique, this function's shape, and the constant names below follow
// crispy-recall by Sylvester Wong (https://github.com/TheSylvester/crispy-recall), MIT licensed,
// Copyright (c) 2026 Sylvester Wong. `buildEmbedText` here is a close paraphrase of the original
// in its `src/recall/embed-config.ts`, not an independent implementation, so the notice travels
// with it. Divergences are ours and are marked where they occur (session-boundary handling,
// call-time thresholds, the sidecar version table).
//
// Embed-input representation — the single source of truth for what text actually gets embedded,
// and for the version stamp that records which rule produced a stored vector.
//
// Why this is its own dependency-free module (same reasoning as lib/rrf.ts): the write paths
// (lib/vec.ts, lib/conversation.ts, lib/digest.ts) and the backfill script must all agree on the
// embed input byte-for-byte. A drift between them produces vectors that are silently incomparable
// — no error, just worse retrieval.

// Bump EMBED_VERSION whenever the embed *input* changes: the model, a task-instruction prefix,
// pooling, or the enrichment rule below. Vectors carrying an older version are re-embedded by
// scripts/backfill-embeddings.ts; until they are, they stay scorable (the never-reject degrade
// contract, ratified 2026-07-06 — a representation migration must not black out semantic search).
//
//   1 = bare turn text (every vector written before 2026-09-18)
//   2 = adjacency-enriched: short turns carry their preceding in-session turn
export const EMBED_VERSION = 2;

// A vector row with no recorded version predates the stamp and is therefore representation 1.
// This is why 0010 needs no data migration: absence IS the answer.
export const IMPLICIT_EMBED_VERSION = 1;

const DEFAULT_ENRICH_MAX_CHARS = 200;
const DEFAULT_ENRICH_PREV_CHARS = 512;

/** Separator between prepended context and the turn's own text. */
export const ENRICH_SEP = '\n';

// Read at call time, not at module load, so both tests and prod can retune without a redeploy
// (same pattern as MOT_GRAPH_PATH and MAINTAINER_BATCH_SIZE). Guarded against 0/NaN/negative:
// a bad env value falls back to the default rather than disabling or exploding enrichment.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Turns shorter than this get adjacency context prepended to their embed input. */
export function enrichMaxChars(): number {
  return envInt('EMBED_ENRICH_MAX_CHARS', DEFAULT_ENRICH_MAX_CHARS);
}

/** Max chars of preceding-turn context to prepend. */
export function enrichPrevChars(): number {
  return envInt('EMBED_ENRICH_PREV_CHARS', DEFAULT_ENRICH_PREV_CHARS);
}

/**
 * Build the text to EMBED for a turn. Never mutates what is stored or what FTS indexes —
 * `conversation.content` and `conversation_fts` are untouched by this function's existence.
 *
 * Measured on the live corpus 2026-09-17: 67% of turns and 95% of USER turns fall under 200
 * chars. Embedded bare, those vectors encode the shape of an utterance ("ok ship it") and none
 * of its subject, so the vector arm cannot retrieve them for any question a human would ask —
 * and worse, returns them for questions it should not.
 *
 * `prevText` must be the preceding turn IN THE SAME SESSION. Callers pass null at a session
 * boundary: M.O.T. sessionizes on a 2-hour gap, so the turn before a boundary is unrelated
 * context and is worse than no context. (crispy-recall, the source of this technique, has no
 * session concept and always reaches backwards.)
 */
export function buildEmbedText(text: string, prevText: string | null): string {
  const own = text.replaceAll('\0', '');
  if (own.length >= enrichMaxChars()) return own;
  const prev = prevText?.replaceAll('\0', '') ?? '';
  if (prev === '') return own;
  return prev.slice(-enrichPrevChars()) + ENRICH_SEP + own;
}

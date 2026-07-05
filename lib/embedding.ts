// Track 5, Phase 1 — the embedding function (server-only; never imported by Edge routes).
//
// Wraps fastembed's AllMiniLM-L6-v2 (384-dim, unit-normalized). MiniLM is symmetric, so a
// single shared embed() is used for both indexing and query — queryEmbed (the single-text
// call) is correct for both. The model is initialized lazily and memoized: the first embed
// call pays the download+load cost, every call after reuses the one FlagEmbedding instance.
//
// Type-vs-runtime note: fastembed's .d.ts declares queryEmbed as Promise<number[]>, but at
// runtime it returns a genuine Float32Array(384). `Float32Array.from` bridges both — it
// accepts either ArrayLike and always yields a real Float32Array.

import { EmbeddingModel, FlagEmbedding } from 'fastembed';

// Memoized init promise — resolve once, reuse on every embed call. On failure the promise is
// cleared so the next call can retry (a transient download hiccup shouldn't wedge the model).
let _initPromise: Promise<FlagEmbedding> | null = null;

function getModel(): Promise<FlagEmbedding> {
  if (_initPromise === null) {
    _initPromise = FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2, // 384-dim, unit-normalized
      // fastembed's own default drops an untracked local_cache/ in cwd; .model-cache is
      // gitignored + deploy-excluded.
      cacheDir: process.env.EMBEDDING_CACHE_DIR ?? './.model-cache',
    }).catch((err) => {
      _initPromise = null; // allow retry on next call
      throw err;
    });
  }
  return _initPromise;
}

// Lazy per-call env read (same pattern as MOT_GRAPH_PATH at graph.ts) so tests can flip the
// switch after import. This is the single global off-switch for embedding.
export function embeddingEnabled(): boolean {
  return process.env.MOT_EMBED_DISABLE !== '1';
}

// Memoized final boolean — a second call after an init failure short-circuits to false
// without re-attempting init. The disable check is NOT memoized (checked every call) so a
// test flipping MOT_EMBED_DISABLE is honoured immediately.
let _available: boolean | null = null;

export async function embedderAvailable(): Promise<boolean> {
  if (!embeddingEnabled()) return false;
  if (_available !== null) return _available;
  try {
    await getModel();
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

export async function embed(text: string): Promise<Float32Array> {
  if (!embeddingEnabled()) throw new Error('embedding disabled');
  const model = await getModel();
  // queryEmbed is a single-text Promise (no generator). Float32Array.from compiles against
  // the declared number[] type and yields a real Float32Array whether the runtime returns
  // number[] or Float32Array.
  return Float32Array.from(await model.queryEmbed(text));
}

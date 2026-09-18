// FTS5 query helpers — shared by lib/tickets.ts, lib/conversation.ts and lib/memory.ts.
//
// The job here is to turn a human's words into an FTS5 MATCH expression that (a) cannot inject
// FTS5 operators, and (b) actually matches something. Those pull in opposite directions, which is
// why this file is bigger than the one-line `ftsPhrase` it replaces.

import { getDb } from '../db/client';

/** The FTS tables this module can compute document frequencies against. */
export type FtsTable = 'conversation_fts' | 'memory_items_fts' | 'ticket_fts';

/** Base table whose row count is the document-frequency denominator for each FTS index. */
const SOURCE_TABLE: Record<FtsTable, string> = {
  conversation_fts: 'conversation',
  memory_items_fts: 'memory_items',
  ticket_fts: 'ticket',
};

/**
 * Structural English function words, dropped regardless of corpus frequency.
 *
 * The corpus-adaptive filter below is the general mechanism, but it UNDER-FILTERS on a small
 * corpus. Measured 2026-09-17 on 1,034 documents: "the" is 54% and gets dropped, but "why" /
 * "did" / "we" / "off" all sit under 15% and survive, because there simply are not enough
 * documents yet for them to cross. Lowering the threshold is not the answer — "we" is 10.6%
 * while the domain terms "mcp" (11.1%) and "tool" (11.3%) sit right beside it, so any cut
 * aggressive enough to catch function words eats the vocabulary that actually discriminates.
 *
 * So: union of both. This list handles words that are structurally contentless in any corpus;
 * the adaptive filter handles words that become common in THIS one (as "mot", "ticket" and
 * "rheo" eventually will), which a static list could never keep up with.
 */
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did',
  'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its',
  'me', 'my', 'of', 'off', 'on', 'or', 'our', 'out', 's', 'so', 'some', 't', 'that', 'the',
  'their', 'them', 'then', 'there', 'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

const DEFAULT_DF_THRESHOLD = 0.15;
/** IDF filtering only engages at this many terms — short queries are already specific. */
const MIN_TERMS_FOR_IDF = 3;
/** If the filter would drop everything, keep this many of the rarest terms instead. */
const RAREST_KEPT = 5;

/**
 * Drop terms appearing in more than this fraction of indexed rows. Read at call time so it is
 * tunable without a redeploy; a junk or out-of-range value falls back to the default rather than
 * disabling the filter or dropping everything.
 */
export function dfThreshold(): number {
  const n = Number(process.env.FTS_DF_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_DF_THRESHOLD;
}

/**
 * Wrap a single token as an FTS5 phrase literal.
 *
 * Every token reaching MATCH goes through here, which is what makes injection impossible: a
 * quoted phrase is not parsed for operators, so `-`, `*`, `NEAR`, `:` and friends are inert.
 */
function quote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Split a user query into tokens, preserving anything the user explicitly double-quoted as a
 * single multi-word token.
 *
 * The separator normalization is load-bearing. The tokenizer treats `-` and `_` as separators,
 * but FTS5 QUERY syntax reads a leading `-` as NOT, so a raw `mot-intake` means "mot WITHOUT
 * intake" — the opposite of the intent, and it silently inverts every kebab-case identifier in
 * this project. Normalize before any FTS5 parsing, never after.
 */
export function tokenize(q: string): { tokens: string[]; userPhrases: string[] } {
  const userPhrases: string[] = [];
  // Pull out "quoted runs" first so the user keeps exact-phrase search when they ask for it.
  const rest = q.replace(/"([^"]+)"/g, (_m, inner: string) => {
    const phrase = inner.replace(/[_-]+(?=\w)/g, ' ').trim();
    if (phrase) userPhrases.push(phrase);
    return ' ';
  });
  const tokens = rest
    // hyphen/underscore BETWEEN word characters -> space (see above)
    .replace(/(\w)[_-]+(\w)/g, '$1 $2')
    // everything else that is not a word char or whitespace is dropped, not escaped: it cannot
    // survive into MATCH, so there is nothing to inject with.
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return { tokens, userPhrases };
}

// ── Index-native stemming ────────────────────────────────────────────────────
// A query term must be stemmed exactly the way the index stemmed the document, or the vocab
// lookup misses and every term looks rare. Rather than reimplement Porter in JS and hope it
// agrees with SQLite's C implementation, push the word through a scratch FTS5 table using the
// SAME tokenizer and read back what it produced. No drift is possible.
//
// `temp.`-qualified and per-connection: a shared persistent scratch table would race between
// concurrent readers.
let stemScratchReady = false;

function ensureStemScratch(db: ReturnType<typeof getDb>): void {
  if (stemScratchReady) return;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp._fts_stem USING fts5(t, tokenize='porter');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp._fts_stem_vocab USING fts5vocab(temp, _fts_stem, 'row');
  `);
  stemScratchReady = true;
}

/** Resolve a word's stem using FTS5's own tokenizer. Falls back to lowercase on any failure. */
export function fts5Stem(word: string): string {
  try {
    const db = getDb();
    ensureStemScratch(db);
    db.prepare('DELETE FROM temp._fts_stem').run();
    db.prepare('INSERT INTO temp._fts_stem(t) VALUES (?)').run(word);
    const row = db.prepare('SELECT term FROM temp._fts_stem_vocab LIMIT 1').get() as
      | { term: string }
      | undefined;
    return row?.term ?? word.toLowerCase();
  } catch {
    return word.toLowerCase();
  }
}

// ── Document frequency ───────────────────────────────────────────────────────
// fts5vocab reads the INDEX, not the content, so it works on these contentless (`content=''`)
// tables. Verified against the real database before this was built on.

/** Cached row counts per source table, refreshed at most once a minute. */
const totalCache = new Map<FtsTable, { n: number; at: number }>();

function totalDocs(table: FtsTable): number {
  const hit = totalCache.get(table);
  const now = Date.now();
  if (hit && now - hit.at < 60_000) return hit.n;
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM ${SOURCE_TABLE[table]}`)
      .get() as { c: number };
    const n = Math.max(row.c, 1);
    totalCache.set(table, { n, at: now });
    return n;
  } catch {
    return hit?.n ?? 1;
  }
}

let vocabReady = new Set<FtsTable>();

/** Fraction of indexed rows containing `term` (0..1). Unknown or on error -> 0 (assume rare). */
export function docFrequency(term: string, table: FtsTable): number {
  try {
    const db = getDb();
    const view = `_vocab_${table}`;
    if (!vocabReady.has(table)) {
      // 3-arg form: the FTS table lives in `main`, the vocab view in `temp`.
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${view} USING fts5vocab(main, ${table}, 'row')`);
      vocabReady.add(table);
    }
    const row = db
      .prepare(`SELECT doc FROM temp.${view} WHERE term = ?`)
      .get(fts5Stem(term)) as { doc: number } | undefined;
    return row ? row.doc / totalDocs(table) : 0;
  } catch {
    return 0;
  }
}

/**
 * Build an FTS5 MATCH expression from a user query.
 *
 * Replaces the previous `ftsPhrase`, which wrapped the WHOLE query in quotes and therefore
 * required an exact phrase match — so every natural-language question returned nothing while its
 * content sat in the index (issue #37).
 *
 * Shape:
 *   - 1-2 terms            -> OR of the quoted terms (already specific; no filtering)
 *   - 3+ terms             -> drop terms above the document-frequency threshold, then OR
 *   - all terms dropped    -> keep the RAREST_KEPT rarest, never an empty match
 *   - explicit "quoted"    -> honoured as a phrase and never IDF-filtered
 *
 * OR rather than AND: BM25 already ranks a row matching two rare terms above one matching a
 * single common one, so OR buys recall without giving up precision in the ranking.
 *
 * Returns '' when nothing survives; callers MUST treat that as "no FTS constraint" and fall back,
 * exactly as they already do for empty input.
 */
export function ftsQuery(q: string, table: FtsTable, opts?: { skipIdf?: boolean }): string {
  const { tokens, userPhrases } = tokenize(q);
  const parts: string[] = userPhrases.map(quote);

  let terms = tokens;
  if (!opts?.skipIdf && terms.length >= MIN_TERMS_FOR_IDF) {
    const cut = dfThreshold();
    const scored = terms.map((t) => ({ t, df: docFrequency(t, table) }));
    const kept = scored.filter((s) => !STOPWORDS.has(s.t.toLowerCase()) && s.df < cut);
    terms = kept.length > 0
      ? kept.map((s) => s.t)
      // Everything was common. Returning an empty match would be worse than a noisy one, so keep
      // the rarest few and let BM25 sort them out.
      // Everything was filtered. Prefer the rarest non-stopwords; only if there are none at all
      // do stopwords come back, because an empty MATCH is worse than a noisy one.
      : [...scored]
          .sort((a, b) => {
            const sa = STOPWORDS.has(a.t.toLowerCase()) ? 1 : 0;
            const sb = STOPWORDS.has(b.t.toLowerCase()) ? 1 : 0;
            return sa !== sb ? sa - sb : a.df - b.df;
          })
          .slice(0, RAREST_KEPT)
          .map((s) => s.t);
  }

  parts.push(...terms.map(quote));
  return parts.join(' OR ');
}

/**
 * Wrap a user query as a single FTS5 phrase literal (exact-match search).
 *
 * Retained because exact phrase matching is still the right tool sometimes, and because a caller
 * that genuinely wants it should not have to hand-roll the escaping. `ftsQuery` is the default.
 */
export function ftsPhrase(q: string): string {
  return quote(q);
}

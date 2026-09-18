// Instrumentation for the MCP surface: what the agents actually ask for.
//
// Four retrieval changes shipped in one day against assumptions about caller behaviour that
// nobody could check, because nothing recorded how these tools were invoked. This closes that.
//
// Discipline, borrowed from the write-path rule that already governs memory capture: logging
// MUST NOT be able to fail a tool call. Every write here is wrapped and swallowed. Losing a log
// row is nothing; failing Rheo's reply because the log table is locked is unacceptable.

import { getDb } from '../db/client';
import { nowIso } from './time';

/** Off-switch, read at call time. Set MOT_TOOL_LOG_DISABLE=1 to stop recording without a deploy. */
function enabled(): boolean {
  return process.env.MOT_TOOL_LOG_DISABLE !== '1';
}

/**
 * Tools whose `q` is recorded verbatim. These are the READ paths, where the query text is the
 * signal being studied: how long is it, is it keywords or a sentence, which mode does it carry.
 *
 * Everything else records only argument NAMES. A ticket body or a memory item already lives in
 * its proper store; copying it here would make this table a second, unmanaged home for content
 * and would widen what a log leak exposes.
 */
const QUERY_TOOLS = new Set([
  'chat_search',
  'memory_recent',
  'entity_search',
  'memory_context',
  'procedural_notes_list',
  'mot_list_tickets',
]);

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  /** Rows returned, when the handler could determine it. */
  resultCount?: number;
}

/** Word count of a query, so shape stays analysable even where text is not recorded. */
function wordCount(q: string): number {
  return q.trim() === '' ? 0 : q.trim().split(/\s+/).length;
}

/**
 * Record one MCP tool call. Never throws, never rejects, never blocks a reply.
 */
export function logToolCall(rec: ToolCallRecord): void {
  if (!enabled()) return;
  try {
    const rawQ = QUERY_TOOLS.has(rec.tool) && typeof rec.args.q === 'string' ? rec.args.q : null;
    const mode = typeof rec.args.mode === 'string' ? rec.args.mode : null;
    getDb()
      .prepare(
        `INSERT INTO tool_call_log
           (ts, tool, query, query_len, mode, arg_keys, result_count, duration_ms, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowIso(),
        rec.tool,
        rawQ,
        rawQ !== null ? wordCount(rawQ) : null,
        mode,
        Object.keys(rec.args).sort().join(','),
        rec.resultCount ?? null,
        Math.round(rec.durationMs),
        rec.ok ? 1 : 0,
      );
  } catch (err) {
    // Swallowed on purpose. See the module header.
    console.error('[MOT/tool-log] failed to record a tool call (ignored):', err);
  }
}

/**
 * Best-effort row count from a tool's response payload, for the `result_count` column.
 *
 * Handlers return ToolContent (a text block holding JSON), so this re-parses rather than
 * threading a count through every case. Cheap relative to the call it describes, and entirely
 * optional — an unparseable or unshaped payload simply records NULL.
 */
export function countResults(content: unknown): number | undefined {
  try {
    const first = Array.isArray(content) ? (content[0] as { text?: string }) : undefined;
    if (!first?.text) return undefined;
    const parsed = JSON.parse(first.text) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    // { retrieval, results } — the shape chat_search adopted in #45.
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { results?: unknown }).results)) {
      return ((parsed as { results: unknown[] }).results).length;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

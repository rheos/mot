// scripts/backfill-relations.ts
//
// One-off RELATION backfill. Relation extraction only went live 2026-07-09, so historical session
// digests never had a relation_draft — the entity graph has entities but no edges from the past.
// This re-reads each historical conversation session, extracts relationships with the LLM (the
// canonical EXTRACTION_PROMPT_GUIDANCE), and feeds them through the SAME deployed pipeline the live
// path uses (runExtraction → processRelations): resolved against existing entities via matchByLabel,
// gated at confidence >= 0.85, appended as UNCONFIRMED candidate edges (confirmed:false). Nothing is
// auto-confirmed. Unlike the embedding backfill (a free re-index of existing text), this needs one
// LLM pass per session because the relationships were never extracted from these transcripts before.
//
//   MUST run on the prod box (that's where the conversation history + graph.jsonl live).
//   npx tsx scripts/backfill-relations.ts --dry-run          # report sessions, no LLM / no writes
//   npx tsx scripts/backfill-relations.ts [--limit N]        # real run (optionally cap sessions)
//
// Idempotent: a session that already has >= 1 relate patch sourced `session:<id>` is skipped, so a
// re-run only fills sessions that missed the first pass.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, migrate_db } from '../db/client';
import { EXTRACTION_PROMPT_GUIDANCE, runExtraction } from '../lib/extraction';
import type { DigestRow } from '../lib/digest';

interface Turn {
  role: string;
  content: string;
  ts: string;
}

function graphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

function parseArgs(argv: string[]): { dryRun: boolean; limit: number } {
  const dryRun = argv.includes('--dry-run');
  const li = argv.indexOf('--limit');
  const limit = li >= 0 && argv[li + 1] ? parseInt(argv[li + 1], 10) : Number.POSITIVE_INFINITY;
  return { dryRun, limit };
}

// session_ids that already carry >= 1 relate patch sourced from them → skip (idempotency).
function alreadyBackfilled(): Set<string> {
  const done = new Set<string>();
  const file = graphPath();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { op?: string; source?: string };
      if (rec.op === 'relate' && typeof rec.source === 'string' && rec.source.startsWith('session:')) {
        done.add(rec.source.slice('session:'.length));
      }
    } catch {
      /* skip malformed line */
    }
  }
  return done;
}

function countRelatePatches(): number {
  const file = graphPath();
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.includes('"op":"relate"') || line.includes('"op": "relate"')) n++;
  }
  return n;
}

// All historical sessions in chronological turn order, keyed by session_id (with chat_id).
function loadSessions(): Map<string, { chatId: string; turns: Turn[] }> {
  const rows = getDb()
    .prepare(`SELECT session_id, chat_id, role, content, ts FROM conversation ORDER BY id ASC`)
    .all() as Array<{ session_id: string; chat_id: string; role: string; content: string; ts: string }>;
  const map = new Map<string, { chatId: string; turns: Turn[] }>();
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, { chatId: r.chat_id, turns: [] });
    map.get(r.session_id)!.turns.push({ role: r.role, content: r.content, ts: r.ts });
  }
  return map;
}

// Run claude -p over one transcript and return relation_draft as a JSON-text array (string).
// Mirrors the bot's run_digest invocation (sonnet, no tools) + balanced-brace JSON extraction.
function extractRelationDraft(transcript: string): string {
  const prompt =
    EXTRACTION_PROMPT_GUIDANCE +
    '\n\nFrom the conversation below, extract ONLY the relation_draft array (entities are already ' +
    'recorded; do not emit entity_draft or procedural_raw). Return ONLY a JSON object of the exact ' +
    'shape {"relation_draft": [ ... ]} — no prose, no markdown fences.\n\nCONVERSATION:\n' +
    transcript;

  const res = spawnSync('claude', ['-p', prompt, '--model', 'claude-sonnet-4-6', '--allowedTools', ''], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`claude -p exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`);
  }
  const raw = (res.stdout || '').trim();
  const clean = raw.replace(/^```json\s*|^```\s*|\s*```$/gm, '').trim();
  const start = clean.indexOf('{');
  if (start < 0) return '[]';
  let depth = 0;
  let end = start;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  try {
    const data = JSON.parse(clean.slice(start, end)) as { relation_draft?: unknown };
    return JSON.stringify(data.relation_draft ?? []);
  } catch {
    return '[]';
  }
}

async function main(argv: string[]): Promise<void> {
  const { dryRun, limit } = parseArgs(argv);
  migrate_db();

  const done = alreadyBackfilled();
  const sessions = loadSessions();
  const todo = [...sessions.entries()].filter(([sid]) => !done.has(sid));

  console.log(
    `[backfill-relations] ${sessions.size} sessions total · ${done.size} already have relations · ` +
      `${todo.length} to process${dryRun ? ' (dry-run — no LLM, no writes)' : ''}`,
  );

  if (dryRun) {
    for (const [sid, { turns }] of todo.slice(0, 20)) {
      console.log(`  would process ${sid} (${turns.length} turns)`);
    }
    if (todo.length > 20) console.log(`  … and ${todo.length - 20} more`);
    process.exit(0);
  }

  const batch = Number.isFinite(limit) ? todo.slice(0, limit) : todo;
  const before = countRelatePatches();
  let processed = 0;
  let failed = 0;
  let totalCandidates = 0;

  for (const [sid, { chatId, turns }] of batch) {
    try {
      const transcript = turns
        .map((t) => `${t.role.toUpperCase()} [${t.ts}]: ${t.content}`)
        .join('\n');
      const relation_draft = extractRelationDraft(transcript);
      const n = (JSON.parse(relation_draft) as unknown[]).length;

      const row: DigestRow = {
        id: 0,
        session_id: sid,
        chat_id: chatId,
        summary: '',
        ts: turns[turns.length - 1]?.ts ?? '',
        topics: null,
        entity_draft: null,
        procedural_raw: null,
        relation_draft,
        parse_error: 0,
        turn_count: turns.length,
      };
      // runExtraction runs all three passes; entity/procedural are null → they no-op, only
      // processRelations fires (resolve labels → existing entities, gate >= 0.85, append confirmed:false).
      await runExtraction(row);

      processed++;
      totalCandidates += n;
      console.log(`  ${sid}: ${n} relation candidate(s) from ${turns.length} turns`);
    } catch (e) {
      failed++;
      console.error(`  ${sid}: FAILED — ${(e as Error).message}`);
    }
  }

  const after = countRelatePatches();
  console.log(
    `[backfill-relations] done: ${processed} processed, ${failed} failed, ` +
      `${totalCandidates} relation candidate(s) emitted; relate patches ${before} → ${after}. ` +
      `All land as UNCONFIRMED candidates.`,
  );
  process.exit(0);
}

void main(process.argv.slice(2));

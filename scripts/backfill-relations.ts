// scripts/backfill-relations.ts
//
// One-off RELATION backfill — the RESOLVE-OR-CREATE version.
//
// Relation extraction only went live 2026-07-09, so historical session digests never had a
// relation_draft — the entity graph has entities but no edges from the past. This re-reads each
// historical conversation session, extracts relationships with the LLM (the canonical
// EXTRACTION_PROMPT_GUIDANCE), and links them.
//
// WHY THIS REPLACED THE FIRST VERSION (which wrote 0 edges): the live path (lib/extraction
// processRelations) resolves each endpoint against EXISTING entities via matchByLabel and SKIPS the
// relation if the endpoint doesn't resolve to exactly one node. But the entity graph is
// fact-SENTENCES ("Taylor has a Claude instance…"), not named nodes — there is no "Taylor" node — so
// "Taylor" matched 24 sentences by prefix, came back ambiguous, and every relation was dropped.
//
// The fix: a relation IMPLIES its endpoints. "(Taylor, owns, SampleApp)" is itself evidence that a
// "Taylor" Person and a "SampleApp" Project exist. So instead of resolve-or-skip we do
// resolve-or-CREATE: EXACT-match an existing node (no fuzzy prefix fallback — that was the bug), and
// if none exists, MINT a canonical named node from the relation's own from_type/to_type + label, then
// link. The relations bootstrap the clean named-entity layer as a side effect — this is the additive
// entity-resolution fix, done as a backfill. Created nodes land UNCONFIRMED (confirmed:false), exactly
// like every other candidate; nothing is auto-confirmed.
//
// Both created entities and edges are append-only. Back up ontology/graph.jsonl before the real run
// (as with any graph write) — a `.bak-<ts>` is easy insurance, and the run is idempotent regardless.
//
//   MUST run on the prod box (that's where the conversation history + graph.jsonl live).
//   npx tsx scripts/backfill-relations.ts --dry-run          # LLM pass + full plan, NO writes
//   npx tsx scripts/backfill-relations.ts [--limit N]        # real run (optionally cap sessions)
//   npx tsx scripts/backfill-relations.ts --no-create        # old behavior: resolve-only, skip misses
//
// Idempotent: a session that already has >= 1 relate patch sourced `session:<id>` is skipped, so a
// re-run only fills sessions that missed the first pass. (The prior run wrote 0 relate patches, so a
// re-run reprocesses everything.)

import fs from 'node:fs';
import path from 'node:path';
import { getDb, migrate_db } from '../db/client';
import { EXTRACTION_PROMPT_GUIDANCE, type BotRelationDraftItem } from '../lib/extraction';
import { identifyViaClaude } from '../lib/maintainer';
import {
  appendEntity,
  appendRelate,
  isRelType,
  loadGraph,
  type EntityRecord,
  type RelType,
} from '../lib/graph';

const CONFIDENCE_THRESHOLD = 0.85;
const CANON = ['Person', 'Project', 'Deadline', 'Preference', 'Fact'] as const;
type EntityType = (typeof CANON)[number];

// Fallback subject/object typing when the LLM omits from_type/to_type. Only the cases that are
// unambiguous from the verb are filled; everything else falls through to 'Fact'. The LLM-provided
// types (mandated by EXTRACTION_PROMPT_GUIDANCE) take precedence over these.
const REL_TYPE_HINTS: Partial<Record<RelType, { from?: EntityType; to?: EntityType }>> = {
  child_of: { from: 'Person', to: 'Person' },
  works_on: { from: 'Person', to: 'Project' },
  deadline_for: { from: 'Deadline' },
  prefers: { from: 'Person' },
  attends: { from: 'Person' },
  owns: { from: 'Person' },
};

function normType(raw: unknown): EntityType | null {
  const t = String(raw ?? '').trim().toLowerCase();
  return CANON.find((c) => c.toLowerCase() === t) ?? null;
}

interface Turn {
  role: string;
  content: string;
  ts: string;
}

function graphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

function parseArgs(argv: string[]): { dryRun: boolean; create: boolean; limit: number } {
  const dryRun = argv.includes('--dry-run');
  const create = !argv.includes('--no-create');
  const li = argv.indexOf('--limit');
  const limit = li >= 0 && argv[li + 1] ? parseInt(argv[li + 1], 10) : Number.POSITIVE_INFINITY;
  return { dryRun, create, limit };
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
// Mirrors the bot's run_digest invocation (sonnet, no tools). The spawn + balanced-brace JSON
// extraction lives in identifyViaClaude (lib/maintainer) — ONE copy of that logic in the repo; this
// builds the prompt and pulls `.relation_draft` out of the returned object.
function extractRelationDraft(transcript: string): string {
  const prompt =
    EXTRACTION_PROMPT_GUIDANCE +
    '\n\nFrom the conversation below, extract ONLY the relation_draft array. For EVERY relation, ' +
    'emit from_type and to_type (the entity type of each endpoint) — these are used to type the ' +
    'nodes. Return ONLY a JSON object of the exact shape {"relation_draft": [ ... ]} — no prose, no ' +
    'markdown fences.\n\nCONVERSATION:\n' +
    transcript;

  const data = identifyViaClaude(prompt) as { relation_draft?: unknown } | null;
  return JSON.stringify(data?.relation_draft ?? []);
}

export interface LinkResult {
  edgesWritten: number;
  entitiesCreated: EntityRecord[];
  skipped: { reason: string; detail: string }[];
}

// The core: fan a relation_draft out into edges, MINTING any missing endpoint as a canonical named
// node (resolve-or-create). `index` is the mutable working set of active entities — creations are
// pushed into it so a later relation in the SAME run resolves to the node the earlier one created
// (the second "Taylor" finds the first "Taylor"). Pure logic given a draft; the LLM already ran.
//
// Endpoint resolution is EXACT-label only (case-insensitive, trimmed), preferring same-type then
// widening to any-type. It deliberately does NOT do matchByLabel's prefix/suffix fallback — that
// fuzzy fallback is exactly what made "Taylor" ambiguous against 24 fact-sentences. Exact-or-create
// sidesteps the ambiguity entirely.
export function linkRelationDraft(
  relationDraftJson: string,
  source: string,
  index: EntityRecord[],
  opts: { dryRun: boolean; create: boolean; seenEdges: Set<string> },
): LinkResult {
  const out: LinkResult = { edgesWritten: 0, entitiesCreated: [], skipped: [] };
  const now = new Date().toISOString();

  let items: BotRelationDraftItem[];
  try {
    items = JSON.parse(relationDraftJson) as BotRelationDraftItem[];
  } catch {
    out.skipped.push({ reason: 'parse-error', detail: source });
    return out;
  }
  if (!Array.isArray(items)) return out;

  const createEntity = (type: EntityType, label: string, confidence: number): EntityRecord => {
    if (opts.dryRun) {
      return {
        id: `dry-run-${index.length}`,
        type,
        label,
        properties: {},
        valid_from: now,
        valid_until: null,
        confidence,
        source,
        superseded_by: null,
        confirmed: false,
      };
    }
    return appendEntity({
      type,
      label,
      properties: {},
      valid_from: now,
      valid_until: null,
      confidence,
      source,
      superseded_by: null,
      confirmed: false,
    });
  };

  // Resolve `label` to an existing exact-match node, or create one of `type`. Returns null only in
  // --no-create mode when nothing matched (caller then skips the edge).
  const resolveOrCreate = (label: string, type: EntityType, confidence: number): string | null => {
    const key = label.trim().toLowerCase();
    if (!key) return null;
    const sameType = index.find((e) => e.label.trim().toLowerCase() === key && e.type === type);
    if (sameType) return sameType.id;
    const anyType = index.find((e) => e.label.trim().toLowerCase() === key);
    if (anyType) return anyType.id;
    if (!opts.create) return null;
    const rec = createEntity(type, label.trim(), confidence);
    index.push(rec);
    out.entitiesCreated.push(rec);
    return rec.id;
  };

  for (const item of items) {
    if (typeof item.confidence !== 'number' || item.confidence < CONFIDENCE_THRESHOLD) {
      out.skipped.push({ reason: 'below-threshold', detail: `${item.from_label} ${item.rel} ${item.to_label}` });
      continue;
    }
    if (!isRelType(item.rel)) {
      out.skipped.push({ reason: 'invalid-rel', detail: `${item.rel}` });
      continue;
    }
    const hint = REL_TYPE_HINTS[item.rel as RelType];
    const fromType = normType(item.from_type) ?? hint?.from ?? 'Fact';
    const toType = normType(item.to_type) ?? hint?.to ?? 'Fact';

    const fromId = resolveOrCreate(item.from_label, fromType, item.confidence);
    if (fromId === null) {
      out.skipped.push({ reason: 'from-unresolved', detail: item.from_label });
      continue;
    }
    const toId = resolveOrCreate(item.to_label, toType, item.confidence);
    if (toId === null) {
      out.skipped.push({ reason: 'to-unresolved', detail: item.to_label });
      continue;
    }
    if (fromId === toId) {
      out.skipped.push({ reason: 'self-relate', detail: `${item.from_label} ${item.rel} ${item.to_label}` });
      continue;
    }
    const ek = `${fromId}|${item.rel}|${toId}`;
    if (opts.seenEdges.has(ek)) {
      out.skipped.push({ reason: 'dup-edge', detail: ek });
      continue;
    }
    opts.seenEdges.add(ek);
    if (!opts.dryRun) {
      appendRelate(fromId, item.rel, toId, item.confidence, source, false);
    }
    out.edgesWritten++;
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const { dryRun, create, limit } = parseArgs(argv);
  migrate_db();

  const done = alreadyBackfilled();
  const sessions = loadSessions();
  const todo = [...sessions.entries()].filter(([sid]) => !done.has(sid));

  console.log(
    `[backfill-relations] ${sessions.size} sessions total · ${done.size} already have relations · ` +
      `${todo.length} to process · mode=${create ? 'resolve-or-CREATE' : 'resolve-only'}` +
      `${dryRun ? ' (dry-run — LLM runs, NO writes)' : ''}`,
  );

  const batch = Number.isFinite(limit) ? todo.slice(0, limit) : todo;
  // Working set of active entities, shared across sessions so a node one session mints resolves for
  // the next. In dry-run this starts from the live graph too, so the plan reflects reality.
  const index = loadGraph().filter((e) => e.superseded_by === null);
  const seenEdges = new Set<string>();
  const before = countRelatePatches();

  let processed = 0;
  let failed = 0;
  let edgesTotal = 0;
  const createdByLabel = new Map<string, string>(); // "Type label" -> first session that minted it

  for (const [sid, { chatId: _chatId, turns }] of batch) {
    try {
      const transcript = turns.map((t) => `${t.role.toUpperCase()} [${t.ts}]: ${t.content}`).join('\n');
      const relation_draft = extractRelationDraft(transcript);
      const res = linkRelationDraft(relation_draft, `session:${sid}`, index, { dryRun, create, seenEdges });

      processed++;
      edgesTotal += res.edgesWritten;
      for (const e of res.entitiesCreated) createdByLabel.set(`${e.type} "${e.label}"`, sid);

      const createdStr = res.entitiesCreated.length
        ? ` · +${res.entitiesCreated.length} entit${res.entitiesCreated.length === 1 ? 'y' : 'ies'} [${res.entitiesCreated
            .map((e) => `${e.type}:${e.label}`)
            .slice(0, 8)
            .join(', ')}${res.entitiesCreated.length > 8 ? ', …' : ''}]`
        : '';
      console.log(`  ${sid}: ${res.edgesWritten} edge(s) from ${turns.length} turns${createdStr}`);
    } catch (e) {
      failed++;
      console.error(`  ${sid}: FAILED — ${(e as Error).message}`);
    }
  }

  const after = countRelatePatches();
  console.log(
    `\n[backfill-relations] done: ${processed} processed, ${failed} failed · ` +
      `${edgesTotal} edge(s), ${createdByLabel.size} distinct entit${createdByLabel.size === 1 ? 'y' : 'ies'} ` +
      `${dryRun ? 'WOULD BE created' : 'created'} · relate patches ${before} → ${after}. ` +
      `All land UNCONFIRMED.`,
  );
  if (createdByLabel.size) {
    console.log(`  entities ${dryRun ? 'to create' : 'created'}:`);
    [...createdByLabel.keys()].sort().slice(0, 60).forEach((k) => console.log(`    ${k}`));
    if (createdByLabel.size > 60) console.log(`    … and ${createdByLabel.size - 60} more`);
  }
  process.exit(0);
}

// Guard so the module can be imported (e.g. by a smoke test) without running the backfill.
if (process.argv[1] && path.basename(process.argv[1]).startsWith('backfill-relations')) {
  void main(process.argv.slice(2));
}

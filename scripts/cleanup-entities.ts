// scripts/cleanup-entities.ts
//
// One-off entity-graph cleanup that unblocks relations by making the entities linkable:
//   1. TYPE NORMALISATION — fold every entity's type to the canonical 5 (person→Person, fact→Fact,
//      preference→Preference). Un-normalised casings fragment the graph and break matchByLabel.
//   2. DEDUP — merge entities that share the same (normalised type, exact label). The duplicates'
//      properties are UNIONED into the surviving canonical record (no information is dropped), and
//      the duplicates are removed. This collapses e.g. 4x "Alex" Person nodes into one, so a
//      relation to "Alex" resolves instead of being skipped as ambiguous.
//
// This is an atomic graph REWRITE (same class of operation as compaction). It BACKS UP graph.jsonl
// first (timestamped copy next to it) and supports --dry-run (report only, no write). Live relate
// patches (op:'relate', valid_until:null) are preserved verbatim; there are none today, but the
// re-pointing of edges off a merged-away duplicate is handled defensively.
//
//   MUST run on the prod box (that's where graph.jsonl lives).
//   npx tsx scripts/cleanup-entities.ts --dry-run     # report normalisations + merges, no write
//   npx tsx scripts/cleanup-entities.ts               # back up + rewrite

import fs from 'node:fs';
import path from 'node:path';
import { loadGraph, resolveEdge } from '../lib/graph';
import type { EntityRecord } from '../lib/graph';
import { mergeGroup, computeRepointedEdges } from '../lib/maintainer';

const CANON = ['Person', 'Project', 'Deadline', 'Preference', 'Fact'] as const;
function normType(raw: unknown): (typeof CANON)[number] | null {
  const t = String(raw ?? '').trim().toLowerCase();
  return CANON.find((c) => c.toLowerCase() === t) ?? null;
}
function graphPath(): string {
  return process.env.MOT_GRAPH_PATH ?? path.join(process.cwd(), 'ontology', 'graph.jsonl');
}

function main(argv: string[]): void {
  const dryRun = argv.includes('--dry-run');
  const file = graphPath();

  const active = loadGraph().filter((e) => e.superseded_by === null);

  // 1. Type normalisation (in memory). An unrecognised type is left as-is + flagged.
  let typeFixed = 0;
  const badType: string[] = [];
  for (const e of active) {
    const nt = normType(e.type);
    if (nt === null) {
      badType.push(`${e.type} "${e.label}"`);
      continue;
    }
    if (nt !== e.type) {
      (e as { type: EntityRecord['type'] }).type = nt;
      typeFixed++;
    }
  }

  // 2. Dedup by (type, exact label lowercased). Merge duplicates' properties into the canonical.
  const groups = new Map<string, EntityRecord[]>();
  for (const e of active) {
    const key = `${e.type}|${e.label.trim().toLowerCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const keep: EntityRecord[] = [];
  const mergedAwayId = new Map<string, string>(); // dropped id -> surviving canonical id
  const mergeLog: string[] = [];
  let dropped = 0;

  // Survivor-select + additive property union live in ONE place now — mergeGroup (lib/maintainer).
  // The script and the dedup worker share it so they never diverge on merge semantics (FR-8/FR-10).
  for (const grp of groups.values()) {
    if (grp.length === 1) {
      keep.push(grp[0]);
      continue;
    }
    const { survivor, mergedAway } = mergeGroup(grp);
    keep.push(survivor);
    for (const dup of mergedAway) {
      mergedAwayId.set(dup.id, survivor.id);
      dropped++;
    }
    mergeLog.push(
      `  merged ${grp.length}× ${survivor.type} "${survivor.label}" → kept ${survivor.id}, dropped ${mergedAway
        .map((x) => x.id)
        .join(', ')}`,
    );
  }

  console.log(
    `[cleanup-entities] active=${active.length} · types normalised=${typeFixed} · ` +
      `unrecognised-type kept=${badType.length} · dup groups=${
        [...groups.values()].filter((g) => g.length > 1).length
      } · dropped=${dropped} · final=${keep.length}${dryRun ? ' (dry-run — no write)' : ''}`,
  );
  mergeLog.slice(0, 40).forEach((l) => console.log(l));
  if (badType.length) console.log(`  (unrecognised types left as-is: ${badType.slice(0, 10).join('; ')})`);

  if (dryRun) {
    process.exit(0);
  }

  // Preserve edges, re-pointing merged-away endpoints to their canonical survivor. Uses the SAME
  // fold semantics as the worker's repointEdges (resolveEdge + computeRepointedEdges) so a human
  // unrelate/confirm_relate survives the rewrite (EC-5/B1) and a self-loop is dropped (B2) —
  // repointEdges APPENDS one line per triple; here we build the array for the atomic rewrite.
  // (`file` is already declared above as `const file = graphPath();` — not redeclared.)
  const liveEdges: string[] = [];
  if (fs.existsSync(file)) {
    // Collect every DISTINCT (from, rel, to) triple across all three patch kinds — a human
    // unrelate/confirm_relate is keyed on the SAME natural key as its relate.
    const triplesSeen = new Set<string>();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { op?: string; from?: string; rel?: string; to?: string };
        if (
          (r.op === 'relate' || r.op === 'confirm_relate' || r.op === 'unrelate') &&
          r.from &&
          r.rel &&
          r.to
        ) {
          triplesSeen.add(`${r.from}|${r.rel}|${r.to}`);
        }
      } catch {
        /* skip malformed */
      }
    }
    for (const triple of triplesSeen) {
      const [from, rel, to] = triple.split('|') as [string, string, string];
      const folded = resolveEdge(from, rel, to); // folds relate + confirm_relate + unrelate
      if (!folded) continue; // no base relate → nothing to preserve
      // computeRepointedEdges handles re-point + B2 self-loop drop (the shared pure core).
      for (const edge of computeRepointedEdges([folded], mergedAwayId)) {
        liveEdges.push(JSON.stringify({ ...edge, op: 'relate' }));
      }
    }
  }

  // Back up, then atomic rewrite: canonical entity records (relations stripped — re-folded at read) + live edges.
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  const lines = keep.map((e) => {
    const { relations: _r, ...props } = e.properties ?? {};
    return JSON.stringify({ ...e, properties: props });
  });
  const out = `${lines.concat(liveEdges).join('\n')}\n`;
  const tmp = `${file}.cleanup.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);

  console.log(
    `[cleanup-entities] rewrote ${file} — ${keep.length} entities + ${liveEdges.length} live edges. Backup: ${backup}`,
  );
  process.exit(0);
}

main(process.argv.slice(2));

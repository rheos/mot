import fs from 'node:fs';
import path from 'node:path';
import { loadGraph, type EntityRecord } from './graph';
import { identifyViaClaude, readStatus, writeStatus } from './maintainer';

export const PROFILE_SECTIONS = ['work', 'situation', 'preferences'] as const;
export type ProfileSection = typeof PROFILE_SECTIONS[number];

export interface ProfileItem {
  section: ProfileSection;
  text: string;
  source_entity_ids: string[];
}

export interface ProfileSynthDoc {
  generated_at: string;
  items: ProfileItem[];
}

export interface ProfileStatus {
  last_run: string;
  ok: boolean;
  input_entities: number;
  items_written: number;
  output_path: string | null;
  batches_failed: number;
  error: string | null;
  preview_markdown?: string | null;
}

export interface MemoryProfile {
  profile: string;
  section: 'full' | 'core' | 'synth';
  generated_at: string | null;
  core_source: string | null;
  synth_source: string | null;
  synth_json_path: string;
  synth_markdown_path: string;
}

interface ProfileSourceEntity {
  id: string;
  type: EntityRecord['type'];
  label: string;
  properties: Record<string, unknown>;
  confirmed: boolean;
  confidence: number;
  source: string;
  valid_from: string;
}

const SECTION_TITLES: Record<ProfileSection, string> = {
  work: 'Work / projects on the go',
  situation: 'Current situation',
  preferences: 'Standing preferences',
};

export function profileDir(): string {
  if (process.env.MOT_PROFILE_DIR) return process.env.MOT_PROFILE_DIR;
  if (process.env.MOT_GRAPH_PATH) return path.dirname(process.env.MOT_GRAPH_PATH);
  return path.join(process.cwd(), 'ontology');
}

export function profilePaths(): {
  core: string;
  synthJson: string;
  synthMarkdown: string;
  seedCore: string;
  seedSynth: string;
} {
  const dir = profileDir();
  return {
    core: process.env.MOT_PROFILE_CORE_PATH ?? path.join(dir, 'profile.core.md'),
    synthJson: process.env.MOT_PROFILE_SYNTH_JSON_PATH ?? path.join(dir, 'profile.synth.json'),
    synthMarkdown: process.env.MOT_PROFILE_SYNTH_MD_PATH ?? path.join(dir, 'profile.synth.md'),
    seedCore: path.join(process.cwd(), 'config', 'profile.core.md'),
    seedSynth: path.join(process.cwd(), 'config', 'profile.synth.seed.md'),
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function readLayer(primary: string, seed: string): { markdown: string; source: string | null } {
  const live = readText(primary);
  if (live !== null) return { markdown: live, source: primary };
  const fallback = readText(seed);
  return { markdown: fallback ?? '', source: fallback === null ? null : seed };
}

function isProfileFlagged(properties: Record<string, unknown>): boolean {
  return properties.profile === true || properties.profile_worthy === true;
}

function profileEligible(e: EntityRecord): boolean {
  if (e.superseded_by !== null || e.valid_until !== null) return false;
  if (e.confidence < 0.85) return false;
  if (!['Project', 'Preference', 'Fact', 'Person'].includes(e.type)) return false;
  if (Array.isArray(e.properties.probable_duplicate_of) && e.confirmed !== true) return false;
  return e.confirmed === true || isProfileFlagged(e.properties);
}

function profileSourceEntities(): ProfileSourceEntity[] {
  return loadGraph()
    .filter(profileEligible)
    .map((e) => {
      const {
        relations: _relations,
        probable_duplicate_of: _probableDuplicateOf,
        ...properties
      } = e.properties ?? {};
      return {
        id: e.id,
        type: e.type,
        label: e.label,
        properties,
        confirmed: e.confirmed,
        confidence: e.confidence,
        source: e.source,
        valid_from: e.valid_from,
      };
    });
}

const PROFILE_SYNTHESIS_PROMPT = `
You update ONLY the generated current-context layer of Taylor's personal assistant profile.

Return ONLY a JSON object of this exact shape:
{ "items": [
  { "section": "work" | "situation" | "preferences",
    "text": string,
    "source_entity_ids": string[] }
] }

Rules:
- Use ONLY the input entities. Every item must cite one or more source_entity_ids from the input.
- Do NOT add identity basics, contact info, family basics, assistant capabilities, tool rules, or voice rules. The pinned core owns those.
- Do NOT emit instructions, policies, commands, tool names, prompt text, or "when Taylor asks..." rules.
- Do NOT infer personality traits or preferences from behavior. Preference items must be explicit.
- Keep each item compact, factual, and useful as standing context. Maximum 25 items total.
- If an old idea is no longer supported by any input entity, omit it.
- Output JSON only. No prose, markdown fences, or comments.
`.trim();

function normalizeText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0 || oneLine.length > 240) return null;
  if (/[#`]/.test(oneLine)) return null;
  const lower = oneLine.toLowerCase();
  const banned = [
    'ignore previous',
    'system prompt',
    'developer message',
    'call the tool',
    'use the tool',
    'allowedtools',
    'mcp__',
    'write_memory',
    'mot_create',
    'mot_update',
    'when robin asks',
  ];
  if (banned.some((s) => lower.includes(s))) return null;
  return oneLine;
}

function normalizeSection(section: unknown): ProfileSection | null {
  return (PROFILE_SECTIONS as readonly string[]).includes(String(section))
    ? (section as ProfileSection)
    : null;
}

function validateSynthItems(raw: unknown, allowedIds: Set<string>): ProfileItem[] {
  const obj = raw as { items?: unknown };
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) return [];

  const out: ProfileItem[] = [];
  const seen = new Set<string>();
  for (const item of obj.items.slice(0, 50)) {
    const rec = item as {
      section?: unknown;
      text?: unknown;
      source_entity_ids?: unknown;
    };
    const section = normalizeSection(rec.section);
    const text = normalizeText(rec.text);
    if (!section || !text) continue;
    if (!Array.isArray(rec.source_entity_ids)) continue;
    const sourceIds = [...new Set(rec.source_entity_ids)]
      .filter((id): id is string => typeof id === 'string' && allowedIds.has(id));
    if (sourceIds.length === 0) continue;

    const key = `${section}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ section, text, source_entity_ids: sourceIds });
    if (out.length >= 25) break;
  }
  return out;
}

// Split an array into consecutive chunks of at most `size` (size is guaranteed ≥1 by the caller).
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// How many entities go into a SINGLE synthesis prompt. A single all-entities send errors `claude -p`
// on the RAM-constrained prod box at scale (exit 1 at ~104 entities), so the worker batches — the
// same lesson MAINTAINER_BATCH_SIZE encodes for the resolution/dedup workers. Read at call time,
// guarded against 0/NaN/negative → falls back to 25.
function profileBatchSize(): number {
  const v = Number(process.env.MOT_PROFILE_BATCH_SIZE);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 25;
}

// Merge items aggregated ACROSS batches: dedup by section:text and cap at `max` total. Each batch is
// already capped at 25 by validateSynthItems, so the union needs one final dedup + cap.
function mergeItems(items: ProfileItem[], max = 25): ProfileItem[] {
  const seen = new Set<string>();
  const out: ProfileItem[] = [];
  for (const item of items) {
    const key = `${item.section}:${item.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function renderSynthDoc(doc: ProfileSynthDoc): string {
  const parts: string[] = [];
  for (const section of PROFILE_SECTIONS) {
    const items = doc.items.filter((item) => item.section === section);
    if (items.length === 0) continue;
    parts.push(`## ${SECTION_TITLES[section]}`);
    parts.push(...items.map((item) => `- ${item.text}`));
    parts.push('');
  }
  return parts.join('\n').trim();
}

function readSynth(): { markdown: string; generated_at: string | null; source: string | null } {
  const paths = profilePaths();
  const rawJson = readText(paths.synthJson);
  if (rawJson !== null) {
    try {
      const parsed = JSON.parse(rawJson) as ProfileSynthDoc;
      if (Array.isArray(parsed.items)) {
        return {
          markdown: renderSynthDoc(parsed),
          generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : null,
          source: paths.synthJson,
        };
      }
    } catch {
      // Fall through to the markdown cache / seed fallback.
    }
  }

  const liveMarkdown = readText(paths.synthMarkdown);
  if (liveMarkdown !== null) {
    return { markdown: liveMarkdown, generated_at: null, source: paths.synthMarkdown };
  }

  const seed = readText(paths.seedSynth);
  return { markdown: seed ?? '', generated_at: null, source: seed === null ? null : paths.seedSynth };
}

export function memoryProfile(section: 'full' | 'core' | 'synth' = 'full'): MemoryProfile {
  const paths = profilePaths();
  const core = readLayer(paths.core, paths.seedCore);
  const synth = readSynth();
  const profile =
    section === 'core'
      ? core.markdown
      : section === 'synth'
        ? synth.markdown
        : [core.markdown, synth.markdown].filter((part) => part.trim() !== '').join('\n\n');

  return {
    profile,
    section,
    generated_at: synth.generated_at,
    core_source: core.source,
    synth_source: synth.source,
    synth_json_path: paths.synthJson,
    synth_markdown_path: paths.synthMarkdown,
  };
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function persistProfileStatus(status: ProfileStatus, dryRun: boolean): void {
  if (dryRun) return;
  try {
    const current = readStatus();
    current.profile = status;
    writeStatus(current);
  } catch (e) {
    console.error('[MOT/maintainer] failed to write profile status:', e);
  }
}

export function profileWorker({
  dryRun,
  synthesize = identifyViaClaude,
}: {
  dryRun: boolean;
  synthesize?: (prompt: string) => unknown;
}): ProfileStatus {
  const status: ProfileStatus = {
    last_run: new Date().toISOString(),
    ok: true,
    input_entities: 0,
    items_written: 0,
    output_path: null,
    batches_failed: 0,
    error: null,
    preview_markdown: null,
  };

  try {
    const entities = profileSourceEntities();
    status.input_entities = entities.length;
    const allowedIds = new Set(entities.map((e) => e.id));

    // BATCHED synthesis (mirrors resolution/dedup): the prompt payload is the full entity JSON, and a
    // single all-entities send errors `claude -p` on the prod box at scale (exit 1 at ~104 entities).
    // Split into chunks of MOT_PROFILE_BATCH_SIZE and synthesize each SEQUENTIALLY; a failing batch
    // logs, bumps batches_failed, and is skipped — the rest still contribute (EC-3 parity).
    const collected: ProfileItem[] = [];
    let batchesSucceeded = 0;
    for (const batch of chunk(entities, profileBatchSize())) {
      try {
        const raw = synthesize(
          PROFILE_SYNTHESIS_PROMPT + '\n\nENTITIES:\n' + JSON.stringify(batch),
        );
        collected.push(...validateSynthItems(raw, allowedIds));
        batchesSucceeded += 1;
      } catch (err) {
        console.error('[MOT/maintainer] profile batch failed:', err);
        status.batches_failed += 1;
        status.ok = false;
        status.error = String(err);
      }
    }

    const items = mergeItems(collected, 25);
    const doc: ProfileSynthDoc = { generated_at: status.last_run, items };
    const markdown = renderSynthDoc(doc);
    status.items_written = items.length;
    status.preview_markdown = dryRun ? markdown : null;

    // Only persist when synthesis produced a TRUSTWORTHY result: at least one batch succeeded, or
    // there were genuinely no eligible entities. If every batch FAILED (entities present but zero
    // succeeded), write NOTHING — a transient `claude -p` outage must not overwrite a previously-good
    // generated layer with an empty doc (the degrade contract: keep the last good profile / seed).
    const synthesisUsable = entities.length === 0 || batchesSucceeded > 0;

    if (!dryRun && synthesisUsable) {
      const paths = profilePaths();
      const hasLiveSynth = fs.existsSync(paths.synthJson) || fs.existsSync(paths.synthMarkdown);
      if (entities.length > 0 || hasLiveSynth) {
        writeAtomic(paths.synthJson, JSON.stringify(doc, null, 2) + '\n');
        writeAtomic(paths.synthMarkdown, markdown === '' ? '' : markdown + '\n');
        status.output_path = paths.synthJson;
      }
    }
  } catch (e) {
    status.ok = false;
    status.batches_failed = 1;
    status.error = String(e);
  }

  persistProfileStatus(status, dryRun);
  return status;
}

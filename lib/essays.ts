// Read-only essay reader for the /essays section. Server-only (uses node:fs at build time;
// the pages are statically generated and the middleware gates them behind the session, same as
// every other UI route). Content lives as plain .md files under content/essays/ — deploy-synced
// with the rest of the source. No markdown dependency: the essays are prose (paragraphs + `---`
// rules), so a tiny block splitter is all the rendering they need.
import fs from 'node:fs';
import path from 'node:path';

export type Essay = { slug: string; title: string; body: string };
export type EssayListItem = { slug: string; title: string; label: string };
export type Block = { type: 'hr' } | { type: 'p'; text: string };

const DIR = path.join(process.cwd(), 'content', 'essays');

// Display order + the one-line label shown on the index. The file is the source of truth for the
// title and prose; the label here is just the index caption.
const ORDER: { slug: string; file: string; label: string }[] = [
  { slug: 'v1', file: 'v1.md', label: 'v1 — first draft: visceral open, science worn light' },
  { slug: 'v2', file: 'v2.md', label: 'v2 — cold run: falsifiability open, visible science' },
  { slug: 'v3-1', file: 'v3-1.md', label: 'v3.1 — graft of v1 + v2 (current working draft)' },
];

// Strip the leading front-matter (an H1 title, an optional *italic version note*, and any leading
// `---` rule) off the top of the file and return the title plus the pure prose body. Order-agnostic:
// some files put the note before the title, some after.
function parse(raw: string): { title: string; body: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    const t = line.trim();
    if (t === '') continue;
    if (t === '---') continue;
    if (t.startsWith('# ')) {
      title = t.slice(2).trim();
      continue;
    }
    if (/^\*.+\*$/.test(t)) {
      // an italic version note — discard it, it is internal meta, not part of the essay
      continue;
    }
    break; // first real paragraph: body starts here
  }
  return { title, body: lines.slice(i).join('\n').trim() };
}

export function listEssays(): EssayListItem[] {
  return ORDER.map(({ slug, file, label }) => {
    const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
    return { slug, label, title: parse(raw).title };
  });
}

export function essaySlugs(): string[] {
  return ORDER.map((e) => e.slug);
}

export function essayLabel(slug: string): string | null {
  return ORDER.find((e) => e.slug === slug)?.label ?? null;
}

export function getEssay(slug: string): Essay | null {
  const entry = ORDER.find((e) => e.slug === slug);
  if (!entry) return null;
  const raw = fs.readFileSync(path.join(DIR, entry.file), 'utf8');
  const { title, body } = parse(raw);
  return { slug, title, body };
}

// Split the prose body into render blocks: a standalone `---` becomes an <hr>, everything else is a
// paragraph (any stray internal newline collapsed to a space).
export function toBlocks(body: string): Block[] {
  return body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b): Block => (b === '---' ? { type: 'hr' } : { type: 'p', text: b.replace(/\s*\n\s*/g, ' ') }));
}

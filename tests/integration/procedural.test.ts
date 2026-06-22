import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recallatron Phase 3 — procedural notes (lib/procedural.ts). Same harness as migrations.test.ts:
// set DATABASE_URL to a fresh temp DB BEFORE the first dynamic import, then drive migrate_db so
// the full hand-written stack — including 0005_procedural_notes — lands. procedural_notes.
// source_session_id FK references session_digest(session_id), so we seed one session up front.

const tmpDbPath = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'mot-procedural-')),
  'procedural.db',
);
process.env.DATABASE_URL = tmpDbPath;

const { migrate_db, getDb } = await import('../../db/client');
const { insertCandidate, listNotes, confirmNote } = await import('../../lib/procedural');

const SESSION_ID = 's-proc';

describe('lib/procedural — procedural notes', () => {
  beforeAll(() => {
    migrate_db();
    getDb()
      .prepare(
        `INSERT INTO session_digest (session_id, chat_id, summary, ts, turn_count)
         VALUES (?, 'c1', 'Proc session', '2026-06-01T10:00:00.000Z', 1)`,
      )
      .run(SESSION_ID);
  });

  afterAll(() => {
    getDb().close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = tmpDbPath + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  });

  it('insertCandidate happy path inserts unconfirmed (confirmed = 0, mention_count = 1)', () => {
    const r = insertCandidate('workflow', 'Always run typecheck before commit', SESSION_ID, 'c1');
    expect('error' in r).toBe(false);
    const n = r as Extract<typeof r, { id: number }>;
    expect(n.confirmed).toBe(0);
    expect(n.confirmed_at).toBeNull();
    expect(n.mention_count).toBe(1);
    expect(n.superseded_by).toBeNull();
    expect(n.note_norm).toBe('always run typecheck before commit');
    expect(n.chat_id).toBe('c1');
    expect(n.category).toBe('workflow');
  });

  it('insertCandidate with a duplicate note_norm (case/trim variant) returns duplicate_skipped + warns', () => {
    insertCandidate('style', 'No emoji in prose', SESSION_ID);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Different casing + surrounding whitespace ⇒ same note_norm.
    const r = insertCandidate('style', '  NO EMOJI in Prose  ', SESSION_ID);
    expect(r).toEqual({ error: 'duplicate_skipped', note_norm: 'no emoji in prose' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[MOT/procedural] dedup-skip: note_norm already exists'),
    );

    warn.mockRestore();

    // The dedup did not insert a second row.
    const count = (
      getDb()
        .prepare(`SELECT count(*) AS c FROM procedural_notes WHERE note_norm = 'no emoji in prose'`)
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it('insertCandidate dedup is cross-category — same text in a different category still skips', () => {
    insertCandidate('catA', 'Shared note text', SESSION_ID);
    const r = insertCandidate('catB', 'Shared note text', SESSION_ID);
    expect(r).toEqual({ error: 'duplicate_skipped', note_norm: 'shared note text' });
  });

  it('listNotes pending=false returns only confirmed, grouped by category', () => {
    insertCandidate('grouping', 'Confirmed note one', SESSION_ID);
    const two = insertCandidate('grouping', 'Confirmed note two', SESSION_ID);
    insertCandidate('grouping', 'Still pending note', SESSION_ID);

    // Confirm the first two of this category.
    const oneId = (
      getDb()
        .prepare(`SELECT id FROM procedural_notes WHERE note_norm = 'confirmed note one'`)
        .get() as { id: number }
    ).id;
    confirmNote(oneId);
    confirmNote((two as Extract<typeof two, { id: number }>).id);

    const grouped = listNotes() as Record<string, ProceduralNoteShape[]>;
    expect(Array.isArray(grouped)).toBe(false);
    expect(grouped['grouping']).toBeDefined();
    const norms = grouped['grouping'].map((n) => n.note_norm);
    expect(norms).toContain('confirmed note one');
    expect(norms).toContain('confirmed note two');
    expect(norms).not.toContain('still pending note'); // unconfirmed excluded
  });

  it('listNotes pending=true returns only unconfirmed, as a flat array', () => {
    insertCandidate('pending-mode', 'A pending candidate', SESSION_ID);
    const r = listNotes(undefined, true);
    expect(Array.isArray(r)).toBe(true);
    const arr = r as ProceduralNoteShape[];
    expect(arr.every((n) => n.confirmed === 0)).toBe(true);
    expect(arr.some((n) => n.note_norm === 'a pending candidate')).toBe(true);
    // A confirmed note from an earlier test is not in the pending list.
    expect(arr.some((n) => n.note_norm === 'confirmed note one')).toBe(false);
  });

  it('listNotes with a category filter scopes the result', () => {
    insertCandidate('filter-cat', 'Filter category note', SESSION_ID);
    const filterId = (
      getDb()
        .prepare(`SELECT id FROM procedural_notes WHERE note_norm = 'filter category note'`)
        .get() as { id: number }
    ).id;
    confirmNote(filterId);

    const grouped = listNotes('filter-cat') as Record<string, ProceduralNoteShape[]>;
    expect(Object.keys(grouped)).toEqual(['filter-cat']);
    expect(grouped['filter-cat']).toHaveLength(1);

    // Same filter in pending mode returns a flat (empty here — the only one is confirmed) array.
    const pending = listNotes('filter-cat', true) as ProceduralNoteShape[];
    expect(Array.isArray(pending)).toBe(true);
    expect(pending).toHaveLength(0);
  });

  it('confirmNote happy path sets confirmed = 1 and confirmed_at', () => {
    const ins = insertCandidate('confirm-happy', 'A note to confirm', SESSION_ID);
    const id = (ins as Extract<typeof ins, { id: number }>).id;
    const r = confirmNote(id);
    expect('error' in r).toBe(false);
    const n = r as Extract<typeof r, { id: number }>;
    expect(n.confirmed).toBe(1);
    expect(n.confirmed_at).toBeTruthy();
  });

  it('confirmNote with a nonexistent id returns not_found', () => {
    expect(confirmNote(999999)).toEqual({ error: 'not_found' });
  });

  it('confirmNote on an already-confirmed note returns already_confirmed', () => {
    const ins = insertCandidate('confirm-twice', 'Confirm me once', SESSION_ID);
    const id = (ins as Extract<typeof ins, { id: number }>).id;
    confirmNote(id);
    expect(confirmNote(id)).toEqual({ error: 'already_confirmed' });
  });

  it('confirmNote on a superseded note returns { error: superseded, current_id }', () => {
    const oldIns = insertCandidate('superseded-cat', 'An old superseded note', SESSION_ID);
    const newIns = insertCandidate('superseded-cat', 'The current replacement note', SESSION_ID);
    const oldId = (oldIns as Extract<typeof oldIns, { id: number }>).id;
    const newId = (newIns as Extract<typeof newIns, { id: number }>).id; // a real row (self-FK valid)
    getDb()
      .prepare(`UPDATE procedural_notes SET superseded_by = ? WHERE id = ?`)
      .run(newId, oldId);

    expect(confirmNote(oldId)).toEqual({ error: 'superseded', current_id: newId });
  });
});

// Minimal structural type for test assertions — the lib's ProceduralNote shape.
interface ProceduralNoteShape {
  id: number;
  category: string;
  note: string;
  note_norm: string;
  confirmed: number;
  confirmed_at: string | null;
  superseded_by: number | null;
  mention_count: number;
  chat_id: string | null;
}

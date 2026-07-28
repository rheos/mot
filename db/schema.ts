import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { Ministry, Status, Severity, Author } from '../lib/enums';

// FR-DB-1 — the full Phase 1 contract. Three real tables + one app-level table.
// The ticket_fts virtual table and its triggers are a hand-written migration (0001_fts.sql),
// not declared here — drizzle-kit has no DSL for FTS5.

// ticket — 19 columns per FR-DB-1.
export const ticket = sqliteTable(
  'ticket',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    ministry: text('ministry', {
      enum: Object.values(Ministry) as [string, ...string[]],
    }).notNull(),
    status: text('status', {
      enum: Object.values(Status) as [string, ...string[]],
    })
      .notNull()
      .default('open'),
    severity: text('severity', {
      enum: Object.values(Severity) as [string, ...string[]],
    }).notNull(),
    ticket_type: text('ticket_type').notNull(),
    provenance: text('provenance').notNull(),
    source_ref: text('source_ref'), // null for manual tickets
    dedup_key: text('dedup_key'), // null when source_ref is null
    body: text('body').notNull(),
    private: integer('private', { mode: 'boolean' }).notNull().default(false),
    needs_review: integer('needs_review', { mode: 'boolean' })
      .notNull()
      .default(false),
    event_count: integer('event_count').notNull().default(1),
    snoozed_until: text('snoozed_until'), // ISO datetime; non-null iff status = snoozed
    blocked_note: text('blocked_note'),
    linked_ticket_id: text('linked_ticket_id').references((): any => ticket.id),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    closed_at: text('closed_at'), // set on → done; cleared on re-open
  },
  (t) => ({
    idxDedupKey: index('idx_ticket_dedup_key').on(t.dedup_key),
    idxTriage: index('idx_ticket_triage').on(t.status, t.severity, t.updated_at),
    idxSnooze: index('idx_ticket_snooze').on(t.status, t.snoozed_until),
  }),
);

export const comment = sqliteTable('comment', {
  id: text('id').primaryKey(),
  ticket_id: text('ticket_id')
    .notNull()
    .references(() => ticket.id),
  author: text('author', {
    enum: Object.values(Author) as [string, ...string[]],
  }).notNull(),
  body: text('body').notNull(),
  created_at: text('created_at').notNull(),
});

// classification_audit — 14 columns. Append-only at create; the ONLY post-insert write is
// the corrected_* back-fill from the PATCH handler (FR-API-2b). No delete path.
export const classificationAudit = sqliteTable('classification_audit', {
  id: text('id').primaryKey(),
  signal_fingerprint: text('signal_fingerprint').notNull(),
  ministry_out: text('ministry_out').notNull(),
  ticket_type_out: text('ticket_type_out').notNull(),
  severity_out: text('severity_out').notNull(),
  confidence: real('confidence').notNull(),
  action: text('action').notNull(), // created | updated | reopened | grouped | skipped-dup
  ticket_id: text('ticket_id').references(() => ticket.id), // null if skipped
  model_version: text('model_version').notNull(),
  prompt_hash: text('prompt_hash'),
  corrected_ministry: text('corrected_ministry'), // back-filled by PATCH (FR-API-2b)
  corrected_severity: text('corrected_severity'),
  corrected_at: text('corrected_at'),
  created_at: text('created_at').notNull(),
});

// conversation — append-only turn ledger for Rheo's Telegram chat history.
// session_id is assigned server-side: a new session starts when the gap since the
// last turn for that chat_id exceeds 2 hours. Never update or delete rows.
export const conversation = sqliteTable(
  'conversation',
  {
    id:         integer('id').primaryKey({ autoIncrement: true }),
    chat_id:    text('chat_id').notNull(),
    session_id: text('session_id').notNull(),
    role:       text('role', { enum: ['user', 'rheo'] }).notNull(),
    content:    text('content').notNull(),
    ts:         text('ts').notNull(), // ISO datetime
  },
  (t) => ({
    idxChatRecent: index('idx_conv_chat_recent').on(t.chat_id, t.ts),
    idxSession:    index('idx_conv_session').on(t.session_id),
  }),
);

// session_digest — one row per closed session; populated by the bot's LLM digest pass (auto)
// or by the summarize_and_archive MCP tool (structural/non-LLM, manual). Keyed on session_id.
export const sessionDigest = sqliteTable(
  'session_digest',
  {
    id:             integer('id').primaryKey({ autoIncrement: true }),
    session_id:     text('session_id').notNull().unique(),
    chat_id:        text('chat_id').notNull(),
    summary:        text('summary').notNull(),
    ts:             text('ts').notNull(),                    // ISO datetime
    topics:         text('topics'),                         // comma-separated; reserved/unpopulated at Track 1
    entity_draft:   text('entity_draft'),                   // JSON text; null on structural/parse-error path
    procedural_raw: text('procedural_raw'),                 // JSON text; null on structural/parse-error path
    relation_draft: text('relation_draft'),                 // JSON text; null on structural/parse-error path
    parse_error:    integer('parse_error', { mode: 'boolean' }).notNull().default(false),
    turn_count:     integer('turn_count').notNull(),
  },
  (t) => ({
    idxDigestChatTs: index('idx_digest_chat_ts').on(t.chat_id, t.ts),
  }),
);

// memory_items — strictly append-only fact store. No row is ever mutated in place.
// Updates produce a new row; the old row's superseded_by is set to the new row's id.
// chat_id is server-derived from source_turn_id (FK lookup); never a caller input.
export const memoryItems = sqliteTable(
  'memory_items',
  {
    id:                integer('id').primaryKey({ autoIncrement: true }),
    type:              text('type', { enum: ['fact', 'preference', 'deadline', 'person'] }).notNull(),
    label:             text('label').notNull(),
    label_norm:        text('label_norm').notNull(),    // lower(trim(label)), computed on write
    properties:        text('properties').notNull(),    // JSON text
    chat_id:           text('chat_id').notNull(),       // server-derived from source_turn_id FK
    source_turn_id:    integer('source_turn_id').notNull().references(() => conversation.id),
    source_session_id: text('source_session_id').notNull(),
    confidence:        real('confidence').notNull(),
    reason:            text('reason').notNull(),
    ts:                text('ts').notNull(),            // ISO datetime
    superseded_by:     integer('superseded_by').references((): any => memoryItems.id),
    conflict_flag:     integer('conflict_flag', { mode: 'boolean' }).notNull().default(false),
    version:           integer('version').notNull().default(1),
  },
  (t) => ({
    idxMemoryLookup:     index('idx_memory_lookup').on(t.type, t.label_norm, t.superseded_by),
    idxMemoryChatActive: index('idx_memory_chat_active').on(t.chat_id, t.superseded_by, t.conflict_flag, t.ts),
  }),
);

// ── Recallatron (Track-2 memory) — Phase 1 schema ──────────────────────────────
// These tables are created by HAND-WRITTEN migrations (0004/0005/0006), NOT drizzle-kit.
// They are declared here for TYPED READS ONLY — do NOT run drizzle-kit generate against
// them (that would write them into the journal and conflict with the hand-written files).

// topic_thread — a human-readable topic grouping sessions. Keyed on slug.
export const topicThread = sqliteTable('topic_thread', {
  slug:           text('slug').primaryKey(),
  title:          text('title').notNull(),
  notes:          text('notes'),
  created_at:     text('created_at').notNull(),
  last_active_at: text('last_active_at').notNull(),
});

// topic_thread_session — many-to-many join between topic_thread and session_digest.
// session_id references session_digest(session_id) (the UNIQUE column), not its PK.
export const topicThreadSession = sqliteTable(
  'topic_thread_session',
  {
    slug:       text('slug').notNull().references(() => topicThread.slug),
    session_id: text('session_id').notNull().references(() => sessionDigest.session_id),
    added_at:   text('added_at').notNull(),
  },
  (t) => ({
    idxTtsSessionId: index('idx_tts_session_id').on(t.session_id),
  }),
);

// procedural_notes — append-only operator workflow notes with a supersede chain (like
// memory_items). note_norm is the normalized form for dedup/lookup. source_session_id
// references session_digest(session_id) (the UNIQUE column), not its PK.
export const proceduralNotes = sqliteTable(
  'procedural_notes',
  {
    id:                integer('id').primaryKey({ autoIncrement: true }),
    category:          text('category').notNull(),
    note:              text('note').notNull(),
    note_norm:         text('note_norm').notNull(),
    source_session_id: text('source_session_id').notNull().references(() => sessionDigest.session_id),
    confirmed:         integer('confirmed', { mode: 'boolean' }).notNull().default(false),
    confirmed_at:      text('confirmed_at'),
    superseded_by:     integer('superseded_by').references((): any => proceduralNotes.id),
    mention_count:     integer('mention_count').notNull().default(1),
    chat_id:           text('chat_id'),
    created_at:        text('created_at').notNull(),
    ts:                text('ts').notNull(),
  },
  (t) => ({
    idxPnCategory: index('idx_pn_category').on(t.category, t.confirmed, t.superseded_by),
    idxPnNoteNorm: index('idx_pn_note_norm').on(t.note_norm),
  }),
);

// app_secret — API-key argon2 hash + the UI login credential. App-level operational state,
// NOT part of the frozen 4-table contract. Lives in 0000_init.sql because it has no FK
// dependency and is needed at first boot. One row only (id always 1).
//
// ui_username / ui_password_hash are nullable and added in a later additive migration
// (0002): the live prod row already holds key_hash, so the UI login moved from env-only
// module memory to this row WITHOUT disturbing the existing API key. Null ⇒ not yet seeded;
// bootstrapUiPassword() seeds them once from MOT_UI_USERNAME / MOT_UI_PASSWORD, after which
// the DB value is authoritative (env no longer overrides it — same pattern as key_hash).
export const appSecret = sqliteTable('app_secret', {
  id: integer('id').primaryKey(),
  key_hash: text('key_hash').notNull(),
  ui_username: text('ui_username'),
  ui_password_hash: text('ui_password_hash'),
  created_at: text('created_at').notNull(),
});

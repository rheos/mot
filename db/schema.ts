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

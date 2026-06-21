#!/usr/bin/env node
// One-off migration: re-ID every ticket from a cuid2 to a short 8-char hex id (matching the new
// allocateTicketId() in lib/tickets.ts). FK-aware — remaps the references in comment.ticket_id,
// classification_audit.ticket_id, and ticket.linked_ticket_id too.
//
// Safe to re-run: tickets whose id is already 8-hex are left untouched (so prod and a re-run are
// idempotent). FTS is untouched — its triggers fire only on title/body changes and it keys on
// rowid, which an id swap doesn't change.
//
// Usage:  node scripts/reid-tickets.cjs [path/to/mot.db]   (defaults to ./mot.db)
// On the box, run ONCE after deploy (the service can stay up — the remap is a single atomic tx):
//   node /opt/mot/scripts/reid-tickets.cjs /opt/mot/mot.db
'use strict';

const Database = require('better-sqlite3');
const { randomBytes } = require('node:crypto');

const dbPath = process.argv[2] || './mot.db';
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');

const isShort = (id) => /^[0-9a-f]{8}$/.test(id);

const tickets = db.prepare('SELECT id FROM ticket').all();
const used = new Set(tickets.map((t) => t.id).filter(isShort)); // keep already-short ids reserved
const map = new Map();
for (const { id } of tickets) {
  if (isShort(id)) continue; // already migrated — leave as-is
  let nid;
  do {
    nid = randomBytes(4).toString('hex');
  } while (used.has(nid));
  used.add(nid);
  map.set(id, nid);
}

if (map.size === 0) {
  console.log(`Nothing to remap — all ${tickets.length} ticket id(s) are already 8-hex.`);
  process.exit(0);
}

const updComment = db.prepare('UPDATE comment SET ticket_id = ? WHERE ticket_id = ?');
const updAudit = db.prepare('UPDATE classification_audit SET ticket_id = ? WHERE ticket_id = ?');
const updLinked = db.prepare('UPDATE ticket SET linked_ticket_id = ? WHERE linked_ticket_id = ?');
const updTicket = db.prepare('UPDATE ticket SET id = ? WHERE id = ?');

// FKs OFF for the swap (the children would otherwise dangle mid-update). Per-connection only —
// the running app's connection is unaffected — and we re-check integrity before turning it back on.
db.pragma('foreign_keys = OFF');
const remap = db.transaction(() => {
  for (const [oldId, newId] of map) {
    updComment.run(newId, oldId);
    updAudit.run(newId, oldId);
    updLinked.run(newId, oldId);
    updTicket.run(newId, oldId);
  }
});
remap();

const violations = db.pragma('foreign_key_check');
db.pragma('foreign_keys = ON');

if (violations.length > 0) {
  console.error('ABORTED: foreign_key_check found violations after remap:', violations);
  process.exit(1);
}

console.log(`Re-IDed ${map.size} ticket(s) to 8-hex. Sample:`);
let n = 0;
for (const [oldId, newId] of map) {
  if (n++ >= 5) break;
  console.log(`  ${oldId}  ->  ${newId}`);
}
db.close();

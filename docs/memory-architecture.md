# Memory Architecture

M.O.T. includes a memory layer for the assistants and automations that work alongside it. It is
not a chat-history log. It is a small set of durable stores — conversation, entity, and procedural
— plus a set of nightly processes that organize what lands in them, exposed to agents over MCP.

## The problem it solves

An LLM call is stateless. Everything it "knows" about a person or a project has to arrive in the
prompt, and prompt space is small, expensive, and gets discarded at the end of the call. The usual
answer is to keep re-summarizing and re-injecting context — which loses detail with every pass and
still forgets anything that was never explicitly recalled.

M.O.T.'s memory layer takes a different position: keep the raw material forever, in a normal
database, and separate two concerns that are usually tangled together — *storage* (never delete
what was true) from *retrieval* (what to put in front of the model right now). Storage never
decays. Retrieval is where recency, relevance, and confidence get to matter.

## Design principles

Two rules constrain every layer described below. They were arrived at the hard way — earlier
designs violated each once, and both were reverted.

- **Persistence is forever.** A fact stated once must survive indefinitely, whether or not it is
  ever referenced again. Nothing in the memory layer is deleted for going unused. The one thing
  that *is* pruned is a record explicitly superseded by a correction — never a record that simply
  sat idle.
- **Memory is ambient, not administered.** The system must not create maintenance work for the
  person using it — no review queue, no "confirm within N days or lose this." Quality control
  happens at the point of extraction (conservative, explicitly-stated-only, above a confidence
  floor) and at the point of correction (a person or an automated process fixing a specific wrong
  record). It never happens by expiring things nobody looked at.

Everything from the confirm/reject model to the nightly workers below exists to uphold those two
rules without turning "never forget" into "never organized."

## Layers

**Conversation ledger.** Every turn of a logged conversation is appended to an immutable table,
grouped into sessions by a gap-based cutoff (a long enough pause starts a new session). This is
the verbatim record — nothing here is summarized or lossy.

**Session digests.** When a session closes, it's compressed into a short summary: what happened,
what was decided, what's open. Digests are what an assistant reads to get its bearings quickly;
the ledger underneath is what it falls back to when a digest's gist isn't enough — a specific
number, a specific phrase, a detail digests are too coarse to preserve.

**Topic threads.** Recurring subjects get their own thread linking back to every session that
touched them, so "what have we said about X" doesn't require re-deriving X's history from scratch
each time.

**Entity graph.** A structured, append-only knowledge graph extracted from session digests:
People, Projects, Deadlines, Preferences, and Facts, plus typed edges between them (a small,
fixed vocabulary — works-with, owns, blocks, and the like). It's stored as an append-only log of
records and mutation patches, not a table that gets rewritten in place — a patch either supersedes
an entity (a correction) or confirms it. Reading the graph means folding the patches over the
records; nothing is ever edited in place.

Every entity starts **unconfirmed**. Extraction is deliberately conservative — high confidence
threshold, explicitly-stated facts only — so what lands is mostly right, and being unconfirmed
doesn't make a record invisible or unusable: relationship traversal and retrieval both operate over
unconfirmed data by default. Confirmation is a signal of trust, not a gate on usefulness.

**Procedural notes.** The graph's equivalent for process rather than fact — "how this person
prefers X to be handled." Same candidate → confirm shape as entities, deduplicated on normalized
text.

**Vector / hybrid retrieval.** Conversation turns, entities, and notes are embedded locally on
write and indexed for semantic search alongside the existing full-text index. Retrieval can run in
three modes — keyword, vector, or hybrid (reciprocal-rank fusion of both) — chosen per call. The
retrieval layer has a strict never-reject contract: if the semantic arm can't run for any reason,
a hybrid query silently degrades to the keyword result rather than failing the caller. An outage in
embedding infrastructure should be invisible, not a broken search.

## The correction model

Nothing is fixed by deleting it. A wrong or stale record is fixed by **superseding** it — an
explicit patch that supersedes the old record and (optionally) writes a corrected one — or, for the
common case of a human just clicking a button, an **unconfirm/confirm/reject** action layered on
top of the same append-only log. That surface is optional by design: it exists for when someone
wants to reach in and clean something up, not because the system requires it to keep functioning.

## Self-organizing without asking anyone

A set of maintenance passes runs on a schedule and does the organizing work a person would
otherwise have to do by hand — each one strictly additive, never deleting a Fact:

- **Resolution** mints canonical named nodes for subjects that keep recurring as loose
  descriptive text, and links the descriptions to the node.
- **Deduplication** merges entities that turn out to be the same thing, re-pointing edges rather
  than deleting either side, and preserving anything a human already confirmed or related.
- **Auto-confirm** promotes candidates to confirmed once they're stable, aged past a minimum
  window, and above a stricter confidence bar than extraction used — the automated arm of
  confirmation, so a downstream feature gated on "confirmed" data populates without anyone doing
  confirmation chores by hand.
- **Profile synthesis** rolls the confirmed and flagged parts of the graph into a compact generated
  profile — the assembled, current-state view an assistant can load in one call instead of
  re-deriving it from the raw graph every time.

Each pass runs independently with its own failure boundary, so one going wrong for a night never
blocks the others or the rest of the maintenance job. A pass that starts failing consistently pages
out through the same ticket surface M.O.T. uses for everything else — a silently broken memory
system is worse than a visibly broken one, and this stack learned that lesson once already.

## Getting facts in without a chat turn

The entity graph doesn't only grow from conversation. Any inbound channel that can produce
actionable signal — email is the one implemented today — can write into it directly through a
dedicated ingestion path, gated by the same confidence and type checks the conversational path
uses, and deduplicated against what's already in the graph so a repeated scan never double-writes.
A fact that arrives this way starts unconfirmed like any other; cross-channel duplicates are
flagged for the nightly dedup pass rather than silently merged.

## Reaching out instead of waiting to be asked

A nightly pass can also work in the other direction: scanning confirmed, dated entities (deadlines,
mainly) and proactively nudging about the ones coming up, on a configurable schedule with quiet
hours and a rate cap. This is the one piece of the memory layer that produces unsolicited output —
everything else is retrieval-on-demand.

## MCP surface

The whole layer is exposed to agents as MCP tools, grouped roughly along the boundaries above:
conversation (log/search/recall a turn), memory (write/recall a fact, one-call session context),
topic threads, the entity graph (get/search/relate/confirm/supersede/ingest), procedural notes, and
the maintenance layer itself (run a pass on demand, read its last-run status, read the synthesized
profile). An agent's context window for "what do you already know about this" is one tool call, not
a bespoke query.

## Status and direction

This describes the memory layer as built and running today. It started as M.O.T.-specific
infrastructure and turned out to be the more interesting part of the project — general enough that
it doesn't need to live inside a ticket tracker. The plan is to extract it into its own product
(worked on under the name Recallatron); this document is written at the level that extraction
should preserve, and is the intended starting point for a longer public write-up of how the system
actually works once that happens.

# Idea: Retrieval Epistemics in the Agent-Facing Contract

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `skill/SKILL.md.template`.

## Why this one matters most

Recallatron's product model is an MCP server plus a skill file that teaches an agent how to use it.
crispy-recall ships the same shape, and their skill file is 40 lines that do more for retrieval
quality than most of their 25k lines of code. It is the closest thing to a competitor's UX and it
is worth reading in full.

Four ideas in it are portable, and none of them require touching the data layer.

## 1. Search returns pointers; read is a separate, centered call

> **Pattern: search → read the match.** `recall "query"` returns rows with session ID + matched
> message ID; then `recall <session-id> <message-id>` reads centered on that match (footer shows
> `--offset` to continue). Don't re-read sessions from the top.

Search results carry a snippet and an ID, not the content. Reading is explicit, opens on the
matched turn rather than the beginning, and paginates from there. An agent chasing one fact in a
long conversation pays for a window around that fact instead of the whole session.

M.O.T.'s `chat_search` returns turn rows directly. That is simpler and fine at small result counts,
and it means the agent cannot choose to look at one result more closely without re-querying. The
centered-read primitive is the missing half: `chat_search` gives you the pointer, and something like
`chat_read(turn_id, context: n)` gives you the neighbourhood. `readMessageTurn` in their
`memory-queries.ts` is the reference, including the detail that the context window is clamped
(0 to 5 turns each side) so a caller cannot ask for the whole session by accident.

## 2. Name the failure mode of the thing you are selling

> Semantic fill returns plausible rows for ANY query — judge relevance yourself.

This is the single best line in the file. Vector search always returns its k nearest neighbours.
When nothing relevant exists, it returns the k least-irrelevant things, and they look exactly like
results. An agent that does not know this treats an empty-corpus answer as a positive finding and
confidently reports a hallucinated recollection.

M.O.T.'s tool descriptions currently describe the modes accurately and neutrally: "vector: semantic
KNN. hybrid: RRF merge of fts + vector." Correct, and it tells the caller nothing about how to
disbelieve the output.

## 3. Say that memory is evidence, not truth

> Transcripts record what was believed, not what is — verify claimed state against git/disk before
> repeating it.

And from their README: *"recall surfaces evidence, not truth. Good agents check recovered context
against git HEAD, the current files, and fresh tests before acting on it."*

This is the hard problem in a memory product and they put it in the skill rather than pretending the
store is authoritative. M.O.T. has the write-side answer already: supersede records, correct rather
than delete, and the ratified position that a wrong memory is fixed by correction. There is no
read-side equivalent. Nothing tells Rheo that a retrieved fact is a claim from a past conversation
and may have been true then and false now.

The M.O.T. version of the verification target is not git HEAD. It is the live ticket, the current
`memory_profile`, or the entity's `valid_from`. A retrieved statement about a deadline should be
checked against the Deadline entity before being repeated as current.

## 4. Make degradation visible to the caller

> A read's header says `Session:`. If it says `Query:`, the ref fell back to search and the rows
> are noise — fix the ID; `recall read <ref>` exits nonzero instead of falling back.

They pair a forgiving default (a bad ID falls back to search) with an explicit signal that it
happened, and a strict variant that refuses to fall back at all.

Every result set also carries its provenance:

```
Paths: FTS5=41  Semantic=200 (active)
Paths: FTS5=41  Semantic=0 (UNAVAILABLE)
```

M.O.T.'s degrade contract ratified 2026-07-06 is deliberately silent: a `hybrid` call whose vector
arm dies returns the FTS-arm result, and `lib/conversation.ts` logs to `console.error` and moves on.
Never-reject is the right call and should not change. But the caller currently cannot distinguish a
healthy hybrid result from an FTS-only degrade, which means Rheo cannot say "semantic search is down,
this may be incomplete" because it does not know.

The fix is additive and small: return the arm counts and availability alongside the rows. The rows
stay identical, so nothing about the never-reject guarantee changes. It just stops being invisible.

## 5. Subagent prompts must restate the rules

> **Deep research → sub-agent.** For multi-search timelines, delegate. The sub-agent can't see this
> file, so its prompt must say: use only the `recall` CLI (never Grep/Read .jsonl transcripts); run
> `recall --help` first; search then read matched messages; dates as flags; `--all` if results are
> thin; search exhaustively and cross-reference before reporting.

A neat acknowledgement that skill instructions do not inherit. Any M.O.T. skill that tells an agent
to delegate memory research needs to carry the delegated prompt inline, for the same reason the
hourly mot-intake routine embeds its full prompt rather than loading `SKILL.md` at runtime.

## What to actually change

Three things, in order of cost:

1. **Tool descriptions in `lib/mcp-tools.ts`.** Add the semantic-plausibility warning to the `mode`
   description on `chat_search` / `memory_recent` / `entity_search`. Pure text, zero risk.
2. **Arm provenance on hybrid results.** Return `{ fts_count, vector_count, semantic_available }`
   beside the rows. Additive, does not change the degrade contract.
3. **A centered read primitive** for conversation turns, so search can return pointers rather than
   bodies.

## Possible next step

Write the skill file. Recallatron needs one to ship at all, and drafting it now against M.O.T.'s
actual tool surface will expose exactly which of the three changes above are load-bearing. The
honest test: if you cannot write "verify this against X before repeating it" because there is no X
to name, that is a product gap, not a documentation gap.

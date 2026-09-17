# Idea: From a Line of Code Back to the Conversation That Produced It

Status: idea / product-level, not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/git-attribution.ts`.

## The feature

```bash
recall --commit 25dd0f8
recall --blame src/paths.ts:82-84
```

Given a commit or a file and line range, return the coding sessions that produced those edits,
including the reasoning and the alternatives that were rejected at the time.

Their one-line pitch is the sharpest thing in the repo: **"git blame tells you who. recall --blame
tells you why."**

That is worth studying regardless of whether the feature ships, because it is a complete product
positioning in eight words. It names an existing tool everyone already uses, identifies the exact
question that tool cannot answer, and claims that question. No adjectives.

## How the matching works

The naive version of this feature is to correlate timestamps: find sessions active around the commit
time and call them the cause. That is wrong often enough to be useless, because a developer has
several sessions open and commits hours after the work.

crispy-recall matches structurally instead:

1. Read the commit: files touched, parent commit time, author time, added and removed lines.
2. Prefilter candidate transcripts by file mtime overlapping the search window. This is what keeps
   it fast; most sessions are eliminated without being parsed.
3. Stream-parse the survivors, keeping only `Edit` / `Write` / `MultiEdit` tool calls that fall in
   `[parent_time, commit_time + 1h]`.
4. Require at least one in-window edit to a file the commit actually touched.
5. Build tri-grams of the session's edited content and of the commit's added lines. A non-empty
   intersection is a match.
6. Compute a `surviving_ratio` against the current file state, deduped per file so tri-grams shared
   across files do not double-count.

Tri-gram intersection is the right primitive here. It tolerates reformatting, partial edits, and
later refactors, while still requiring genuine content overlap rather than mere temporal proximity.

Two design choices worth noting. It is **pure on-demand computation** with no persistent index, so
there is nothing to keep in sync and nothing to migrate. And the module explicitly refuses to rank:
its header states it "does NOT decide which match is best" and returns the full chronological list
for the caller to reason over. For an evidence-surfacing tool that is the honest boundary.

## Why this is interesting for Recallatron

It is the one feature in the repo that is genuinely hard to copy and genuinely valuable, and it
points at a product direction the current Recallatron pitch does not cover.

The positioning today is agent memory: entity graph, procedural notes, episodic timeline, aimed at
agent operators. Code provenance is a different buyer with a sharper pain. "Why does this line
exist" is asked constantly, has no good answer today, and the answer is sitting unused in transcript
files on every developer's disk.

It also has a structural advantage as a wedge: it is verifiable. A user can check whether the
returned session really did produce that line, which is not true of most memory claims. A feature
whose output can be checked builds trust in the features whose output cannot.

## What it would require

The hard dependency is keeping structured tool-call records. crispy-recall deliberately excludes
tool calls from its *searchable* corpus (tool output is re-runnable; the conversation that
interpreted it is not) but parses the raw transcripts on demand for attribution. So the raw record
must survive even though it is not indexed.

That is a direct conflict with M.O.T.'s current conversation layer, which stores turn text and
nothing else. Adding attribution means either keeping raw transcripts alongside the indexed turns,
or extracting and storing edit records at ingest. The first is more faithful and more storage; the
second is cheaper and loses anything the extractor did not anticipate.

Their own stated limitation is worth inheriting rather than fighting: edits made by arbitrary shell
commands carry no structured evidence and are not attributable. Scoping the claim to what the tool
can actually see is what keeps the feature trustworthy.

## The honest assessment

This is a dev-tools feature, and Recallatron is currently positioned as an agent memory layer for
agent operators. Those overlap but are not the same market, and building this would be a decision to
chase the dev-tools one.

It is also the most work of anything in this doc set: git plumbing, transcript parsing per vendor,
tri-gram matching, an mtime prefilter to keep it fast, and a storage decision about raw records. Not
a weekend.

## Possible next step

Nothing to build. Keep it on the list as a possible differentiator and revisit if Recallatron's
first cohort turns out to be developers rather than agent operators, which the waitlist will answer.

Independent of the feature, steal the positioning sentence structure. "X tells you who, Y tells you
why" is a template: name the incumbent, name the question it cannot answer, claim it.

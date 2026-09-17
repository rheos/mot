# Idea: Install-Time Backfill as the Cold-Start Answer

Status: idea / product-level, not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/recall/catchup.ts`,
README "Install".

## The one-line version

> Install-time backfill indexes the Claude Code and Codex sessions still present on disk, so recall
> is useful on day one rather than only after day one.

## The problem it solves

A memory product is worth nothing the day you buy it. You install it, it has no memories, and the
first useful retrieval is weeks away, after enough conversation has accumulated to search. Every
day of that gap is a day the user is paying for a promise.

That is a churn problem disguised as a technical one. The Recallatron landing page sells against
agent amnesia: every session starts from zero. A new subscriber's first session also starts from
zero, which is an uncomfortable demonstration of the thing the product claims to fix.

## What they do about it

The installer backfills. It walks the Claude Code and Codex transcript roots, indexes every session
still on disk, and drains the embedding queue. By the time `recall install` finishes, there is a
searchable history, and the very first query can return something real.

The supporting detail that makes this work as a product argument rather than a nice-to-have is their
retention observation:

> Claude Code deletes transcripts after 30 days by default. The recall index doesn't. You can and
> often should raise `cleanupPeriodDays`; longer retention keeps more source files, while recall
> makes the record searchable after those files are gone.

And the closing line of that section: **"Grep can't search a deleted file."**

That reframes the whole feature. The backfill is not just onboarding convenience; it is a rescue.
There is a finite window in which a user's existing history still exists on disk, and installing the
product captures it permanently before the harness deletes it. Waiting costs you data.

## Why Recallatron should take this seriously

The asset is sitting there. Anyone signing up for an agent memory product has months of Claude
transcripts in `~/.claude/projects/`. Indexing them at signup converts an empty product into a
populated one in a single operation, and it is the most persuasive possible demo: the user's first
query is about their own past work, and it returns their own past work.

It also inverts the usual trial dynamic. Instead of "use this for a month and see if it helps",
it becomes "connect it and ask it something you did in June". The value is demonstrable in the first
session rather than inferred from a promise about future sessions.

## The operational shape

crispy-recall's version has three parts worth copying:

1. **Phase separation.** FTS catch-up first (fast, silent), then gap detection, then embedding
   backfill (slow). The keyword index is usable immediately while vectors fill in behind it.
2. **A gate on large jobs.** Under 200 unembedded rows it drains silently; above, it asks, with a
   time estimate from a measured throughput constant. See
   [write-path failure discipline](write-path-failure-discipline-idea.md).
3. **Resumability.** Progress is reported as machine-readable events, the work queue is a database
   query rather than in-memory state, and an interrupted run picks up where it stopped.

Point 3 matters more hosted than local. A server-side backfill of a new tenant's uploaded history
will be interrupted by deploys and rate limits, and it has to survive that without restarting or
double-indexing.

## The parts that are harder hosted

Local backfill reads files that are already on the machine. Hosted backfill means the user uploads
months of raw transcripts to a third party as their first act, before any trust has been
established. That is a real friction point and a real privacy question, and it lands at the worst
possible moment in the funnel.

Options worth thinking about rather than resolving here: client-side filtering before upload,
selective backfill by project or date range, or a local-first import that only ships derived
structure rather than raw text. The last one is interesting because it fits the existing product
shape (extraction produces entities and procedural notes, which are much smaller and much less
sensitive than the transcripts they came from), though it gives up the verbatim record that makes
[the episodic layer](verbatim-episodic-layer-idea.md) valuable.

There is also a cost question. Embedding a new subscriber's entire history is a real bill incurred
before the first subscription payment clears, and it is the obvious thing for someone to abuse by
signing up, backfilling, and cancelling. The capacity allocation model in the product plan is the
right place to handle it.

## Possible next step

Nothing to build in M.O.T. For Recallatron, treat backfill as part of onboarding rather than as a
migration tool, and write the privacy answer before the feature rather than after.

The retention framing is usable in marketing copy immediately, independent of any implementation:
Claude Code deletes transcripts after 30 days by default, and the window to capture what is already
there is closing continuously. That is a genuine reason to act now rather than manufactured urgency,
which is rare enough to be worth using.

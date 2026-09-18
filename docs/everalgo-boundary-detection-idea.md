# Idea: Sessions Are Decided by a Clock, Not by Content

Status: idea / not scheduled. Captured 2026-09-18 from
[EverAlgo](https://github.com/EverMind-AI/EverAlgo) (Apache 2.0, EverMind-AI),
`packages/everalgo-boundary/`. Reviewed the same day against `chat.py`, its prompt, and the
`BoundaryDetector` facade in `everalgo-user-memory`; the description of `tail`, the claim about
`topic_summary`, and the measurement were corrected. The title overstates the contrast (see
"What EverAlgo does"), and is kept because the idea underneath it survives.

## What M.O.T. does

One constant, in `lib/conversation.ts`:

```ts
const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours
```

More than two hours since the last turn in a chat starts a new session. That is the whole rule. It
decides what a digest summarizes, what the deferred embed sweep treats as one unit, and (since #31)
which turns may lend adjacency context to their neighbours.

Two mechanics matter for what follows. The boundary is decided when the *next* turn arrives:
`resolveSessionId` compares the new turn's timestamp with the last stored one and, on a gap, returns
`boundary_closed_session_id`, which the bot uses to fire the digest of the session that just
closed. So the boundary and the digest are decided at the same instant, by the same test. And a
digest *can* be rewritten (`upsertDigest` is an upsert and re-indexes the digest vector), but
nothing ever triggers that for a boundary reason.

The rule is cheap, deterministic and testable, and it is wrong in both directions in ways that are
easy to name. A single conversation broken by lunch splits into two, so the afternoon's first turn
loses the morning's context and the digest summarizes half a thought. Two unrelated exchanges
ninety minutes apart merge into one session, so the digest blends subjects and adjacency
enrichment prepends unrelated context to a short turn.

## What EverAlgo does

Two paths, and the interesting one is the batch path.

**Batch** (`detect_boundaries`): one LLM call over `prior_tail + new_messages`, returning
`DetectionResult(cells, tail, should_wait)`:

- **`cells`**: slices closed by the boundaries the model placed. The caller persists these.
- **`tail`**: everything after the *last* boundary. This is not a judgement; it is structural.
  The model cannot know whether the conversation continues past the last message it saw, so the
  trailing segment is always left open unless the caller passes `is_final=True`. The docstring
  says so: a non-empty tail is the normal case. The caller carries it into the next batch.
- **`should_wait`**: the narrower verdict, and the model's own: the tail is too thin to place in
  an episode at all (only media placeholders, an intent-free "ok", a system notification, or a
  30-minute-to-4-hour gap with content that neither clearly continues nor clearly starts). The
  docstring is careful that this is not "tail is non-empty".

**Step** (`adetect_boundary_step`, wrapped by `BoundaryDetector.adetect_step`): one LLM call per
new message, answering "has a new episode begun", returning `should_end`, a `confidence`, and a
`topic_summary` for the episode being closed. A bucketed `time_gap_info` label ("47 minutes (recent
conversation)", "5 hours (same day, but significant pause)") is rendered into the prompt, so time
is an input, not the decision. `should_wait` is always `None` on this path.

Two corrections to the first draft. `topic_summary` exists only on the step path; the batch path
returns one `reasoning` sentence for all its boundaries together, and neither is stored on the
`MemCell` (which carries items and a timestamp, nothing else). And the step path does not defer
anything: it decides on every message, with a model call, and accumulates until it says stop.
Deferral is a property of the batch design, where the caller holds the tail.

**Their clock rules.** The title of this doc contrasts a clock with content. EverAlgo's batch
prompt has clock rules of its own, and its highest-priority one is cruder than M.O.T.'s:

> Cross-day split (highest priority): Adjacent messages have different calendar dates: MUST split
> at the date boundary.

Then: a gap over 4 hours *and* a new topic splits; a 30-minute-to-4-hour gap is the ambiguous band;
and hard limits of 8,192 tokens or 50 messages force a split regardless of content. A conversation
that crosses midnight is cut by their rule and not by M.O.T.'s. The accurate contrast is not "clock
versus content" but "one clock threshold" versus "a clock band plus a content judgement inside it".

## The idea worth taking, independent of the model

**A session boundary can be undecided.**

M.O.T.'s rule is forced to answer immediately and permanently on every turn: same session or new
one, decided by a clock, never revisited. There is no state for "these last few turns might belong
to either, ask again when more arrives."

That matters because the boundary is consumed by things that are not recomputed. The digest is
generated the moment the boundary is declared. Adjacency enrichment is baked into a stored vector.
A boundary placed wrongly at 14:31 is still wrong at midnight.

A deferred band would let the cheap rule keep running outside it while the ambiguous gaps wait
for evidence. But "defer" has to name what decides later, or it is the same clock with a delay. If
the later decision is also a clock, nothing has been gained. The honest cheap version is the
vectors that already exist: at a gap inside the band, hold the boundary until the next turn
arrives, then compare that turn's vector with the previous session's turns, and only then close
or continue. No model call, but a real content signal.

Two costs the first draft did not state. Holding the boundary means holding the digest trigger,
which changes the contract with `bot.py` (`boundary_closed_session_id` would fire later, or from a
different place). And the first turn after a gap is exactly the turn that embeds worst: #31
measured 95% of user turns under 200 characters, and enrichment deliberately does not reach across
a boundary, so that turn's vector is bare. The comparison would have to use the first *substantive*
turn, or several turns together, which pushes the decision later still.

## Honest counter-argument, and it is strong

**The clock may be good enough here.** Their corpus is coding sessions across several tools; a
Telegram thread with one human has far simpler structure. Robin talks to Rheo in bursts, and a
two-hour silence genuinely is usually a boundary.

**Nobody has shown the rule failing.** The 2026-09-18 measurements saw 1,034 turns across 86
sessions, twelve turns each on average, which is plausible for real exchanges. No
split-mid-conversation or merged-unrelated-topics case was observed, because nothing looked. That
is an absence of evidence, and the failure rate is unmeasured.

**A model call is expensive in the wrong place.** It would sit on the `logTurn` hot path, which has
a documented ~300ms budget before inline embedding gets deferred. EverAlgo's operators are async
Python and leave persistence to the caller, so where the call sits is the caller's problem there
and would be M.O.T.'s here.

## The measurement that would settle it

The first draft proposed comparing the last turn before each boundary with the first turn after,
against within-session adjacent pairs as a baseline. That comparison is confounded in both
directions and would not answer the question:

- Within-session adjacent pairs are question-then-answer by construction, so they are close for a
  reason that has nothing to do with topic continuity across a gap.
- Boundary-adjacent turns are systematically different from mid-session turns: closers, openers,
  "ok", "hey". Short and bare. A large distance there reflects the turn's shape, not the topic.
- The same shortness makes a *small* distance unreliable too.

So "boundary pairs indistinguishable from within-session pairs" could come out either way for
reasons unrelated to whether the clock split a live conversation.

Run this instead, in order, cheapest first:

1. **The gap histogram.** For every consecutive pair of turns in a chat, the gap in minutes.
   Confound-free and needs no vectors. If the distribution is bimodal with a trough around two
   hours, the cut sits in the trough and the number of ambiguous gaps (say 1 to 4 hours) is the
   size of the whole problem. With 86 sessions there are 85 boundaries; count how many fall in the
   band. If it is three, close this doc.
2. **For the ambiguous boundaries only**, compare the first substantive post-gap user turn (long
   turns only, the same trick #43 used to dodge enrichment) with the *previous session's digest
   vector* in `session_digest_vec`, and with a sample of other sessions' digests as the baseline.
   A digest is a whole-session summary, so this asks "is the new turn about what that session was
   about" rather than "is it close to whatever the last message happened to be".
3. **For merges**, within sessions, look for adjacent long-turn pairs with a gap in the 30-minute
   to 2-hour range and a distance out in the irrelevant tail (#43's p50 for unrelated content was
   0.816). Those are candidate false merges. The Q/A confound still applies to a user turn
   following a bot turn; compare user turn to the *preceding user turn* instead.

None of the three is clean, and the second and third inherit every caveat about short turns. The
first is clean, and it is the one that decides whether the other two are worth running.

The data is on the box, not local: the local `mot.db` snapshot has 369 turns in 13 sessions. Pull a
fresh copy (memory note `local-dev-data-from-prod`) before running anything.

## Possible next step

Run the gap histogram before anything else. If the ambiguous band is nearly empty, the clock is
doing its job and this doc should be closed as not-needed, which is a perfectly good outcome and
the same one `retrieval_class` earned.

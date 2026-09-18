# Idea: Ask Whether the Results Are Enough

Status: idea / not scheduled. Captured 2026-09-18 from
[EverAlgo](https://github.com/EverMind-AI/EverAlgo) (Apache 2.0, EverMind-AI),
`packages/everalgo-rank/src/everalgo/rank/agentic.py`. Reviewed the same day; the description of
what EverAlgo does on an empty first round, and the "cheaper inversion" claim built on it, were
corrected.

## The gap this fills

Issue #43 gave the vector arm a relevance floor, so a query with no answer now returns nothing
instead of eight confident-looking rows. That was the right fix and it is half an answer.

The floor establishes **that nothing was near**. It does not decide **what to do about it**. Today
the answer is always the same: return what survived, and let the caller work it out. An empty
result and a thin result look identical from the outside, and neither triggers a second attempt.

The live example that prompted the floor is also the example here:

```
chat_search("what did we decide about the maintainer provider", hybrid)
  -> rank 2: "how are you holding up?"
```

That conversation happened in Claude Code, not Telegram. The correct response is not "return
fewer rows". It is "the corpus does not contain this; say so, or try a different question".

## What EverAlgo does

`agentic.py` wraps any retrieval function with a sufficiency check and a conditional second round:

```
1. Round 1: base_retrieve(query, round1_top_n)
   -> if EMPTY, return [] immediately. No LLM call, no expansion.
2. Optional rerank
3. Sufficiency check: one LLM call, structured output
   (is_sufficient, reasoning, key_information_found, missing_information)
4. If sufficient -> return, flagged is_multi_round=False
5. If not, either:
     multi_query   -> LLM generates 2-3 queries aimed at missing_information, run in parallel, RRF-merged
     refined_query -> LLM generates one rewritten query, run once
6. Merge round 1 + round 2, dedup by id, optional final rerank, truncate
```

Step 1 is the detail the first draft of this doc missed, and it changes the conclusion below. An
empty first round is treated as a terminal answer. Expansion only ever runs when *something* came
back and the model judged it insufficient. The multi-query prompt is built from that judgement: it
is handed `key_information_found`, `missing_information` and the retrieved documents, and picks a
strategy per gap (pivot to a related entity, anchor a relative date, expand vocabulary, relax a
constraint). It is an informed rewrite, not a paraphrase.

Two details worth keeping.

**The decision is returned, not hidden.** `AgenticDecision(is_multi_round, is_sufficient,
reasoning, missing_info, refined_queries, ...)` travels with the results, so the caller knows what
happened. That is the same instinct as the retrieval provenance added in #45.

**The two rounds are fused with RRF.** The round-2 sub-queries are independent attempts at the
same information need, which is the case fusion was designed for.

## The two failure classes, and which one M.O.T. can detect

There are two ways a search can fail, and they need different detectors:

| | what came back | who can see it |
|---|---|---|
| **nothing near** | zero rows (or rows the floor discarded) | the relevance floor, for free |
| **near but not the answer** | rows about the topic that do not contain what was asked | only something that read them |

M.O.T. has the first detector and not the second. EverAlgo has the second and does nothing about
the first. The first draft of this doc proposed "use the floor as the gate, then expand": that is
not EverAlgo's design turned cheaper, it is a different mechanism. With zero rows there is no
`key_info` and no `missing_info` to steer the rewrite, so the expansion has only the original
query to work from. That is a blind paraphrase, which may still be worth trying, but it should not
be described as their loop with the expensive step removed.

The second detector costs a model call on every search that returned anything. A day of
measurement showed M.O.T.'s retrieval problems were mostly mechanical (an FTS arm that matched
nothing, fusion that discarded consensus, an arm with no floor) and were fixed with arithmetic.
Whether "near but not the answer" happens often enough to pay for a per-query model call is
unmeasured.

## Who should own the retry

The expansion loop can live in two places:

- **In M.O.T.**, behind the MCP tool, so any caller benefits and the logic is tested once.
- **In Rheo's prompt**, as an instruction to try again with different words when a search comes
  back empty.

The second is nearly free and already half-present. The bot's system prompt (`bot.py`,
`CLAUDE_SYSTEM`, the "Recall protocol" added 2026-08-27) tells Rheo to call
`chat_search(mode:"hybrid")` before claiming not to remember, and `profile.md`, which is appended
to the same system prompt, tells it when to reach for hybrid. Neither says what to do when the
search returns nothing. "If it comes back empty, try once more with different words before
concluding it is not there" is one sentence in the recall protocol, needs no code, and is testable
immediately.

The first is more reliable and more expensive, and it moves a judgement into the data layer that
the data layer has no context to make. M.O.T. sees the query string the agent produced, not what
Robin asked.

That argues for the prompt first, measured with the tool-call log, and the code version only if
the prompt version demonstrably fails.

## Honest counter-argument

This proposes adding a model call, or at least a second search, to a path that currently makes
neither, on the strength of one example whose real cause was that the memory lived in a different
system. Query expansion will not find a conversation that happened somewhere else. The honest
answer to that query was always "not here", and #45 already put that warning into the tool
descriptions: vector search always returns its nearest rows, and an empty result from `hybrid`
means both arms found nothing (a fully-floored vector arm degrades to the FTS list, so zero rows
means FTS was empty too). The most valuable part of this idea may simply be the agent *saying* that
rather than trying harder.

## Possible next step

Add the one sentence to the recall protocol in `bot.py`, then read `tool_call_log` after a week.
It records `query`, `mode`, `result_count` and `duration_ms` for the read tools, so "how often does
a search return zero" is one query. It does not record a chat or session id, so "did a second
attempt follow" has to be inferred from time adjacency (same tool, within a minute). On a
single-user system that is good enough to size the problem before any code is written.

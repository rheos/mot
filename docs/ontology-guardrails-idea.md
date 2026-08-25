# Idea: Ontology Guardrails for the Memory Layer

Status: idea / not scheduled. Follow-up captured after watching Frank Coyle's talk
"Why Agentic Systems Need Ontologies" (AI Engineer, 2026-07-23).

## The talk in one paragraph

Coyle's pitch is neurosymbolic: keep the probabilistic LLM on the inside, put a formal
ontology on the outside as logical guardrails. An ontology is just typed entities,
relationships, and constraints, expressed with old standards like RDFS and OWL. You wrap a
tool-use loop with a validator: the model proposes a tool call, you check its argument types
(he uses Pydantic) and check its results against the ontology, and only then let it act. The
constraints catch things a paragraph of English cannot reliably stop — a second refund on the
same order (a uniqueness constraint), a payout sent to the support rep instead of the buyer
(disjoint classes), an order status of "probably shipped" (a value that is not in the allowed
set).

## Why it is relevant here

The memory layer already is the data structure Coyle argues for. It is a typed entity graph:
Person / Project / Deadline / Preference / Fact, with properties and a small fixed edge
vocabulary. That is his "ontology = typed entities + relationships + constraints." He is
naming, in RDFS/OWL terms, roughly the thing this layer already runs informally.

Two of his specific constructs are already enforced elsewhere in the app, at the ticket layer
rather than the memory layer: statuses, severities, and ministries are fixed enums, transitions
are checked against a legal-transition table, and an illegal transition is rejected at the API
boundary. That is exactly his "value must be one of this set" idea, already shipped for tickets.

## Where it does NOT fit — the part to not import blindly

The memory layer's design is deliberately the opposite of hard rejection, and that is ratified,
not accidental:

- Memory is persistent. Facts are not deleted for going unused; there is no decay.
- The system is ambient, not administered. Quality control lives at extraction time, and a
  wrong record is fixed by correction or supersession, not by deletion.
- Duplicates are flagged, not auto-merged. Edges are traversed even when unconfirmed.

A strict OWL reasoner that rejects or deletes records on a constraint violation would fight all
three. Coyle's model also assumes irreversible side effects worth guarding (refunds, payouts).
The memory layer is a record surface with no consequential action to gate, so "validate at the
ledger before the side effect" has no ledger to sit in front of. The tool-loop validator pattern
belongs on write paths that actually mutate state (the maintainer workers, entity ingestion,
ticket writes), not on the read/memory role.

So: conceptually aligned at the data model, opposed at the enforcement model. Nothing here
argues for rebuilding the memory layer on OWL.

## The one concrete borrow worth doing

The maintainer workers already perform OWL-style constraints, but by LLM. Two examples:

- Minting one canonical named node for a recurring subject, instead of several duplicates, is a
  uniqueness / functional-property constraint.
- Normalizing entity types so every record uses a valid type is a disjoint-class /
  enumeration constraint. The layer has already needed a one-off mechanical cleanup of invalid
  lowercase types.

The mechanical cases of both can be expressed as deterministic code constraints rather than an
LLM pass. Doing so is:

- Cheaper and lower-risk. Fewer LLM calls in the nightly maintainer job means less cost and less
  exposure to the resource limits that already force the LLM workers to batch.
- Deterministic. Exact-match dedup and type normalization do not need a probabilistic model to
  decide; they need a rule. Reserve the LLM for the genuinely fuzzy calls (near-duplicate subjects,
  ambiguous references) where a rule cannot decide.

This keeps the ratified invariants intact: it moves the *mechanical* constraints into code, it
does not add rejection or deletion, and it does not make Robin do maintenance.

## What to leave alone (for now)

RDFS domain/range inference (from "X manages Y" derive "X is a Person") is the one capability the
talk has that this layer does not. It is genuinely useful, but it leans toward deriving and
asserting new facts automatically, which is closer to the administered direction the memory design
avoids. Park it unless a concrete need appears.

## Possible next step

Audit the resolution and dedup maintainer workers for the subset of decisions that are exact-match
mechanical (identical type+label, invalid type string, obvious canonical merge). Pull those into a
pure-code pre-pass that runs before the LLM step, and let the LLM handle only what is left. Measure
the reduction in LLM calls per nightly run.

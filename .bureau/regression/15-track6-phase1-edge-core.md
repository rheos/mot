name: Track 6 Phase 1 — edge core (relate write, single ts-ordered fold, confirmed-only BFS, entity_relate MCP tools)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/graph.test.ts tests/integration/mcp-tools.test.ts -t "Track 6"
expected: all Track-6 cases pass — graph.test.ts "Track 6 — edge core (lib/graph)" (round-trip AC-1, fold populates AC-2, confirmed-only BFS AC-3, manual edge AC-4, one-way confirmed latch AC-14, automated-relate-after-unrelate-stays-expired AC-16, human re-assert AC-17, reject contract AC-18/W4, dedup EC4, expired-excluded EC7, phantom-clear W3, vocab closure, confirm-then-downgrade) + mcp-tools.test.ts "Track 6 edge tools" (entity_relate self_relate/invalid_rel/from_not_found/to_not_found AC-5, entity_relate_confirm already_confirmed, entity_relate_reject not_found/already_rejected). Guards the resolveEdges single ts-ordered fold: the confirmed one-way latch and human-authoritative liveness (a later automated relate can never flip a human's confirm/reject).
phase: 15 · execute-plan
owner: .bureau/runs/20260707-rheo-memory-track6/prompts.md Prompt 1 — Edge core
mutation-test: CONFIRMED 2026-07-08 — neutralizing the confirmed-only BFS guard (lib/graph.ts:696 `if (edge.confirmed !== true) continue;`) turns this fixture RED (AC-3 fails: an unconfirmed edge is wrongly traversed → 1 failed | 20 passed). Reverted cleanly; baseline green (21 passed).

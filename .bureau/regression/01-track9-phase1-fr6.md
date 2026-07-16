name: Track 9 Phase 1 — FR-6 resolve-or-create in processRelations (live extraction grows the graph, no longer drops edges)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/extraction.test.ts
expected: all extraction.test.ts cases pass — the FR-6 Phase-1 cases (unresolved endpoint MINTS a confirmed:false/source:session: node + links it; exact-label endpoint resolves with no duplicate mint; backfill create:false regression guard on the generalized source param) plus the 4 rewritten Track-6 cases now asserting resolve-or-CREATE (Levenshtein decoy still proves 'mot' does NOT fuzzy-match 'moi' — it mints a distinct node instead of dropping the edge).
phase: 01 · execute-plan (Track 9)
owner: .bureau/runs/20260709-rheo-memory-track9-maintainer/prompts.md Prompt 1 — Live FR-6 fix
mutation-test: PENDING — capture at close-out before promotion (neutralize the create:true resolve-or-create path in processRelations → the mint-on-unresolved case goes RED)

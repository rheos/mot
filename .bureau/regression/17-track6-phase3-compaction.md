name: Track 6 Phase 3 — compaction + pruning safety (foldRecords edge fold, compactGraph edge emission, FR14 prune-guard)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/graph-compact.test.ts
expected: all graph-compact tests pass (15) — incl FR14/AC-11 (prunePendingEntities spares an unconfirmed, old, low-confidence entity that has an outgoing relate patch — protection via a real appendRelate patch, not inline relations), AC-10 (compactGraph emits live surviving-from confirmed relate lines, drops expired + orphaned-from, confirm_relate/unrelate collapsed), EC6 (orphaned-from patch no-op post-compact), and blocker-path-b/AC-15 (a compacted relate(confirmed:true) is NOT downgraded by a later automated relate(confirmed:false) on re-loadGraph; BFS still follows the edge). Guards the shared resolveEdges/attachRelations fold in graph-compact (no third copy) + the atomic entity+edge write.
phase: 17 · execute-plan
owner: .bureau/runs/20260707-rheo-memory-track6/prompts.md Prompt 3 — Compaction + pruning safety
mutation-test: CONFIRMED 2026-07-08 — neutralizing the FR14 fix (lib/graph-compact.ts:146 `attachRelations(entities, resolvedEdges)` removed from foldRecords) turns this fixture RED (2 failed | 13 passed — AC-11 wrongly prunes an entity whose only edges are pending relate patches, plus a fold test). Reverted cleanly; baseline green (15 passed).

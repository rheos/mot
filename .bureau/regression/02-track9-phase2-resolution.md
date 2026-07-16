name: Track 9 Phase 2 — resolution worker (LLM-identify→mint canonical node + link facts) + bidirectional relatedEntities (AC-1)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/maintainer-resolution.test.ts
expected: all resolution-worker cases pass — LLM-identify (injected stub, no real claude -p) mints a canonical node (confirmed:false, source:'maintainer:resolution') and links ≥5 member Facts via points_to; relatedEntities(robinId) returns ≥5 (AC-1, via bidirectional traversal); below-threshold distinct_source_count NOT minted (FR-5); re-run appends ZERO new JSONL lines (B3 cross-run idempotency seeded from persisted edges); Facts never superseded (persistence FR-3/FR-17); dry_run appends nothing (AC-9).
phase: 02 · execute-plan (Track 9)
owner: .bureau/runs/20260709-rheo-memory-track9-maintainer/prompts.md Prompt 2 — Resolution worker (+ 2b bidirectional relatedEntities)
mutation-test: PENDING — capture at close-out (neutralize the ≥0.85 gate or the persisted-seenEdges seeding → idempotency/threshold case goes RED)

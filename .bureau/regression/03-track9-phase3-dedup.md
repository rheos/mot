name: Track 9 Phase 3 — dedup/merge worker + EC-5 edge re-point (whole-pass map, confirmed+expired, property union)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/maintainer-dedup.test.ts
expected: all dedup cases pass — mergeGroup property union loses NO key (incl. deep-merge of nested object-valued conflicting keys, FR-10); two/three exact-label dups → one survivor; EC-5 re-point via appendResolvedRelate (AC-6a unrelate→expired, AC-6b confirm_relate→confirmed, AC-6c self-loop dropped, AC-6d confirmed-then-rejected→expired, AC-6e confirmed-live→live); EC-12 cross-group loser edge re-points to survivor→survivor (no phantom edge to a superseded node); superseded content remains in JSONL; re-run appends zero lines (idempotency); dry_run → no JSONL + no .bak; no single-entity retype (B4); injected stub identify (no real claude -p).
phase: 03 · execute-plan (Track 9)
owner: .bureau/runs/20260709-rheo-memory-track9-maintainer/prompts.md Prompt 3 — Dedup worker + EC-5 (+ fixes: NUL, confirmed+expired, whole-pass map)
mutation-test: PENDING — capture at close-out (neutralize the whole-pass mergedAwayMap flatten → EC-12 phantom-edge case goes RED; neutralize the ≥0.85 gate or appendResolvedRelate valid_until → an EC-6 case goes RED)

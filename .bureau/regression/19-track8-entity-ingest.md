name: Track 8 Phase 1 — entity_ingest MCP tool + shared-gate refactor
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/entity-ingest.test.ts tests/integration/extraction.test.ts
expected: entity-ingest 6 cases pass (confidence boundary 0.84 reject / 0.85 admit + nothing appended on reject; unknown type reject + no append; clean append confirmed:false with source echoed; idempotency — same source twice -> 2nd { skipped:true } and exactly ONE entity with that source; dedup flag — probable_duplicate_of non-empty referencing seeded id; reason persisted to properties.reason) AND extraction.test.ts 28 pass (behavior-preserving refactor proof — scanForDuplicates extraction did not change the digest dedup path).
phase: 01 · feature build-tail (Track 8)
owner: .bureau/runs/20260717-rheo-memory-track8-gmail-ingestion/prompts.md Prompt 1 — Shared-gate refactor + entity_ingest MCP tool
mutation-test: CONFIRMED 2026-07-18 — neutralizing the graphEntitySources idempotency guard (`if (sources.has(source))` -> `if (false && ...)`) turns the idempotency case RED (1 failed), reverted clean. Guards: idempotency skip, spread-merge properties, passesConfidence >= gate, the three exports.

name: Recallatron Phase 1 — migration integration test
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/migrations.test.ts
expected: 4 tests pass (topic_thread, topic_thread_session, procedural_notes, memory_items_fts tables created; FTS insert trigger indexes)
phase: 01 · execute-plan
owner: prompts.md Prompt 1 — Storage foundation

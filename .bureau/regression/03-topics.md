name: Recallatron Phase 3 — topics + procedural library tests
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/topics.test.ts tests/integration/procedural.test.ts
expected: 21 tests pass (11 topics + 10 procedural — all happy paths and documented error returns)
phase: 03 · execute-plan
owner: prompts.md Prompt 3 — Relational data libraries

name: Recallatron Phase 2 — entity graph library tests
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/graph.test.ts
expected: 16 tests pass (round-trip, supersession fold, malformed skip, cycle guard, 50-cap, unconfirmedOnly filter, getEntity, etc.)
phase: 02 · execute-plan
owner: prompts.md Prompt 2 — Entity graph library

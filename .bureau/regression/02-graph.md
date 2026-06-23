name: Recallatron Phase 2 — entity graph library tests
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/graph.test.ts
expected: 19 tests pass (round-trip, supersession fold, malformed skip, cycle guard, 50-cap, unconfirmedOnly filter, getEntity, etc. + Track 3: confirm-fold false→true with unpatched-stays-false control, appendEntityConfirm round-trip, no-op discrimination guard)
phase: 02 · execute-plan
owner: prompts.md Prompt 2 — Entity graph library

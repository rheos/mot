name: Prompt 5 — Phase 1 vec write-path integration tests green
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT" && npx vitest run tests/integration/vec-write.test.ts
expected: exit 0 — 7/7 pass (or clean describe.skipIf skip on a box without extension+embedder)
phase: 05 · execute build tail
owner: prompts.md Prompt 5

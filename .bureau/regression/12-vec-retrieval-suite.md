name: Prompt 9 — Phase 2 retrieval integration tests green
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT" && npx vitest run tests/integration/vec-retrieval.test.ts
expected: exit 0 — 11/11 pass (or clean skipIf skip on a box without extension+embedder)
phase: 09 · execute build tail
owner: prompts.md Prompt 9

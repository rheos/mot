name: Prompt 11 — backfill dry-run/idempotency tests green
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT" && npx vitest run tests/integration/vec-backfill.test.ts
expected: exit 0 — 4/4 pass (or clean skipIf skip on a box without extension+embedder)
phase: 11 · execute build tail
owner: prompts.md Prompt 11

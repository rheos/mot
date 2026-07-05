name: Prompt 10 — backfill script seams (npm entry, exitCode semantics, idempotency primitive)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  grep -q '"backfill:embeddings"' "$ROOT/package.json" && \
  strip "$ROOT/scripts/backfill-embeddings.ts" | grep -q 'process.exitCode = 1' && \
  strip "$ROOT/scripts/backfill-embeddings.ts" | grep -q 'export function vecIdSet'
expected: exit 0 — npm entry present, partial-failure exitCode assignment present, idempotency primitive exported
phase: 10 · execute build tail
owner: prompts.md Prompt 10

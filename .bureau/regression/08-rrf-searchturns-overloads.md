name: Prompt 6 — rrfMerge helper + searchTurns overload seam present
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  test -f "$ROOT/lib/rrf.ts" && \
  strip "$ROOT/lib/rrf.ts" | grep -q 'export function rrfMerge' && \
  strip "$ROOT/lib/conversation.ts" | grep -q "'vector' | 'hybrid'" && \
  cd "$ROOT" && npx tsc --noEmit
expected: exit 0 — rrfMerge exported, overload mode union present in searchTurns, typecheck green (overload binding intact)
phase: 06 · execute build tail
owner: prompts.md Prompt 6

name: Prompt 7 — entity/memory retrieval seams present (overloads + vector/hybrid fns)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/lib/graph.ts" | grep -q "'vector' | 'hybrid'" && \
  strip "$ROOT/lib/memory.ts" | grep -q 'export async function searchActiveMemoryVector' && \
  strip "$ROOT/lib/memory.ts" | grep -q 'export async function searchActiveMemoryHybrid' && \
  cd "$ROOT" && npx tsc --noEmit
expected: exit 0 — searchEntities mode union present, both memory retrieval fns exported, typecheck green (AC-4 overload binding intact)
phase: 07 · execute build tail
owner: prompts.md Prompt 7

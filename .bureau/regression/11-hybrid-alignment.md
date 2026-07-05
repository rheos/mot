name: Alignment patch — uniform hybrid contract tokens (entity limit, empty-q gates)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/lib/graph.ts" | grep -q 'ENTITY_SEARCH_LIMIT = 50' && \
  strip "$ROOT/lib/conversation.ts" | grep -q 'q.trim()' && \
  strip "$ROOT/lib/graph.ts" | grep -q 'q.trim()' && \
  strip "$ROOT/lib/memory.ts" | grep -q 'q.trim()'
expected: exit 0 — shared entity limit constant and empty-q guards present in all three retrieval libs
phase: alignment-patch · execute build tail
owner: Conductor alignment directive (hybrid-degrade ratified 2026-07-06)

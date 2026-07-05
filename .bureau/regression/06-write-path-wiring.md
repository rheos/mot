name: Prompt 4 — write-path vec wiring, uniform double gates, loadGraph export
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/lib/conversation.ts" | grep -q 'indexAsync' && \
  strip "$ROOT/lib/memory.ts" | grep -q 'embeddingEnabled() && vecAvailable()' && \
  strip "$ROOT/lib/graph-compact.ts" | grep -q 'embeddingEnabled() && vecAvailable()' && \
  strip "$ROOT/lib/digest.ts" | grep -q 'EMBED_INLINE' && \
  strip "$ROOT/lib/graph.ts" | grep -q 'export function loadGraph'
expected: exit 0 — indexAsync wired in conversation; double gates in memory + graph-compact; deferred sweep flag in digest; loadGraph exported (Prompts 7/10 prerequisite)
phase: 04 · execute build tail
owner: prompts.md Prompt 4

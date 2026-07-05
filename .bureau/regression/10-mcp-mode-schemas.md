name: Prompt 8 — mode enum on exactly three MCP tool schemas + await wiring
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  n=$(strip "$ROOT/lib/mcp-tools.ts" | grep -c "'fts', 'vector', 'hybrid'")
  test "$n" -eq 3 && \
  strip "$ROOT/lib/mcp-tools.ts" | grep -q 'await searchTurns' && \
  strip "$ROOT/lib/mcp-tools.ts" | grep -q 'await searchEntities'
expected: exit 0 — mode enum appears exactly 3 times (chat_search, memory_recent, entity_search), both W5 await sites present
phase: 08 · execute build tail
owner: prompts.md Prompt 8

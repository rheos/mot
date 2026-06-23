name: Recallatron Phase 5 — MCP tool surface tests
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/mcp-tools.test.ts tests/integration/memory-track1.test.ts
expected: 49 tests pass (17 mcp-tools + 32 memory-track1 — all 8 Track-2 tools + Track 3: arg-shape guard returns invalid_arg, EXPECTED_MCP_TOOLS subset incl. entity_confirm/entity_supersede)
phase: 05 · execute-plan
owner: prompts.md Prompt 5 — MCP tool surface

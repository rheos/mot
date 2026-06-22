name: Recallatron Phase 5 — MCP tool surface tests
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/mcp-tools.test.ts tests/integration/memory-track1.test.ts
expected: 46 tests pass (17 mcp-tools + 29 memory-track1 — all 8 new tools, happy paths + domain errors, memory_recent FTS routing)
phase: 05 · execute-plan
owner: prompts.md Prompt 5 — MCP tool surface

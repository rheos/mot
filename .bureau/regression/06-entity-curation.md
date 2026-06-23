name: Track 3 — entity curation MCP tools (entity_confirm, entity_supersede)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/entity-curation.test.ts
expected: 8 tests pass — AC-1 confirm drops from unconfirmed set; AC-2 unknown id not_found; AC-3 already_confirmed; AC-4 supersede drops from active, target remains; AC-5 self_supersede / not_found,id / target_not_found; EC-1 superseded → not_found. Every error path returns text({error}), never throws (AC-12).
phase: 06 · execute-plan
owner: prompts.md Prompt 2 — Curation MCP tools (entity_confirm, entity_supersede)

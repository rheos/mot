name: Track 9 Phase 4 — nightly cron wiring + maintainer_status/maintainer_run MCP tools + status file
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/backup-nightly.test.ts tests/integration/maintainer-mcp.test.ts
expected: nightly sequence runs all steps even when a worker throws (each own try/catch, AC-10); MAINTAINER_*_DISABLE=1 short-circuits before any worker call/write (AC-7); maintainer_status zero-state on no prior run, never throws (AC-8); maintainer_run dry-run runs identify (stub) but writes nothing/no backup (AC-9); crash-atomic writeStatus + parse-safe readStatus; MCP tools return typed {error}, never throw.
phase: 04 · execute-plan (Track 9)
owner: .bureau/runs/20260709-rheo-memory-track9-maintainer/prompts.md Prompt 4 — Cron + MCP + status
mutation-test: PENDING — capture at close-out (remove a worker's try/catch → the throw-isolation case goes RED; neutralize the disable-env check → AC-7 goes RED)

name: Track 3 — graph.jsonl nightly backup helper (backupGraph)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/backup.test.ts
expected: backupGraph copies graph.jsonl to <backupDir>/graph.jsonl with matching content (AC-9a) and returns without throwing when the graph file is absent (AC-9b / EC-7), so a missing graph never aborts the DB backup.
phase: 07 · execute-plan
owner: prompts.md Prompt 4 — backup + arg guard + allowlist (lib/backup.ts)

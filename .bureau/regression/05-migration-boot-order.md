name: Prompt 3 — 0007_vec migration registered + migrations suite green
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/db/client.ts" | grep -F -q "'0007_vec.sql'," && \
  strip "$ROOT/db/client.ts" | grep -q 'loadVecExtension' && \
  test -f "$ROOT/db/migrations/0007_vec.sql" && \
  cd "$ROOT" && npx vitest run tests/integration/migrations.test.ts
expected: exit 0 — 0007 registered in HAND_WRITTEN_MIGRATIONS (quoted array-entry form, unique to the registration line), extension load wired, migration file present, migrations suite green
phase: 03 · execute build tail
owner: prompts.md Prompt 3

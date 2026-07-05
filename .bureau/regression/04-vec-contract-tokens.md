name: Prompt 2 — vec/embedding live-code contract tokens (AS id alias, BigInt PK coercion, embed-off switch)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/lib/vec.ts" | grep -q 'AS id, distance' && \
  strip "$ROOT/lib/vec.ts" | grep -q 'BigInt(' && \
  strip "$ROOT/lib/embedding.ts" | grep -q 'MOT_EMBED_DISABLE'
expected: exit 0 — KNN id alias, INTEGER-PK BigInt coercion, and test embed-off switch all present in live code
phase: 02 · execute build tail
owner: prompts.md Prompt 2

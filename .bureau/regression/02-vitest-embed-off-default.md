name: Prompt 1 — test suite defaults to embed-off (no model download in tests)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/vitest.config.ts" | grep -q 'MOT_EMBED_DISABLE' && \
  strip "$ROOT/.gitignore" | grep -q '.model-cache' && \
  strip "$ROOT/.github/workflows/deploy.yml" | grep -q 'model-cache'
expected: exit 0 — embed-off env in vitest config; model cache gitignored and deploy-excluded
phase: 01 · execute build tail
owner: prompts.md Prompt 1

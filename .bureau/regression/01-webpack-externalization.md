name: Prompt 1 — native deps externalized in next.config.mjs
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  strip() { grep -v '^[[:space:]]*//' "$1"; }
  strip "$ROOT/next.config.mjs" | grep -q "startsWith('sqlite-vec-')" && \
  strip "$ROOT/next.config.mjs" | grep -q 'fastembed' && \
  strip "$ROOT/next.config.mjs" | grep -q 'onnxruntime'
expected: exit 0 — all three externalization tokens present in live (non-comment) config code
phase: 01 · execute build tail
owner: prompts.md Prompt 1

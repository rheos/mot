name: TypeScript strict typecheck green
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT" && npx tsc --noEmit
expected: exit 0, no output — strict typecheck passes
phase: 01 · execute build tail
owner: prompts.md Prompt 1

name: Recallatron Phase 4 — extraction pass tests
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/extraction.test.ts
expected: 13 tests pass (fixture round-trip with confidence gating + dedup; parse_error guard; null/null no-op; malformed-json no-throw + Track 3 dedup signal: probable_duplicate_of via edit-distance<=2 and prefix/suffix gate, length floor blocks short labels, no-key when no match, levenshtein units)
phase: 04 · execute-plan
owner: prompts.md Prompt 4 — Extraction pass

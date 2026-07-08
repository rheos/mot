name: Track 6 Phase 2 — extraction pass (relation_draft → candidate edges: processRelations, matchByLabel typed-then-widen, both digest guards)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/extraction.test.ts -t "Track 6 Phase 2"
expected: all Track-6 Phase-2 cases pass — confidence gate AC-6 (0.8499 skip / 0.85 append), zero-match skip+log AC-7, ambiguous >1-match skip+log AC-8, malformed relation_draft warn+return-without-breaking-sibling-passes AC-9, self-relation skip EC3, relation-only digest reaches processRelations (both guards), type-hint disambiguation AC-19 (typed-then-widen: mistyped hint widens, resolves), exact-match-preferred AC-20 (mot vs stored moi does NOT resolve), infra-edge append (owns Taylor→SampleApp). Guards processRelations gates + matchByLabel resolution + the FR10 two-guard relation-only-digest path.
phase: 16 · execute-plan
owner: .bureau/runs/20260707-rheo-memory-track6/prompts.md Prompt 2 — Extraction pass
mutation-test: CONFIRMED 2026-07-08 — neutralizing the processRelations confidence gate (lib/extraction.ts:307 `if (!passesConfidence(item.confidence))` → `if (false)`) turns this fixture RED (AC-6 fails: a 0.8499 candidate is wrongly appended → 1 failed | 11 passed). Reverted cleanly; baseline green (12 passed).

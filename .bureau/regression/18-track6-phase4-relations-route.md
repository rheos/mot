name: Track 6 Phase 4 — browser relations route (POST /api/memory/relations: session-OR-key auth, confirm/reject dispatch, typed-error-at-200 contract)
command: |
  ROOT="${ROOT:-$(git rev-parse --show-toplevel)}"
  cd "$ROOT"
  npx vitest run tests/integration/relations-route.test.ts
expected: all route-layer cases pass — 401 unauthenticated; 400 malformed/missing (from/rel/to/action); action='confirm' dispatches confirmRelate, action='reject' dispatches rejectRelate; the confirmRelate/rejectRelate result is returned VERBATIM at 200 including typed {error} bodies (not_found/already_confirmed/already_rejected are 200, NOT remapped to 404/409 — the browser island reads body shape); session-cookie AND API-key both authorized. Guards the FR16 browser route contract the EntityDetail confirm/reject island depends on. (The island UI behavior — AC-12/AC-13/reject — is guarded separately by the Playwright e2e memory-entities.spec.ts, run via npm run test:e2e, not in this vitest standing suite.)
phase: 18 · execute-plan
owner: .bureau/runs/20260707-rheo-memory-track6/prompts.md Prompt 4 — Browser (Section C route test)
mutation-test: CONFIRMED 2026-07-08 — neutralizing the 401 auth guard (app/api/memory/relations/route.ts:31 `if (!hasKey && !hasSession) return unauthorized()` → `if (false)`) turns this fixture RED (1 failed | 11 passed — an unauthenticated request is no longer refused). Reverted cleanly; baseline green (12 passed).

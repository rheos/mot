import { buildStatus } from '../../../lib/status';

// ── GET /api/status (FR-API-5, AC-STATUS-ENDPOINT) ────────────────────────────
// The one unauthenticated endpoint: a health + queue snapshot for the operator and the app
// shell's last-heartbeat indicator (FR-UI-9). No auth guard by design. When the DB is
// unreachable (db_ok=false) we answer 503 with the same payload shape, so a monitor can read
// the body either way.
export async function GET(): Promise<Response> {
  const status = buildStatus();
  return Response.json(status, { status: status.db_ok ? 200 : 503 });
}

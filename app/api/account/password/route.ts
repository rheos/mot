import { requireSession, unauthorized, changeUiPassword } from '../../../../lib/auth';
import { validationErrorResponse, badRequest, internalError } from '../../../../lib/validation';
import { z } from 'zod';

// ── POST /api/account/password (self-service change password) ─────────────────
// The logged-in user changes their own UI login password. SESSION-ONLY: a Bearer-key caller
// is the ingest pipeline, not the human, so this is gated on a valid mot_session cookie only
// (unlike POST /tickets, which accepts key OR session). The new password is stored DB-backed
// in app_secret.ui_password_hash, so it takes effect on the next login with no restart.
//   200 { ok: true }              — changed
//   401 { error: 'unauthorized' } — no valid session
//   422 { error, fields[] }       — new_password fails policy (the shared validation shape)
//   422 { error: 'invalid_current_password' } — current_password is wrong
//   400 { error: 'bad_request' }  — malformed body
// Existing sessions stay valid (we don't force re-login).

// new_password policy: non-empty + a light minimum for a user-chosen password (Phase-1 login
// policy was "any non-empty"; 8 chars is a reasonable floor for a password someone types).
const MIN_NEW_PASSWORD = 8;

const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'current_password is required'),
  new_password: z
    .string()
    .min(MIN_NEW_PASSWORD, `new_password must be at least ${MIN_NEW_PASSWORD} characters`),
});

export async function POST(req: Request): Promise<Response> {
  // Session-gated: only the logged-in user may change the password. No key path.
  const user = await requireSession(req);
  if (!user) return unauthorized();

  const body = await readBody(req);
  if (body === null) return badRequest('Malformed body');

  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) return validationErrorResponse(parsed.error);

  try {
    const ok = await changeUiPassword(
      parsed.data.current_password,
      parsed.data.new_password,
    );
    if (!ok) {
      // Wrong current password — clear error, nothing leaked beyond "it was wrong".
      return Response.json(
        { error: 'invalid_current_password', message: 'Current password is incorrect' },
        { status: 422 },
      );
    }
    return Response.json({ ok: true }, { status: 200 });
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /account/password error:', e);
    return internalError();
  }
}

// Accept JSON or an HTML form post (same dual-mode as the login route). Returns the raw
// object, or null if the body couldn't be parsed at all.
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  try {
    const form = await req.formData();
    return {
      current_password: String(form.get('current_password') ?? ''),
      new_password: String(form.get('new_password') ?? ''),
    };
  } catch {
    return null;
  }
}

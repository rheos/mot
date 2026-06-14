import { cookies } from 'next/headers';
import { getIronSession } from 'iron-session';
import { sessionOptions, verifyCredentials, type SessionData } from '../../../../lib/auth';

// POST /api/auth/login — verify env-var credentials, set the iron-session cookie, redirect.
//
// Accepts either an HTML form post (application/x-www-form-urlencoded) or JSON. On success
// it sets the encrypted cookie and 303-redirects to the triage view (/). On failure it
// redirects back to /login?error=1 — one message regardless of which field was wrong
// (no account enumeration, FR-AUTH-2). The /login page UI lands in a later prompt.
export async function POST(req: Request): Promise<Response> {
  const { username, password } = await readCredentials(req);

  const ok = await verifyCredentials(username, password);
  if (!ok) {
    return Response.redirect(new URL('/login?error=1', req.url), 303);
  }

  const session = await getIronSession<SessionData>(cookies(), sessionOptions);
  session.user = username;
  await session.save();

  return Response.redirect(new URL('/', req.url), 303);
}

async function readCredentials(
  req: Request,
): Promise<{ username: string; password: string }> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : '',
    };
  }
  const form = await req.formData();
  return {
    username: String(form.get('username') ?? ''),
    password: String(form.get('password') ?? ''),
  };
}

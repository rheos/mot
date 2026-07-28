import { sealData } from 'iron-session';
import { sessionOptions, verifyCredentials } from '../../../../lib/auth';
import { withBasePath } from '../../../../lib/client/base-path';
import { serializeSessionCookie } from '../../../../lib/session';

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
    // Relative, path-only Location so the browser resolves it against the EXTERNAL host
    // (the public sub-path host), not the internal origin a route handler's req.url reports behind the
    // reverse proxy. withBasePath yields '/mot/login?error=1' in prod, '/login?error=1' at root.
    return new Response(null, {
      status: 303,
      headers: { Location: withBasePath('/login?error=1') },
    });
  }

  // Seal the session and attach it as an explicit Set-Cookie on the response we return.
  // getIronSession(cookies(), …) + save() writes the cookie into Next's request store, which
  // a hand-built Response returned from `next start` does NOT reliably carry — so we seal here
  // and ship the cookie on the SAME 303 as the redirect. serializeSessionCookie derives every
  // attribute from sessionOptions (single source of truth — no literals).
  const sealed = await sealData(
    { user: username },
    { password: sessionOptions.password as string, ttl: sessionOptions.ttl },
  );

  return new Response(null, {
    status: 303,
    headers: {
      Location: withBasePath('/'),
      'Set-Cookie': serializeSessionCookie(sealed),
    },
  });
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

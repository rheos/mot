// Sub-path awareness for raw URL strings. Next auto-prefixes <Link>, useRouter().push(), and the
// route handlers themselves with basePath — but a raw fetch('/api/...'), a <form action="/api/...">,
// or a server-side Response.redirect('/path') is NOT prefixed, so under NEXT_PUBLIC_BASE_PATH=/mot
// (a reverse-proxy sub-path deploy) those would hit the un-prefixed path and 404 behind the
// proxy. These helpers prepend the base path so the SAME build works at root (no env var → no-op)
// or under a sub-path.
//
// NEXT_PUBLIC_* is inlined at build time, so this value is available in both client bundles and
// server code. Nothing hardcodes '/mot' — it all flows from the one env var.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// API endpoints hit by a raw client-side fetch (the API route handlers live under basePath, but a
// bare fetch string does not get prefixed). Pass an absolute app path like '/api/tickets'.
export const apiPath = (p: string): string => `${basePath}${p}`;

// In-app page paths used in raw string form — currently the auth route handlers' Response.redirect
// targets ('/', '/login'). Link/router already handle basePath, so UI navigation does not need this.
export const withBasePath = (p: string): string => `${basePath}${p}`;

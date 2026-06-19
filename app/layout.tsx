import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Cinzel, Hanken_Grotesk } from 'next/font/google';
import './globals.css';
import { TopNav } from '../components/TopNav';
import { ErrorBoundary } from '../components/error-boundary';
import type { StatusPayload } from '../lib/status';
import { apiPath } from '../lib/client/base-path';

export const metadata: Metadata = {
  title: 'M.O.T. — Ministry of Tickets',
  description: 'Single-user triage and ticketing.',
};

const cinzel = Cinzel({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-cinzel',
  weight: ['600', '700'],
});

const hankenGrotesk = Hanken_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-hanken-grotesk',
  weight: ['400', '500', '600', '700', '800'],
});

// The shell reads GET /api/status on every render to source the last-heartbeat indicator
// (FR-UI-9). It goes over HTTP — not a direct lib/status import — so the UI layer holds no DB
// handle (house rule 2). The origin comes from the request Host header (works on any dev port,
// including the one Playwright boots), not a hardcoded localhost:3000. Any failure → null,
// which the nav renders as "No heartbeat yet".
async function getStatus(): Promise<StatusPayload | null> {
  try {
    const h = headers();
    const host = h.get('host');
    if (!host) return null;
    const proto = h.get('x-forwarded-proto') ?? 'http';
    // apiPath adds the sub-path prefix (e.g. /mot) under the reverse proxy; no-op at root. The
    // status route handler is served under basePath, so the bare /api/status would 404 there.
    const res = await fetch(`${proto}://${host}${apiPath('/api/status')}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as StatusPayload;
  } catch {
    return null;
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const status = await getStatus();
  const lastRun = status?.last_successful_run ?? null;

  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${hankenGrotesk.variable}`}
    >
      <body className="min-h-screen bg-bg text-ink font-sans antialiased">
        <TopNav lastRun={lastRun} />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}

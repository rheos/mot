import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { TopNav } from '../components/TopNav';
import { ErrorBoundary } from '../components/error-boundary';
import type { StatusPayload } from '../lib/status';

export const metadata: Metadata = {
  title: 'M.O.T. — Ministry of Tickets',
  description: 'Single-user triage and ticketing.',
};

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
    const res = await fetch(`${proto}://${host}/api/status`, {
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
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <TopNav lastRun={lastRun} />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}

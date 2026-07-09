import Link from 'next/link';
import type { Metadata } from 'next';
import { listEssays } from '../../lib/essays';

// Private essays index (/essays). Session-gated by the middleware — /essays is not in PUBLIC_PATHS,
// so an unauthenticated request is bounced to /login before this renders. Statically generated; the
// content is read from content/essays/ at build time.
export const metadata: Metadata = {
  title: 'Essays — M.O.T.',
  robots: { index: false, follow: false },
};

export default function EssaysIndex(): React.JSX.Element {
  const essays = listEssays();
  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="mb-1 font-serif text-2xl text-ink">Essays</h1>
      <p className="mb-10 text-sm text-ink-3">Private drafts. Behind your login, not indexed, not linked.</p>
      <ul className="space-y-6">
        {essays.map((e) => (
          <li key={e.slug}>
            <Link href={`/essays/${e.slug}`} className="group block">
              <span className="text-lg text-ink underline-offset-4 group-hover:underline">{e.title}</span>
              <span className="mt-0.5 block text-sm text-ink-3">{e.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

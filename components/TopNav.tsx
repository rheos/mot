import Link from 'next/link';
import { Suspense } from 'react';
import { relativeTime } from '../lib/time';
import { SearchBox } from './SearchBox';

// The persistent top bar (FR-UI-1, FR-UI-9). Server Component — it receives the already-fetched
// last-run timestamp as a serializable string prop from the layout, so it does no I/O itself.
//
//   • Left:   app name (text, no logo).
//   • Middle: the debounced keyword search (SearchBox, a client component, FR-UI-7) — drives the
//             ?q= URL param and composes with the active filters.
//   • Right:  New-ticket link + last-heartbeat indicator.
export function TopNav({ lastRun }: { lastRun: string | null }): React.JSX.Element {
  return (
    <header className="border-b border-gray-200 bg-white">
      <nav className="flex items-center gap-4 px-4 h-12">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight text-gray-900 shrink-0"
        >
          M.O.T.
        </Link>

        {/* SearchBox reads useSearchParams(); Suspense keeps static prerender of the routes that
            share this layout (/login, /tickets/new) from bailing out (Next 14 CSR-bailout rule).
            The fallback is the same input shape, so there is no layout shift on hydration. */}
        <div className="flex-1 max-w-md" role="search">
          <Suspense
            fallback={
              <input
                type="search"
                placeholder="Search tickets…"
                aria-label="Search tickets"
                disabled
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
              />
            }
          >
            <SearchBox />
          </Suspense>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <span className="text-xs text-gray-500" data-testid="last-heartbeat">
            {lastRun ? `Last run: ${relativeTime(lastRun)}` : 'No heartbeat yet'}
          </span>
          <Link
            href="/account"
            className="text-sm text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded"
          >
            Account
          </Link>
          <Link
            href="/tickets/new"
            className="bg-gray-900 text-white rounded px-3 py-1.5 text-sm font-medium hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
          >
            New ticket
          </Link>
        </div>
      </nav>
    </header>
  );
}

import Link from 'next/link';
import { relativeTime } from '../lib/time';

// The persistent top bar (FR-UI-1, FR-UI-9). Server Component — it receives the already-fetched
// last-run timestamp as a serializable string prop from the layout, so it does no I/O itself.
//
//   • Left:   app name (text, no logo).
//   • Middle: a no-JS search entry — a GET form to / that sets ?q=. The richer SearchBox
//             client component lands in Prompt 13; this placeholder is already bookmarkable.
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

        <form action="/" method="GET" className="flex-1 max-w-md" role="search">
          <input
            type="search"
            name="q"
            placeholder="Search tickets…"
            aria-label="Search tickets"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          />
        </form>

        <div className="flex items-center gap-4 shrink-0">
          <span className="text-xs text-gray-500" data-testid="last-heartbeat">
            {lastRun ? `Last run: ${relativeTime(lastRun)}` : 'No heartbeat yet'}
          </span>
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

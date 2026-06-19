import Link from 'next/link';
import { Suspense } from 'react';
import { Plus, Scale, Search, User } from 'lucide-react';
import { relativeTime } from '../lib/time';
import { SearchBox } from './SearchBox';
import { ThemeToggle } from './ThemeToggle';

// The persistent top bar (FR-UI-1, FR-UI-9). Server Component — it receives the already-fetched
// last-run timestamp as a serializable string prop from the layout, so it does no I/O itself.
//
//   • Left:   seal + wordmark.
//   • Middle: the debounced keyword search (SearchBox, a client component, FR-UI-7) — drives the
//             ?q= URL param and composes with the active filters.
//   • Right:  last-heartbeat indicator + theme toggle + account action + New-ticket link.
export function TopNav({ lastRun }: { lastRun: string | null }): React.JSX.Element {
  return (
    <header className="sticky top-0 z-40 border-b border-gold-line bg-[color-mix(in_srgb,var(--bg-deep)_88%,transparent)] shadow-[0_1px_0_var(--hair)] backdrop-blur-xl">
      <nav className="flex min-h-[64px] flex-wrap items-center gap-3 px-[18px] py-[13px] sm:flex-nowrap">
        <Link
          href="/"
          className="flex min-w-0 shrink-0 items-center gap-3 rounded-ministry-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] border border-gold-line bg-[color-mix(in_srgb,var(--gold)_16%,var(--surface))] text-gold-bright shadow-[inset_0_1px_0_rgba(255,255,255,.08)]">
            <Scale aria-hidden="true" className="h-[21px] w-[21px]" strokeWidth={1.9} />
          </span>
          <span className="flex min-w-0 flex-col leading-none">
            <span className="font-serif text-[17px] font-bold uppercase text-ink">
              M.O.T.
            </span>
            <span className="mt-1 hidden font-serif text-[10px] font-semibold uppercase tracking-[0.22em] text-gold-soft sm:block">
              Ministry of Tickets
            </span>
          </span>
        </Link>

        {/* SearchBox reads useSearchParams(); Suspense keeps static prerender of the routes that
            share this layout (/login, /tickets/new) from bailing out (Next 14 CSR-bailout rule).
            The fallback is the same input shape, so there is no layout shift on hydration. */}
        <div
          className="relative order-last w-full min-w-[180px] flex-1 sm:order-none sm:max-w-md [&_input]:h-10 [&_input]:w-full [&_input]:rounded-ministry-sm [&_input]:border [&_input]:border-border [&_input]:bg-surface-2 [&_input]:py-2 [&_input]:pl-10 [&_input]:pr-3 [&_input]:text-sm [&_input]:text-ink [&_input]:shadow-[inset_0_1px_0_rgba(255,255,255,.03)] [&_input]:outline-none [&_input]:placeholder:text-ink-3 [&_input]:focus-visible:border-gold [&_input]:focus-visible:ring-2 [&_input]:focus-visible:ring-gold-line"
          role="search"
        >
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-gold-soft"
            strokeWidth={1.9}
          />
          <Suspense
            fallback={
              <input
                type="search"
                placeholder="Search tickets…"
                aria-label="Search tickets"
                disabled
                className="w-full"
              />
            }
          >
            <SearchBox />
          </Suspense>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span
            className="inline-flex h-9 items-center gap-2 rounded-full border border-[color:color-mix(in_srgb,var(--teal)_30%,transparent)] bg-[color-mix(in_srgb,var(--teal)_14%,var(--surface))] px-3 text-xs text-ink-2"
            data-testid="last-heartbeat"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full bg-teal-bright shadow-[0_0_0_5px_rgba(58,163,184,.13)]"
            />
            <span className="hidden md:inline">
              {lastRun ? `Last run: ${relativeTime(lastRun)}` : 'No heartbeat yet'}
            </span>
          </span>
          <ThemeToggle />
          <Link
            href="/account"
            aria-label="Account"
            className="inline-flex h-9 w-9 items-center justify-center rounded-ministry-sm border border-border bg-surface-2 text-ink-2 hover:border-gold-line hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <User aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
          </Link>
          <Link
            href="/tickets/new"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-ministry-sm border border-gold-line bg-gold px-3 text-sm font-bold text-on-gold shadow-[0_0_0_1px_rgba(255,255,255,.06)_inset] hover:bg-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Plus aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
            <span className="hidden sm:inline">New ticket</span>
          </Link>
        </div>
      </nav>
    </header>
  );
}

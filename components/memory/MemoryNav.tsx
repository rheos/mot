'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Brain, ListTree, ScrollText } from 'lucide-react';

// The Recallatron section sub-nav (Track 4) — a tab row that makes the three memory pages
// navigable as a set, rendered at the top of each app/memory/*/page.tsx above its browser island.
// 'use client' because it reads usePathname() to mark the active tab. Plain next/link <Link href>:
// /memory is INSIDE this app's basePath, so the router prefixes these internal routes correctly
// (no apiPath() — that helper is only for raw client fetch, which auto-prefixing doesn't cover).
//
// usePathname() returns the path WITHOUT the basePath in the browser, so an exact === would miss
// under the /mot proxy; .endsWith() matches the route segment regardless of any basePath prefix.

const TABS: { href: string; label: string; icon: typeof Brain }[] = [
  { href: '/memory/entities', label: 'Entities', icon: Brain },
  { href: '/memory/topics', label: 'Topics', icon: ListTree },
  { href: '/memory/procedural', label: 'Procedural', icon: ScrollText },
];

export function MemoryNav(): React.JSX.Element {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Recallatron sections"
      className="flex items-center gap-2 overflow-x-auto pb-px"
    >
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname.endsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            data-testid={`memory-nav-${label.toLowerCase()}`}
            className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-[13px] text-[13px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
              active
                ? 'border-gold-line bg-[color-mix(in_srgb,var(--gold)_16%,var(--surface))] text-gold-bright'
                : 'border-border bg-surface-2 text-ink-2 hover:border-gold-line hover:text-gold-bright'
            }`}
          >
            <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={1.9} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

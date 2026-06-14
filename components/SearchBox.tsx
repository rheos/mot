'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

// Header keyword search (FR-UI-7). Debounced ~300ms: typing updates the `q` URL param, which the
// triage Server page re-reads and re-queries through FTS5 (lib/tickets listTickets). It composes
// with the active filters — it only touches `q`, every other param is preserved. Clearing the box
// removes `q` and returns to the plain filtered list. The input is controlled so the field stays
// responsive while the router push lags behind by the debounce window.
export function SearchBox(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get('q') ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = useCallback(
    (v: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (v.trim()) {
        params.set('q', v.trim());
      } else {
        params.delete('q');
      }
      params.delete('page'); // a new search starts at page 1
      router.push(params.toString() ? `/?${params.toString()}` : '/');
    },
    [router, searchParams],
  );

  function onChange(next: string): void {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push(next), 300);
  }

  return (
    <input
      type="search"
      name="q"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search tickets…"
      aria-label="Search tickets"
      className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
    />
  );
}

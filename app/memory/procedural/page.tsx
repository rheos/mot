import { listNotes, type ProceduralNote } from '../../../lib/procedural';
import { ProceduralBrowser } from '../../../components/memory/ProceduralBrowser';
import { MemoryNav } from '../../../components/memory/MemoryNav';

// Recallatron procedural-note browser (Track 4, Phase 4 — FR-6). Server Component: it reads the
// procedural store IN-PROCESS via listNotes (no fetch — Server Components read the data layer
// directly, the way app/page.tsx and the sibling entities page do). Reachable only behind a valid
// session (middleware), so the operator sees the full set. Two reads seed the island:
//   - confirmed = Object.values(listNotes(undefined, false)).flat()  → confirmed notes (listNotes
//                 returns them grouped by category, Record<category, notes[]> — flatten to a list)
//   - pending   = listNotes(undefined, true)                          → unconfirmed candidates (flat)
// The result is handed to the client ProceduralBrowser as initialData, which owns the tabs, the
// Confirm write, the optimistic Pending→Confirmed move (AC-15), and the four UI states (house
// rule 6). A DB/read error renders the island in its error state rather than crashing the route
// (mirrors app/memory/entities/page.tsx).
//
// Next 14 reads are synchronous, so the page is a sync Server Component like the entities page.

export const dynamic = 'force-dynamic';

export default function ProceduralPage(): React.JSX.Element {
  let confirmed: ProceduralNote[] = [];
  let pending: ProceduralNote[] = [];
  let error = false;

  try {
    // false ⇒ confirmed, grouped by category as Record<string, ProceduralNote[]> (procedural.ts:69).
    const confirmedGrouped = listNotes(undefined, false) as Record<string, ProceduralNote[]>;
    confirmed = Object.values(confirmedGrouped).flat();
    // true ⇒ unconfirmed, returned as a flat ProceduralNote[] (procedural.ts:83).
    pending = listNotes(undefined, true) as ProceduralNote[];
  } catch {
    error = true;
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4">
      <MemoryNav />
      <ProceduralBrowser initialData={{ confirmed, pending, error }} />
    </main>
  );
}

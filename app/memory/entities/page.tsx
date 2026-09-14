import { searchEntities, type EntityRecord } from '../../../lib/graph';
import { EntityBrowser } from '../../../components/memory/EntityBrowser';
import { MemoryNav } from '../../../components/memory/MemoryNav';

// Recallatron entity browser (Track 4, Phase 4 — FR-6). Server Component: it reads the entity
// graph IN-PROCESS via searchEntities (no fetch — this is what Server Components are for, and
// app/page.tsx reads its data layer the same way). The page is only reachable behind a valid
// session (middleware), so the operator sees the full active set. Two reads seed the island:
//   - active     = searchEntities('')               → all active, non-superseded entities
//   - unconfirmed = searchEntities('', undefined, true) → unconfirmed candidates awaiting review
// The result is handed to the client EntityBrowser as initialData, which owns interactivity,
// live search, the filter, the detail panel, and the four UI states (house rule 6). A DB/read
// error renders the island in its error state rather than crashing the route (mirrors
// app/page.tsx:40-48).
//
// The reads here are synchronous, so the page is a sync Server Component like the triage page.

export const dynamic = 'force-dynamic';

export default function EntitiesPage(): React.JSX.Element {
  let active: EntityRecord[] = [];
  let unconfirmed: EntityRecord[] = [];
  let error = false;

  try {
    active = searchEntities(''); // empty needle matches all active entities (graph.ts:226-227)
    unconfirmed = searchEntities('', undefined, true); // unconfirmed only (graph.ts:231-232)
  } catch {
    error = true;
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4">
      <MemoryNav />
      <EntityBrowser initialData={{ active, unconfirmed, error }} />
    </main>
  );
}

import { listThreads, type TopicThreadWithCount } from '../../../lib/topics';
import { TopicBrowser } from '../../../components/memory/TopicBrowser';
import { MemoryNav } from '../../../components/memory/MemoryNav';

// Recallatron topic browser (Track 4, Phase 5 — FR-6). Server Component: it reads the topic
// threads IN-PROCESS via listThreads (no fetch — Server Components read the data layer directly,
// the way app/page.tsx and the sibling entities/procedural pages do). listThreads already orders
// last_active_at DESC (topics.ts:107), which AC-14 requires; the island renders the threads in the
// received order without re-sorting. Reachable only behind a valid session (middleware), so the
// operator sees the full set. The result is handed to the client TopicBrowser as initialData,
// which owns the thread list, the detail panel, the session-authed Synthesize call, and the four
// UI states (house rule 6). A DB/read error renders the island in its error state rather than
// crashing the route (mirrors app/memory/entities/page.tsx).
//
// Next 14 reads are synchronous, so the page is a sync Server Component like the sibling pages.

export const dynamic = 'force-dynamic';

export default function TopicsPage(): React.JSX.Element {
  let threads: TopicThreadWithCount[] = [];
  let error = false;

  try {
    threads = listThreads(); // already last_active_at DESC (topics.ts:107) — AC-14.
  } catch {
    error = true;
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4">
      <MemoryNav />
      <TopicBrowser initialData={{ threads, error }} />
    </main>
  );
}

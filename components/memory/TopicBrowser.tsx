'use client';

import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { TopicThreadWithCount, SummarizeResult } from '../../lib/topics';
import { apiPath } from '../../lib/client/base-path';
import { EmptyState, ErrorState } from '../ui-states';

// The interactive shell of the topic browser (Track 4, Phase 5 — Recallatron). The Server page
// does the initial in-process read (listThreads, already last_active_at DESC) and hands it in as
// initialData (react-nextjs §2: prefer initialData from the server parent over a client waterfall),
// so first paint is instant. The thread list is rendered in the RECEIVED order — no client re-sort
// — because listThreads already returns last_active_at DESC (AC-14).
//
// Clicking a thread opens a detail panel with a Synthesize button. Synthesize calls the
// session-authed GET /api/memory/topics/<slug>/summarize route (NOT /api/mcp, which is API-key-only
// and would 401 the browser's session cookie). mot stays MODEL-FREE (OQ-1 = (b)): the route returns
// a STRUCTURED SummarizeResult (the most-recent sessions array, truncated to budget), never
// synthesized prose — so this renders a SESSION LIST (ts + summary), not a paragraph. All four
// states ship from day one (house rule 6): loading shows a busy/disabled Synthesize button, error
// renders synthesisError + a Retry, empty shows "No topic threads yet" when there are no threads,
// populated is the thread list and detail panel.
//
// SummarizeResult is imported type-only from lib/topics — a type-only import carries no runtime
// code across the server→client boundary, so it does NOT pull the DB layer into the client bundle.

interface InitialData {
  threads: TopicThreadWithCount[];
  error: boolean;
}

// Narrow the SummarizeResult union to its not-found arm.
function isThreadNotFound(
  data: SummarizeResult,
): data is { error: 'thread_not_found'; slug: string } {
  return 'error' in data;
}

export function TopicBrowser({
  initialData,
}: {
  initialData: InitialData;
}): React.JSX.Element {
  const [threads] = useState<TopicThreadWithCount[]>(initialData.threads);
  const [selected, setSelected] = useState<TopicThreadWithCount | null>(null);
  const [synthesisResult, setSynthesisResult] = useState<SummarizeResult | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthesisError, setSynthesisError] = useState<string | null>(null);

  // Open a thread's detail panel. Selecting a different thread clears any prior synthesis so the
  // panel never shows a stale result from another thread.
  function openThread(thread: TopicThreadWithCount): void {
    setSelected(thread);
    setSynthesisResult(null);
    setSynthesisError(null);
  }

  // Synthesize: fetch the structured session set for the selected thread from the session-authed
  // route. The result is rendered as a session list (OQ-1 = (b)), not prose.
  async function synthesize(slug: string): Promise<void> {
    setSynthesizing(true);
    setSynthesisError(null);
    try {
      const res = await fetch(
        apiPath(`/api/memory/topics/${encodeURIComponent(slug)}/summarize`),
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SummarizeResult;
      setSynthesisResult(data);
    } catch (e) {
      setSynthesisError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSynthesizing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <h1 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
          Topics
        </h1>
      </div>

      {/* Two-column on wide screens: thread list + detail panel. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section
          className="overflow-hidden rounded-[15px] border border-border bg-surface shadow-ministry-2"
          data-testid="topic-list"
        >
          <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-[11px]">
            <h2 className="font-serif text-xs font-semibold uppercase tracking-[0.18em] text-gold-soft">
              Topic threads
            </h2>
            <span className="text-[12.5px] text-ink-3">
              {threads.length} {threads.length === 1 ? 'thread' : 'threads'}
            </span>
          </div>

          {initialData.error ? (
            <div className="px-4 py-5">
              <ErrorState message="Could not load topic threads" />
            </div>
          ) : threads.length === 0 ? (
            <div className="px-4 py-5">
              <EmptyState message="No topic threads yet" />
            </div>
          ) : (
            // Rendered in the received order — listThreads is already last_active_at DESC (AC-14).
            <ul>
              {threads.map((thread) => (
                <li key={thread.slug}>
                  <button
                    type="button"
                    onClick={() => openThread(thread)}
                    aria-pressed={selected?.slug === thread.slug}
                    data-testid="topic-row"
                    className={`flex w-full flex-col items-start gap-1 border-b border-hair px-4 py-[13px] text-left transition last:border-0 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                      selected?.slug === thread.slug ? 'bg-surface-2' : ''
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="truncate font-semibold text-ink">{thread.title}</span>
                      <span className="shrink-0 rounded-ministry-xs border border-border bg-surface-2 px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em] text-ink-2">
                        {thread.session_count}{' '}
                        {thread.session_count === 1 ? 'session' : 'sessions'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
                      <code className="break-all rounded-[5px] border border-hair bg-bg-alt px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                        {thread.slug}
                      </code>
                      <span>active {thread.last_active_at}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Detail panel */}
        <section
          className="rounded-[15px] border border-border bg-surface p-[18px] shadow-ministry-2"
          data-testid="topic-detail"
        >
          {selected ? (
            <ThreadDetail
              thread={selected}
              synthesisResult={synthesisResult}
              synthesizing={synthesizing}
              synthesisError={synthesisError}
              onSynthesize={() => void synthesize(selected.slug)}
            />
          ) : (
            <p className="text-sm text-ink-3">Select a topic thread to see its details.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ThreadDetail({
  thread,
  synthesisResult,
  synthesizing,
  synthesisError,
  onSynthesize,
}: {
  thread: TopicThreadWithCount;
  synthesisResult: SummarizeResult | null;
  synthesizing: boolean;
  synthesisError: string | null;
  onSynthesize: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-[18px] font-bold leading-tight text-ink">
            {thread.title}
          </h2>
          <code className="mt-1 inline-block break-all rounded-[5px] border border-hair bg-bg-alt px-1.5 py-0.5 font-mono text-[12px] text-ink-2">
            {thread.slug}
          </code>
        </div>
        <span className="shrink-0 rounded-ministry-xs border border-border bg-surface-2 px-[9px] py-[3px] text-[11.5px] font-bold tracking-[0.02em] text-ink-2">
          {thread.session_count} {thread.session_count === 1 ? 'session' : 'sessions'}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-x-[22px] gap-y-3">
        <Field label="Last active">{thread.last_active_at}</Field>
        <Field label="Created">{thread.created_at}</Field>
        {thread.notes && (
          <div className="col-span-2 flex flex-col gap-1">
            <dt className="text-[11.5px] tracking-[0.04em] text-ink-3">Notes</dt>
            <dd className="break-words text-sm text-ink-2">{thread.notes}</dd>
          </div>
        )}
      </dl>

      {/* Synthesize action + structured result (OQ-1 = (b)). */}
      <div className="flex flex-col gap-3 border-t border-hair pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-soft">
            Synthesis
          </h3>
          <button
            type="button"
            onClick={onSynthesize}
            disabled={synthesizing}
            aria-busy={synthesizing}
            data-testid="synthesize-button"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-ministry-sm border border-gold-line px-3 text-sm font-bold text-gold-bright transition hover:bg-gold-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-60"
          >
            {synthesizing ? (
              <>
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" strokeWidth={2} />
                Loading…
              </>
            ) : (
              <>
                <Sparkles aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                {synthesisResult ? 'Re-synthesize' : 'Synthesize'}
              </>
            )}
          </button>
        </div>

        {synthesisError ? (
          <ErrorState
            message={`Could not synthesize — ${synthesisError}`}
            onRetry={onSynthesize}
          />
        ) : synthesisResult ? (
          <SynthesisResult result={synthesisResult} />
        ) : (
          <p className="text-sm text-ink-3" data-testid="synthesis-idle">
            Synthesize to pull this thread&rsquo;s sessions for cross-session review.
          </p>
        )}
      </div>
    </div>
  );
}

// Render the structured SummarizeResult (OQ-1 = (b)): a session list (ts + summary), NOT prose.
// Surfaces the not-found body, the truncation note, and the total-vs-displayed session counts.
function SynthesisResult({ result }: { result: SummarizeResult }): React.JSX.Element {
  if (isThreadNotFound(result)) {
    return (
      <p className="text-sm text-ink-3" data-testid="synthesis-not-found">
        Thread not found
      </p>
    );
  }

  const displayed = result.sessions.length;

  return (
    <div className="flex flex-col gap-3" data-testid="synthesis-result">
      {/* Total vs displayed session counts. */}
      <p className="text-[12.5px] text-ink-3" data-testid="synthesis-count">
        {result.session_count} {result.session_count === 1 ? 'session' : 'sessions'} total
        {displayed !== result.session_count ? ` · showing ${displayed}` : ''}
      </p>

      {/* Truncation note, prominent, above the list. */}
      {result.truncated && result.truncation_note && (
        <div
          role="status"
          data-testid="synthesis-truncation"
          className="rounded-[12px] border border-amber-line bg-amber-tint px-4 py-3 text-sm font-semibold text-amber"
        >
          {result.truncation_note}
        </div>
      )}

      {result.sessions.length === 0 ? (
        <p className="text-sm text-ink-3" data-testid="synthesis-empty">
          No sessions linked to this thread yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {result.sessions.map((session) => (
            <li
              key={session.session_id}
              data-testid="synthesis-session"
              className="flex flex-col gap-1 rounded-[12px] border border-hair bg-bg-alt px-4 py-3"
            >
              <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
                <span>{session.ts}</span>
                <code className="break-all rounded-[5px] border border-hair bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                  {session.session_id}
                </code>
              </div>
              <p className="break-words text-sm text-ink-2">{session.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11.5px] tracking-[0.04em] text-ink-3">{label}</dt>
      <dd className="break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

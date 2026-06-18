import { headers } from 'next/headers';
import { relativeTime } from '../../lib/time';
import type { StatusPayload } from '../../lib/status';
import { apiPath } from '../../lib/client/base-path';

// System Health (FR-UI-8). Server Component. Three honest sections — pipeline status,
// classification accuracy, source-feed health — each an explicit "no data yet" stub in Phase 1.
// No charts (the spec excludes visualization beyond text figures); the same view populates live
// in Phase 2 with no structural change. /health is public (middleware PUBLIC_PATHS), so we read
// GET /api/status over HTTP off the request Host header — the same pattern the app shell uses, so
// the UI layer holds no DB handle (house rule 2). Any failure → null, rendered as the stub copy
// rather than a throw or a blank div (house rule 6).

export const dynamic = 'force-dynamic';

async function getStatus(): Promise<StatusPayload | null> {
  try {
    const h = headers();
    const host = h.get('host');
    if (!host) return null;
    const proto = h.get('x-forwarded-proto') ?? 'http';
    // apiPath adds the sub-path prefix (e.g. /mot) under the reverse proxy; no-op at root. The
    // status route handler is served under basePath, so the bare /api/status would 404 there.
    const res = await fetch(`${proto}://${host}${apiPath('/api/status')}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as StatusPayload;
  } catch {
    return null;
  }
}

export default async function HealthPage(): Promise<React.JSX.Element> {
  const status = await getStatus();
  const lastRun = status?.last_successful_run ?? null;

  return (
    <main className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-xl font-semibold text-gray-900">System health</h1>
      <p className="mt-1 text-sm text-gray-500">
        Phase 1 surface. The pipeline that fills these sections lands in Phase 2.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <Section title="Pipeline status">
          {lastRun
            ? `Last heartbeat: ${relativeTime(lastRun)}`
            : 'No heartbeat yet — Phase 2 will populate this'}
        </Section>
        <Section title="Observed correction rate / classifier quality signal">
          <AuditQualitySection quality={status?.audit_quality} />
        </Section>
        <Section title="Source-feed health">No pipeline data yet</Section>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="font-medium text-sm text-gray-700 mb-2">{title}</h2>
      {/* div, not p: AuditQualitySection nests a <ul>, which is invalid inside a <p>. */}
      <div className="text-sm text-gray-500">{children}</div>
    </section>
  );
}

// AC-11. Renders the observed correction-rate signal. Three honest states: no rows yet
// (empty stub), rows but no corrections yet ("awaiting correction history"), and a populated
// rate. This is NOT an accuracy metric — see the inline note and the AuditQualityPayload doc.
function AuditQualitySection({
  quality,
}: {
  quality: StatusPayload['audit_quality'];
}): React.JSX.Element {
  // Honest empty state: no audit rows yet (pipeline hasn't run with P2.2 in place).
  if (!quality) {
    return (
      <>
        No classification data yet
        <br />
        <span className="text-xs text-gray-400">
          Populates once the intake routine starts passing the audit block (Phase 2.2).
        </span>
      </>
    );
  }

  const { total_audited, total_correction_signals, by_version } = quality;

  // Intermediate state: rows exist but no corrections back-filled yet.
  const hasCorrections = total_correction_signals > 0;
  const correctionLabel = hasCorrections
    ? `${total_correction_signals} / ${total_audited} (${((total_correction_signals / total_audited) * 100).toFixed(1)}%)`
    : 'awaiting correction history';

  return (
    <>
      <span>
        {total_audited} classification{total_audited !== 1 ? 's' : ''} audited &middot;{' '}
        correction signals: {correctionLabel}
      </span>
      <br />
      <span className="text-xs text-gray-400">
        Note: this is an observed correction rate, not an accuracy metric. A true accuracy
        figure requires a confirmed-correct workflow that does not exist yet.
      </span>
      {by_version.length > 0 && (
        <ul className="mt-2 text-xs space-y-0.5">
          {by_version.map((v, i) => (
            <li key={i} className="text-gray-500">
              {v.model_version}
              {v.prompt_hash ? ` / prompt ${v.prompt_hash.slice(0, 8)}…` : ' / unhashed'}{' '}
              &mdash; {v.audited_count} audited, {v.correction_signal_count} corrected
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ministry, Severity } from '../lib/enums';
import { MinistryTokens, SeverityTokens } from '../lib/tokens';
import { apiPath } from '../lib/client/base-path';

// Manual ticket creation form (FR-UI-10, AC-CREATE). Posts to POST /api/tickets with
// provenance='manual', source_ref=null, and NO classification_audit block — so the data layer
// writes no audit row and, with a null source_ref, always creates (dedup never runs on manual
// tickets; dedup_key stays null). Client-side validation gates the request: an empty title or body
// is rejected inline before any fetch (AC-CREATE negative case — no new DB row). A 422 from the
// server surfaces its fields[] inline on the matching inputs; a network/server error shows a
// banner above the form and keeps every field populated so Taylor can retry without re-typing. On
// 201 we redirect to the new ticket's detail view.

const TICKET_TYPE_SUGGESTIONS = ['ad-hoc', 'flow-block', 'interior-note', 'general'];

interface FormFields {
  title: string;
  ministry: Ministry | '';
  severity: Severity | '';
  ticket_type: string;
  body: string;
  private: boolean;
}

export function NewTicketForm(): React.JSX.Element {
  const router = useRouter();
  const [fields, setFields] = useState<FormFields>({
    title: '',
    ministry: '',
    severity: '',
    ticket_type: '',
    body: '',
    private: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Client-side gate. Returns true when the form is shippable. Runs BEFORE any network request so
  // the empty-field case never hits the API (AC-CREATE negative).
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!fields.title.trim()) e.title = 'Title is required';
    if (!fields.body.trim()) e.body = 'Body is required';
    if (!fields.ministry) e.ministry = 'Ministry is required';
    if (!fields.severity) e.severity = 'Severity is required';
    if (!fields.ticket_type.trim()) e.ticket_type = 'Ticket type is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!validate()) return; // no fetch when invalid
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch(apiPath('/api/tickets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: fields.title,
          ministry: fields.ministry,
          severity: fields.severity,
          ticket_type: fields.ticket_type,
          body: fields.body,
          private: fields.private,
          provenance: 'manual', // ALWAYS manual — not a UI field
          source_ref: null, // ALWAYS null — manual tickets carry no source_ref
          // NO classification_audit block — manual tickets write no audit row.
        }),
      });
      if (res.status === 201) {
        const data = (await res.json()) as { id: string };
        router.push(`/tickets/${data.id}`);
        return;
      }
      if (res.status === 422) {
        const data = (await res.json()) as {
          fields?: { field: string; message: string }[];
        };
        const fieldErrors: Record<string, string> = {};
        for (const f of data.fields ?? []) fieldErrors[f.field] = f.message;
        setErrors(fieldErrors);
        return;
      }
      setServerError('Server error — please try again. Your form data is preserved.');
    } catch {
      setServerError('Network error — please try again. Your form data is preserved.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="max-w-xl mx-auto mt-8 flex flex-col gap-4">
      <h1 className="text-lg font-semibold">New ticket</h1>

      {serverError && (
        <div
          role="alert"
          className="rounded-ministry-sm border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {serverError}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="title" className="text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          value={fields.title}
          onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
          aria-invalid={Boolean(errors.title)}
          className="surface-input px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
        />
        {errors.title && <p className="text-red-400 text-xs">{errors.title}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="ministry" className="text-sm font-medium">
          Ministry
        </label>
        <select
          id="ministry"
          value={fields.ministry}
          onChange={(e) =>
            setFields((f) => ({ ...f, ministry: e.target.value as Ministry | '' }))
          }
          aria-invalid={Boolean(errors.ministry)}
          className="surface-input px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
        >
          <option value="">Select ministry…</option>
          {Object.values(Ministry).map((m) => (
            <option key={m} value={m}>
              {MinistryTokens[m].label}
            </option>
          ))}
        </select>
        {errors.ministry && <p className="text-red-400 text-xs">{errors.ministry}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="severity" className="text-sm font-medium">
          Severity
        </label>
        <select
          id="severity"
          value={fields.severity}
          onChange={(e) =>
            setFields((f) => ({ ...f, severity: e.target.value as Severity | '' }))
          }
          aria-invalid={Boolean(errors.severity)}
          className="surface-input px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
        >
          <option value="">Select severity…</option>
          {Object.values(Severity).map((s) => (
            <option key={s} value={s}>
              {SeverityTokens[s].label}
            </option>
          ))}
        </select>
        {errors.severity && <p className="text-red-400 text-xs">{errors.severity}</p>}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="ticket_type" className="text-sm font-medium">
          Ticket type
        </label>
        <input
          id="ticket_type"
          value={fields.ticket_type}
          onChange={(e) => setFields((f) => ({ ...f, ticket_type: e.target.value }))}
          list="ticket-type-suggestions"
          placeholder="e.g. flow-block, ad-hoc"
          aria-invalid={Boolean(errors.ticket_type)}
          className="surface-input px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
        />
        <datalist id="ticket-type-suggestions">
          {TICKET_TYPE_SUGGESTIONS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {errors.ticket_type && (
          <p className="text-red-400 text-xs">{errors.ticket_type}</p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="body" className="text-sm font-medium">
          Body
        </label>
        <textarea
          id="body"
          value={fields.body}
          onChange={(e) => setFields((f) => ({ ...f, body: e.target.value }))}
          aria-invalid={Boolean(errors.body)}
          className="surface-input min-h-[100px] resize-y px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
        />
        {errors.body && <p className="text-red-400 text-xs">{errors.body}</p>}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="private"
          checked={fields.private}
          onChange={(e) => setFields((f) => ({ ...f, private: e.target.checked }))}
          className="accent-gold"
        />
        <label htmlFor="private" className="text-sm">
          Private (Education / co-parent)
        </label>
      </div>

      <button
        type="submit"
        disabled={submitting}
        aria-busy={submitting}
        className="inline-flex items-center justify-center self-start rounded-ministry-sm border border-gold-line bg-gold px-4 py-2 text-sm font-bold text-on-gold outline-none hover:bg-gold-bright disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        {submitting ? 'Creating…' : 'Create ticket'}
      </button>
    </form>
  );
}

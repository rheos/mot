'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPath } from '../lib/client/base-path';

// Self-service change-password form (POST /api/account/password). Session-cookie only — the
// browser already holds mot_session, so we send NO Authorization header. Three fields: current,
// new, confirm. Client-side validation gates the request BEFORE any fetch (all non-empty,
// new === confirm, new length >= 8 — mirrors the server's MIN_NEW_PASSWORD so the user gets
// instant feedback). The server is still the source of truth: a 422 validation_failed maps its
// fields[] onto New, and invalid_current_password (a different error shape — branch on `error`,
// NOT fields[]) renders under Current. Success clears the fields and keeps the user on the page
// (the current session stays valid; the new password takes effect on next login). A 401 means no
// session (middleware should prevent this on a gated page) → send to /login. Anything else shows
// the red error banner and keeps the form populated.

const MIN_NEW_PASSWORD = 8;

interface FormFields {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

const EMPTY: FormFields = {
  current_password: '',
  new_password: '',
  confirm_password: '',
};

export function ChangePasswordForm(): React.JSX.Element {
  const router = useRouter();
  const [fields, setFields] = useState<FormFields>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Client-side gate. Returns true when the form is shippable. Runs BEFORE any network request so
  // a mismatched/empty/too-short submit never hits the API.
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!fields.current_password) e.current_password = 'Current password is required';
    if (!fields.new_password) {
      e.new_password = 'New password is required';
    } else if (fields.new_password.length < MIN_NEW_PASSWORD) {
      e.new_password = `New password must be at least ${MIN_NEW_PASSWORD} characters`;
    }
    if (!fields.confirm_password) {
      e.confirm_password = 'Please confirm your new password';
    } else if (
      fields.new_password &&
      fields.confirm_password !== fields.new_password
    ) {
      e.confirm_password = "Passwords don't match";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSuccess(false);
    setServerError(null);
    if (!validate()) return; // no fetch when the client gate fails
    setSubmitting(true);
    try {
      // Session cookie only — no Authorization header. apiPath() keeps the path correct behind
      // the /mot reverse proxy.
      const res = await fetch(apiPath('/api/account/password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: fields.current_password,
          new_password: fields.new_password,
        }),
      });

      if (res.status === 200) {
        setFields(EMPTY);
        setErrors({});
        setSuccess(true);
        return; // stay on the page — the session is still valid
      }

      if (res.status === 401) {
        // No session — middleware should have caught this on a gated page; fall back to login.
        router.push('/login');
        return;
      }

      if (res.status === 422) {
        const data = (await res.json()) as {
          error?: string;
          message?: string;
          fields?: { field: string; message: string }[];
        };
        // Two distinct 422 shapes — branch on `error`, not on the presence of fields[].
        if (data.error === 'invalid_current_password') {
          setErrors({
            current_password: data.message ?? 'Current password is incorrect',
          });
          return;
        }
        // validation_failed: map each fields[] entry by name (new_password → New field).
        const fieldErrors: Record<string, string> = {};
        for (const f of data.fields ?? []) fieldErrors[f.field] = f.message;
        setErrors(fieldErrors);
        return;
      }

      setServerError('Could not change your password. Please try again.');
    } catch {
      setServerError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {serverError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700"
        >
          {serverError}
        </div>
      )}

      {success && (
        <div
          role="status"
          className="bg-green-50 border border-green-200 rounded px-3 py-2 text-sm text-green-700"
        >
          Password changed
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="current_password" className="text-sm font-medium">
          Current password
        </label>
        <input
          id="current_password"
          type="password"
          autoComplete="current-password"
          value={fields.current_password}
          onChange={(e) =>
            setFields((f) => ({ ...f, current_password: e.target.value }))
          }
          aria-invalid={Boolean(errors.current_password)}
          aria-describedby={
            errors.current_password ? 'current_password-error' : undefined
          }
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        />
        {errors.current_password && (
          <p id="current_password-error" className="text-red-600 text-xs">
            {errors.current_password}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="new_password" className="text-sm font-medium">
          New password
        </label>
        <input
          id="new_password"
          type="password"
          autoComplete="new-password"
          value={fields.new_password}
          onChange={(e) =>
            setFields((f) => ({ ...f, new_password: e.target.value }))
          }
          aria-invalid={Boolean(errors.new_password)}
          aria-describedby={errors.new_password ? 'new_password-error' : undefined}
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        />
        {errors.new_password && (
          <p id="new_password-error" className="text-red-600 text-xs">
            {errors.new_password}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="confirm_password" className="text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirm_password"
          type="password"
          autoComplete="new-password"
          value={fields.confirm_password}
          onChange={(e) =>
            setFields((f) => ({ ...f, confirm_password: e.target.value }))
          }
          aria-invalid={Boolean(errors.confirm_password)}
          aria-describedby={
            errors.confirm_password ? 'confirm_password-error' : undefined
          }
          className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        />
        {errors.confirm_password && (
          <p id="confirm_password-error" className="text-red-600 text-xs">
            {errors.confirm_password}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={submitting}
        aria-busy={submitting}
        className="self-start mt-2 bg-gray-900 text-white rounded px-4 py-2 text-sm font-medium hover:bg-gray-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
      >
        {submitting ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}

'use client';;
import { use } from "react";

// Login (FR-AUTH-2). Centered card, no logo, no chrome — a tool's front door, not a product
// page. The form posts straight to the login route handler (Prompt 4), which seals the
// session cookie and redirects to /. On failure it redirects back here with ?error=1; we
// render one "Invalid credentials" line regardless of which field was wrong (no account
// enumeration). Next 15 passes searchParams as a Promise, so the page awaits it.

import { apiPath } from '../../lib/client/base-path';

export default function LoginPage(
  props: {
    searchParams: Promise<{ error?: string }>;
  }
): React.JSX.Element {
  const searchParams = use(props.searchParams);
  const failed = Boolean(searchParams.error);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface-card w-full max-w-sm p-8">
        <h1 className="font-serif text-2xl font-bold uppercase tracking-wide text-gold-bright">
          M.O.T.
        </h1>
        <p className="mb-6 mt-1 text-xs uppercase tracking-[0.18em] text-ink-3">
          Ministry of Tickets
        </p>
        <form
          action={apiPath('/api/auth/login')}
          method="POST"
          className="flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-2">Username</span>
            <input
              name="username"
              type="text"
              autoComplete="username"
              required
              className="surface-input px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-2">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="surface-input px-3 py-2 text-sm outline-none focus-visible:border-gold focus-visible:ring-2 focus-visible:ring-gold-line"
            />
          </label>
          <button
            type="submit"
            className="mt-2 inline-flex items-center justify-center rounded-ministry-sm border border-gold-line bg-gold px-3 py-2 text-sm font-bold text-on-gold outline-none hover:bg-gold-bright focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            Sign in
          </button>
          {failed && (
            <p className="text-center text-sm text-red-400" role="alert">
              Invalid credentials
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

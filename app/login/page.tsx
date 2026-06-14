'use client';

// Login (FR-AUTH-2). Centered card, no logo, no chrome — a tool's front door, not a product
// page. The form posts straight to the login route handler (Prompt 4), which seals the
// session cookie and redirects to /. On failure it redirects back here with ?error=1; we
// render one "Invalid credentials" line regardless of which field was wrong (no account
// enumeration). Next 14 passes searchParams as a plain prop on the page component.

import { apiPath } from '../../lib/client/base-path';

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}): React.JSX.Element {
  const failed = Boolean(searchParams.error);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white border border-gray-200 rounded-lg p-8 shadow-sm">
        <h1 className="text-lg font-semibold mb-1 tracking-tight">M.O.T.</h1>
        <p className="text-xs text-gray-500 mb-6">Ministry of Tickets</p>
        <form
          action={apiPath('/api/auth/login')}
          method="POST"
          className="flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Username</span>
            <input
              name="username"
              type="text"
              autoComplete="username"
              required
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            />
          </label>
          <button
            type="submit"
            className="mt-2 bg-gray-900 text-white rounded px-3 py-2 text-sm font-medium hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500"
          >
            Sign in
          </button>
          {failed && (
            <p className="text-red-600 text-sm text-center" role="alert">
              Invalid credentials
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

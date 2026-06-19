import { ChangePasswordForm } from '../../components/ChangePasswordForm';

// Account page (/account). Session-gated by the middleware — /account is not in PUBLIC_PATHS,
// so an unauthenticated request is bounced to /login before this ever renders. A thin Server
// Component wrapper; ChangePasswordForm is the Client Component that owns the controlled inputs,
// client-side validation, and the POST. Centered card, consistent with the login page.

export default function AccountPage(): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12">
      <div className="surface-card w-full max-w-sm p-8">
        <h1 className="mb-1 text-lg font-semibold tracking-tight text-ink">Change password</h1>
        <p className="mb-6 text-xs text-ink-3">
          Takes effect on your next sign-in.
        </p>
        <ChangePasswordForm />
      </div>
    </main>
  );
}

import { ChangePasswordForm } from '../../components/ChangePasswordForm';

// Account page (/account). Session-gated by the middleware — /account is not in PUBLIC_PATHS,
// so an unauthenticated request is bounced to /login before this ever renders. A thin Server
// Component wrapper; ChangePasswordForm is the Client Component that owns the controlled inputs,
// client-side validation, and the POST. Centered card, consistent with the login page.

export default function AccountPage(): React.JSX.Element {
  return (
    <main className="min-h-screen flex items-start justify-center bg-gray-50 px-4 py-12">
      <div className="w-full max-w-sm bg-white border border-gray-200 rounded-lg p-8 shadow-sm">
        <h1 className="text-lg font-semibold mb-1 tracking-tight">Change password</h1>
        <p className="text-xs text-gray-500 mb-6">
          Takes effect on your next sign-in.
        </p>
        <ChangePasswordForm />
      </div>
    </main>
  );
}

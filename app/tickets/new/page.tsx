import { NewTicketForm } from '../../../components/NewTicketForm';

// Manual ticket creation route (FR-UI-10). Session-gated by the middleware (Prompt 4). The page
// is a thin Server Component wrapper; the form is a Client Component (it owns the controlled
// inputs, client-side validation, and the POST) — the nav "New ticket" link routes here.

export default function NewTicketPage(): React.JSX.Element {
  return (
    <main className="px-4 py-4">
      <NewTicketForm />
    </main>
  );
}

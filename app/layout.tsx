import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'M.O.T. — Ministry of Tickets',
  description: 'Single-user triage and ticketing.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

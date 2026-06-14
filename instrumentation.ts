// Next.js calls register() once at server boot (App Router instrumentation hook).
// We run migrations here so the schema is current before any request hits the DB.
// Guard on the Node.js runtime so this never executes in the Edge runtime, which has
// no filesystem or native better-sqlite3 binding.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { migrate_db } = await import('./db/client');
  migrate_db();
}

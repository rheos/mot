// Next.js calls register() once at server boot (App Router instrumentation hook).
// We run migrations here so the schema is current before any request hits the DB.
// Guard on the Node.js runtime so this never executes in the Edge runtime, which has
// no filesystem or native better-sqlite3 binding.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { migrate_db } = await import('./db/client');
  migrate_db();
  // Auth bootstrap runs once here, after migrations (app_secret table must exist):
  // seed/verify the API-key hash, and hash the UI password into module memory.
  const { bootstrapApiKey, bootstrapUiCredentials } = await import('./lib/auth');
  await bootstrapApiKey();
  await bootstrapUiCredentials();
  // Nightly DB backup (FR-DB-2): register the 02:00 VACUUM INTO cron once at boot.
  const { scheduleNightly } = await import('./lib/backup');
  scheduleNightly();
}

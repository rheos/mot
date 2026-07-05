// Next.js calls register() once at server boot (App Router instrumentation hook).
// We run migrations here so the schema is current before any request hits the DB.
// Guard on the Node.js runtime so this never executes in the Edge runtime, which has
// no filesystem or native better-sqlite3 binding.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { migrate_db } = await import('./db/client');
  migrate_db();
  // Validate adapter config at boot: a misconfigured adapter must fail the app here,
  // not silently misroute at runtime (AC-7).
  const { validateMinistryConfig } = await import('./lib/ministry-config');
  const { MINISTRY_ADAPTERS } = await import('./config/ministry-adapters');
  validateMinistryConfig(MINISTRY_ADAPTERS);
  // Auth bootstrap runs once here, after migrations (app_secret table must exist):
  // seed/verify the API-key hash, hash the UI password into module memory (env fallback),
  // then seed the DB-backed UI credential once from env (after bootstrapApiKey, which seeds
  // the app_secret row on first boot — the UI seed UPDATEs that row).
  const { bootstrapApiKey, bootstrapUiCredentials, bootstrapUiPassword } =
    await import('./lib/auth');
  await bootstrapApiKey();
  await bootstrapUiCredentials();
  await bootstrapUiPassword();
  // Nightly DB backup (FR-DB-2): register the 02:00 VACUUM INTO cron once at boot.
  const { scheduleNightly } = await import('./lib/backup');
  scheduleNightly();
  // Boot warm-up (W4): trigger the ~90MB model download at service start so the first
  // user turn never pays the download cost. Non-blocking — boot never waits on this.
  // The try/catch covers the dynamic import too: a module-eval throw (e.g. a broken
  // native dep on a degraded box) logs and continues, never fails boot. The prod
  // fail-fast path for the vec EXTENSION lives in getDb()/loadVecExtension — that one
  // is intentionally NOT caught here.
  if (process.env.MOT_EMBED_DISABLE !== '1') {
    try {
      const { embed } = await import('./lib/embedding');
      // The success line is load-bearing for the ops runbook: CLAUDE.md tells the operator
      // to `journalctl -u mot.service | grep 'warmup'` after the first deploy.
      embed('warmup')
        .then(() => console.log('[MOT/embed] boot warmup complete'))
        .catch((err) => console.error('[MOT/embed] boot warmup failed:', err));
    } catch (err) {
      console.error('[MOT/embed] boot warmup failed to load embedding module:', err);
    }
  }
}

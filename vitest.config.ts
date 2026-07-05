import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    // Each integration test opens its own on-disk SQLite DB; run files serially to keep
    // temp DB paths and the better-sqlite3 native binding well-behaved.
    pool: 'forks',
    fileParallelism: false,
    // Track 5: embedding is OFF by default across the whole suite so ordinary tests never
    // download the ~90MB model or fire vec writes. Vec-specific tests opt back in by
    // `delete process.env.MOT_EMBED_DISABLE` at their module top (AC 1 / AC 10 safeguard).
    env: { MOT_EMBED_DISABLE: '1' },
  },
});

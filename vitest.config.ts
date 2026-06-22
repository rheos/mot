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
  },
});

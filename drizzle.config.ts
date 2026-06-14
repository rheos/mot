import type { Config } from 'drizzle-kit';

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  driver: 'better-sqlite',
  dbCredentials: { url: process.env.DATABASE_URL ?? './mot.db' },
} satisfies Config;

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../db/client', () => ({ migrate_db: vi.fn() }));
vi.mock('../../lib/ministry-config', () => ({ validateMinistryConfig: vi.fn() }));
vi.mock('../../config/ministry-adapters', () => ({ MINISTRY_ADAPTERS: [] }));
vi.mock('../../lib/auth', () => ({
  bootstrapApiKey: vi.fn(async () => {}),
  bootstrapUiCredentials: vi.fn(async () => {}),
  bootstrapUiPassword: vi.fn(async () => {}),
}));
vi.mock('../../lib/backup', () => ({ scheduleNightly: vi.fn() }));
vi.mock('../../lib/embedding', () => ({ embed: vi.fn(async () => new Float32Array(384)) }));

const { register } = await import('../../instrumentation');
const { migrate_db } = await import('../../db/client');
const { bootstrapApiKey, bootstrapUiCredentials, bootstrapUiPassword } = await import('../../lib/auth');
const { scheduleNightly } = await import('../../lib/backup');
const { embed } = await import('../../lib/embedding');
const previousRuntime = process.env.NEXT_RUNTIME;
const previousEmbedDisable = process.env.MOT_EMBED_DISABLE;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_RUNTIME = 'nodejs';
  delete process.env.MOT_EMBED_DISABLE;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = previousRuntime;
  if (previousEmbedDisable === undefined) delete process.env.MOT_EMBED_DISABLE;
  else process.env.MOT_EMBED_DISABLE = previousEmbedDisable;
  delete process.env.MOT_MEMORY_DISABLE;
  vi.restoreAllMocks();
});

it('ticket-only boot keeps migrations, auth and backup registration but never warms the model', async () => {
  process.env.MOT_MEMORY_DISABLE = '1';
  await register();
  for (const startup of [migrate_db, bootstrapApiKey, bootstrapUiCredentials, bootstrapUiPassword, scheduleNightly]) {
    expect(startup).toHaveBeenCalledOnce();
  }
  expect(embed).not.toHaveBeenCalled();
});

it('default boot still starts embedding warm-up', async () => {
  delete process.env.MOT_MEMORY_DISABLE;
  await register();
  expect(embed).toHaveBeenCalledWith('warmup');
});

import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/embedding', () => ({
  embeddingEnabled: () => process.env.MOT_MEMORY_DISABLE !== '1',
  embed: vi.fn(),
}));
const { embed } = await import('../../lib/embedding');
const { indexAsync } = await import('../../lib/vec');

afterEach(() => {
  delete process.env.MOT_MEMORY_DISABLE;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it('a vector result arriving after disable cannot mutate the store', async () => {
  delete process.env.MOT_MEMORY_DISABLE;
  let finish!: (value: Float32Array) => void;
  vi.mocked(embed).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const transaction = vi.fn();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  indexAsync({ transaction } as never, 'conversation_vec', 1, 'Synthetic pending fixture');
  expect(embed).toHaveBeenCalledOnce();
  process.env.MOT_MEMORY_DISABLE = '1';
  finish(new Float32Array(384));
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[MOT/vec] indexAsync error:', expect.objectContaining({ name: 'MemoryDisabledError' })));
  expect(transaction).not.toHaveBeenCalled();
});

it('disabled indexing does not start an embedding request', () => {
  process.env.MOT_MEMORY_DISABLE = '1';
  indexAsync({} as never, 'conversation_vec', 1, 'Synthetic refused fixture');
  expect(embed).not.toHaveBeenCalled();
});

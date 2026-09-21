import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The Maintainer LLM provider seam (lib/llm-provider.ts). This is the fix for the 2026-08-13→
// 2026-09-11 outage: the old identifyViaClaude hard-wired `spawnSync('claude', ...)` with no
// fallback and no swap-in, so a container missing the `claude` binary (no credentials either)
// failed every batch, every night, silently. Both backends here go through spawnSync so the seam
// stays synchronous (matching every existing call site — resolutionWorker/dedupWorker/profileWorker
// call `identify(prompt)` without awaiting it); the tests mock node:child_process's spawnSync so
// nothing here ever shells out for real.

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const { identifyViaProvider, extractBalancedJson } = await import('../../lib/llm-provider');

beforeEach(() => {
  spawnSyncMock.mockReset();
  delete process.env.MAINTAINER_LLM_PROVIDER;
  delete process.env.MAINTAINER_OPENROUTER_MODEL;
  delete process.env.MAINTAINER_OPENROUTER_MAX_TOKENS;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  delete process.env.MAINTAINER_LLM_PROVIDER;
  delete process.env.MAINTAINER_OPENROUTER_MODEL;
  delete process.env.MAINTAINER_OPENROUTER_MAX_TOKENS;
  delete process.env.OPENROUTER_API_KEY;
});

describe('extractBalancedJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractBalancedJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fence before extracting', () => {
    expect(extractBalancedJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts only the first balanced object, ignoring trailing prose', () => {
    expect(extractBalancedJson('{"a":{"b":1}} some trailing text')).toEqual({ a: { b: 1 } });
  });

  it('returns null when there is no JSON object in the text', () => {
    expect(extractBalancedJson('no json here')).toBeNull();
  });
});

describe('identifyViaProvider — claude-cli backend (default)', () => {
  it('spawns the local node_modules/.bin/claude binary with -p and the prompt', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '{"identifications":[]}', stderr: '' });

    const result = identifyViaProvider('PROMPT TEXT');

    expect(result).toEqual({ identifications: [] });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(bin).toMatch(/node_modules[/\\]\.bin[/\\]claude$/);
    expect(args).toEqual(['-p', 'PROMPT TEXT', '--model', 'claude-sonnet-4-6', '--allowedTools', '']);
  });

  it('throws with the exit status and stderr when claude -p exits non-zero', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });

    expect(() => identifyViaProvider('x')).toThrow(/claude -p exited 1: boom/);
  });

  it('throws with "exited null" when the binary is missing (ENOENT — the 2026-08-13 outage shape)', () => {
    spawnSyncMock.mockReturnValue({ status: null, stdout: '', stderr: '' });

    expect(() => identifyViaProvider('x')).toThrow(/claude -p exited null/);
  });

  it('falls back to stdout when stderr is empty (the CLI\'s "session limit" message ships on stdout, not stderr)', () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "You've hit your session limit · resets 10:40am (UTC)",
      stderr: '',
    });

    expect(() => identifyViaProvider('x')).toThrow(/session limit/);
  });

  it('prefers stderr over stdout when both are present', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: 'stdout noise', stderr: 'real error' });

    expect(() => identifyViaProvider('x')).toThrow(/claude -p exited 1: real error/);
  });
});

describe('identifyViaProvider — openrouter backend', () => {
  beforeEach(() => {
    process.env.MAINTAINER_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  it('throws when OPENROUTER_API_KEY is not set', () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => identifyViaProvider('x')).toThrow(/OPENROUTER_API_KEY is not set/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('POSTs to OpenRouter via curl with the API key and default cheap model, parsing message content', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ choices: [{ message: { content: '{"groups":[]}' } }] }),
      stderr: '',
    });

    const result = identifyViaProvider('PROMPT TEXT');

    expect(result).toEqual({ groups: [] });
    const [bin, args, opts] = spawnSyncMock.mock.calls[0] as [string, string[], { input: string }];
    expect(bin).toBe('curl');
    expect(args).toContain('https://openrouter.ai/api/v1/chat/completions');
    expect(args).toContain('Authorization: Bearer test-key');
    const body = JSON.parse(opts.input);
    expect(body.model).toBe('anthropic/claude-haiku-4.5');
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT TEXT' }]);
  });

  // The 2026-09-21 outage shape: with no max_tokens in the body OpenRouter's credit pre-check
  // reserves the model's full 64k output ceiling and rejects the call ("requires more credits, or
  // fewer max_tokens") even though the balance covers the real response many times over. An
  // explicit cap MUST always be sent.
  it('always sends an explicit max_tokens cap (default 8192) so the credit pre-check reserves a realistic amount', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      stderr: '',
    });

    identifyViaProvider('x');

    const [, , opts] = spawnSyncMock.mock.calls[0] as [string, string[], { input: string }];
    expect(JSON.parse(opts.input).max_tokens).toBe(8192);
  });

  it('honors MAINTAINER_OPENROUTER_MAX_TOKENS when set, ignoring junk values', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      stderr: '',
    });

    process.env.MAINTAINER_OPENROUTER_MAX_TOKENS = '4096';
    identifyViaProvider('x');
    let [, , opts] = spawnSyncMock.mock.calls[0] as [string, string[], { input: string }];
    expect(JSON.parse(opts.input).max_tokens).toBe(4096);

    for (const junk of ['0', '-5', 'abc', '']) {
      spawnSyncMock.mockClear();
      process.env.MAINTAINER_OPENROUTER_MAX_TOKENS = junk;
      identifyViaProvider('x');
      [, , opts] = spawnSyncMock.mock.calls[0] as [string, string[], { input: string }];
      expect(JSON.parse(opts.input).max_tokens).toBe(8192);
    }
  });

  it('honors MAINTAINER_OPENROUTER_MODEL when set', () => {
    process.env.MAINTAINER_OPENROUTER_MODEL = 'some/other-model';
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      stderr: '',
    });

    identifyViaProvider('x');

    const [, , opts] = spawnSyncMock.mock.calls[0] as [string, string[], { input: string }];
    expect(JSON.parse(opts.input).model).toBe('some/other-model');
  });

  it('throws when curl itself fails (non-zero exit)', () => {
    spawnSyncMock.mockReturnValue({ status: 7, stdout: '', stderr: 'connection refused' });
    expect(() => identifyViaProvider('x')).toThrow(/openrouter call exited 7/);
  });

  it('throws with the API error message when OpenRouter returns a JSON error body', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ error: { message: 'insufficient credits' } }),
      stderr: '',
    });
    expect(() => identifyViaProvider('x')).toThrow(/openrouter error: insufficient credits/);
  });
});

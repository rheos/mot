import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The deploy_drift_check MCP tool. Read-only by design: Rheo (or Robin) can ask "is production
// actually running main?" at any time without filing or closing anything — the nightly cron owns
// the alarm. This exists because the 2026-09-18 drift was only findable by SSHing to the box and
// eyeballing a container image tag, which is why nobody did it for five days.

const HEAD = '81751bdfa3a2a386037356b3a9057fb10284926b';

vi.mock('../../db/client', () => ({ getDb: vi.fn(() => ({ exec: vi.fn() })) }));

const { listMcpTools, callMcpTool } = await import('../../lib/mcp-tools');

const ENV_KEYS = ['SOURCE_COMMIT', 'MOT_DEPLOYED_SHA', 'MOT_DEPLOY_DRIFT_DISABLE'];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
});

function parse(content: Array<{ type: 'text'; text: string }>): Record<string, unknown> {
  return JSON.parse(content[0].text);
}

describe('deploy_drift_check MCP tool', () => {
  it('is registered with an empty input schema', () => {
    const tool = listMcpTools().find((t) => t.name === 'deploy_drift_check');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('SOURCE_COMMIT');
    expect(tool!.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('returns the comparison without touching any ticket', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sha: HEAD, commit: { committer: { date: '2026-09-01T00:00:00Z' } } }),
      })),
    );

    // getDb is mocked to a stub with only exec() — any ticket write would throw here, which is
    // exactly the assertion: this path must not write.
    const result = parse(await callMcpTool('deploy_drift_check', {}));
    expect(result.checked).toBe(true);
    expect(result.drifted).toBe(false);
    expect(result.head_sha).toBe(HEAD);
  });

  it('reports the skip reason instead of erroring outside a deployed container', async () => {
    const result = parse(await callMcpTool('deploy_drift_check', {}));
    expect(result.skipped_reason).toContain('SOURCE_COMMIT');
    expect(result.drifted).toBe(false);
  });

  it('still answers when the nightly alarm is disabled', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    process.env.MOT_DEPLOY_DRIFT_DISABLE = '1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sha: HEAD, commit: { committer: { date: '2026-09-01T00:00:00Z' } } }),
      })),
    );

    const result = parse(await callMcpTool('deploy_drift_check', {}));
    expect(result.checked).toBe(true);
  });
});

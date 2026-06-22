import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Unit test for the notify_robin MCP tool (Phase 1). fetch is mocked via vi.stubGlobal —
// nothing here touches a real DB or a real Telegram chat. notify_robin reads credentials from
// process.env at CALL time and does no DB access, so we import callMcpTool directly and drive
// it with per-test env + a stubbed fetch. (The integration helpers in tests/integration are for
// real-DB route tests; this tool needs neither, so we keep this in tests/unit.)
//
// Backoff between retry attempts is real setTimeout (1s, then 2s). We use fake timers and
// advance them so the retry/exhaustion cases run instantly and deterministically.

const { callMcpTool, listMcpTools } = await import('../../lib/mcp-tools');

const BOT_TOKEN = 'test-bot-token';
const CHAT_ID = '123456789';

// A minimal Response-like object with the ok/status fields notify_robin inspects.
function fakeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_ALLOWED_USER = CHAT_ID;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_USER;
});

// Drain microtasks AND flush all pending timers (the backoff sleeps), repeatedly, until the
// promise under test settles, then return it. With fake timers a plain await would hang on the
// 1s/2s sleeps. We track settlement WITHOUT branching the promise (a second `.then/.catch`
// chain would surface a rejection as "unhandled"), then return the original promise for the
// caller to await/assert on.
function settle<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  // Single observer on the original promise; its own rejection is swallowed here so it never
  // looks unhandled. The caller still gets `p` (with its real value/rejection) to assert on.
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  return (async () => {
    // Up to a few rounds covers the 3-attempt retry loop (two sleeps).
    for (let i = 0; i < 10 && !settled; i++) {
      await Promise.resolve();
      await vi.runAllTimersAsync();
    }
    return p;
  })();
}

describe('notify_robin: tool registration', () => {
  it('listMcpTools() includes notify_robin with a required text input', () => {
    const tool = listMcpTools().find((t) => t.name === 'notify_robin');
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty('text');
    expect(schema.required).toContain('text');
  });
});

describe('notify_robin: truncation (FR-7, AC-8)', () => {
  // The helper is private; we observe its effect through the body sent to fetch.
  async function sentBody(text: string): Promise<string> {
    const fetchMock = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(async () =>
      fakeResponse(200),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await callMcpTool('notify_robin', { text });
    expect(res).toEqual([{ type: 'text', text: 'ok' }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    return body.text as string;
  }

  it('passes text ≤4096 chars through unchanged', async () => {
    const text = 'A'.repeat(4096);
    expect(await sentBody(text)).toBe(text);
  });

  it('cuts >4096-char text at a section-header boundary with "…and N more", ≤4096', async () => {
    // Build a body with header lines ("\nSection ...") so a boundary exists late in the string,
    // then pad past 4096 so truncation triggers.
    const head = 'Briefing start.\n';
    const headers: string[] = [];
    for (let i = 0; i < 60; i++) headers.push(`Section ${i}: ` + 'x'.repeat(60));
    const text = head + headers.join('\n') + '\n' + 'Z'.repeat(2000);
    expect(text.length).toBeGreaterThan(4096);

    const out = await sentBody(text);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/\n…and \d+ more$/);
    // The kept prefix is a real prefix of the original.
    const kept = out.replace(/\n…and \d+ more$/, '');
    expect(text.startsWith(kept)).toBe(true);
    // N reflects the dropped remainder.
    const n = Number(out.match(/…and (\d+) more$/)![1]);
    expect(n).toBe(text.length - kept.length);
  });

  it('hard-cuts the degenerate case (no header boundary) and appends the suffix, ≤4096', async () => {
    // No '\n' followed by an uppercase letter anywhere → degenerate branch.
    const text = 'a'.repeat(5000);
    const out = await sentBody(text);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toMatch(/\n…and \d+ more$/);
    const kept = out.replace(/\n…and \d+ more$/, '');
    expect(kept).toBe('a'.repeat(4096 - 25));
    const n = Number(out.match(/…and (\d+) more$/)![1]);
    expect(n).toBe(5000 - (4096 - 25));
  });
});

describe('notify_robin: missing credentials throw (isError path)', () => {
  it('throws a named error when TELEGRAM_BOT_TOKEN is absent', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchMock = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callMcpTool('notify_robin', { text: 'hi' })).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a named error when TELEGRAM_ALLOWED_USER is absent', async () => {
    delete process.env.TELEGRAM_ALLOWED_USER;
    const fetchMock = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);
    await expect(callMcpTool('notify_robin', { text: 'hi' })).rejects.toThrow(
      /TELEGRAM_ALLOWED_USER/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('notify_robin: send + retry', () => {
  it('returns ok on a first-try 200 and POSTs plain text with no parse_mode (T-5)', async () => {
    const fetchMock = vi.fn<Parameters<FetchFn>, ReturnType<FetchFn>>(async () =>
      fakeResponse(200),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await callMcpTool('notify_robin', { text: 'hello' });
    expect(res).toEqual([{ type: 'text', text: 'ok' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: CHAT_ID, text: 'hello' });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('retries on 500 twice then succeeds on the third attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(500))
      .mockResolvedValueOnce(fakeResponse(500))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await settle(callMcpTool('notify_robin', { text: 'hello' }));
    expect(res).toEqual([{ type: 'text', text: 'ok' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after 3 failed attempts (exhaustion → isError)', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => fakeResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      settle(callMcpTool('notify_robin', { text: 'hello' })),
    ).rejects.toThrow(/failed after 3 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errSpy).toHaveBeenCalled();
  });

  it('retries on a network error (fetch rejects) then succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await settle(callMcpTool('notify_robin', { text: 'hello' }));
    expect(res).toEqual([{ type: 'text', text: 'ok' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

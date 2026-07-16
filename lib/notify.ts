// Stateless Telegram delivery (Track 7, D1 / FR-11 / AC-17). Extracted verbatim from the
// notify_robin MCP case so the surfacing cron can reach the send logic without importing the
// whole MCP dispatch layer. Leaf module — its only dependencies are process.env and the global
// fetch. It MUST NOT import lib/mcp-tools.ts or any other lib/ module (AC-17: callable from
// lib/backup.ts without the MCP surface).

// ── notify_robin: truncation helper (FR-7, AC-8) ──────────────────────────────
// Telegram caps a sendMessage body at 4096 chars. When the briefing is longer, cut it at the
// LAST section-header boundary (a newline followed by an uppercase letter) that still leaves
// room for the "\n…and NNNNN more" suffix, and append that suffix. The suffix counts toward
// the 4096 budget, so the backward scan starts at maxBody = 4096 - 25 (25 is a safe upper
// bound for the suffix). Result is always ≤4096 chars.
export function _truncateBriefing(text: string): string {
  if (text.length <= 4096) return text;

  const maxBody = 4096 - 25; // 25 ≥ len('\n…and ') + len(String(N)) + len(' more') for any real N

  // Scan backward from maxBody for a section-header boundary: '\n' followed by an uppercase letter.
  let cutPoint = -1;
  for (let i = maxBody; i >= 0; i--) {
    if (text[i] === '\n' && /[A-Z]/.test(text[i + 1] ?? '')) {
      cutPoint = i;
      break;
    }
  }

  if (cutPoint !== -1) {
    const n = text.length - cutPoint;
    return text.slice(0, cutPoint) + '\n…and ' + n + ' more';
  }

  // Degenerate: no header boundary in range. Hard-cut at maxBody and append the suffix.
  const n = text.length - maxBody;
  return text.slice(0, maxBody) + '\n…and ' + n + ' more';
}

// Stateless Telegram delivery (FR-4, FR-7–FR-9; T-1..T-5). Credentials are read at call time
// (mirroring lib/auth's env-read pattern), not at module load. On a missing credential or send
// exhaustion this THROWS — the notify_robin MCP case lets route.ts's catch set isError=true at the
// JSON-RPC level; the surfacing scan catches the throw and skips the ledger write. We never return
// a silent success on failure. Returns Promise<void>: the [{ type:'text', text:'ok' }] envelope
// stays in the notify_robin case, not here.
export async function sendTelegramNotify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ALLOWED_USER?.trim();
  if (!token) {
    // eslint-disable-next-line no-console
    console.error('[MOT/notify_robin] missing-credential: TELEGRAM_BOT_TOKEN is not set');
    throw new Error('notify_robin: TELEGRAM_BOT_TOKEN is not set');
  }
  if (!chatId) {
    // eslint-disable-next-line no-console
    console.error('[MOT/notify_robin] missing-credential: TELEGRAM_ALLOWED_USER is not set');
    throw new Error('notify_robin: TELEGRAM_ALLOWED_USER is not set');
  }

  const body = _truncateBriefing(text);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // Plain text only — NO parse_mode (T-5): Markdown/HTML parse errors on user content
  // would turn a valid briefing into a 400.
  const payload = { chat_id: chatId, text: body };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastReason = '';
  // Up to 3 attempts. Backoff between attempts: 1s after #1, 2s after #2 (T-2).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      lastReason = `Telegram returned HTTP ${res.status}`;
    } catch (e: unknown) {
      lastReason = e instanceof Error ? e.message : 'network error';
    }
    if (attempt < 3) await sleep(attempt * 1000); // 1s, then 2s
  }

  // eslint-disable-next-line no-console
  console.error(`[MOT/notify_robin] send failed after 3 attempts: ${lastReason}`);
  throw new Error(`notify_robin: delivery failed after 3 attempts (${lastReason})`);
}

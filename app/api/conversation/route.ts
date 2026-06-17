import { apiKeyGuard, unauthorized } from '../../../lib/auth';
import { internalError, parsePositiveInt } from '../../../lib/validation';
import { logTurn, getRecentTurns, searchTurns } from '../../../lib/conversation';

// POST /api/conversation  — log a single turn
// Body: { chat_id: string, role: "user"|"rheo", content: string }
// Returns 201 + the saved turn.
export async function POST(req: Request): Promise<Response> {
  if (!await apiKeyGuard(req)) return unauthorized();

  let body: unknown;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const { chat_id, role, content } = body as Record<string, string>;
  if (!chat_id || !role || !content) {
    return new Response('chat_id, role, and content are required', { status: 422 });
  }
  if (role !== 'user' && role !== 'rheo') {
    return new Response('role must be "user" or "rheo"', { status: 422 });
  }

  try {
    const turn = logTurn(chat_id, role as 'user' | 'rheo', content);
    return Response.json(turn, { status: 201 });
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /conversation error:', e);
    return internalError();
  }
}

// GET /api/conversation?chat_id=X&n=12   — recent turns (default 12, max 50)
// GET /api/conversation?chat_id=X&q=term — FTS keyword search
export async function GET(req: Request): Promise<Response> {
  if (!await apiKeyGuard(req)) return unauthorized();

  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get('chat_id') ?? undefined;
  const q = searchParams.get('q');

  try {
    if (q) {
      const limit = Math.min(parsePositiveInt(searchParams.get('limit')) ?? 20, 50);
      return Response.json(searchTurns(q, chatId, limit));
    }

    if (!chatId) return new Response('chat_id is required', { status: 422 });
    const n = Math.min(parsePositiveInt(searchParams.get('n')) ?? 12, 50);
    return Response.json(getRecentTurns(chatId, n));
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /conversation error:', e);
    return internalError();
  }
}

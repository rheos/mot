import { apiKeyGuard, unauthorized } from '../../../lib/auth';
import { parsePositiveInt, internalError } from '../../../lib/validation';
import { getActiveMemory } from '../../../lib/memory';

// GET /api/memory?chat_id=X&limit=N
// Returns active (non-superseded, non-conflicted) memory items for a chat.
// Returns [] when none — the active-only filter is applied inside getActiveMemory.
export async function GET(req: Request): Promise<Response> {
  if (!await apiKeyGuard(req)) return unauthorized();

  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get('chat_id');
  if (!chatId) return Response.json({ error: 'chat_id is required' }, { status: 422 });

  const limit = Math.min(parsePositiveInt(searchParams.get('limit')) ?? 20, 50);

  try {
    return Response.json(getActiveMemory(chatId, limit));
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /memory error:', e);
    return internalError();
  }
}

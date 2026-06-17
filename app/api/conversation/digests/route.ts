import { apiKeyGuard, unauthorized } from '../../../../lib/auth';
import { parsePositiveInt, internalError } from '../../../../lib/validation';
import { getDigests } from '../../../../lib/digest';

// GET /api/conversation/digests?chat_id=X&n=5
// Returns an array of session_digest rows (newest first). Returns [] when none — never 500 on empty.
export async function GET(req: Request): Promise<Response> {
  if (!await apiKeyGuard(req)) return unauthorized();

  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get('chat_id');
  if (!chatId) return new Response('chat_id is required', { status: 422 });

  const n = Math.min(parsePositiveInt(searchParams.get('n')) ?? 5, 20);

  try {
    return Response.json(getDigests(chatId, n));
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] GET /conversation/digests error:', e);
    return internalError();
  }
}

import { apiKeyGuard, unauthorized } from '../../../../lib/auth';
import { parsePositiveInt, internalError } from '../../../../lib/validation';
import { upsertDigest } from '../../../../lib/digest';

// POST /api/conversation/digest
// Write-back endpoint for bot.py run_digest. Does NOT spawn claude -p or any subprocess.
// Accepts: { session_id, summary, turn_count, chat_id, topics?, entity_draft?, procedural_raw?, parse_error? }
export async function POST(req: Request): Promise<Response> {
  if (!await apiKeyGuard(req)) return unauthorized();

  let body: unknown;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }

  const b = body as Record<string, unknown>;

  if (!b.session_id || typeof b.session_id !== 'string') {
    return new Response('session_id is required', { status: 422 });
  }
  if (!b.summary || typeof b.summary !== 'string') {
    return new Response('summary is required', { status: 422 });
  }
  if (!b.chat_id || typeof b.chat_id !== 'string') {
    return new Response('chat_id is required', { status: 422 });
  }
  const turnCount = parsePositiveInt(String(b.turn_count ?? ''));
  if (turnCount === undefined) {
    return new Response('turn_count is required and must be a positive integer', { status: 422 });
  }

  try {
    const row = upsertDigest({
      session_id:     b.session_id,
      summary:        b.summary,
      chat_id:        b.chat_id,
      turn_count:     turnCount,
      topics:         typeof b.topics === 'string' ? b.topics : null,
      entity_draft:   typeof b.entity_draft === 'string' ? b.entity_draft : null,
      procedural_raw: typeof b.procedural_raw === 'string' ? b.procedural_raw : null,
      parse_error:    b.parse_error === true,
    });
    return Response.json(row, { status: 200 });
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error('[MOT] POST /conversation/digest error:', e);
    return internalError();
  }
}

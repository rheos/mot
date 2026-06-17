import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiKeyGuard, unauthorized } from '../../../lib/auth';

const LOG_PATH = join(process.cwd(), 'bot', 'bot.log');
const MAX_LINES = 200;

export async function GET(req: Request): Promise<Response> {
  const authed = await apiKeyGuard(req);
  if (!authed) return unauthorized();

  try {
    const raw = readFileSync(LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const recent = lines.slice(-MAX_LINES);
    return Response.json({ lines: recent, total: lines.length, path: LOG_PATH });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ lines: [], error: msg }, { status: 200 });
  }
}

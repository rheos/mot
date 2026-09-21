// The Maintainer LLM provider seam (novadiem-engineering standard 14 — never hard-wire a model or
// provider SDK into pipeline code). lib/maintainer.ts's identifyViaClaude used to spawn `claude -p`
// directly; that hard-wire is why the nightly workers went silently dark on 2026-08-13 — the MOT
// Coolify container (nixpacks build, no Dockerfile in this repo) has neither the `claude` binary nor
// any credentials, so spawnSync returned status:null and every batch failed the same way for weeks.
//
// Two backends, selected by MAINTAINER_LLM_PROVIDER (read at CALL time, so it's tunable in Coolify
// without a redeploy):
//   - 'claude-cli' (default) — headless `claude -p` on Robin's own subscription. The standing
//     pattern for Robin's own/single-user tools (never the raw Anthropic API at full price).
//     Resolves the project-local node_modules/.bin/claude first (works in a container with no
//     global install), falling back to whatever `claude` resolves to on PATH.
//   - 'openrouter' — the swap-in for scale. Text-only, routed to a cheap model by default (this is
//     mechanical dedup/resolution work, not prose) — MAINTAINER_OPENROUTER_MODEL overrides it.
//
// Both backends are SYNCHRONOUS (spawnSync) on purpose: resolutionWorker/dedupWorker/profileWorker
// call `identify(prompt)` without awaiting it today, and making the seam async would mean threading
// async through every worker, every call site (mcp-tools.ts, scripts/backfill-relations.ts), and
// every existing test. Shelling out to `curl` for the OpenRouter call keeps the synchronous contract
// intact with a one-line diff at the call site (curl is present in the container — confirmed via
// `docker exec ... command -v curl`).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type MaintainerLLMProvider = 'claude-cli' | 'openrouter';

function resolveProvider(): MaintainerLLMProvider {
  return process.env.MAINTAINER_LLM_PROVIDER?.trim().toLowerCase() === 'openrouter'
    ? 'openrouter'
    : 'claude-cli';
}

// Extract the first balanced {...} JSON object from arbitrary LLM output (strips a ```json fence
// first). Shared by both backends so there is exactly one copy of this parsing logic in the repo.
// Returns null when the text has no `{` at all (the caller's JSON.parse would otherwise throw on
// slice(start, start) === '').
export function extractBalancedJson(text: string): unknown {
  const clean = text.trim().replace(/^```json\s*|^```\s*|\s*```$/gm, '').trim();
  const start = clean.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = start;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return JSON.parse(clean.slice(start, end));
}

// Prefer the project-local dependency binary (bundled via package.json so it's present in the
// built container regardless of build pack) over a bare `claude` on PATH — a container has no
// global install, but Robin's own machine does, so the PATH fallback keeps local/dev usage working.
function resolveClaudeBin(): string {
  const local = path.join(process.cwd(), 'node_modules', '.bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

function identifyViaClaudeCli(prompt: string): unknown {
  const res = spawnSync(
    resolveClaudeBin(),
    ['-p', prompt, '--model', 'claude-sonnet-4-6', '--allowedTools', ''],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    // The CLI's user-facing error text (e.g. "You've hit your session limit · resets ...") comes
    // through stdout, not stderr — a stderr-only message swallowed exactly that diagnosis during
    // the 2026-09-12 verification, showing an empty error for a real, explainable failure. Prefer
    // stderr when present (still the right place for a crash/stack trace), fall back to stdout.
    const detail = (res.stderr || res.stdout || '').slice(0, 300);
    throw new Error(`claude -p exited ${res.status}: ${detail}`);
  }
  return extractBalancedJson(res.stdout || '');
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Output-token cap for the OpenRouter request. OpenRouter runs a credit PRE-CHECK against
// max_tokens before it forwards the call, and when the body carries no max_tokens it reserves the
// model's FULL output ceiling (64,000 for claude-haiku-4.5). That is how the 2026-09-21 nightly
// failed every batch of every worker without spending a cent: "This request requires more credits,
// or fewer max_tokens. You requested up to 64000 tokens, but can only afford 62039" — the balance
// could easily cover the actual response (compact JSON over a ≤25-entity batch: a few thousand
// tokens at the very most) but not a 64k reservation. Sending an explicit, realistic cap keeps a
// modest balance usable and bounds the worst-case spend of a runaway response. Env-overridable and
// read at CALL time like the other knobs; guarded against 0/NaN/negative.
const DEFAULT_OPENROUTER_MAX_TOKENS = 8192;

function resolveOpenRouterMaxTokens(): number {
  const v = Number(process.env.MAINTAINER_OPENROUTER_MAX_TOKENS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_OPENROUTER_MAX_TOKENS;
}

function identifyViaOpenRouter(prompt: string): unknown {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('MAINTAINER_LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set');
  const model = process.env.MAINTAINER_OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';

  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: resolveOpenRouterMaxTokens(),
  });

  // Array-argv spawnSync (no shell:true) — the prompt/body never passes through shell
  // interpolation. --data-binary @- reads the JSON body from stdin so an ~25-entity batch never
  // has to fit in an argv (ARG_MAX) or show up in a process listing.
  const res = spawnSync(
    'curl',
    [
      '-sS',
      '--max-time',
      '110',
      OPENROUTER_URL,
      '-H',
      `Authorization: Bearer ${apiKey}`,
      '-H',
      'Content-Type: application/json',
      '-H',
      'HTTP-Referer: https://rheo.ca/mot',
      '-H',
      'X-Title: MOT Maintainer',
      '--data-binary',
      '@-',
    ],
    { input: body, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(
      `openrouter call exited ${res.status}: ${(res.stderr || res.stdout || '').slice(0, 300)}`,
    );
  }

  let parsed: {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`openrouter returned non-JSON output: ${res.stdout.slice(0, 300)}`);
  }
  if (parsed.error) {
    throw new Error(`openrouter error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  const content = parsed.choices?.[0]?.message?.content ?? '';
  return extractBalancedJson(content);
}

// The seam entry point. lib/maintainer.ts's identifyViaClaude delegates here — kept as a separate
// exported name from the two backends above so a future third backend is a new function + one
// branch here, never a call-site change.
export function identifyViaProvider(prompt: string): unknown {
  return resolveProvider() === 'openrouter' ? identifyViaOpenRouter(prompt) : identifyViaClaudeCli(prompt);
}

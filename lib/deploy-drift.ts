// Deploy-drift alarm: is the code running in this container the code that is on main?
//
// On 2026-09-18 production was found five days and four commits behind main. No push webhook was
// registered on the repo and auto-deploy was switched off on the app; both are fixed.
// The gap this module closes is the one underneath: a failed deploy rolls back silently and looks
// exactly like a deploy that never ran, and nothing watched either case. The only evidence was a
// container image tag nobody was comparing to anything.
//
// The check, from inside the container:
//   - The running image tag IS the deployed commit (Coolify tags images `<resource-uuid>:<full-sha>`),
//     and Coolify hands the same value to the process as SOURCE_COMMIT. Reading our own env beats
//     shelling out to docker, which a container cannot do.
//   - main's HEAD comes from the GitHub API. rheos/mot is public, so an unauthenticated call works
//     and the 60/hour unauthenticated budget dwarfs two calls a night — but the box shares that
//     budget across every service on it, and the repo could go private, so MOT_GITHUB_TOKEN /
//     GITHUB_TOKEN are honoured when present.
//   - A grace window keeps an in-flight deploy from paging, measured from the moment production
//     FIRST fell behind — the oldest un-deployed commit, never the branch head. Anchoring on the
//     head would suppress the incident itself: commits kept landing on main all through the outage,
//     so a head-anchored window would have called a five-day-old container "mid-deploy".
//
// Two alert identities, because "production is stale" and "I can no longer tell whether production
// is stale" are different problems and each deserves its own page and its own recovery:
//   deploy:drift        critical — deployed sha != branch HEAD past the grace window
//   deploy:drift-check  high     — the check itself could not run
// Both ride lib/alert-ticket.ts, so a drift that persists for a week is one page and one ticket
// whose event_count climbs, and both close themselves once the condition clears.

import { fileAlert, clearAlert } from './alert-ticket';
import { nowIso } from './time';

const DRIFT_SOURCE_REF = 'deploy:drift';
const CHECK_SOURCE_REF = 'deploy:drift-check';

const DEFAULT_REPO = 'rheos/mot';
const DEFAULT_GRACE_MINUTES = 30;
const REQUEST_TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export interface DeployDriftResult {
  /** No alarm condition: either the check ran clean, or it deliberately did not run. */
  ok: boolean;
  /** Did the comparison actually happen? False for both skips and errors. */
  checked: boolean;
  /** Why the check did not run, when it deliberately did not. Null otherwise. */
  skipped_reason: string | null;
  repo: string;
  branch: string;
  deployed_sha: string | null;
  head_sha: string | null;
  drifted: boolean;
  /** How many commits the branch is ahead of the deployed sha. Null when compare was unavailable. */
  behind_by: number | null;
  /** GitHub's compare verdict for deployed...HEAD: 'ahead' | 'diverged' | 'identical' | 'unknown'. */
  compare_status: string | null;
  head_committed_at: string | null;
  /**
   * The timestamp the grace window is measured from: the commit date of the OLDEST un-deployed
   * commit, i.e. the moment production first fell behind. Null when it could not be established.
   */
  grace_anchor: string | null;
  /** Drifted, but production only fell behind inside the grace window — a deploy may still be running. */
  within_grace: boolean;
  error: string | null;
  checked_at: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Read an env var, treating blank as absent. Load-bearing, not defensive: `??` only falls through
 * on null/undefined, and .env.local.example ships every knob as `KEY=` (as AGENTS.md tells you to
 * copy it). Without this, `MOT_DEPLOYED_SHA=` masks SOURCE_COMMIT and the check skips forever —
 * the monitor silently disabling itself, which is the exact failure this module exists to stop.
 * A blank MOT_DEPLOY_REPO would likewise build a request against `/repos//commits/...`.
 */
function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function config() {
  return {
    disabled: process.env.MOT_DEPLOY_DRIFT_DISABLE === '1',
    // Opt-in hardening: with this set, a missing SOURCE_COMMIT is an alert rather than a quiet
    // skip. Production should set it, so that Coolify dropping SOURCE_COMMIT some day surfaces as
    // a broken check instead of as a monitor that silently stopped monitoring.
    required: process.env.MOT_DEPLOY_DRIFT_ENABLE === '1',
    repo: envStr('MOT_DEPLOY_REPO') ?? DEFAULT_REPO,
    // COOLIFY_BRANCH is whatever branch this app actually deploys from, so a preview app compares
    // against its own branch rather than falsely reporting itself behind main.
    branch: envStr('MOT_DEPLOY_BRANCH') ?? envStr('COOLIFY_BRANCH') ?? 'main',
    deployedSha: envStr('MOT_DEPLOYED_SHA') ?? envStr('SOURCE_COMMIT') ?? '',
    graceMinutes: intEnv('MOT_DEPLOY_DRIFT_GRACE_MINUTES', DEFAULT_GRACE_MINUTES),
    token: envStr('MOT_GITHUB_TOKEN') ?? envStr('GITHUB_TOKEN') ?? '',
  };
}

/**
 * Two shas name the same commit when one is a prefix of the other and the shorter is a usable
 * abbreviation. SOURCE_COMMIT and the GitHub API both give full 40-char shas; the prefix rule only
 * matters for a hand-set MOT_DEPLOYED_SHA.
 */
export function _shaMatches(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length < 7) return false;
  return long.startsWith(short);
}

function baseResult(cfg: ReturnType<typeof config>): DeployDriftResult {
  return {
    ok: true,
    checked: false,
    skipped_reason: null,
    repo: cfg.repo,
    branch: cfg.branch,
    deployed_sha: cfg.deployedSha || null,
    head_sha: null,
    drifted: false,
    behind_by: null,
    compare_status: null,
    head_committed_at: null,
    grace_anchor: null,
    within_grace: false,
    error: null,
    checked_at: nowIso(),
  };
}

// Small retry wrapper. A single nightly sample means one transient 502 would otherwise cost a
// page, so retry inside the run and let a failure that survives three attempts be real.
async function githubJson(pathname: string, token: string): Promise<unknown> {
  const url = `https://api.github.com${pathname}`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'mot-deploy-drift',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  let lastReason = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      lastReason = `GitHub returned HTTP ${res.status} for ${pathname}`;
      // 404 and 401/403 are verdicts, not weather — retrying just burns the rate limit.
      if (res.status === 404 || res.status === 401 || res.status === 403) break;
    } catch (e: unknown) {
      lastReason = e instanceof Error ? e.message : 'network error';
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  throw new Error(lastReason || `GitHub request failed for ${pathname}`);
}

/**
 * Compare the deployed commit against the branch HEAD. Pure read — files no tickets, honours no
 * disable switch — so the MCP tool can poll it on demand the way surfacing_preview does.
 */
export async function checkDeployDrift(): Promise<DeployDriftResult> {
  const cfg = config();
  const result = baseResult(cfg);

  if (!cfg.deployedSha) {
    // Not running in a Coolify-built container: local dev, CI, a `npm start` on a laptop. There is
    // nothing to compare, so skip rather than invent a drift. `required` flips this to an error so
    // production cannot lose the check by losing an env var.
    const reason = 'no deployed sha in environment (SOURCE_COMMIT / MOT_DEPLOYED_SHA unset)';
    if (cfg.required) {
      return { ...result, ok: false, error: reason };
    }
    return { ...result, skipped_reason: reason };
  }

  let head: { sha: string; committedAt: string | null };
  try {
    const commit = (await githubJson(
      `/repos/${cfg.repo}/commits/${encodeURIComponent(cfg.branch)}`,
      cfg.token,
    )) as { sha?: unknown; commit?: { committer?: { date?: unknown } } };
    if (typeof commit.sha !== 'string' || !commit.sha) {
      throw new Error('GitHub commit response carried no sha');
    }
    const date = commit.commit?.committer?.date;
    head = { sha: commit.sha, committedAt: typeof date === 'string' ? date : null };
  } catch (e: unknown) {
    return { ...result, ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  result.checked = true;
  result.head_sha = head.sha;
  result.head_committed_at = head.committedAt;

  if (_shaMatches(cfg.deployedSha, head.sha)) {
    return result; // In sync. ok stays true, drifted stays false.
  }

  result.drifted = true;

  // How far behind, and — the load-bearing part — WHEN production first fell behind. A 404 here
  // means the deployed sha is not a commit on this repo at all (force-push, rewritten history, an
  // image built from somewhere else).
  try {
    const cmp = (await githubJson(
      `/repos/${cfg.repo}/compare/${cfg.deployedSha}...${encodeURIComponent(cfg.branch)}`,
      cfg.token,
    )) as { status?: unknown; ahead_by?: unknown; commits?: unknown };
    result.compare_status = typeof cmp.status === 'string' ? cmp.status : null;
    result.behind_by = typeof cmp.ahead_by === 'number' ? cmp.ahead_by : null;

    // compare returns the un-deployed commits oldest-first, so commits[0] is the one that first
    // put production behind. Pagination caps the array at 250, but the FIRST entry is still the
    // oldest overall, which is all this needs.
    const commits = Array.isArray(cmp.commits) ? cmp.commits : [];
    const oldest = commits[0] as { commit?: { committer?: { date?: unknown } } } | undefined;
    const date = oldest?.commit?.committer?.date;
    if (typeof date === 'string') result.grace_anchor = date;
  } catch {
    result.compare_status = 'unknown';
  }

  // Grace is measured from the moment production FIRST fell behind, never from the branch head.
  // Anchoring on the head would suppress exactly the case this module exists for: through the
  // 2026-09-13→18 outage, commits kept landing on main, so on any night shortly after a push a
  // head-anchored window would have called a five-day-old container "mid-deploy" and stayed quiet.
  //
  // No anchor means no grace. If the oldest un-deployed commit cannot be established — the compare
  // call failed, or the deployed sha is not on this repo — the check is loud rather than quiet.
  const anchorMs = result.grace_anchor ? Date.parse(result.grace_anchor) : NaN;
  if (Number.isFinite(anchorMs)) {
    result.within_grace = (Date.now() - anchorMs) / 60_000 < cfg.graceMinutes;
  }

  result.ok = result.within_grace;
  return result;
}

/**
 * The by-hand verification, rendered for whoever reads the ticket. Coolify tags every image
 * `<resource-uuid>:<full-sha>` and hands the container its own COOLIFY_RESOURCE_UUID, so the exact
 * filter is derivable at runtime — no deployment identifiers are baked into this repo.
 */
function verifySteps(branch: string): string {
  const uuid = (process.env.COOLIFY_RESOURCE_UUID ?? '').trim();
  const psCmd = uuid
    ? `  docker ps --filter "name=${uuid}" --format "{{.Image}}"`
    : '  docker ps --format "{{.Names}} {{.Image}}"   # find this app, then read its image tag';
  return [
    'Verify by hand on the host:',
    psCmd,
    `  git ls-remote origin refs/heads/${branch}`,
    '',
    'The image tag IS the deployed commit sha.',
  ].join('\n');
}

function driftBody(r: DeployDriftResult): string {
  const behind =
    r.behind_by !== null
      ? `${r.behind_by} commit${r.behind_by === 1 ? '' : 's'} behind`
      : 'behind by an unknown number of commits';
  const compareNote =
    r.compare_status === 'unknown'
      ? `\n\nGitHub could not compare the two: the deployed sha may not be a commit on ${r.repo} at all (force-push, rewritten history, or an image built from somewhere else).`
      : r.compare_status === 'diverged'
        ? '\n\nThe two have DIVERGED — the deployed commit is not an ancestor of the branch head.'
        : '';

  return [
    `Production is running ${r.deployed_sha?.slice(0, 12)} while ${r.repo}@${r.branch} is at ${r.head_sha?.slice(0, 12)} — ${behind}.`,
    `Production first fell behind at ${r.grace_anchor ?? '(unknown)'}; the branch head was committed at ${r.head_committed_at ?? '(unknown)'}.${compareNote}`,
    '',
    'A failed Coolify deploy rolls back silently and looks identical to a deploy that never ran, so check both:',
    '  1. Did a deploy run at all? Coolify → the mot app → Deployments. An empty log since the last push means the webhook did not fire.',
    '  2. Did it run and fail? A failed build leaves the previous container up with no other trace.',
    '',
    'The two settings that caused the 2026-09-18 outage, worth re-checking first:',
    '  - the manual webhook on the GitHub repo (deploy-key sources do not get one automatically)',
    '  - auto-deploy enabled on the app',
    '',
    verifySteps(r.branch),
    '',
    'This ticket closes itself once the two match again.',
  ].join('\n');
}

/**
 * The nightly entry point: run the check, then file or clear the alerts it implies. Honours
 * MOT_DEPLOY_DRIFT_DISABLE. Never throws — lib/backup.ts still wraps it, but a monitor that can
 * take down the job it monitors is worse than no monitor.
 */
export async function runDeployDriftCheck(): Promise<DeployDriftResult> {
  if (process.env.MOT_DEPLOY_DRIFT_DISABLE === '1') {
    const cfg = config();
    // eslint-disable-next-line no-console
    console.log('[MOT/deploy-drift] disabled — skipping');
    return { ...baseResult(cfg), skipped_reason: 'MOT_DEPLOY_DRIFT_DISABLE=1' };
  }

  let result: DeployDriftResult;
  try {
    result = await checkDeployDrift();
  } catch (e: unknown) {
    result = { ...baseResult(config()), ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // The two alert identities report in SEPARATE try/catch blocks, on purpose. Sharing one would
  // mean a DB hiccup while filing the check-health ticket swallows the drift page underneath it —
  // one monitor silencing another, which is the failure this module was written to end.
  try {
    if (result.error) {
      // Blind, not necessarily stale. Leave any open drift ticket alone: we no longer know.
      fileAlert({
        sourceRef: CHECK_SOURCE_REF,
        severity: 'high',
        title: 'Deploy-drift check cannot run',
        body: `The nightly deploy-drift check failed, so nothing is currently watching whether production matches ${result.repo}@${result.branch}.\n\nError: ${result.error}\n\nUntil this clears, check it yourself.\n\n${verifySteps(result.branch)}\n\nThis ticket closes itself once the check runs again.`,
      });
    } else if (result.checked) {
      clearAlert(CHECK_SOURCE_REF, 'Resolved — the deploy-drift check ran successfully again.');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[MOT/deploy-drift] failed to report check health:', e);
  }

  try {
    if (result.drifted && !result.within_grace) {
      fileAlert({
        sourceRef: DRIFT_SOURCE_REF,
        severity: 'critical',
        title: `Production is behind ${result.repo}@${result.branch}`,
        body: driftBody(result),
      });
    } else if (result.checked && !result.drifted) {
      clearAlert(
        DRIFT_SOURCE_REF,
        `Resolved — production is running ${result.head_sha?.slice(0, 12)}, matching ${result.repo}@${result.branch}.`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[MOT/deploy-drift] failed to report drift:', e);
  }

  if (result.skipped_reason) {
    // eslint-disable-next-line no-console
    console.log(`[MOT/deploy-drift] skipped — ${result.skipped_reason}`);
  } else if (result.error) {
    // eslint-disable-next-line no-console
    console.error(`[MOT/deploy-drift] check failed: ${result.error}`);
  } else if (result.drifted) {
    // eslint-disable-next-line no-console
    console.warn(
      `[MOT/deploy-drift] drift: deployed ${result.deployed_sha?.slice(0, 12)} vs ${result.branch} ${result.head_sha?.slice(0, 12)}` +
        (result.within_grace ? ' (within grace window — no alert)' : ''),
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`[MOT/deploy-drift] in sync at ${result.head_sha?.slice(0, 12)}`);
  }

  return result;
}

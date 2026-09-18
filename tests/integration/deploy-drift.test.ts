import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// checkDeployDrift() — the pure comparison half of the deploy-drift alarm (lib/deploy-drift.ts).
// No DB and no tickets here: this file pins what the check CONCLUDES from an env + a GitHub
// response. deploy-drift-alerting.test.ts covers what it then FILES, against a real temp DB.
//
// Every test mocks global fetch. The suite must never reach api.github.com — a monitor whose own
// tests depend on the network is a monitor that goes red for reasons that have nothing to do with
// the code.

const HEAD = '81751bdfa3a2a386037356b3a9057fb10284926b';
const OLD = 'd142be6c0c0ffee0c0ffee0c0ffee0c0ffee0c0f';

// A commit old enough to be well outside any grace window.
const LONG_AGO = '2026-09-01T00:00:00Z';

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}
let calls: FetchCall[] = [];

function commitResponse(sha: string, date: string | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      sha,
      commit: { committer: date === null ? {} : { date } },
    }),
  };
}

/**
 * compare returns the un-deployed commits oldest-first. `oldestDate` is the commit date of
 * commits[0] — the moment production first fell behind, which is what the grace window is measured
 * from. Pass null to model a compare response that carries no usable date.
 */
function compareResponse(status: string, aheadBy: number, oldestDate: string | null = LONG_AGO) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status,
      ahead_by: aheadBy,
      commits: oldestDate === null ? [] : [{ commit: { committer: { date: oldestDate } } }],
    }),
  };
}

/** Route by URL so a test does not have to care how many calls the check makes, or in what order. */
function mockGithub(handlers: {
  commit?: () => unknown;
  compare?: () => unknown;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      if (String(url).includes('/compare/')) {
        if (!handlers.compare) throw new Error('unexpected compare call');
        return handlers.compare();
      }
      if (!handlers.commit) throw new Error('unexpected commit call');
      return handlers.commit();
    }),
  );
}

const { checkDeployDrift, _shaMatches } = await import('../../lib/deploy-drift');

const ENV_KEYS = [
  'MOT_DEPLOYED_SHA',
  'SOURCE_COMMIT',
  'COOLIFY_BRANCH',
  'MOT_DEPLOY_REPO',
  'MOT_DEPLOY_BRANCH',
  'MOT_DEPLOY_DRIFT_ENABLE',
  'MOT_DEPLOY_DRIFT_DISABLE',
  'MOT_DEPLOY_DRIFT_GRACE_MINUTES',
  'MOT_GITHUB_TOKEN',
  'GITHUB_TOKEN',
];

beforeEach(() => {
  calls = [];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('_shaMatches', () => {
  it('matches identical shas regardless of case', () => {
    expect(_shaMatches(HEAD, HEAD.toUpperCase())).toBe(true);
  });

  it('matches a short sha against the full one it abbreviates', () => {
    expect(_shaMatches('81751bd', HEAD)).toBe(true);
  });

  it('rejects an abbreviation too short to be meaningful', () => {
    expect(_shaMatches('81751b', HEAD)).toBe(false);
  });

  it('rejects different shas and empty input', () => {
    expect(_shaMatches(OLD, HEAD)).toBe(false);
    expect(_shaMatches('', HEAD)).toBe(false);
  });
});

describe('checkDeployDrift — in sync', () => {
  it('reports ok with no drift when the deployed sha is the branch head', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ commit: () => commitResponse(HEAD, LONG_AGO) });

    const r = await checkDeployDrift();
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(true);
    expect(r.drifted).toBe(false);
    expect(r.error).toBeNull();
    expect(r.head_sha).toBe(HEAD);
    // No compare call when there is nothing to compare — that is a wasted rate-limit unit.
    expect(calls.filter((c) => c.url.includes('/compare/'))).toHaveLength(0);
  });
});

describe('checkDeployDrift — drift', () => {
  it('reports drift with a commit count when the deployed sha is behind', async () => {
    process.env.SOURCE_COMMIT = OLD;
    mockGithub({
      commit: () => commitResponse(HEAD, LONG_AGO),
      compare: () => compareResponse('ahead', 4),
    });

    const r = await checkDeployDrift();
    expect(r.ok).toBe(false);
    expect(r.drifted).toBe(true);
    expect(r.within_grace).toBe(false);
    expect(r.deployed_sha).toBe(OLD);
    expect(r.head_sha).toBe(HEAD);
    expect(r.behind_by).toBe(4);
    expect(r.compare_status).toBe('ahead');
  });

  it('still reports drift when the compare call fails (behind_by unknown, not a check failure)', async () => {
    process.env.SOURCE_COMMIT = OLD;
    mockGithub({
      commit: () => commitResponse(HEAD, LONG_AGO),
      // 404 = the deployed sha is not a commit on this repo at all (force-push, foreign image).
      compare: () => ({ ok: false, status: 404, json: async () => ({}) }),
    });

    const r = await checkDeployDrift();
    expect(r.drifted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toBeNull();
    expect(r.behind_by).toBeNull();
    expect(r.compare_status).toBe('unknown');
    // No anchor means no grace: being loud when we cannot tell is the point of this module.
    expect(r.grace_anchor).toBeNull();
    expect(r.within_grace).toBe(false);
  });

  it('holds fire while production only just fell behind — a deploy may still be running', async () => {
    process.env.SOURCE_COMMIT = OLD;
    process.env.MOT_DEPLOY_DRIFT_GRACE_MINUTES = '30';
    const justNow = new Date(Date.now() - 5 * 60_000).toISOString();
    mockGithub({
      commit: () => commitResponse(HEAD, justNow),
      compare: () => compareResponse('ahead', 1, justNow),
    });

    const r = await checkDeployDrift();
    expect(r.drifted).toBe(true);
    expect(r.within_grace).toBe(true);
    expect(r.grace_anchor).toBe(justNow);
    expect(r.ok).toBe(true);
  });

  it('alarms once the oldest un-deployed commit ages past the grace window', async () => {
    process.env.SOURCE_COMMIT = OLD;
    process.env.MOT_DEPLOY_DRIFT_GRACE_MINUTES = '30';
    const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    mockGithub({
      commit: () => commitResponse(HEAD, anHourAgo),
      compare: () => compareResponse('ahead', 1, anHourAgo),
    });

    const r = await checkDeployDrift();
    expect(r.within_grace).toBe(false);
    expect(r.ok).toBe(false);
  });

  // ── REGRESSION GUARD — the grace window must not be anchored on the branch head ──────────────
  // Through the 2026-09-13→18 outage, commits kept landing on main. A head-anchored grace window
  // would have seen a fresh head on every one of those nights and called a five-day-old container
  // "mid-deploy", suppressing exactly the alarm this module exists to raise. Anchor on the OLDEST
  // un-deployed commit: the moment production first fell behind.
  it('alarms on days-old drift even when the branch head is minutes old', async () => {
    process.env.SOURCE_COMMIT = OLD;
    process.env.MOT_DEPLOY_DRIFT_GRACE_MINUTES = '30';
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
    mockGithub({
      commit: () => commitResponse(HEAD, oneMinuteAgo),
      compare: () => compareResponse('ahead', 4, fiveDaysAgo),
    });

    const r = await checkDeployDrift();
    expect(r.head_committed_at).toBe(oneMinuteAgo);
    expect(r.grace_anchor).toBe(fiveDaysAgo);
    expect(r.within_grace).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('grants no grace when the oldest un-deployed commit cannot be established', async () => {
    process.env.SOURCE_COMMIT = OLD;
    mockGithub({
      commit: () => commitResponse(HEAD, new Date().toISOString()),
      compare: () => compareResponse('ahead', 2, null),
    });

    const r = await checkDeployDrift();
    expect(r.grace_anchor).toBeNull();
    expect(r.within_grace).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe('checkDeployDrift — no deployed sha', () => {
  it('skips quietly outside a deployed container, and makes no network call', async () => {
    mockGithub({});
    const r = await checkDeployDrift();
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(false);
    expect(r.drifted).toBe(false);
    expect(r.skipped_reason).toContain('SOURCE_COMMIT');
    expect(calls).toHaveLength(0);
  });

  it('treats the same missing sha as a check failure when MOT_DEPLOY_DRIFT_ENABLE=1', async () => {
    process.env.MOT_DEPLOY_DRIFT_ENABLE = '1';
    mockGithub({});
    const r = await checkDeployDrift();
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.skipped_reason).toBeNull();
    expect(r.error).toContain('SOURCE_COMMIT');
  });
});

describe('checkDeployDrift — GitHub failures', () => {
  it('returns an error (never a silent pass) when GitHub keeps failing', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ commit: () => ({ ok: false, status: 500, json: async () => ({}) }) });

    const r = await checkDeployDrift();
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.drifted).toBe(false);
    expect(r.error).toContain('500');
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    let n = 0;
    mockGithub({
      commit: () => {
        n += 1;
        if (n === 1) throw new Error('socket hang up');
        return commitResponse(HEAD, LONG_AGO);
      },
    });

    const r = await checkDeployDrift();
    expect(n).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.drifted).toBe(false);
  });

  it('does not burn retries on a 404 — that is a verdict, not weather', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    let n = 0;
    mockGithub({
      commit: () => {
        n += 1;
        return { ok: false, status: 404, json: async () => ({}) };
      },
    });

    const r = await checkDeployDrift();
    expect(n).toBe(1);
    expect(r.error).toContain('404');
  });

  it('errors rather than passing when the response carries no sha', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ commit: () => ({ ok: true, status: 200, json: async () => ({}) }) });

    const r = await checkDeployDrift();
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.error).toContain('no sha');
  });
});

describe('checkDeployDrift — configuration', () => {
  it('defaults to rheos/mot and follows COOLIFY_BRANCH', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    process.env.COOLIFY_BRANCH = 'main';
    mockGithub({ commit: () => commitResponse(HEAD, LONG_AGO) });

    const r = await checkDeployDrift();
    expect(r.repo).toBe('rheos/mot');
    expect(r.branch).toBe('main');
    expect(calls[0].url).toBe('https://api.github.com/repos/rheos/mot/commits/main');
  });

  it('honours MOT_DEPLOY_REPO / MOT_DEPLOY_BRANCH over the Coolify defaults', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    process.env.COOLIFY_BRANCH = 'main';
    process.env.MOT_DEPLOY_REPO = 'rheos/other';
    process.env.MOT_DEPLOY_BRANCH = 'release';
    mockGithub({ commit: () => commitResponse(HEAD, LONG_AGO) });

    const r = await checkDeployDrift();
    expect(r.repo).toBe('rheos/other');
    expect(r.branch).toBe('release');
    expect(calls[0].url).toBe('https://api.github.com/repos/rheos/other/commits/release');
  });

  it('sends no Authorization header unauthenticated, and one when a token is set', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ commit: () => commitResponse(HEAD, LONG_AGO) });
    await checkDeployDrift();
    expect(calls[0].headers.authorization).toBeUndefined();

    calls = [];
    process.env.MOT_GITHUB_TOKEN = 'ghp_test';
    await checkDeployDrift();
    expect(calls[0].headers.authorization).toBe('Bearer ghp_test');
  });

  it('MOT_DEPLOYED_SHA overrides SOURCE_COMMIT', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    process.env.MOT_DEPLOYED_SHA = OLD;
    mockGithub({
      commit: () => commitResponse(HEAD, LONG_AGO),
      compare: () => compareResponse('ahead', 1),
    });

    const r = await checkDeployDrift();
    expect(r.deployed_sha).toBe(OLD);
    expect(r.drifted).toBe(true);
  });

  it('is read-only: MOT_DEPLOY_DRIFT_DISABLE does not stop the pure check', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    process.env.MOT_DEPLOY_DRIFT_DISABLE = '1';
    mockGithub({ commit: () => commitResponse(HEAD, LONG_AGO) });

    const r = await checkDeployDrift();
    expect(r.checked).toBe(true);
  });
});

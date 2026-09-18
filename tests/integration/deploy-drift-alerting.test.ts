import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { setupTempDb, cleanupTempDb } from './_helpers';

// runDeployDriftCheck() against a REAL ticket DB: what the drift alarm actually files, dedups and
// closes. deploy-drift.test.ts covers what the check concludes; this file covers the paging
// contract — the property the 2026-09-18 incident turned on. Five days of drift must cost exactly
// one Telegram page, not five, and the ticket must close itself once production catches up.
//
// Two alert identities, because they are different problems:
//   deploy:drift        production is stale
//   deploy:drift-check  we can no longer tell whether production is stale

const HEAD = '81751bdfa3a2a386037356b3a9057fb10284926b';
const OLD = 'd142be6c0c0ffee0c0ffee0c0ffee0c0ffee0c0f';
const LONG_AGO = '2026-09-01T00:00:00Z';

// fileAlert pages on a new incident (#39). Mock the transport so this suite asserts ticket
// behaviour without attempting a real send.
vi.mock('../../lib/notify', () => ({
  sendTelegramNotify: vi.fn(async (_text: string) => {}),
}));

const dbPath = setupTempDb('deploy-drift-alerting');
const { runDeployDriftCheck } = await import('../../lib/deploy-drift');
const { listTickets, getTicket, patchTicket } = await import('../../lib/tickets');

function openAlerts(sourceRef: string) {
  return listTickets({
    status: ['open', 'watching', 'snoozed'],
    ministry: ['works'],
    includePrivate: true,
  }).tickets.filter((t) => t.ticket_type === 'infra-alert' && t.source_ref === sourceRef);
}

/**
 * `oldest` is the commit date of the oldest un-deployed commit — the moment production first fell
 * behind, and what the grace window is measured from. Defaults to well outside any grace window.
 */
function mockGithub(
  opts: { headSha: string; date?: string | null; aheadBy?: number; oldest?: string } | 'down',
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (opts === 'down') return { ok: false, status: 503, json: async () => ({}) };
      if (String(url).includes('/compare/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ahead',
            ahead_by: opts.aheadBy ?? 1,
            commits: [{ commit: { committer: { date: opts.oldest ?? LONG_AGO } } }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sha: opts.headSha,
          commit: { committer: { date: opts.date === undefined ? LONG_AGO : opts.date } },
        }),
      };
    }),
  );
}

/**
 * Close every open deploy:* alert, so each test starts from a known-clean slate. These tests share
 * one temp DB (setupTempDb is per FILE) and the alert source_refs are deliberately stable, so
 * without this a test would inherit whatever the previous one left open — and `createTicket`'s
 * dedup REOPENS a done ticket on a re-fire, which quietly hides an ordering dependency.
 */
function resetAlerts(): void {
  for (const ref of ['deploy:drift', 'deploy:drift-check']) {
    for (const t of openAlerts(ref)) {
      patchTicket(t.id, { status: 'done' });
    }
  }
}

/** Put production into the drifted-and-past-grace state this file keeps needing as a precondition. */
async function seedDrift(aheadBy = 2): Promise<string> {
  process.env.SOURCE_COMMIT = OLD;
  mockGithub({ headSha: HEAD, aheadBy });
  await runDeployDriftCheck();
  const tickets = openAlerts('deploy:drift');
  expect(tickets).toHaveLength(1);
  return tickets[0].id;
}

/** Put the check itself into the cannot-run state. */
async function seedCheckFailure(): Promise<string> {
  process.env.SOURCE_COMMIT = HEAD;
  mockGithub('down');
  await runDeployDriftCheck();
  const tickets = openAlerts('deploy:drift-check');
  expect(tickets).toHaveLength(1);
  return tickets[0].id;
}

const ENV_KEYS = [
  'MOT_DEPLOYED_SHA',
  'SOURCE_COMMIT',
  'COOLIFY_BRANCH',
  'MOT_DEPLOY_DRIFT_ENABLE',
  'MOT_DEPLOY_DRIFT_DISABLE',
  'MOT_DEPLOY_DRIFT_GRACE_MINUTES',
  'COOLIFY_RESOURCE_UUID',
];

let logSpy = vi.spyOn(console, 'log');
let warnSpy = vi.spyOn(console, 'warn');
let errSpy = vi.spyOn(console, 'error');

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetAlerts();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errSpy.mockRestore();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  cleanupTempDb(dbPath);
});

describe('runDeployDriftCheck — drift alerting', () => {
  it('files one critical ticket naming both shas and how far behind production is', async () => {
    process.env.SOURCE_COMMIT = OLD;
    process.env.COOLIFY_RESOURCE_UUID = 'testuuid123';
    mockGithub({ headSha: HEAD, aheadBy: 4 });

    await runDeployDriftCheck();

    const tickets = openAlerts('deploy:drift');
    expect(tickets).toHaveLength(1);
    expect(tickets[0].severity).toBe('critical');
    expect(tickets[0].ministry).toBe('works');
    expect(tickets[0].status).toBe('open');
    expect(tickets[0].body).toContain(OLD.slice(0, 12));
    expect(tickets[0].body).toContain(HEAD.slice(0, 12));
    expect(tickets[0].body).toContain('4 commits behind');
    expect(tickets[0].body).toContain('git ls-remote origin refs/heads/main');
    // The docker filter is rendered from COOLIFY_RESOURCE_UUID at runtime — no deployment
    // identifier is baked into this repo (AGENTS.md § Safety Rules).
    expect(tickets[0].body).toContain('docker ps --filter "name=testuuid123"');
    // The actionable number is when production FIRST fell behind, not when the head landed.
    expect(tickets[0].body).toContain(`Production first fell behind at ${LONG_AGO}`);
  });

  it('a second night of drift dedups onto the same ticket — one page, not two', async () => {
    await seedDrift(4);
    const before = openAlerts('deploy:drift')[0];

    await runDeployDriftCheck();

    const after = openAlerts('deploy:drift');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].event_count).toBeGreaterThan(before.event_count);
  });

  it('closes the drift ticket with a resolution comment once production catches up', async () => {
    const ticketId = await seedDrift();

    vi.unstubAllGlobals();
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ headSha: HEAD });

    const r = await runDeployDriftCheck();
    expect(r.drifted).toBe(false);

    const closed = getTicket(ticketId, true)!;
    expect(closed.status).toBe('done');
    expect(closed.comments.some((c) => c.body.includes('Resolved'))).toBe(true);
    expect(openAlerts('deploy:drift')).toHaveLength(0);
  });

  it('files nothing while production only just fell behind', async () => {
    process.env.SOURCE_COMMIT = OLD;
    process.env.MOT_DEPLOY_DRIFT_GRACE_MINUTES = '30';
    const justNow = new Date(Date.now() - 60_000).toISOString();
    mockGithub({ headSha: HEAD, date: justNow, oldest: justNow });

    const r = await runDeployDriftCheck();
    expect(r.within_grace).toBe(true);
    expect(openAlerts('deploy:drift')).toHaveLength(0);
  });
});

describe('runDeployDriftCheck — check-failure alerting', () => {
  it('files a separate high ticket when the check itself cannot run', async () => {
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub('down');

    const r = await runDeployDriftCheck();
    expect(r.error).toBeTruthy();

    const tickets = openAlerts('deploy:drift-check');
    expect(tickets).toHaveLength(1);
    expect(tickets[0].severity).toBe('high');
    expect(tickets[0].body).toContain('503');
  });

  it('leaves any open drift ticket alone while blind — a failed check is not a recovery', async () => {
    await seedDrift();

    // Go blind. The drift ticket must survive: we no longer know that it resolved.
    vi.unstubAllGlobals();
    mockGithub('down');
    await runDeployDriftCheck();

    expect(openAlerts('deploy:drift')).toHaveLength(1);
  });

  it('closes the check-failure ticket once the check runs again', async () => {
    const checkTicketId = await seedCheckFailure();

    vi.unstubAllGlobals();
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ headSha: HEAD });
    await runDeployDriftCheck();

    expect(getTicket(checkTicketId, true)!.status).toBe('done');
    expect(openAlerts('deploy:drift-check')).toHaveLength(0);
  });

  // A fault filing one alert identity must not swallow the other. They report in separate
  // try/catch blocks precisely so a hiccup on the check-health ticket cannot silence a drift page.
  it('clears BOTH identities in one pass when a recovered check also finds production in sync', async () => {
    await seedDrift();
    const checkTicketId = await seedCheckFailure();

    vi.unstubAllGlobals();
    process.env.SOURCE_COMMIT = HEAD;
    mockGithub({ headSha: HEAD });
    await runDeployDriftCheck();

    expect(getTicket(checkTicketId, true)!.status).toBe('done');
    expect(openAlerts('deploy:drift-check')).toHaveLength(0);
    expect(openAlerts('deploy:drift')).toHaveLength(0);
  });
});

describe('runDeployDriftCheck — skips and safety', () => {
  it('files nothing and calls nothing outside a deployed container', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const r = await runDeployDriftCheck();
    expect(r.skipped_reason).toContain('SOURCE_COMMIT');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openAlerts('deploy:drift')).toHaveLength(0);
    expect(openAlerts('deploy:drift-check')).toHaveLength(0);
  });

  it('MOT_DEPLOY_DRIFT_DISABLE=1 short-circuits before any network call', async () => {
    process.env.SOURCE_COMMIT = OLD;
    process.env.MOT_DEPLOY_DRIFT_DISABLE = '1';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const r = await runDeployDriftCheck();
    expect(r.skipped_reason).toBe('MOT_DEPLOY_DRIFT_DISABLE=1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openAlerts('deploy:drift')).toHaveLength(0);
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes('[MOT/deploy-drift] disabled')),
    ).toBe(true);
  });

  it('never throws, even when fetch itself blows up in an unexpected way', async () => {
    process.env.SOURCE_COMMIT = OLD;
    vi.stubGlobal('fetch', () => {
      throw new Error('TypeError: fetch is not a function');
    });

    await expect(runDeployDriftCheck()).resolves.toBeDefined();
  });
});

# Idea: Write-Path Failure Discipline for Memory Capture

Status: idea / not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/hooks/stop-hook.ts`,
`src/recall/catchup.ts`, `src/recall/available-memory.ts`.

## The principle

> Discipline: this hook MUST exit 0. Exit 2 blocks the agent from stopping (recall failure must
> never block the user's turn). Any error is logged to `~/.recall/logs/stop-hook.log` and swallowed.

A memory system sits on the side of the thing it remembers. When it fails, the correct behaviour is
to lose a memory, not to break the conversation. crispy-recall states that as a hard invariant on
its capture hook and builds three mechanisms around it.

M.O.T. already agrees in one place. `lib/conversation.ts:57` fires vec indexing after the durable
write specifically so a failed embed never fails the turn write. The principle is understood; it is
applied unevenly.

## 1. Bounded retry on transient contention, and the bug that hides inside it

SQLite can reject concurrent first-open WAL transitions without invoking its busy handler, so
crispy-recall wraps ingest in a bounded retry keyed on `/database is locked|SQLITE_BUSY/i`, capped
at three attempts with a 25ms-per-attempt backoff.

The instructive part is a bug they document in `src/db.ts`:

> SQLITE_BUSY on a marker read is TRANSIENT, not "migration pending". Misclassifying it raised
> MigrationPendingError, which the stop hook's retryBusyIngest never retries, so a contended Stop
> hook dropped the turn outright.

A transient lock was being read as a permanent schema condition. The retry wrapper existed, matched
on the wrong error, and silently dropped turns under load. Their fix is to rethrow busy explicitly
before any other error classification runs, so busy can never be mistaken for a structural failure.

M.O.T. is multi-process in the same way (Next.js server, the nightly cron, Vitest, backfill scripts,
all against one WAL file) and already sets `busy_timeout`. The lesson is not "add retries", it is
that any catch-all which converts an exception into a permanent-looking state must exclude transient
errors first.

## 2. A memory floor on the embed backfill

```
const AVAILABLE_MEM_FLOOR_MB = 1024;
```

The backfill pauses below a gigabyte of available memory rather than pushing on and getting killed.

M.O.T. has already paid for the absence of this. The maintainer's single-batch `claude -p` send was
OOM-killed (exit 143) on the 1.9GB Contabo box, and the fix was `MAINTAINER_BATCH_SIZE`, chunking
entities into groups of 25 sent sequentially. That fix bounds the size of each request. A memory
floor bounds the *conditions* under which any request runs at all, which is the complementary guard:
correct batch sizes still fail if something else on the box is using the RAM that night.

Their implementation carries a detail worth stealing verbatim. `os.freemem()` on macOS reports only
free pages and ignores reclaimable ones, so a healthy Mac looks starved and the backfill stalls
forever. They shell out to `vm_stat` and sum free plus inactive plus purgeable, cache it for a
second, and fall back to `freemem()` if the probe fails. Linux keeps the plain `freemem()` path, so
the Contabo box would use the simple version and only local dev would need the Darwin branch.

## 3. Gate a large job on a human, silently do a small one

```
const SILENT_EMBED_THRESHOLD = 200;
```

Under 200 unembedded rows, drain them without saying anything. Over, ask first, with an estimate
derived from a measured throughput constant (~0.2s per message). `--auto-embed` skips the prompt for
non-interactive runs.

This is the ambient-not-administered principle applied to an operational job rather than to memory
content. Small maintenance is invisible. Large maintenance, which will take real time and real
resources, gets one decision point. The threshold is what separates "the system takes care of
itself" from "the system surprises you with a 40-minute job".

The M.O.T. analogue is the on-demand `maintainer_run`, which has no such gate and which
`CLAUDE.local.md` now records as blocking the entire app for roughly nine minutes at current graph
size, taking `/api/status`, the ticket API, and the MCP endpoint down with it. That is exactly the
case a threshold-and-confirm is for, and it is already documented as a known cost rather than fixed.

## 4. The half M.O.T. already has, and got right the hard way

crispy-recall's failure handling stops at "log it and move on". That is where the
2026-08-13 to 2026-09-11 maintainer outage came from in M.O.T.: three weeks of nightly failures that
nobody saw, because `maintainer_status` is pull-only and nothing pushed.

The fix already shipped (`lib/maintainer-health.ts`, files a `critical` `infra-alert` ticket keyed on
`maintainer:<worker>` so repeated failures bump `event_count` instead of paging nightly, and
auto-closes on recovery). That is strictly better than crispy-recall's approach and should not be
traded away for anything here.

So the combined rule for any memory write path is both halves:

- **Never block the user.** Swallow the error, retry transient contention, pause under resource
  pressure.
- **Never be silent about it.** A swallowed error still files an alert, so "failing" and "idle" are
  distinguishable from the outside.

Neither half is sufficient. crispy-recall has the first and lost three weeks' equivalent to the
second being missing; M.O.T. lost three weeks to exactly that and fixed it.

## Possible next step

Audit the capture paths for the first half: `logTurn`, the digest close sweep, `entity_ingest`, and
the `/api/bot-log` handler. For each, answer whether a failure can propagate back into the caller
and break Rheo's reply. Any that can, wrap.

Separately, a memory floor in front of the nightly maintainer is a small, self-contained change with
a known prior incident behind it, and does not depend on anything else in this doc set.

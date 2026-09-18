# Idea: Where Alarms Land After M.O.T.

Status: analysis / decision recorded, work not scheduled. Captured 2026-09-18, from mapping the
alarm surface before M.O.T. is decommissioned in favour of rheo.stream.

## Why this needed an answer

M.O.T. is not just *a* place alarms go. It is the cluster's entire alerting infrastructure, and
other services were built without an alert path of their own because M.O.T. supplied one. The
ViralVision worker says so in its config, next to the only integration it has:

> Disk guardrail (alert-only via a CRITICAL M.O.T. ticket; MOT auto-Telegrams on critical create,
> so this is the whole alert path).

Decommissioning M.O.T. therefore removes the alerting for services that have nothing to do with
M.O.T. That is worth naming before the switch-off, not after.

## What was actually found

### 1. In-process alarms never paged

`sendTelegramNotify` had three call sites: the `POST /api/tickets` route handler, the `notify_robin`
MCP tool, and `lib/surfacing.ts`. `createTicket()` in the data layer did not notify.

So every monitor filing in-process created a critical ticket and told nobody — `maintainer-health`
from #5 onward, and the deploy-drift alarm from #35. Meanwhile ViralVision's guardrail *did* page,
purely because it goes over HTTP. External producers paged; the system's own monitors did not.

Both modules carried comments asserting a page fired. Those comments were wrong from the day they
were written, and the second one was copied from the first.

Fixed in #39 by hanging delivery off `fileAlert()` — the act of filing an alarm — rather than off
one transport that happened to reach it. **The general lesson outlives this repo: verify the
delivery path end to end. "A ticket was created" is not "a human was told."**

### 2. Two classes of alarm were conflated

M.O.T. is simultaneously the life-admin triage surface and the infra alarm sink. Those have
different audiences, different lifetimes, and different destinations.

| Class | Producers | What it needs |
| --- | --- | --- |
| **Infra self-monitoring** | maintainer workers (4), deploy-drift (2), ViralVision disk guardrail | stable dedup key, one page per incident, auto-resolve |
| **Life-admin intake** | Gmail intake, MOL leads, bills, school comms | a triage surface a person reads daily |

### 3. rheo.stream cannot take either one yet

From its architecture and build-plan documents:

- `modules/current` — "commitments, projects, tasks, deadlines, dependencies, and work state" — is
  a reserved stub, scheduled for **phase 5**. That is the replacement for the ticket surface.
- `channels` (Telegram) is **phase 6**.
- Release one is phases one to three, and nothing is deployed yet.
- There is **no alerting design in the specification at all**. Health is `rheo doctor` and
  `leads.connection.health`: both pull-only, read on demand.

That last point is the one worth carrying forward. Pull-only health is exactly what let the
maintainer workers fail every night from 2026-08-13 to 2026-09-11 with nobody noticing. A system
whose only health surface must be asked will eventually not be asked.

## The decision

**Split the two classes. Do not rebuild M.O.T.'s dual role inside rheo.stream.**

### Infra alarms → an external sink (Sentry)

Chosen 2026-09-18. The reasoning:

- Sentry's native primitives *are* the contract M.O.T. hand-rolled. Fingerprint is `source_ref`.
  Event count is `event_count`. Issue alert rules are "page once on first occurrence". Auto-resolve
  on regression is the auto-close. Building this anywhere else means reimplementing Sentry worse.
- **It sits outside everything it watches.** This is the decisive property, not convenience.
  M.O.T. monitoring itself was always slightly circular, and rheo.stream monitoring itself would
  repeat that. A sink sharing a failure domain with its subject goes quiet exactly when it matters:
  if the box dies, an on-box sink dies with it and nothing pages.
- It survives both M.O.T.'s decommission and rheo.stream's phases, so there is nothing to migrate
  again at phase 5.

This also gives rheo.stream somewhere to push to from day one, rather than waiting for an
observability story that is not currently in its plan.

### Life-admin tickets → `current`, phase 5

There is no shortcut here, and that makes it a scheduling constraint rather than a design choice:
**M.O.T. cannot be switched off before rheo.stream reaches phase 5**, or the triage surface
disappears with roughly fifty open items and no replacement.

## Open work, if this is picked up

1. A small Sentry client for the alarm path, replacing `fileAlert`'s ticket write (or sitting
   beside it while both exist).
2. Point ViralVision's disk guardrail at the same sink; it is the one external producer that
   outlives M.O.T. and it currently has no fallback.
3. Decide whether rheo.stream's module manifest `health_checks` field should push rather than only
   answer `rheo doctor`. This is the pull-only trap again, already written into the contract.

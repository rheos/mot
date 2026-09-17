# Idea: Hub/Satellite as the Recallatron SaaS Topology

Status: idea / product-level, not scheduled. Captured 2026-09-17 from
[crispy-recall](https://github.com/TheSylvester/crispy-recall) (MIT), `src/hub/`, `src/satellite/`,
`src/installer/config.ts`.

## What they built

One machine is the **hub**: it holds the database, runs the embedding model, and answers queries.
Every other machine is a **satellite**: it holds no database and no model, uploads its transcripts,
and forwards its queries to the hub.

```bash
# hub
recall install
recall hub token --host laptop
recall hub serve --bind <private-ip> --port 7877 --detach

# satellite
recall install --hub http://<private-ip>:7877 --token -
```

That is a self-hosted SaaS with the server left as an exercise. The satellite install is already the
client install for a hosted product; the only difference is who runs the hub and what the URL points
at.

## Why it maps onto Recallatron directly

The planned product model is "subscribers get a capacity allocation plus a skill file that tells
their agent how to use the API, where the MCP server is the API and the skill file is the
distribution layer." That is the satellite, described from the other end.

Several of their decisions transfer without modification:

**The split of responsibilities is correct.** The satellite does no indexing and runs no model. That
matters more for a hosted product than for their LAN case: it means a customer needs no GPU, no
90MB model download, no native SQLite binding, and no version-matched Node. Their own install
instructions are full of ABI warnings (`better_sqlite3.node` is locked to the Node it was built
for, Node 23 has no prebuilt binding, Node 20 needs Python and a compiler). A thin satellite makes
every one of those the hub's problem, which is to say Novadiem's problem, which is to say solvable
once instead of per customer.

**Per-host tokens, revocable without restart.** `recall hub token --host laptop` issues, reissuing
for the same name replaces, `--revoke` removes it live. That is the minimum credential model and
they got the lifecycle right.

**Honest scoping of what a token can do.** From their README: *"Only connect trusted users:
satellites upload raw transcripts, and every hub token can search the entire hub history."* A token
scopes uploads to its own named satellite's mirror but grants read across everything.

That last sentence is the whole multi-tenancy gap, stated by the people who shipped it. For a
personal LAN it is an acceptable simplification. For Recallatron it is the product, and the existing
plan already says so: row-level security scoped to `tenant_id` from day one. This repo is the
working demonstration of what happens if that gets deferred, which is that it stops being
retrofittable.

## What does not transfer

**Plain HTTP with no TLS.** They are explicit that it belongs on a LAN or Tailscale and that Recall
does not configure either. Non-starter hosted; every satellite link needs TLS and the token needs to
be a bearer credential over it, not a shared secret on a trusted network.

**Query text leaving the client.** In satellite mode the satellite forwards its query text and cwd
to the hub, which is unavoidable in this topology and worth stating plainly in Recallatron's privacy
copy rather than discovering later. They also note that a query's text is written to a transient
0600 file under `~/.recall/run/query-embed/` while it is being embedded and deleted after. Someone
will ask; have the answer written down.

**Full-history reads per token.** Covered above.

**No per-session deletion.** Listed as a limitation: "forgetting is database-level today." A hosted
product cannot ship that. Deletion requests are table stakes, and the design has to support "remove
this conversation" and "remove this tenant" as first-class operations, not as a database drop.

## The operational lesson underneath

Their hub has a `--detach` flag that explicitly does not survive reboot, a separate
`hub install-service` for the systemd unit, and a README note that Windows and macOS need their own
startup configuration. They also state that live platform and reboot acceptance for the prerelease
is still pending.

The point is not that they cut a corner. It is that "run a daemon on the customer's machine" has a
long tail of platform work, and the hosted topology skips all of it. That is a real argument for
hosting being the right shape for Recallatron rather than merely the monetizable one.

## What M.O.T. contributes here

M.O.T. is already the hub, minus multi-tenancy. It has the MCP endpoint, bearer auth on the same API
key as REST, the retrieval layer, the entity graph, and the nightly workers. The remaining work to
become a real hub is `tenant_id` on every table, row-level security, per-tenant token issuance and
revocation, and capacity accounting.

The sequencing implication is worth noting: those are Postgres-shaped problems, and the plan already
calls for Postgres rather than SQLite for the SaaS version. Any hub work done against the current
SQLite prototype is throwaway. Better to treat M.O.T. as the reference implementation of the
*retrieval and memory semantics* and build the hub fresh on the intended stack.

## Possible next step

Nothing to build in M.O.T. When Recallatron's server work starts, lift the client-side contract:
`install --hub <url> --token`, per-host named tokens, revocation without restart, and a `doctor`
command that proves the connection end to end before the user files a support ticket about it.

The `doctor` command is underrated. Theirs runs read-only install and database checks and is
referenced in every error message in the codebase. A hosted product with a thin client needs one
even more, because the failure could be on either side of the link.

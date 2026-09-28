# Memory-only disable switch

`MOT_MEMORY_DISABLE=1` disables M.O.T.'s memory subsystem while keeping the
operations desk running. Only the exact value `1` activates it. An absent value
or `0` preserves normal behavior. Deploying this code does **not** activate it.

When active:

- Authenticated conversation, digest, memory, entity, relation, procedural, topic
  summary, and legacy bot-log API requests return `503 {"error":"memory_disabled"}`
  before parsing memory input or reading memory stores. Unauthenticated requests
  retain the existing `401` behavior.
- The three memory browser pages show an unavailable message without reading data.
- MCP discovery retains only ticket list/get/create/update, service status,
  ministry configuration, notifications, and deploy-drift checks. Cached memory
  tool names are refused with `isError: true`; their arguments are not persisted
  in the tool-call log. Newly added tools are unavailable until explicitly
  classified as non-memory.
- Nightly memory compaction, resolution, deduplication, auto-confirmation,
  profile synthesis, daytime surfacing, and embedding warm-up are skipped.
- Direct memory mutation helpers and the extraction/embedding/relation backfill
  and entity-cleanup commands refuse execution, including dry runs.
- Tickets, authentication, service health, non-memory notifications, deploy-drift
  checks, database backups, and graph backups continue. Existing memory rows,
  graph records, profile files, and vectors are not deleted or rewritten.

This switch is **not** an emergency cancellation mechanism, a read-only database,
or a replacement for stopping external writers. Ticket activity still changes the
shared database and ticket-tool activity still writes its normal operational log.
Normal schema migrations and authentication bootstrap still run at startup.
Private backups continue to contain the old memory and any credential material;
protect them accordingly. Read-only library helpers remain available for local
backup/inspection code; public memory entry points do not.

## Activation boundary

1. Obtain separate approval for the live activation/cutover and arrange external
   producers to stop retrying or writing to the old memory store. Calls are refused,
   not forwarded or queued for the replacement system.
2. Stop the entire M.O.T. process and all separate memory/backfill processes. Wait
   for requests, model work, workers, and pending vector writes to finish or for
   their processes to terminate. Verify no old process is left running.
3. Take and verify the final protected snapshot while the source is quiet. A code
   change or successful test is not proof of this live quiet checkpoint.
4. Set `MOT_MEMORY_DISABLE=1` in the runtime environment used by **every** M.O.T.
   instance and maintenance command, then restart M.O.T. with the switch active.
   Do not keep an older instance or a separate writer running alongside it.
5. Verify an authenticated memory read and write return the fixed `503`, MCP
   discovery contains only the eight non-memory tools, a cached memory call is
   refused, and ticket create/update and service health still work. Check that
   source memory/graph state stays unchanged (excluding ordinary ticket data,
   schema/auth metadata, and backup files).

Changing an environment file does not update an already-running process. Guards
read the process environment at call time, but they cannot recall work already
started or cancel external side effects. Always use the stop/drain/restart
boundary above; do not claim a hot toggle establishes a consistent snapshot.

## Reversal

Removing the variable or setting it to `0`, followed by another full restart,
restores the old memory paths. After a cutover, do this only as part of an approved
rollback that accounts for writes already accepted by the replacement system;
otherwise it can restart two competing memory writers. No automatic rollback or
data transfer is performed by this switch.

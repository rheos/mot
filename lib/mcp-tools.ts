import { listTickets, getTicket, createTicket, patchTicket, type ListOpts } from './tickets';
import { buildStatus } from './status';
import { createTicketSchema, patchTicketSchema, writeMemorySchema } from './validation';
import { logTurn, getRecentTurns, searchTurns } from './conversation';
import type { RetrievalStats } from './rrf';
import { structuralDigest } from './digest';
import { writeMemory, getActiveMemory, searchActiveMemory, searchActiveMemoryVector, searchActiveMemoryHybrid } from './memory';
import { listThreads, getThread, createThread, linkThreadSession, summarizeThread } from './topics';
import { getEntity, searchEntities, relatedEntities, confirmEntity, appendSupersede, appendRelate, confirmRelate, rejectRelate, isRelType, appendEntity, REL_VOCABULARY, type EntityRecord } from './graph';
import { listNotes, confirmNote } from './procedural';
import { memoryContext } from './memory-context';
import { compactGraph, graphEntitySources } from './graph-compact';
import { passesConfidence, normalizeEntityType, scanForDuplicates } from './extraction';
import { nowIso } from './time';
import { readStatus, resolutionWorker, dedupWorker, autoconfirmWorker } from './maintainer';
import { memoryProfile, profileWorker } from './profile';
import { sendTelegramNotify } from './notify';
import { runSurfacing } from './surfacing';
import { checkDeployDrift } from './deploy-drift';
import { MINISTRY_ADAPTERS } from '../config/ministry-adapters';
import type { Ministry, Status, Severity } from './enums';
import path from 'node:path';

// ── MCP tool definitions + dispatch (Streamable HTTP transport, 2024-11-05) ───

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolContent = Array<{ type: 'text'; text: string }>;

function text(data: unknown): ToolContent {
  return [{ type: 'text', text: JSON.stringify(data, null, 2) }];
}

const MINISTRY_ENUM = [
  'works', 'commerce', 'plenty', 'peace',
  'education', 'flow', 'interior', 'foreign_affairs',
];
const STATUS_ENUM = ['open', 'watching', 'snoozed', 'done'];
const SEVERITY_ENUM = ['critical', 'high', 'normal', 'low'];
const PROVENANCE_ENUM = [
  'sentry-alert', 'stripe-webhook', 'gmail-parse',
  'status-poll', 'manual', 'heartbeat',
];

export function listMcpTools(): ToolDef[] {
  return [
    {
      name: 'mot_list_tickets',
      description:
        'List and filter tickets from the MOT triage queue. Defaults to open tickets, sorted by severity then recency.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'array',
            items: { type: 'string', enum: STATUS_ENUM },
            description: 'Filter by status. Defaults to [open].',
          },
          ministry: {
            type: 'array',
            items: { type: 'string', enum: MINISTRY_ENUM },
            description:
              'Filter by ministry. education=learning/school, commerce=customers/income, ' +
              'plenty=bills/renewals, flow=dev/deploys, works=tasks, peace=health/personal, ' +
              'interior=legal/admin, foreign_affairs=community.',
          },
          severity: {
            type: 'array',
            items: { type: 'string', enum: SEVERITY_ENUM },
          },
          needs_review: { type: 'boolean' },
          wake_pending: {
            type: 'boolean',
            description: 'Return snoozed tickets past their wake time.',
          },
          q: {
            type: 'string',
            description: 'Full-text search over title, body, and comments.',
          },
          page: { type: 'integer', minimum: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
    {
      name: 'mot_get_ticket',
      description: 'Get a single ticket by ID, including its full comment history.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket CUID2 id.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'mot_create_ticket',
      description:
        'Create a ticket or absorb a duplicate signal. Set source_ref to enable dedup ' +
        '(dedup_key = source_ref:ticket_type). Existing open/watching/done tickets with the ' +
        'same dedup_key are updated/reopened/grouped instead of duplicated.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          ministry: {
            type: 'string',
            enum: MINISTRY_ENUM,
            description:
              'Life domain. education=learning/school, commerce=customers/income, ' +
              'plenty=bills/renewals, flow=dev/deploys, works=tasks, peace=health/personal, ' +
              'interior=legal/admin, foreign_affairs=community.',
          },
          severity: { type: 'string', enum: SEVERITY_ENUM },
          ticket_type: {
            type: 'string',
            description:
              'Colon-free classification label, e.g. school-notice, support-email, payment-failed.',
          },
          provenance: { type: 'string', enum: PROVENANCE_ENUM },
          body: { type: 'string', description: 'Full signal content or summary.' },
          source_ref: {
            type: 'string',
            description:
              'The Gmail thread ID — all messages in a conversation share one ticket ' +
              '(`dedup_key = thread_id:ticket_type`).',
          },
          bridge_source_refs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The message ids observed in this Gmail thread — used by the one-time pre-fix ' +
              'compatibility bridge to find a pre-fix message-keyed ticket when the primary ' +
              'thread-id lookup misses. Omit for heartbeat, manual, and post-migration thread creates.',
          },
          needs_review: { type: 'boolean' },
          private: { type: 'boolean' },
          classification_audit: {
            type: 'object',
            description: 'Include when an AI model classified this signal.',
            properties: {
              signal_fingerprint: { type: 'string' },
              model_version: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              prompt_hash: {
                type: 'string',
                description:
                  "SHA-256 hex of the CLASSIFIER-PROMPT region in the skill file. REQUIRED when " +
                  "provenance is 'gmail-parse' — the API will reject a gmail-parse create that " +
                  "omits this field or passes it as null. Optional for heartbeat and manual " +
                  "creates (the Zod schema keeps it optional at the type level, but the gmail-parse " +
                  "refine enforces it at runtime).",
              },
            },
            required: ['signal_fingerprint', 'model_version', 'confidence'],
          },
        },
        required: ['title', 'ministry', 'severity', 'ticket_type', 'provenance', 'body'],
      },
    },
    {
      name: 'mot_update_ticket',
      description:
        'Update a ticket: change status, severity, ministry, snooze, add a comment, or link tickets. ' +
        'Legal transitions: open→watching/snoozed/done, watching→snoozed/done, snoozed→open/done, done→open.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Ticket ID.' },
          status: { type: 'string', enum: STATUS_ENUM },
          severity: { type: 'string', enum: SEVERITY_ENUM },
          ministry: { type: 'string', enum: MINISTRY_ENUM },
          title: { type: 'string' },
          body: { type: 'string' },
          snoozed_until: {
            type: 'string',
            description: 'ISO 8601 datetime, required when status=snoozed. Must be in the future.',
          },
          needs_review: { type: 'boolean' },
          blocked_note: { type: 'string' },
          linked_ticket_id: {
            type: 'string',
            description: 'Link to another ticket — auto-closes linked ticket when this one is done.',
          },
          add_comment: {
            type: 'object',
            properties: {
              author: { type: 'string', enum: ['robin', 'tuttle'] },
              body: { type: 'string' },
            },
            required: ['author', 'body'],
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'mot_get_status',
      description:
        'Health check and queue snapshot: DB status, last classifier run timestamp, ' +
        'and ticket counts by status and ministry.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'mot_get_ministry_config',
      description:
        'Return the validated Ministry Source Adapter config. Each entry carries the ' +
        'sourceId, ministry, channel, cadence, classifierInput mode, ticketTypes, and ' +
        '(where set) expectedFrequency baseline. Use this to read per-adapter constraints ' +
        'before classifying or filing a signal.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'chat_log_turn',
      description:
        'Append a turn to the Rheo conversation ledger. Call once for the user message ' +
        'and once for the Rheo reply at the end of each exchange.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Telegram chat ID.' },
          role:    { type: 'string', enum: ['user', 'rheo'] },
          content: { type: 'string', description: 'Full message text.' },
        },
        required: ['chat_id', 'role', 'content'],
      },
    },
    {
      name: 'chat_recent',
      description:
        'Return the most recent turns for a chat, in chronological order. ' +
        'Use for booting context or reviewing what was just discussed.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          n:       { type: 'integer', minimum: 1, maximum: 50, description: 'Number of turns. Default 12.' },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'chat_search',
      description:
        'Full-text or semantic search over Rheo conversation history. mode defaults to fts. ' +
        'Pass mode:vector or mode:hybrid for semantic or combined retrieval. ' +
        'Returns { retrieval, results }: read `retrieval` before trusting `results` — it says ' +
        'which arms ran and whether the semantic side was available. ' +
        'These are TRANSCRIPTS: they record what was believed at the time, not what is true now. ' +
        'Verify anything load-bearing (a deadline, a decision, a config value) against the ' +
        'current ticket, entity or system state before repeating it as fact.',
      inputSchema: {
        type: 'object',
        properties: {
          q:       { type: 'string', description: 'Search query (FTS5 porter-stemmed).' },
          chat_id: { type: 'string', description: 'Restrict to one chat. Omit to search all.' },
          limit:   { type: 'integer', minimum: 1, maximum: 50 },
          mode: {
            type: 'string',
            enum: ['fts', 'vector', 'hybrid'],
            description: 'Search mode. fts (default): keyword/FTS5 — exact terms, returns nothing if the words are absent. vector: semantic KNN — finds meaning without shared words, but ALWAYS returns its nearest rows, so judge relevance yourself rather than assuming a result is an answer. hybrid: RRF merge of both; degrades to the fts list if the semantic side is unavailable.',
          },
        },
        required: ['q'],
      },
    },
    {
      name: 'summarize_and_archive',
      description:
        'Produce a structural (non-LLM) digest for a session and persist it. ' +
        'Returns the session_digest row, or { error } on zero-turn session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID to summarize.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'write_memory',
      description:
        'Write a durable fact, preference, deadline, or person record to memory. ' +
        'Call at the END of your reply, after answering the user. ' +
        'chat_id is NOT an input — it is derived server-side from source_turn_id.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['fact', 'preference', 'deadline', 'person'] },
          content: {
            type: 'object',
            properties: {
              label:      { type: 'string', description: 'Short, specific label for this fact.' },
              properties: { type: 'object', description: 'Key-value pairs with the fact details.' },
            },
            required: ['label', 'properties'],
          },
          source_turn_id:    { type: 'integer', description: 'ID of the conversation turn where this was stated.' },
          source_session_id: { type: 'string',  description: 'Session ID of that turn.' },
          confidence:        { type: 'number', minimum: 0, maximum: 1 },
          reason:            { type: 'string', description: 'Why this is worth remembering.' },
        },
        required: ['type', 'content', 'source_turn_id', 'source_session_id', 'confidence', 'reason'],
      },
    },
    {
      name: 'memory_recent',
      description:
        'Return active (non-superseded, non-conflicted) memory items, most recent first. ' +
        'Pass q to keyword-search them by FTS5 relevance instead. ' +
        'Pass mode:vector or mode:hybrid for semantic retrieval of memory. ' +
        'Returns { retrieval, results }; read `retrieval` before trusting `results`. ' +
        'A memory is a claim recorded at a point in time. It is corrected by supersession, not ' +
        'by deletion, so an active item can still be out of date — prefer the most recent, and ' +
        'check against live state when it matters. ' +
        'Entity-graph / topic-thread / procedural-note search are separate Track-2 tools.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Restrict to one chat. Omit to return all active items.' },
          limit:   { type: 'integer', minimum: 1, maximum: 50, description: 'Max items to return. Default 20.' },
          q:       { type: 'string', description: 'Optional keyword search (FTS5 porter-stemmed). When provided, filters results by match. Empty string ignored.' },
          mode: {
            type: 'string',
            enum: ['fts', 'vector', 'hybrid'],
            description: 'Search mode. fts (default): keyword/FTS5 — exact terms, returns nothing if the words are absent. vector: semantic KNN — finds meaning without shared words, but ALWAYS returns its nearest rows, so judge relevance yourself rather than assuming a result is an answer. hybrid: RRF merge of both; degrades to the fts list if the semantic side is unavailable.',
          },
        },
      },
    },
    {
      name: 'topic_threads',
      description:
        "List topic threads, or get one thread's sessions when label is given.",
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Canonical slug. Omit to list all threads.' },
        },
      },
    },
    {
      name: 'topic_thread_create',
      description: 'Create a new topic thread.',
      inputSchema: {
        type: 'object',
        properties: {
          slug:  { type: 'string', description: 'Kebab-case canonical label, e.g. alex-school.' },
          title: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['slug', 'title'],
      },
    },
    {
      name: 'topic_thread_link',
      description: 'Link a session to a topic thread. Idempotent.',
      inputSchema: {
        type: 'object',
        properties: {
          slug:       { type: 'string' },
          session_id: { type: 'string' },
        },
        required: ['slug', 'session_id'],
      },
    },
    {
      name: 'entity_get',
      description:
        'Get a single entity record plus its 1-hop relations. Discovery tool — returns ' +
        'superseded/expired entities too, by design (use entity_search for active-only).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'entity_search',
      description: 'Search entities by keyword. Returns active records only by default. Returns { retrieval, results }; read `retrieval` before trusting `results`. Entities are extracted candidates: most are unconfirmed, and `confirmed` marks review status, not correctness. Use entity_related to follow an entity outward rather than re-searching for each neighbour.',
      inputSchema: {
        type: 'object',
        properties: {
          q:    { type: 'string', description: 'Case-insensitive keyword.' },
          type: { type: 'string', enum: ['Person', 'Project', 'Deadline', 'Preference', 'Fact'] },
          unconfirmed_only: { type: 'boolean', description: 'Return unconfirmed candidates only.' },
          mode: {
            type: 'string',
            enum: ['fts', 'vector', 'hybrid'],
            description: 'Search mode. fts (default): keyword/FTS5 — exact terms, returns nothing if the words are absent. vector: semantic KNN — finds meaning without shared words, but ALWAYS returns its nearest rows, so judge relevance yourself rather than assuming a result is an answer. hybrid: RRF merge of both; degrades to the fts list if the semantic side is unavailable.',
          },
        },
        required: ['q'],
      },
    },
    {
      name: 'entity_related',
      description:
        'Traverse entity relations from a starting entity. A REACHED node may itself be ' +
        'superseded/expired (surfaced by design); but a merged-away node\'s own outbound ' +
        'edges do not contribute — after a dedup merge they are re-pointed to the survivor.',
      inputSchema: {
        type: 'object',
        properties: {
          id:   { type: 'string' },
          rel:  { type: 'string', description: 'Relation type filter, e.g. child_of.' },
          hops: { type: 'integer', minimum: 1, maximum: 3, description: 'Degrees of separation. Default 1.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'entity_confirm',
      description: 'Confirm an entity candidate, marking it as verified. Returns the updated EntityRecord. Returns { error: "not_found" } if the entity does not exist or is superseded. Returns { error: "already_confirmed" } if it is already confirmed.',
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'string', description: 'Entity id to confirm.' } },
        required: ['id'],
      },
    },
    {
      name: 'entity_supersede',
      description: 'Mark entity `id` as superseded by `superseded_by_id`. Returns { ok: true, id, superseded_by_id }. Returns typed errors for unknown ids or self-supersede.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Entity id to supersede (the one being replaced).' },
          superseded_by_id: { type: 'string', description: 'Entity id that replaces it.' },
        },
        required: ['id', 'superseded_by_id'],
      },
    },
    {
      name: 'entity_ingest',
      description:
        'Write a durable-fact entity candidate from an email or external source. ' +
        'Enforces the same confidence/type/dedup gates as the digest extraction. ' +
        'Idempotent on `source` — a repeated call with the same source returns { skipped: true }. ' +
        'Always writes confirmed:false. Returns the EntityRecord on success, or a typed { error } object.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          type:       { type: 'string', description: 'Entity type (Person, Project, Deadline, Preference, Fact). Case-insensitive — normalized internally.' },
          label:      { type: 'string', description: 'Subject the entity names.' },
          properties: { type: 'object', description: 'Free key-value. Include properties.date (YYYY-MM-DD) for Deadlines.' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Must be >= 0.85 to pass the gate.' },
          source:     { type: 'string', description: 'Provenance string, e.g. "gmail:<msg_id>". Drives idempotency — repeated calls with the same source are skipped.' },
          reason:     { type: 'string', description: 'Optional human-readable provenance note, stored on properties for auditability.' },
        },
        required: ['type', 'label', 'confidence', 'source'],
      },
    },
    {
      name: 'entity_relate',
      description:
        'Assert a directed relation between two entities. `rel` must be one of the 10 ' +
        'closed-vocabulary verbs (' + REL_VOCABULARY.join(', ') + '). Manual assertions are ' +
        'confirmed:true by default. Returns the appended RelatePatch or a typed error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', description: 'Subject entity id.' },
          rel: { type: 'string', description: 'Relation verb (closed vocabulary).' },
          to: { type: 'string', description: 'Object entity id.' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Defaults to 1.0.' },
        },
        required: ['from', 'rel', 'to'],
      },
    },
    {
      name: 'entity_relate_confirm',
      description:
        'Confirm an unconfirmed candidate edge, marking it trusted for BFS traversal. ' +
        'Returns the now-confirmed RelatePatch or a typed error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string' },
          rel: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'rel', 'to'],
      },
    },
    {
      name: 'entity_relate_reject',
      description:
        'Reject (expire) a candidate edge. A rejected edge is excluded from BFS traversal. ' +
        'Returns the now-expired RelatePatch or a typed error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string' },
          rel: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'rel', 'to'],
      },
    },
    {
      name: 'procedural_notes_list',
      description: 'List procedural notes. Default: confirmed active notes grouped by category.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          pending:  { type: 'boolean', description: 'Return unconfirmed candidates instead.' },
        },
      },
    },
    {
      name: 'procedural_note_confirm',
      description: 'Confirm a procedural note candidate.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
        },
        required: ['id'],
      },
    },
    {
      name: 'notify_robin',
      description: 'Send a text message to the configured Telegram chat. Truncates to 4096 chars. ' +
        'Retries up to 3 times on network error or non-2xx. Returns ok or an error string.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to deliver.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'memory_context',
      description:
        'One-call session boot bundle. Returns the four Recallatron stores: recent topics, ' +
        'active entities, confirmed procedural notes, and recent memory items. When q is ' +
        'provided, each section is relevance-filtered. When absent, returns recency-ordered items.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Optional keyword filter applied to all four sections.' },
          chat_id: { type: 'string', description: 'Scope recent_memory to this chat.' },
          limit: { type: 'integer', description: 'Override per-section default limits uniformly.' },
        },
      },
    },
    {
      name: 'memory_profile',
      description:
        'Return the configured standing profile as markdown: pinned core plus the latest generated ' +
        'current-context layer. section defaults to "full".',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['full', 'core', 'synth'],
            description: 'Which profile layer to return. Default: full.',
          },
        },
      },
    },
    {
      name: 'graph_compact',
      description:
        'Admin tool: compact graph.jsonl by folding all patches and dropping superseded/pruned ' +
        'entities. Atomically replaces the live file. Only needed when the file is large; the ' +
        'nightly job handles routine compaction automatically.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'topic_thread_summarize',
      description:
        'Fetch and budget a topic thread for cross-session synthesis. Returns the thread\'s ' +
        'linked sessions (most recent N, truncated to 50 sessions or ~40k chars of combined ' +
        'summaries). Rheo synthesizes the returned sessions — mot is model-free. Returns ' +
        '{ error: "thread_not_found" } when the slug is unknown.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The topic thread slug.' },
        },
        required: ['slug'],
      },
    },
    {
      name: 'maintainer_status',
      description:
        'Return the last-run summary for the Maintainer workers (resolution + dedup + autoconfirm ' +
        '+ profile). Returns a zero-state object (null timestamps) if no pass has run yet.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'deploy_drift_check',
      description:
        'Compare the commit this container was built from (Coolify\'s SOURCE_COMMIT, which is also ' +
        'the running image tag) against the current HEAD of the deploy branch on GitHub. Read-only: ' +
        'files no ticket and closes none, so it is safe to poll — the nightly 02:00 cron is what ' +
        'raises the alarm. Returns { drifted, deployed_sha, head_sha, behind_by, within_grace, ' +
        'error, skipped_reason }. skipped_reason is set (and drifted false) outside a deployed ' +
        'container, e.g. local dev. Runs regardless of MOT_DEPLOY_DRIFT_DISABLE.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'maintainer_run',
      description:
        'Trigger the Maintainer worker(s) on demand and return the run summary. worker defaults ' +
        'to "all". dry_run:true runs the LLM identification step but writes nothing (no graph ' +
        'mutation, no backup, no status file update).',
      inputSchema: {
        type: 'object',
        properties: {
          worker: {
            type: 'string',
            enum: ['resolution', 'dedup', 'autoconfirm', 'profile', 'all'],
            description: 'Which worker to run. Default: all.',
          },
          dry_run: {
            type: 'boolean',
            description: 'Run LLM step but write nothing and take no backup. Default: false.',
          },
        },
      },
    },
    {
      name: 'profile_synthesize',
      description:
        'Trigger only the generated profile-layer worker now. dry_run:true runs synthesis and ' +
        'returns a preview without writing profile files or status.',
      inputSchema: {
        type: 'object',
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'Run synthesis but write nothing. Default: false.',
          },
        },
      },
    },
    {
      name: 'surfacing_preview',
      description:
        'Dry-run preview of the proactive surfacing scan. Returns the list of Deadline entities ' +
        'that WOULD be surfaced by the next scheduled scan, annotated with "new" vs "already_surfaced". ' +
        'Sends nothing, writes nothing. Available regardless of whether SURFACING_ENABLE is set.',
      inputSchema: {
        type: 'object',
        properties: {
          horizon_days: {
            type: 'integer',
            description:
              'Override the outer-bucket upper edge for this preview only (default 7). ' +
              'Must be a positive integer.',
          },
        },
      },
    },
  ];
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolContent> {
  // Pre-switch arg-shape guard for typed Track-2/3 tools (FR-14).
  // The three Zod-validated tools (mot_create_ticket, mot_update_ticket, write_memory)
  // validate inside their own cases and are deliberately absent from this table.
  const ARG_SPECS: Record<string, { name: string; type: 'string' | 'integer' }[]> = {
    topic_thread_create:     [{ name: 'slug', type: 'string' }, { name: 'title', type: 'string' }],
    topic_thread_link:       [{ name: 'slug', type: 'string' }, { name: 'session_id', type: 'string' }],
    topic_thread_summarize:  [{ name: 'slug', type: 'string' }],
    entity_get:              [{ name: 'id', type: 'string' }],
    entity_search:           [{ name: 'q', type: 'string' }],
    entity_related:          [{ name: 'id', type: 'string' }],
    procedural_note_confirm: [{ name: 'id', type: 'integer' }],
    entity_confirm:          [{ name: 'id', type: 'string' }],
    entity_supersede:        [{ name: 'id', type: 'string' }, { name: 'superseded_by_id', type: 'string' }],
    entity_ingest:           [{ name: 'type', type: 'string' }, { name: 'label', type: 'string' }],
    entity_relate:           [{ name: 'from', type: 'string' }, { name: 'rel', type: 'string' }, { name: 'to', type: 'string' }],
    entity_relate_confirm:   [{ name: 'from', type: 'string' }, { name: 'rel', type: 'string' }, { name: 'to', type: 'string' }],
    entity_relate_reject:    [{ name: 'from', type: 'string' }, { name: 'rel', type: 'string' }, { name: 'to', type: 'string' }],
  };
  const specs = ARG_SPECS[name];
  if (specs) {
    for (const spec of specs) {
      const v = args[spec.name];
      const ok =
        spec.type === 'string'
          ? typeof v === 'string' && v !== ''
          : typeof v === 'number' && Number.isInteger(v);  // 'integer' check (EC-8)
      if (!ok) return text({ error: 'invalid_arg', arg: spec.name });
    }
  }

  switch (name) {
    case 'mot_list_tickets': {
      const opts: ListOpts = { includePrivate: true };
      if (Array.isArray(args.status)) opts.status = args.status as Status[];
      if (Array.isArray(args.ministry)) opts.ministry = args.ministry as Ministry[];
      if (Array.isArray(args.severity)) opts.severity = args.severity as Severity[];
      if (typeof args.needs_review === 'boolean') opts.needs_review = args.needs_review;
      if (args.wake_pending === true) opts.wake_pending = true;
      if (typeof args.q === 'string') opts.q = args.q;
      if (typeof args.page === 'number') opts.page = args.page;
      if (typeof args.per_page === 'number') opts.per_page = args.per_page;
      return text(listTickets(opts));
    }

    case 'mot_get_ticket': {
      const ticket = getTicket(args.id as string, true);
      if (!ticket) throw new Error(`Ticket not found: ${args.id as string}`);
      return text(ticket);
    }

    case 'mot_create_ticket': {
      const parsed = createTicketSchema.safeParse(args);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      return text(createTicket(parsed.data));
    }

    case 'mot_update_ticket': {
      const { id, ...patch } = args;
      const parsed = patchTicketSchema.safeParse(patch);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      return text({ id, ticket: patchTicket(id as string, parsed.data) });
    }

    case 'mot_get_status':
      return text(buildStatus());

    case 'mot_get_ministry_config':
      return text(MINISTRY_ADAPTERS);

    case 'chat_log_turn':
      return text(logTurn(
        args.chat_id as string,
        args.role as 'user' | 'rheo',
        args.content as string,
      ));

    case 'chat_recent':
      return text(getRecentTurns(args.chat_id as string, (args.n as number) ?? 12));

    case 'chat_search': {
      const mode = args.mode as 'fts' | 'vector' | 'hybrid' | undefined;
      const q = args.q as string;
      const chatId = args.chat_id as string | undefined;
      const limit = (args.limit as number) ?? 20;
      // Caller-owned so concurrent requests cannot read each other's stats. The arms populate it;
      // nothing here infers availability from a pre-flight check.
      const retrieval: RetrievalStats = { mode: mode ?? 'fts' };
      const results =
        mode === 'vector' || mode === 'hybrid'
          ? // W5: MUST await — the overload returns Promise<Turn[]>.
            await searchTurns(q, chatId, limit, mode, retrieval)
          : searchTurns(q, chatId, limit, undefined, retrieval); // sync overload
      // { retrieval, results } rather than a bare array: the consumer is a model deciding how far
      // to trust what it got, and a degraded hybrid answer is indistinguishable from a healthy one
      // without this. See lib/rrf.ts RetrievalStats.
      return text({ retrieval, results });
    }

    case 'summarize_and_archive': {
      const result = structuralDigest(args.session_id as string);
      return text(result);
    }

    case 'write_memory': {
      const parsed = writeMemorySchema.safeParse(args);
      if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      const result = writeMemory(parsed.data);
      const label = parsed.data.content.label;
      const status = 'conflict' in result ? 'conflict' : 'ok';
      // eslint-disable-next-line no-console
      console.log(`[MOT/memory] write: ${parsed.data.type} "${label}" conf=${parsed.data.confidence} status=${status}`);
      return text(result);
    }

    case 'memory_recent': {
      const chatId = typeof args.chat_id === 'string' ? args.chat_id : undefined;
      const limit  = typeof args.limit === 'number' ? args.limit : 20;
      const q = typeof args.q === 'string' ? args.q : '';
      const mode = args.mode as 'fts' | 'vector' | 'hybrid' | undefined;
      if (mode === 'vector') {
        return text(await searchActiveMemoryVector(q, chatId, limit));
      }
      if (mode === 'hybrid') {
        return text(await searchActiveMemoryHybrid(q, chatId, limit));
      }
      // Default fts behavior — unchanged.
      // A non-empty q switches to FTS keyword search; otherwise return recent active items.
      if (q.trim() !== '') {
        return text(searchActiveMemory(q, chatId, limit));
      }
      return text(getActiveMemory(chatId, limit));
    }

    // ── Track-2 tools (AC-12): these dispatch cases NEVER throw. The lib functions return
    //    typed { error } objects on failure; we return text() of them as a SUCCESSFUL MCP
    //    result (isError:false at the route level), so the caller gets structured JSON to
    //    branch on — not a plain string inside an isError:true envelope (the Track-1 pattern
    //    at app/api/mcp/route.ts lines 71–85, which the throwing cases above rely on).

    case 'topic_threads': {
      const label = typeof args.label === 'string' && args.label !== '' ? args.label : undefined;
      // getThread returns a typed { error: 'thread_not_found' } on a miss — return text() of it.
      return text(label !== undefined ? getThread(label) : listThreads());
    }

    case 'topic_thread_create':
      // createThread returns a typed { error } on invalid_slug / slug_exists — return text() of it.
      return text(createThread(
        args.slug as string,
        args.title as string,
        typeof args.notes === 'string' ? args.notes : undefined,
      ));

    case 'topic_thread_link':
      // linkThreadSession returns a typed { error } on thread_not_found / session_not_found.
      return text(linkThreadSession(args.slug as string, args.session_id as string));

    case 'entity_get': {
      // NOTE: getEntity returns superseded/expired entities too — intentional (discovery tool).
      const result = getEntity(args.id as string);
      if (result === null) return text({ error: 'entity_not_found', id: args.id });
      return text(result);
    }

    case 'entity_search': {
      const mode = args.mode as 'fts' | 'vector' | 'hybrid' | undefined;
      const q = args.q as string;
      const entityType = args.type as EntityRecord['type'] | undefined;
      const unconfirmedOnly = typeof args.unconfirmed_only === 'boolean' ? args.unconfirmed_only : undefined;
      if (mode === 'vector' || mode === 'hybrid') {
        // W5: MUST await — the 4-arg overload returns Promise<EntityRecord[]>.
        return text(await searchEntities(q, entityType, unconfirmedOnly, mode));
      }
      return text(searchEntities(q, entityType, unconfirmedOnly)); // sync overload
    }

    case 'entity_related':
      // NOTE: a REACHED node may itself be superseded/expired — intentional (discovery tool).
      // But a superseded node's OWN outbound edges no longer contribute (Track 9 attachRelations
      // skips `from.superseded_by !== null`): after a dedup merge those edges are re-pointed to the
      // survivor, so counting them off the dead node too would double-count the relation.
      return text(relatedEntities(
        args.id as string,
        typeof args.rel === 'string' ? args.rel : undefined,
        typeof args.hops === 'number' ? args.hops : 1,
      ));

    case 'entity_confirm':
      // Shared pre-checks + append live in confirmEntity (lib/graph.ts), also used by
      // POST /api/memory/entities/confirm (the browser Confirm button). Never throws (AC-12):
      // not_found (missing OR superseded) / already_confirmed; else the updated record.
      return text(confirmEntity(args.id as string));

    case 'entity_supersede': {
      // AC-12: raw patch appender, not a chain resolver — if the target is itself superseded,
      // proceed anyway (EC-2). OQ-4 (decided NO auto-confirm): do NOT confirm superseded_by_id.
      // Never throws.
      const id = args.id as string;
      const supersededById = args.superseded_by_id as string;
      if (id === supersededById) return text({ error: 'self_supersede' });
      if (getEntity(id) === null) return text({ error: 'not_found', id });
      if (getEntity(supersededById) === null) return text({ error: 'target_not_found', superseded_by_id: supersededById });
      appendSupersede(id, supersededById);
      return text({ ok: true, id, superseded_by_id: supersededById });
    }

    // ── Track-8 durable-fact ingestion (AC-12): never throws — typed { error | skipped } on
    //    every sad path. Enforces the SAME gates as the digest extraction pass (shared helpers
    //    from lib/extraction), so a gmail-sourced fact is admitted on identical terms.
    case 'entity_ingest': {
      // Step 1 already handled by ARG_SPECS: type + label are guaranteed non-empty strings here.

      // Step 2 — normalize type BEFORE the idempotency check (reject a bad type without a file read).
      const normType = normalizeEntityType(args.type);
      if (normType === null) return text({ error: 'unknown_entity_type' });

      // Step 3 — confidence gate (EC-5 boundary: >= 0.85 passes).
      const confidence = args.confidence as number;
      if (!passesConfidence(confidence)) return text({ error: 'confidence_below_threshold' });

      // Step 4 — idempotency check: resolve graphPath, then check `source`.
      // CRITICAL: use this EXACT expression (mirrors the graph_compact case) so the idempotency
      // READ and the appendEntity WRITE resolve to the same file, and tests' MOT_GRAPH_PATH is honored.
      const graphPath =
        process.env.MOT_GRAPH_PATH ??
        path.join(process.cwd(), 'ontology', 'graph.jsonl');
      const source = args.source as string;
      const sources = graphEntitySources(graphPath);
      if (sources.has(source)) return text({ skipped: true, reason: 'source_already_ingested' });

      // Step 5 — dedup scan (spread-merge, never bare assignment — a bare reassignment would
      // clobber caller-supplied keys like properties.date on a Deadline).
      const label = args.label as string;
      let properties = (args.properties as Record<string, unknown> | undefined) ?? {};
      const dupIds = scanForDuplicates(label, normType);
      if (dupIds.length > 0) {
        properties = { ...properties, probable_duplicate_of: dupIds };
      }

      // Step 6 — persist `reason` to properties when provided (auditability, W-4). DELIBERATE
      // divergence from the digest path, which drops reason — do NOT match that precedent here.
      const reason = typeof args.reason === 'string' ? args.reason : undefined;
      if (reason !== undefined) {
        properties = { ...properties, reason };
      }

      // Step 7 — append (confirmed:false ALWAYS; catch so an append throw becomes a typed error
      // rather than propagating to the route as isError:true).
      try {
        const record = appendEntity({
          type: normType,
          label,
          properties,
          confidence,
          source,
          confirmed: false,
          valid_from: nowIso(),
          valid_until: null,
          superseded_by: null,
        });
        return text(record);
      } catch (e: unknown) {
        return text({ error: 'append_failed', detail: String(e) });
      }
    }

    // ── Track-6 edge tools (AC-12): never throw — typed { error } on every sad path. ──
    case 'entity_relate': {
      const from = args.from as string;
      const rel = args.rel as string;
      const to = args.to as string;
      if (from === to) return text({ error: 'self_relate' }); // EC3/EC11
      if (!isRelType(rel)) return text({ error: 'invalid_rel' });
      if (getEntity(from) === null) return text({ error: 'from_not_found' });
      if (getEntity(to) === null) return text({ error: 'to_not_found' });
      const confidence = typeof args.confidence === 'number' ? args.confidence : 1.0;
      // A5/FR11 — a manual assertion is confirmed:true, source:'manual'.
      const patch = appendRelate(from, rel, to, confidence, 'manual', true);
      return text(patch);
    }

    case 'entity_relate_confirm':
      return text(confirmRelate(args.from as string, args.rel as string, args.to as string));

    case 'entity_relate_reject':
      return text(rejectRelate(args.from as string, args.rel as string, args.to as string));

    case 'procedural_notes_list':
      return text(listNotes(
        typeof args.category === 'string' ? args.category : undefined,
        typeof args.pending === 'boolean' ? args.pending : false,
      ));

    case 'procedural_note_confirm':
      // confirmNote returns a typed { error } on not_found / already_confirmed / superseded.
      return text(confirmNote(args.id as number));

    case 'notify_robin':
      // Delegates to lib/notify.ts (D1 / FR-11 / AC-17) — behaviour-identical to the prior inline
      // send: same missing-credential throws, same parse_mode-free payload, same 3-attempt backoff,
      // same throw-on-exhaustion. On success the helper resolves; we re-add the 'ok' envelope here.
      await sendTelegramNotify(args.text as string);
      return [{ type: 'text', text: 'ok' }];

    // ── Track-4 tools ─────────────────────────────────────────────────────────
    case 'memory_context':
      return text(await memoryContext(
        typeof args.q === 'string' ? args.q : undefined,
        typeof args.chat_id === 'string' ? args.chat_id : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
      ));

    case 'memory_profile': {
      const section =
        args.section === 'core' || args.section === 'synth' || args.section === 'full'
          ? args.section
          : 'full';
      return text(memoryProfile(section));
    }

    case 'graph_compact': {
      const graphPath =
        process.env.MOT_GRAPH_PATH ??
        path.join(process.cwd(), 'ontology', 'graph.jsonl');
      await compactGraph(graphPath);
      return text({ ok: true, message: 'Graph compacted successfully.' });
    }

    case 'topic_thread_summarize':
      return text(summarizeThread(args.slug as string));

    // ── Maintainer tools ─────────────────────────────────────────────────────
    // These return text({error}) on failure, NEVER throw — the Track-2/3/4 convention (the route
    // surfaces a structured { error } with isError:false; callers branch on the field).
    case 'maintainer_status': {
      try {
        return text(readStatus());
      } catch (e) {
        return text({ error: String(e) });
      }
    }

    case 'deploy_drift_check': {
      try {
        return text(await checkDeployDrift());
      } catch (e) {
        return text({ error: String(e) });
      }
    }

    case 'maintainer_run': {
      try {
        const worker = (args.worker as string | undefined) ?? 'all';
        const dryRun = (args.dry_run as boolean | undefined) ?? false;
        // Start from the persisted status so the untouched worker's sub-object is preserved in
        // the returned payload (each worker also self-persists its own sub-object unless dry-run).
        const status = readStatus();
        if (worker === 'resolution' || worker === 'all') {
          status.resolution = await resolutionWorker({ dryRun });
        }
        if (worker === 'dedup' || worker === 'all') {
          status.dedup = await dedupWorker({ dryRun });
        }
        if (worker === 'autoconfirm' || worker === 'all') {
          status.autoconfirm = autoconfirmWorker({ dryRun });
        }
        if (worker === 'profile' || worker === 'all') {
          status.profile = profileWorker({ dryRun });
        }
        return text(status);
      } catch (e) {
        return text({ error: String(e) });
      }
    }

    case 'profile_synthesize': {
      try {
        const dryRun = (args.dry_run as boolean | undefined) ?? false;
        return text(profileWorker({ dryRun }));
      } catch (e) {
        return text({ error: String(e) });
      }
    }

    case 'surfacing_preview': {
      // FR-14 dry-run: horizon_days is parsed INLINE (guarded int), NOT via ARG_SPECS — routing it
      // through ARG_SPECS would make the arg de-facto required (breaks the "optional" contract).
      // The inline guard supplies the 7 fallback when the arg is absent or invalid.
      const h = Number.parseInt(String(args.horizon_days), 10);
      const horizonDays = Number.isInteger(h) && h > 0 ? h : 7;
      return text(await runSurfacing({ dryRun: true, horizonDays }));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

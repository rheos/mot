import { listTickets, getTicket, createTicket, patchTicket, type ListOpts } from './tickets';
import { buildStatus } from './status';
import { createTicketSchema, patchTicketSchema, writeMemorySchema } from './validation';
import { logTurn, getRecentTurns, searchTurns } from './conversation';
import { structuralDigest } from './digest';
import { writeMemory, getActiveMemory, searchActiveMemory } from './memory';
import { listThreads, getThread, createThread, linkThreadSession } from './topics';
import { getEntity, searchEntities, relatedEntities, type EntityRecord } from './graph';
import { listNotes, confirmNote } from './procedural';
import { MINISTRY_ADAPTERS } from '../config/ministry-adapters';
import type { Ministry, Status, Severity } from './enums';

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
              'Filter by ministry. education=school/Alex, commerce=SampleApp/Upwork/income, ' +
              'plenty=bills/renewals, flow=dev/deploys, works=tasks, peace=health/personal, ' +
              'interior=legal/gov, foreign_affairs=community.',
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
              'Life domain. education=school/Alex, commerce=SampleApp/Upwork/income, ' +
              'plenty=bills/renewals, flow=dev/deploys, works=tasks, peace=health/personal, ' +
              'interior=legal/gov, foreign_affairs=community.',
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
        'Full-text keyword search over Rheo conversation history. ' +
        'Use when Taylor asks about something discussed in a past session.',
      inputSchema: {
        type: 'object',
        properties: {
          q:       { type: 'string', description: 'Search query (FTS5 porter-stemmed).' },
          chat_id: { type: 'string', description: 'Restrict to one chat. Omit to search all.' },
          limit:   { type: 'integer', minimum: 1, maximum: 50 },
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
        'Call at the END of your reply, after answering Taylor. ' +
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
        'Entity-graph / topic-thread / procedural-note search are separate Track-2 tools.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Restrict to one chat. Omit to return all active items.' },
          limit:   { type: 'integer', minimum: 1, maximum: 50, description: 'Max items to return. Default 20.' },
          q:       { type: 'string', description: 'Optional keyword search (FTS5 porter-stemmed). When provided, filters results by match. Empty string ignored.' },
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
      description: 'Search entities by keyword. Returns active records only by default.',
      inputSchema: {
        type: 'object',
        properties: {
          q:    { type: 'string', description: 'Case-insensitive keyword.' },
          type: { type: 'string', enum: ['Person', 'Project', 'Deadline', 'Preference', 'Fact'] },
          unconfirmed_only: { type: 'boolean', description: 'Return unconfirmed candidates only.' },
        },
        required: ['q'],
      },
    },
    {
      name: 'entity_related',
      description:
        'Traverse entity relations from a starting entity. Traversal includes ' +
        'superseded/expired entities, by design.',
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
      description: 'Send a text message to Taylor\'s Telegram chat. Truncates to 4096 chars. ' +
        'Retries up to 3 times on network error or non-2xx. Returns ok or an error string.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to deliver.' },
        },
        required: ['text'],
      },
    },
  ];
}

// ── notify_robin: truncation helper (FR-7, AC-8) ──────────────────────────────
// Telegram caps a sendMessage body at 4096 chars. When the briefing is longer, cut it at the
// LAST section-header boundary (a newline followed by an uppercase letter) that still leaves
// room for the "\n…and NNNNN more" suffix, and append that suffix. The suffix counts toward
// the 4096 budget, so the backward scan starts at maxBody = 4096 - 25 (25 is a safe upper
// bound for the suffix). Result is always ≤4096 chars.
function _truncateBriefing(text: string): string {
  if (text.length <= 4096) return text;

  const maxBody = 4096 - 25; // 25 ≥ len('\n…and ') + len(String(N)) + len(' more') for any real N

  // Scan backward from maxBody for a section-header boundary: '\n' followed by an uppercase letter.
  let cutPoint = -1;
  for (let i = maxBody; i >= 0; i--) {
    if (text[i] === '\n' && /[A-Z]/.test(text[i + 1] ?? '')) {
      cutPoint = i;
      break;
    }
  }

  if (cutPoint !== -1) {
    const n = text.length - cutPoint;
    return text.slice(0, cutPoint) + '\n…and ' + n + ' more';
  }

  // Degenerate: no header boundary in range. Hard-cut at maxBody and append the suffix.
  const n = text.length - maxBody;
  return text.slice(0, maxBody) + '\n…and ' + n + ' more';
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolContent> {
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

    case 'chat_search':
      return text(searchTurns(
        args.q as string,
        args.chat_id as string | undefined,
        (args.limit as number) ?? 20,
      ));

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

    case 'entity_search':
      return text(searchEntities(
        args.q as string,
        args.type as EntityRecord['type'] | undefined,
        typeof args.unconfirmed_only === 'boolean' ? args.unconfirmed_only : undefined,
      ));

    case 'entity_related':
      // NOTE: relatedEntities traversal includes superseded/expired — intentional.
      return text(relatedEntities(
        args.id as string,
        typeof args.rel === 'string' ? args.rel : undefined,
        typeof args.hops === 'number' ? args.hops : 1,
      ));

    case 'procedural_notes_list':
      return text(listNotes(
        typeof args.category === 'string' ? args.category : undefined,
        typeof args.pending === 'boolean' ? args.pending : false,
      ));

    case 'procedural_note_confirm':
      // confirmNote returns a typed { error } on not_found / already_confirmed / superseded.
      return text(confirmNote(args.id as number));

    case 'notify_robin': {
      // Stateless Telegram delivery (FR-4, FR-7–FR-9; T-1..T-5). Credentials are read at
      // call time (mirroring lib/auth's env-read pattern), not at module load. On a missing
      // credential or send exhaustion this THROWS — route.ts's catch sets isError=true at the
      // JSON-RPC level. We never return a 200-silent success on failure.
      const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
      const chatId = process.env.TELEGRAM_ALLOWED_USER?.trim();
      if (!token) {
        // eslint-disable-next-line no-console
        console.error('[MOT/notify_robin] missing-credential: TELEGRAM_BOT_TOKEN is not set');
        throw new Error('notify_robin: TELEGRAM_BOT_TOKEN is not set');
      }
      if (!chatId) {
        // eslint-disable-next-line no-console
        console.error('[MOT/notify_robin] missing-credential: TELEGRAM_ALLOWED_USER is not set');
        throw new Error('notify_robin: TELEGRAM_ALLOWED_USER is not set');
      }

      const body = _truncateBriefing(args.text as string);
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      // Plain text only — NO parse_mode (T-5): Markdown/HTML parse errors on user content
      // would turn a valid briefing into a 400.
      const payload = { chat_id: chatId, text: body };

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let lastReason = '';
      // Up to 3 attempts. Backoff between attempts: 1s after #1, 2s after #2 (T-2).
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (res.ok) return [{ type: 'text', text: 'ok' }];
          lastReason = `Telegram returned HTTP ${res.status}`;
        } catch (e: unknown) {
          lastReason = e instanceof Error ? e.message : 'network error';
        }
        if (attempt < 3) await sleep(attempt * 1000); // 1s, then 2s
      }

      // eslint-disable-next-line no-console
      console.error(`[MOT/notify_robin] send failed after 3 attempts: ${lastReason}`);
      throw new Error(`notify_robin: delivery failed after 3 attempts (${lastReason})`);
    }


    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

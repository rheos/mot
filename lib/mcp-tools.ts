import { listTickets, getTicket, createTicket, patchTicket, type ListOpts } from './tickets';
import { buildStatus } from './status';
import { createTicketSchema, patchTicketSchema, writeMemorySchema } from './validation';
import { logTurn, getRecentTurns, searchTurns } from './conversation';
import { structuralDigest } from './digest';
import { writeMemory, getActiveMemory } from './memory';
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
        'Return active (non-superseded, non-conflicted) memory items. ' +
        'Input is LOCKED to { chat_id?, limit? } only — no filter, query, or type params. ' +
        'Any search or filtering over memory items is Track 2 (entity_search, not available here).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Restrict to one chat. Omit to return all active items.' },
          limit:   { type: 'integer', minimum: 1, maximum: 50, description: 'Max items to return. Default 20.' },
        },
      },
    },
  ];
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
      return text(getActiveMemory(chatId, limit));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

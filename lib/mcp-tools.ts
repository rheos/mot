import { listTickets, getTicket, createTicket, patchTicket, type ListOpts } from './tickets';
import { buildStatus } from './status';
import { createTicketSchema, patchTicketSchema } from './validation';
import { logTurn, getRecentTurns, searchTurns } from './conversation';
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
            description: 'External signal ID (e.g. Gmail thread ID) — enables dedup.',
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
              prompt_hash: { type: 'string' },
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

import { z, ZodError } from 'zod';
import { Ministry, Severity, Provenance } from './enums';

// ── Validation layer (FR-API-1/2, AC-VALIDATION) ──────────────────────────────
// The Zod boundary every route handler crosses before touching the DB. Pure: schemas
// + Response construction, no DB access. House rule 8 — this is the strict-typing guard
// at the API boundary; the inferred types below are the validated payload contract P8 consumes.

// Statuses a PATCH may set. `archived` is excluded on purpose: it is cron-only (FR-LC-1)
// and the refines below reject it with the exact AC-VALIDATION message.
const PATCH_STATUSES = ['open', 'watching', 'snoozed', 'done'] as const;

// Exact message AC-VALIDATION mandates for any archived attempt (POST or PATCH).
const ARCHIVED_MESSAGE = 'archived status cannot be set via API';

// Optional classification_audit block on create (FR-API-1). Present ⇒ the handler writes
// an audit row; absent (manual create) ⇒ no audit row.
const classificationAuditSchema = z.object({
  signal_fingerprint: z.string().min(1),
  model_version: z.string().min(1),
  prompt_hash: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

// ── POST /tickets ─────────────────────────────────────────────────────────────
export const createTicketSchema = z
  .object({
    title: z.string().min(1, 'title is required'),
    ministry: z.enum(Object.values(Ministry) as [string, ...string[]]),
    severity: z.enum(Object.values(Severity) as [string, ...string[]]),
    // OQ-P7 separator guard: ticket_type must be colon-free so `source_ref:ticket_type`
    // stays injective as a dedup_key. Validated here so P6 never has to re-check.
    ticket_type: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, 'ticket_type must not contain a colon'),
    provenance: z.enum(Object.values(Provenance) as [string, ...string[]]),
    source_ref: z.string().nullable().optional(),
    body: z.string().min(1, 'body is required'),
    private: z.boolean().optional().default(false),
    needs_review: z.boolean().optional().default(false),
    event_count: z.number().int().min(1).optional().default(1),
    snoozed_until: z.string().nullable().optional(),
    blocked_note: z.string().nullable().optional(),
    linked_ticket_id: z.string().nullable().optional(),
    // status is not part of the documented POST body (the DB defaults it to 'open'), but if
    // a caller passes it we must reject 'archived' with the exact message — declared
    // explicitly so the refine can see it (Zod strips undeclared keys).
    status: z.string().optional(),
    classification_audit: classificationAuditSchema.optional(),
  })
  .refine((data) => data.status !== 'archived', {
    message: ARCHIVED_MESSAGE,
    path: ['status'],
  });

// ── PATCH /tickets/:id ────────────────────────────────────────────────────────
// status is validated as a RAW STRING, then sequential refines gate it. We deliberately do
// NOT use z.enum(['open','watching','snoozed','done']) here: a bare enum rejects 'archived'
// with a generic Zod message BEFORE any refine can fire, so the AC-VALIDATION-mandated
// "archived status cannot be set via API" would never be returned. String + ordered refines
// make the archived message win.
export const patchTicketSchema = z
  .object({
    status: z.string().optional(),
    severity: z.enum(Object.values(Severity) as [string, ...string[]]).optional(),
    ministry: z.enum(Object.values(Ministry) as [string, ...string[]]).optional(),
    title: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    snoozed_until: z.string().nullable().optional(),
    blocked_note: z.string().nullable().optional(),
    linked_ticket_id: z.string().nullable().optional(),
    needs_review: z.boolean().optional(),
    add_comment: z
      .object({
        author: z.enum(['robin', 'tuttle']),
        body: z.string().min(1),
      })
      .optional(),
  })
  // At least one field required.
  .refine((data) => Object.keys(data).length > 0, {
    message: 'at least one field required',
  })
  // Reject 'archived' FIRST, with the exact AC-VALIDATION message — this must precede the
  // lifecycle-values check so 'archived' returns this message, not the generic one below.
  .refine((data) => data.status !== 'archived', {
    message: ARCHIVED_MESSAGE,
    path: ['status'],
  })
  // Reject any other non-lifecycle status value ('archived' already handled above).
  .refine(
    (data) =>
      data.status === undefined ||
      (PATCH_STATUSES as readonly string[]).includes(data.status),
    {
      message: 'status must be one of: open, watching, snoozed, done',
      path: ['status'],
    },
  )
  // snoozed requires a FUTURE snoozed_until (EC-ARCH-4 — a past datetime is rejected, not
  // silently accepted into an immediately-wake-pending state).
  .refine(
    (data) => {
      if (data.status !== 'snoozed') return true;
      if (!data.snoozed_until) return false;
      const when = new Date(data.snoozed_until);
      return !Number.isNaN(when.getTime()) && when > new Date();
    },
    {
      message:
        'snoozed_until must be a valid future datetime when status is snoozed',
      path: ['snoozed_until'],
    },
  );

// Validated payload types — the boundary contract P8's route handlers pass to the data layer.
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type PatchTicketInput = z.infer<typeof patchTicketSchema>;

// ── ZodError → 422 { error, fields[] } (FR-API-1) ─────────────────────────────
export function validationErrorResponse(err: ZodError): Response {
  const fields = err.issues.map((issue) => ({
    field: issue.path.join('.') || 'unknown',
    message: issue.message,
  }));
  return Response.json({ error: 'validation_failed', fields }, { status: 422 });
}

// ── Numeric query-string helpers ──────────────────────────────────────────────
// Parse a raw query-string value as a positive integer.
// Returns undefined for null input, non-integers, zero, and negatives — the caller
// applies its own default and cap. Shared by any route that takes a limit/page param.
export function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ── HTTP error-code policy (FR-API-1) ─────────────────────────────────────────
// 400 malformed JSON · 401 auth (lib/auth) · 404 not found · 422 validation · 500 unexpected.
export function badRequest(message = 'Bad request'): Response {
  return Response.json({ error: 'bad_request', message }, { status: 400 });
}

export function notFound(message = 'Not found'): Response {
  return Response.json({ error: 'not_found', message }, { status: 404 });
}

export function internalError(message = 'Internal server error'): Response {
  return Response.json({ error: 'internal_error', message }, { status: 500 });
}

// ── write_memory MCP tool schema (Track 1) ────────────────────────────────────
// chat_id is deliberately absent — it is derived server-side from source_turn_id.
export const writeMemorySchema = z.object({
  type: z.enum(['fact', 'preference', 'deadline', 'person']),
  content: z.object({
    label: z.string().min(1),
    properties: z.record(z.unknown()),
  }),
  source_turn_id: z.number().int().positive(),
  source_session_id: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type WriteMemoryInput = z.infer<typeof writeMemorySchema>;

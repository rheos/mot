import { describe, it, expect } from 'vitest';
import {
  createTicketSchema,
  patchTicketSchema,
  validationErrorResponse,
} from '../../lib/validation';

// AC-VALIDATION — pure unit tests, no DB. Parse a payload, and where it should fail, run the
// ZodError through validationErrorResponse() and assert the 422 { error, fields[] } shape.

type FieldError = { field: string; message: string };

async function fieldsFor(
  schema: typeof createTicketSchema | typeof patchTicketSchema,
  payload: unknown,
): Promise<FieldError[]> {
  const result = schema.safeParse(payload);
  expect(result.success).toBe(false);
  if (result.success) return [];
  const res = validationErrorResponse(result.error);
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error: string; fields: FieldError[] };
  expect(body.error).toBe('validation_failed');
  return body.fields;
}

const validPost = {
  title: 'Payment failed',
  ministry: 'commerce',
  severity: 'high',
  ticket_type: 'payment-alert',
  provenance: 'stripe-webhook',
  body: 'Charge stripe-ch-123 failed.',
};

describe('createTicketSchema (POST /tickets) — AC-VALIDATION', () => {
  it('1. missing title → fields includes title', async () => {
    const { title: _omit, ...noTitle } = validPost;
    const fields = await fieldsFor(createTicketSchema, noTitle);
    expect(fields.some((f) => f.field === 'title')).toBe(true);
  });

  it('2. invalid ministry → fields includes ministry', async () => {
    const fields = await fieldsFor(createTicketSchema, {
      ...validPost,
      ministry: 'not-a-ministry',
    });
    expect(fields.some((f) => f.field === 'ministry')).toBe(true);
  });

  it('3. ticket_type containing a colon → fields includes ticket_type', async () => {
    const fields = await fieldsFor(createTicketSchema, {
      ...validPost,
      ticket_type: 'payment:alert',
    });
    expect(fields.some((f) => f.field === 'ticket_type')).toBe(true);
  });

  it('3b. POST status=archived → rejected with the exact message', async () => {
    const fields = await fieldsFor(createTicketSchema, {
      ...validPost,
      status: 'archived',
    });
    const status = fields.find((f) => f.field === 'status');
    expect(status?.message).toBe('archived status cannot be set via API');
  });

  it('7. valid POST payload parses without error', () => {
    expect(createTicketSchema.safeParse(validPost).success).toBe(true);
  });

  // ── bridge_source_refs colon guard (Prompt 2, FR-15/17) ─────────────────────
  // Same colon-free rule as ticket_type: any element with a colon would alias a candidate
  // dedup_key, so it is rejected (not sanitized).
  it('bridge: a bridge_source_refs element containing a colon → fields includes bridge_source_refs', async () => {
    const fields = await fieldsFor(createTicketSchema, {
      ...validPost,
      bridge_source_refs: ['clean-msg-id', 'msg:with:colon'],
    });
    expect(fields.some((f) => f.field.startsWith('bridge_source_refs'))).toBe(true);
  });

  it('bridge: colon-free bridge_source_refs parse, and the field is omittable', () => {
    expect(
      createTicketSchema.safeParse({
        ...validPost,
        bridge_source_refs: ['msg-1', 'msg-2'],
      }).success,
    ).toBe(true);
    // Omitting bridge_source_refs entirely is valid (heartbeat / manual / post-migration).
    expect(createTicketSchema.safeParse(validPost).success).toBe(true);
  });
});

describe('patchTicketSchema (PATCH /tickets/:id) — AC-VALIDATION', () => {
  it('4. status=archived → field status with the exact AC-VALIDATION message', async () => {
    const fields = await fieldsFor(patchTicketSchema, { status: 'archived' });
    const status = fields.find((f) => f.field === 'status');
    expect(status).toBeDefined();
    expect(status?.message).toBe('archived status cannot be set via API');
  });

  it('5. status=snoozed without snoozed_until → field snoozed_until', async () => {
    const fields = await fieldsFor(patchTicketSchema, { status: 'snoozed' });
    expect(fields.some((f) => f.field === 'snoozed_until')).toBe(true);
  });

  it('6. status=snoozed with a PAST snoozed_until → field snoozed_until (EC-ARCH-4)', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const fields = await fieldsFor(patchTicketSchema, {
      status: 'snoozed',
      snoozed_until: past,
    });
    expect(fields.some((f) => f.field === 'snoozed_until')).toBe(true);
  });

  it('8. valid PATCH payload ({ body }) parses without error', () => {
    expect(patchTicketSchema.safeParse({ body: 'updated' }).success).toBe(true);
  });

  it('extra: status=snoozed with a FUTURE snoozed_until parses', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(
      patchTicketSchema.safeParse({ status: 'snoozed', snoozed_until: future }).success,
    ).toBe(true);
  });

  // ── AC-15 — PATCH cannot mutate ticket identity (source_ref / dedup_key) ─────
  // The schema is not .strict(), so undeclared keys are STRIPPED silently rather than rejected.
  // Either way the identity fields can never reach the data layer through a PATCH — the only
  // source_ref/dedup_key writes are the create tx (incl. the in-tx bridge migration). This proves
  // the identity-mutation path is closed to PATCH.
  it('15. PATCH with source_ref → field is stripped, never reaches the data layer', () => {
    const parsed = patchTicketSchema.safeParse({ body: 'x', source_ref: 'thread-evil' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('source_ref' in parsed.data).toBe(false);
    }
  });

  it('15b. PATCH with dedup_key → field is stripped, never reaches the data layer', () => {
    const parsed = patchTicketSchema.safeParse({ body: 'x', dedup_key: 'thread-evil:bill-due' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('dedup_key' in parsed.data).toBe(false);
    }
  });
});

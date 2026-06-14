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
});

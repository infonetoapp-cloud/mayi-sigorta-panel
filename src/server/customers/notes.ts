import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';

const ACTION = 'customer.note.create';
const entityId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const canonicalTime = z
  .string()
  .datetime()
  .refine((value) => new Date(value).toISOString() === value);
const storedContent = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value === value.trim() && !value.includes('\0'));
const noteSchema = z
  .object({
    id: z.string().uuid(),
    content: storedContent,
    authorName: z.string().min(1).max(200).nullable(),
    createdAt: canonicalTime,
  })
  .strict();
export type CustomerNoteDto = z.infer<typeof noteSchema>;
export const createCustomerNoteSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((value) => !value.includes('\0')),
  })
  .strict();
export const customerNotesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export class CustomerNoteError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 500,
  ) {
    super(code);
  }
}
interface Authority {
  context: AuthenticatedUserContext;
  agencyId: string;
  membershipId: string;
  sql: string;
  bindings: (string | number)[];
  archived: boolean;
  assignee: string;
}

async function authority(
  db: D1Database,
  original: AuthenticatedUserContext,
  customerId: string,
  write: boolean,
): Promise<Authority> {
  // Detach server identity before the first await; client fields never enter authority or authorship.
  const member = original.memberships[0];
  if (!member || member.status !== 'ACTIVE') throw new CustomerNoteError('NOT_FOUND', 404);
  const context: AuthenticatedUserContext = {
    userId: original.userId,
    identityId: original.identityId,
    assurance: original.assurance,
    memberships: [{ ...member }],
  };
  const active = context.memberships[0]!;
  const customer = await db
    .prepare('SELECT assignee_membership_id,archived_at FROM customers WHERE agency_id=? AND id=?')
    .bind(active.agencyId, customerId)
    .first<{ assignee_membership_id: string; archived_at: string | null }>();
  if (!customer) throw new CustomerNoteError('NOT_FOUND', 404);
  const resource = {
    agencyId: active.agencyId,
    assigneeMembershipId: customer.assignee_membership_id,
  };
  const checks: string[] = [];
  const permissionBindings: string[] = [];
  for (const action of write ? ['customer.read', 'customer.update'] : ['customer.read']) {
    const result = await evaluateAuthorization(db, { context, action, resource });
    if (
      result.decision !== 'ALLOW' ||
      !['ASSIGNED', 'AGENCY'].includes(result.effectiveScope ?? '')
    )
      throw new CustomerNoteError('NOT_FOUND', 404);
    checks.push(
      `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp WHERE mp.membership_id=m.id AND mp.permission_code=? AND mp.scope=?))`,
    );
    permissionBindings.push(action, result.effectiveScope!);
    if (result.effectiveScope === 'ASSIGNED') checks.push('c.assignee_membership_id=m.id');
  }
  return {
    context,
    agencyId: active.agencyId,
    membershipId: active.id,
    archived: customer.archived_at !== null,
    assignee: customer.assignee_membership_id,
    sql: `SELECT 1 FROM customers c JOIN agency_memberships m ON m.agency_id=c.agency_id
      JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
      JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
      WHERE c.agency_id=? AND c.id=? AND m.id=? AND m.user_id=? AND m.type=?
        AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND m.permission_version=?
        AND ${checks.join(' AND ')}`,
    bindings: [
      context.identityId,
      active.agencyId,
      customerId,
      active.id,
      context.userId,
      active.type,
      active.permissionVersion,
      ...permissionBindings,
    ],
  };
}
function assertAuthority(db: D1Database, auth: Authority, unarchived: boolean) {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS(${auth.sql}${unarchived ? ' AND c.archived_at IS NULL' : ''}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(crypto.randomUUID(), ...auth.bindings);
}
async function protectedRead(
  db: D1Database,
  auth: Authority,
  query: D1PreparedStatement,
): Promise<D1Result<CustomerNoteDto>> {
  try {
    const results = await db.batch<CustomerNoteDto>([assertAuthority(db, auth, false), query]);
    const result = results[1];
    if (!result?.success) throw new CustomerNoteError('READ_FAILED', 500);
    return result;
  } catch (error) {
    if (
      /LOCAL_SESSION_REVOKED|MEMBERSHIP_PERMISSION_NOT_FOUND/.test(
        error instanceof Error ? error.message : '',
      )
    )
      throw new CustomerNoteError('NOT_FOUND', 404);
    throw error;
  }
}
const cursorSchema = z
  .object({
    agencyId: entityId,
    customerId: entityId,
    membershipId: entityId,
    permissionVersion: z.number().int().positive(),
    createdAt: canonicalTime,
    id: z.string().uuid(),
  })
  .strict();

export async function listCustomerNotes(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  rawQuery: unknown,
) {
  const input = customerNotesQuerySchema.safeParse(rawQuery);
  if (!entityId.safeParse(customerId).success || !input.success)
    throw new CustomerNoteError('VALIDATION_ERROR', 400);
  const auth = await authority(db, context, customerId, false);
  const binding = {
    agencyId: auth.agencyId,
    customerId,
    membershipId: auth.membershipId,
    permissionVersion: auth.context.memberships[0]!.permissionVersion,
  };
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (input.data.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(atob(input.data.cursor)));
      if (
        Object.entries(binding).some(
          ([key, value]) => cursor![key as keyof typeof binding] !== value,
        )
      )
        throw new Error('binding');
    } catch {
      throw new CustomerNoteError('INVALID_CURSOR', 400);
    }
  }
  const update = await evaluateAuthorization(db, {
    context: auth.context,
    action: 'customer.update',
    resource: { agencyId: auth.agencyId, assigneeMembershipId: auth.assignee },
  });
  const query = db
    .prepare(
      `SELECT n.id,n.content,n.author_name AS authorName,n.created_at AS createdAt
    FROM customer_notes n WHERE n.agency_id=? AND n.customer_id=? AND EXISTS(${auth.sql})
    ${cursor ? 'AND (n.created_at<? OR (n.created_at=? AND n.id<?))' : ''}
    ORDER BY n.created_at DESC,n.id DESC LIMIT ?`,
    )
    .bind(
      auth.agencyId,
      customerId,
      ...auth.bindings,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      input.data.limit + 1,
    );
  // Request-bound batch adds the existing live session/credential-epoch assertion.
  // Keep authorization and result disclosure in that same transaction boundary.
  const results = await protectedRead(db, auth, query);
  if (!results.success) throw new CustomerNoteError('READ_FAILED', 500);
  const items = results.results.slice(0, input.data.limit).map((row) => noteSchema.parse(row));
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      results.results.length > input.data.limit && last
        ? btoa(JSON.stringify({ ...binding, createdAt: last.createdAt, id: last.id }))
        : null,
    canCreate: !auth.archived && update.decision === 'ALLOW',
  };
}

export async function createCustomerNote(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  rawInput: unknown,
  key: string,
) {
  const input = createCustomerNoteSchema.safeParse(rawInput);
  if (!entityId.safeParse(customerId).success || !entityId.safeParse(key).success || !input.success)
    throw new CustomerNoteError('VALIDATION_ERROR', 400);
  const content = input.data.content;
  const auth = await authority(db, context, customerId, true);
  const fingerprint = await computePayloadHash({
    action: ACTION,
    customerId,
    content: input.data.content,
  });
  async function replay() {
    const receipt = await db
      .prepare(
        `SELECT id,action,payload_fingerprint,status,response_status,response_body FROM operation_receipts
      WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
      )
      .bind(auth.agencyId, auth.context.userId, auth.membershipId, key)
      .first<{
        id: string;
        action: string;
        payload_fingerprint: string;
        status: string;
        response_status: number;
        response_body: string;
      }>();
    if (!receipt) return null;
    if (receipt.action !== ACTION || receipt.payload_fingerprint !== fingerprint)
      throw new CustomerNoteError('IDEMPOTENCY_CONFLICT', 409);
    let id: string;
    try {
      id = z.object({ id: z.string().uuid() }).strict().parse(JSON.parse(receipt.response_body)).id;
    } catch {
      throw new CustomerNoteError('REPLAY_NOT_AUTHORIZED', 404);
    }
    if (receipt.status !== 'COMPLETED' || receipt.response_status !== 201)
      throw new CustomerNoteError('REPLAY_NOT_AUTHORIZED', 404);
    const query = db
      .prepare(
        `SELECT n.id,n.content,n.author_name AS authorName,n.created_at AS createdAt
      FROM customer_notes n WHERE n.id=? AND n.customer_id=? AND n.agency_id=? AND n.operation_receipt_id=?
        AND n.author_user_id=? AND n.author_membership_id=? AND n.content=? AND EXISTS(${auth.sql})
        AND (SELECT count(*) FROM audit_events audit WHERE audit.agency_id=n.agency_id
          AND audit.actor_user_id=n.author_user_id AND audit.actor_membership_id=n.author_membership_id
          AND audit.action='customer.note.created' AND audit.target_type='customer_notes' AND audit.target_id=n.id
          AND audit.idempotency_key=? AND audit.outcome='SUCCESS' AND audit.created_at=n.created_at)=1`,
      )
      .bind(
        id,
        customerId,
        auth.agencyId,
        receipt.id,
        auth.context.userId,
        auth.membershipId,
        content,
        ...auth.bindings,
        key,
      );
    const row = (await protectedRead(db, auth, query)).results[0];
    if (!row) throw new CustomerNoteError('REPLAY_NOT_AUTHORIZED', 404);
    const parsed = noteSchema.safeParse(row);
    if (!parsed.success) throw new CustomerNoteError('REPLAY_NOT_AUTHORIZED', 404);
    return { data: parsed.data, replayed: true };
  }
  const prior = await replay();
  if (prior) return prior;
  if (auth.archived) throw new CustomerNoteError('NOT_FOUND', 404);
  const id = crypto.randomUUID(),
    receiptId = crypto.randomUUID(),
    now = new Date().toISOString();
  const audit = buildSafeAuditRecord({
    agencyId: auth.agencyId,
    actorUserId: auth.context.userId,
    actorMembershipId: auth.membershipId,
    action: 'customer.note.created',
    targetType: 'customer_notes',
    targetId: id,
    correlationId: crypto.randomUUID(),
    idempotencyKey: key,
    outcome: 'SUCCESS',
    createdAt: now,
    metadata: { customerId, changedFields: ['content'] },
  });
  try {
    await db.batch([
      assertAuthority(db, auth, true),
      db
        .prepare(
          `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'COMPLETED',201,?,?,?)`,
        )
        .bind(
          receiptId,
          auth.agencyId,
          auth.context.userId,
          auth.membershipId,
          ACTION,
          key,
          fingerprint,
          JSON.stringify({ id }),
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO customer_notes(id,agency_id,customer_id,content,author_user_id,author_membership_id,author_name,operation_receipt_id,created_at)
        SELECT ?,?,?,?,?,?,nullif(trim(display_name),''),?,? FROM users WHERE id=?`,
        )
        .bind(
          id,
          auth.agencyId,
          customerId,
          input.data.content,
          auth.context.userId,
          auth.membershipId,
          receiptId,
          now,
          auth.context.userId,
        ),
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),'CUSTOMER_NOTE_INSERT_FAILED'`,
        )
        .bind(crypto.randomUUID()),
      db
        .prepare(
          `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          audit.id,
          audit.agencyId,
          audit.actorUserId,
          audit.actorMembershipId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.correlationId,
          audit.idempotencyKey,
          audit.outcome,
          audit.metadataJson,
          audit.createdAt,
        ),
    ]);
  } catch (error) {
    if (
      /operation_receipts_idem_uq|UNIQUE constraint failed: operation_receipts|IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN/.test(
        error instanceof Error ? error.message : '',
      )
    ) {
      const raced = await replay();
      if (raced) return raced;
    }
    if (/MEMBERSHIP_PERMISSION_NOT_FOUND/.test(error instanceof Error ? error.message : ''))
      throw new CustomerNoteError('NOT_FOUND', 404);
    throw new CustomerNoteError('WRITE_FAILED', 500);
  }
  // Return only the persisted note after the exact same live-authority/effect proof used by retry.
  const persisted = await replay();
  if (!persisted) throw new CustomerNoteError('READ_FAILED', 500);
  return { ...persisted, replayed: false };
}

import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { member, salesGate, SalesError } from './service';
import { renewalSourceJoins, renewalSourceReadGate } from './renewal-source';
import {
  salesPriceCreateSchema,
  salesPriceReviseSchema,
  salesPriceResultSchema,
  salesPriceReceiptSchema,
  salesPriceRevisionSchema,
  salesPriceRowSchema,
} from '../../shared/sales-prices';

type Context = AuthenticatedUserContext;
type Result = z.infer<typeof salesPriceResultSchema>;
const joins = `FROM sales_cases s
 JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 JOIN agency_memberships m ON m.agency_id=s.agency_id
 JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=s.agency_id ${renewalSourceJoins}`;
const writable = `c.archived_at IS NULL AND ((s.context_kind='NEW_BUSINESS' AND s.result='OPEN') OR
 (s.context_kind='RENEWAL' AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED') AND p.status='ACTIVE' AND p.archived_at IS NULL))`;
interface Parent {
  version: number;
  context: 'NEW_BUSINESS' | 'RENEWAL';
  customerId: string;
  branchId: string;
  writable: number;
}
async function parent(db: D1Database, ctx: Context, caseId: string, write = false) {
  const m = member(ctx),
    g = salesGate(ctx, write, false, true);
  const row = (
    await db.batch<Parent>([
      db
        .prepare(
          `SELECT s.version,s.context_kind context,s.customer_id customerId,s.branch_id branchId,CASE WHEN ${writable} THEN 1 ELSE 0 END writable
     ${joins} WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate}`,
        )
        .bind(m.agencyId, caseId, ...g.args),
    ])
  )[0]!.results[0];
  if (!row) throw new SalesError('NOT_FOUND', 404);
  return { row, g, m };
}
const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1600).optional(),
  source: z.enum(['PRICE_REVISION', 'QUOTE_VERSION']).optional(),
});
const historyQuery = pageQuery.omit({ source: true });
type PageQuery = z.infer<typeof pageQuery>;
const eventStateSql = `coalesce((SELECT pe.event_code FROM sales_price_events pe WHERE pe.agency_id=s.agency_id AND pe.case_id=s.id AND pe.revision_id=v.id ORDER BY pe.case_version DESC LIMIT 1),'NOT_SHARED')`;
const light = `SELECT 'PRICE_REVISION' source,sp.insurer_id insurerId,i.name insurerName,
 v.amount_minor amountMinor,v.currency,v.created_at createdAt,
 sp.id priceId,sp.version priceVersion,v.id revisionId,v.revision_number revisionNumber,v.terms_note termsNote,
 v.offered_start_date offeredStartDate,v.offered_end_date offeredEndDate,
 NULL quoteId,NULL quoteVersionId,NULL quoteVersionNumber,NULL quoteStatus,NULL validUntil,NULL startDate,NULL endDate,
 sp.created_at sortAt,sp.id sortId,${eventStateSql} eventState
 ${joins} JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id
 JOIN sales_price_revisions v ON v.agency_id=sp.agency_id AND v.price_id=sp.id AND v.id=sp.current_revision_id
 JOIN insurers i ON i.agency_id=sp.agency_id AND i.id=sp.insurer_id`;
const legacy = `SELECT 'QUOTE_VERSION' source,v.insurer_id insurerId,i.name insurerName,
 v.gross_premium_minor amountMinor,v.currency,v.created_at createdAt,
 NULL priceId,NULL priceVersion,NULL revisionId,NULL revisionNumber,v.terms_summary termsNote,
 NULL offeredStartDate,NULL offeredEndDate,q.id quoteId,v.id quoteVersionId,v.version_number quoteVersionNumber,
 q.status quoteStatus,v.valid_until validUntil,v.start_date startDate,v.end_date endDate,q.created_at sortAt,q.id sortId,NULL eventState
 ${joins} JOIN renewal_quotes q ON q.agency_id=s.agency_id AND q.renewal_id=s.renewal_id
 JOIN renewal_quote_versions v ON v.agency_id=q.agency_id AND v.quote_id=q.id AND v.id=q.current_version_id
 JOIN insurers i ON i.agency_id=v.agency_id AND i.id=v.insurer_id`;
interface PriceRow {
  source: 'PRICE_REVISION' | 'QUOTE_VERSION';
  insurerId: string;
  insurerName: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
  priceId: string;
  priceVersion: number;
  revisionId: string;
  revisionNumber: number;
  termsNote: string | null;
  offeredStartDate: string | null;
  offeredEndDate: string | null;
  quoteId: string;
  quoteVersionId: string;
  quoteVersionNumber: number;
  quoteStatus: string;
  validUntil: string;
  startDate: string;
  endDate: string;
  sortAt: string;
  sortId: string;
  eventState: 'NOT_SHARED' | 'SHARED' | 'CUSTOMER_ACCEPTED' | 'ACCEPTANCE_REVOKED';
}
function dto(row: PriceRow) {
  const common = {
    insurerId: row.insurerId,
    insurerName: row.insurerName,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdAt: row.createdAt,
  };
  return salesPriceRowSchema.parse(
    row.source === 'PRICE_REVISION'
      ? {
          ...common,
          source: 'PRICE_REVISION' as const,
          priceId: row.priceId,
          priceVersion: row.priceVersion,
          revisionId: row.revisionId,
          revisionNumber: row.revisionNumber,
          termsNote: row.termsNote,
          eventState: row.eventState,
          offeredPeriod:
            row.offeredStartDate && row.offeredEndDate
              ? { startDate: row.offeredStartDate, endDate: row.offeredEndDate }
              : null,
        }
      : {
          ...common,
          source: 'QUOTE_VERSION' as const,
          quoteId: row.quoteId,
          quoteVersionId: row.quoteVersionId,
          quoteVersionNumber: row.quoteVersionNumber,
          quoteStatus: row.quoteStatus,
          validUntil: row.validUntil,
          startDate: row.startDate,
          endDate: row.endDate,
          termsNote: row.termsNote,
        },
  );
}
async function cursorBinding(ctx: Context, caseId: string, q: PageQuery, priceId: string | null) {
  const m = member(ctx);
  return computePayloadHash({
    user: ctx.userId,
    member: m.id,
    agency: m.agencyId,
    pver: m.permissionVersion,
    caseId,
    priceId,
    q: Object.fromEntries(Object.entries(q).filter(([key]) => key !== 'cursor')),
  });
}
function readCursor(cursor: string | undefined, binding: string) {
  if (!cursor) return null;
  try {
    return z
      .tuple([
        z.literal(binding),
        z.string().datetime(),
        z.enum(['PRICE_REVISION', 'QUOTE_VERSION']),
        z.string().min(1).max(128),
      ])
      .parse(JSON.parse(atob(cursor)));
  } catch {
    throw new SalesError('INVALID_CURSOR', 400);
  }
}
export async function readSalesPrices(
  db: D1Database,
  ctx: Context,
  caseId: string,
  raw: unknown = {},
) {
  const { g, m } = await parent(db, ctx, caseId),
    q = pageQuery.parse(raw),
    binding = await cursorBinding(ctx, caseId, q, null),
    cursor = readCursor(q.cursor, binding);
  const condition = `s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate}`;
  const branches: string[] = [],
    args: unknown[] = [];
  if (q.source !== 'QUOTE_VERSION') {
    branches.push(`${light} WHERE ${condition}`);
    args.push(m.agencyId, caseId, ...g.args);
  }
  if (q.source !== 'PRICE_REVISION') {
    branches.push(`${legacy} WHERE ${condition} AND s.context_kind='RENEWAL'`);
    args.push(m.agencyId, caseId, ...g.args);
  }
  let after = '';
  if (cursor) {
    after = 'WHERE (sortAt>? OR(sortAt=? AND source>?) OR(sortAt=? AND source=? AND sortId>?))';
    args.push(cursor[1], cursor[1], cursor[2], cursor[1], cursor[2], cursor[3]);
  }
  const rows = (
    await db.batch<PriceRow>([
      db
        .prepare(
          `SELECT * FROM (${branches.join(' UNION ALL ')}) ${after} ORDER BY sortAt,source,sortId LIMIT ?`,
        )
        .bind(...args, q.limit + 1),
    ])
  )[0]!.results;
  const selected = rows.slice(0, q.limit),
    last = selected.at(-1),
    hasMore = rows.length > q.limit;
  const manageGate = salesGate(ctx, true, false, true);
  const canManage =
    (
      await db.batch([
        db
          .prepare(
            `SELECT 1 ${joins} WHERE s.agency_id=? AND s.id=? AND ${manageGate.sql} AND ${renewalSourceReadGate} AND ${writable}`,
          )
          .bind(m.agencyId, caseId, ...manageGate.args),
      ])
    )[0]!.results.length > 0;
  return {
    items: selected.map(dto),
    hasMore,
    canManage,
    nextCursor:
      hasMore && last
        ? btoa(JSON.stringify([binding, last.sortAt, last.source, last.sortId]))
        : null,
  };
}
const revisionSelect = `SELECT 'PRICE_REVISION' source,sp.insurer_id insurerId,i.name insurerName,v.amount_minor amountMinor,v.currency,v.created_at createdAt,
 sp.id priceId,v.revision_number priceVersion,v.id revisionId,v.revision_number revisionNumber,v.terms_note termsNote,v.offered_start_date offeredStartDate,v.offered_end_date offeredEndDate,
 v.created_at sortAt,v.id sortId,${eventStateSql} eventState ${joins} JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id
 JOIN sales_price_revisions v ON v.agency_id=sp.agency_id AND v.price_id=sp.id JOIN insurers i ON i.agency_id=sp.agency_id AND i.id=sp.insurer_id`;
export async function readSalesPriceHistory(
  db: D1Database,
  ctx: Context,
  caseId: string,
  priceId: string,
  raw: unknown = {},
) {
  const { g, m } = await parent(db, ctx, caseId),
    q = historyQuery.parse(raw),
    binding = await cursorBinding(ctx, caseId, q, priceId),
    cursor = readCursor(q.cursor, binding);
  const args: unknown[] = [m.agencyId, caseId, ...g.args, priceId];
  let after = '';
  if (cursor) {
    if (cursor[2] !== 'PRICE_REVISION') throw new SalesError('INVALID_CURSOR', 400);
    after = 'AND (v.created_at>? OR(v.created_at=? AND v.id>?))';
    args.push(cursor[1], cursor[1], cursor[3]);
  }
  const rows = (
    await db.batch<PriceRow>([
      db
        .prepare(
          `${revisionSelect} WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate} AND sp.id=? ${after} ORDER BY v.created_at,v.id LIMIT ?`,
        )
        .bind(...args, q.limit + 1),
    ])
  )[0]!.results;
  if (!rows.length && !cursor) {
    const existing = await db
      .prepare('SELECT 1 FROM sales_prices WHERE agency_id=? AND case_id=? AND id=?')
      .bind(m.agencyId, caseId, priceId)
      .first();
    if (!existing) throw new SalesError('NOT_FOUND', 404);
  }
  const selected = rows.slice(0, q.limit),
    last = selected.at(-1),
    hasMore = rows.length > q.limit;
  return {
    revisions: selected.map(dto),
    hasMore,
    nextCursor:
      hasMore && last
        ? btoa(JSON.stringify([binding, last.sortAt, 'PRICE_REVISION', last.sortId]))
        : null,
  };
}
export async function readSalesPriceRevision(
  db: D1Database,
  ctx: Context,
  caseId: string,
  priceId: string,
  revisionId: string,
) {
  const { g, m } = await parent(db, ctx, caseId);
  const row = (
    await db.batch<PriceRow>([
      db
        .prepare(
          `${revisionSelect} WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate} AND sp.id=? AND v.id=?`,
        )
        .bind(m.agencyId, caseId, ...g.args, priceId, revisionId),
    ])
  )[0]!.results[0];
  if (!row) throw new SalesError('NOT_FOUND', 404);
  return salesPriceRevisionSchema.parse(dto(row));
}
async function operationProof(
  db: D1Database,
  ctx: Context,
  caseId: string,
  operationId: string,
  write = false,
) {
  const { g, m } = await parent(db, ctx, caseId, write);
  const rows = (
    await db.batch<{
      response_body: string;
      action: string;
      payload_fingerprint: string;
      actor_user_id: string;
      actor_membership_id: string;
      response_status: number;
      responseHash: string;
    }>([
      db
        .prepare(
          `SELECT o.response_body,o.action,o.payload_fingerprint,o.actor_user_id,o.actor_membership_id,o.response_status,json_extract(ae.metadata_json,'$.responseHash') responseHash
     ${joins} JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id
     JOIN operation_receipts o ON o.agency_id=s.agency_id AND o.id=h.receipt_id
     JOIN audit_events ae ON ae.agency_id=o.agency_id AND ae.correlation_id=o.id AND ae.action=o.action AND ae.target_type='sales_cases' AND ae.target_id=s.id
      AND ae.actor_user_id=o.actor_user_id AND ae.actor_membership_id=o.actor_membership_id AND ae.idempotency_key=o.idempotency_key AND ae.outcome='SUCCESS'
     WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate} AND o.id=? AND o.status='COMPLETED'
     AND ((o.action='sales.price.create' AND h.event_code='PRICE_CREATED') OR(o.action='sales.price.revise' AND h.event_code='PRICE_REVISED'))
     AND h.case_version=json_extract(o.response_body,'$.result.caseVersion') AND h.actor_user_id=o.actor_user_id AND h.actor_membership_id=o.actor_membership_id AND h.task_id IS NULL`,
        )
        .bind(m.agencyId, caseId, ...g.args, operationId),
    ])
  )[0]!.results;
  if (rows.length !== 1) throw new SalesError('NOT_FOUND', 404);
  const o = rows[0]!,
    saved = salesPriceReceiptSchema.parse(JSON.parse(o.response_body)),
    r = saved.result;
  const create = o.action === 'sales.price.create';
  const command = (create ? salesPriceCreateSchema : salesPriceReviseSchema).parse(saved.command);
  if (
    r.caseId !== caseId ||
    r.operationId !== operationId ||
    saved.targetId !== caseId ||
    r.caseVersion !== command.expectedCaseVersion + 1 ||
    o.response_status !== (create ? 201 : 200) ||
    saved.priceId !== (create ? null : r.priceId) ||
    r.revisionNumber !== r.priceVersion ||
    r.priceVersion !==
      (create ? 1 : salesPriceReviseSchema.parse(command).expectedPriceVersion + 1) ||
    (await computePayloadHash({
      action: o.action,
      targetId: caseId,
      priceId: saved.priceId,
      input: command,
    })) !== o.payload_fingerprint ||
    (await computePayloadHash(r)) !== o.responseHash
  )
    throw new SalesError('REPLAY_INVALID', 500);
  const revision = await readSalesPriceRevision(db, ctx, caseId, r.priceId, r.revisionId);
  if (
    revision.source !== 'PRICE_REVISION' ||
    revision.revisionNumber !== r.revisionNumber ||
    revision.amountMinor !== command.amountMinor ||
    revision.currency !== command.currency ||
    revision.termsNote !== command.termsNote ||
    JSON.stringify(revision.offeredPeriod) !== JSON.stringify(command.offeredPeriod) ||
    ('insurerId' in command && revision.insurerId !== command.insurerId)
  )
    throw new SalesError('REPLAY_INVALID', 500);
  return { saved, o };
}
export async function salesPriceOperation(
  db: D1Database,
  ctx: Context,
  caseId: string,
  operationId: string,
) {
  return (await operationProof(db, ctx, caseId, operationId)).saved.result;
}
export async function writeSalesPrice(
  db: D1Database,
  ctx: Context,
  caseId: string,
  priceId: string | null,
  raw: unknown,
  key: string,
): Promise<{ data: Result; replayed: boolean }> {
  const create = priceId === null,
    input = (create ? salesPriceCreateSchema : salesPriceReviseSchema).parse(raw),
    m = member(ctx),
    action = create ? 'sales.price.create' : 'sales.price.revise',
    hash = await computePayloadHash({ action, targetId: caseId, priceId, input });
  const receipt = await db
    .prepare(
      'SELECT id,action,payload_fingerprint,actor_membership_id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
    )
    .bind(m.agencyId, ctx.userId, key)
    .first<{
      id: string;
      action: string;
      payload_fingerprint: string;
      actor_membership_id: string;
    }>();
  if (receipt) {
    if (receipt.action !== action || receipt.payload_fingerprint !== hash)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    if (receipt.actor_membership_id !== m.id) throw new SalesError('REPLAY_INVALID', 500);
    const p = await operationProof(db, ctx, caseId, receipt.id, true);
    if (p.o.actor_user_id !== ctx.userId || p.o.actor_membership_id !== m.id)
      throw new SalesError('REPLAY_INVALID', 500);
    return { data: p.saved.result, replayed: true };
  }
  const { row, g } = await parent(db, ctx, caseId, true);
  if (!row.writable || row.version !== input.expectedCaseVersion) throw new SalesError('CONFLICT');
  let insurerId: string,
    priceVersion = 1;
  if (create) insurerId = salesPriceCreateSchema.parse(input).insurerId;
  else {
    const current = await db
      .prepare(
        'SELECT insurer_id,version FROM sales_prices WHERE agency_id=? AND case_id=? AND id=?',
      )
      .bind(m.agencyId, caseId, priceId)
      .first<{ insurer_id: string; version: number }>();
    if (!current) throw new SalesError('NOT_FOUND', 404);
    if (current.version !== salesPriceReviseSchema.parse(input).expectedPriceVersion)
      throw new SalesError('CONFLICT');
    insurerId = current.insurer_id;
    priceVersion = current.version + 1;
  }
  const insurer = await db
    .prepare('SELECT status FROM insurers WHERE agency_id=? AND id=?')
    .bind(m.agencyId, insurerId)
    .first<{ status: string }>();
  if (!insurer || insurer.status !== 'ACTIVE') throw new SalesError('INSURER_NOT_ACTIVE', 400);
  const id = priceId ?? crypto.randomUUID(),
    revisionId = crypto.randomUUID(),
    operationId = crypto.randomUUID(),
    now = new Date().toISOString();
  const data = salesPriceResultSchema.parse({
    operationId,
    caseId,
    caseVersion: input.expectedCaseVersion + 1,
    priceId: id,
    priceVersion,
    revisionId,
    revisionNumber: priceVersion,
  });
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${joins} WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate}) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
      )
      .bind(crypto.randomUUID(), m.agencyId, caseId, ...g.args),
    db
      .prepare(
        `UPDATE sales_cases SET version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=? AND EXISTS(
      SELECT 1 ${joins} JOIN insurers selected ON selected.agency_id=s.agency_id AND selected.id=? AND selected.status='ACTIVE'
      WHERE s.agency_id=? AND s.id=? AND ${g.sql} AND ${renewalSourceReadGate} AND ${writable} AND s.version=?)`,
      )
      .bind(
        now,
        m.agencyId,
        caseId,
        input.expectedCaseVersion,
        insurerId,
        m.agencyId,
        caseId,
        ...g.args,
        input.expectedCaseVersion,
      ),
    db
      .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
      .bind(crypto.randomUUID()),
  ];
  if (create)
    statements.push(
      db
        .prepare(
          'INSERT INTO sales_prices(id,agency_id,case_id,insurer_id,current_revision_id,version,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)',
        )
        .bind(id, m.agencyId, caseId, insurerId, revisionId, now, now),
    );
  else
    statements.push(
      db
        .prepare(
          'UPDATE sales_prices SET current_revision_id=?,version=version+1,updated_at=? WHERE agency_id=? AND case_id=? AND id=? AND version=?',
        )
        .bind(
          revisionId,
          now,
          m.agencyId,
          caseId,
          id,
          salesPriceReviseSchema.parse(input).expectedPriceVersion,
        ),
      db
        .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
        .bind(crypto.randomUUID()),
    );
  statements.push(
    db
      .prepare(
        'INSERT INTO sales_price_revisions(id,agency_id,price_id,revision_number,amount_minor,currency,terms_note,offered_start_date,offered_end_date,created_by_user_id,created_by_membership_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        revisionId,
        m.agencyId,
        id,
        priceVersion,
        input.amountMinor,
        input.currency,
        input.termsNote,
        input.offeredPeriod?.startDate ?? null,
        input.offeredPeriod?.endDate ?? null,
        ctx.userId,
        m.id,
        now,
      ),
    db
      .prepare(
        "INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)",
      )
      .bind(
        operationId,
        m.agencyId,
        ctx.userId,
        m.id,
        action,
        key,
        hash,
        create ? 201 : 200,
        JSON.stringify({ result: data, command: input, targetId: caseId, priceId }),
        now,
        now,
      ),
    db
      .prepare(
        'INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,?,NULL,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        m.agencyId,
        caseId,
        data.caseVersion,
        create ? 'PRICE_CREATED' : 'PRICE_REVISED',
        ctx.userId,
        m.id,
        operationId,
        now,
      ),
  );
  const audit = buildSafeAuditRecord({
    agencyId: m.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: m.id,
    action,
    targetType: 'sales_cases',
    targetId: caseId,
    correlationId: operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: { responseHash: await computePayloadHash(data) },
    createdAt: now,
  });
  statements.push(
    db
      .prepare(
        'INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
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
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const msg = String(error);
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION/.test(msg)) throw new SalesError('FORBIDDEN', 403);
    if (
      /UNIQUE|OPTIMISTIC|SALES_CASE_INVALID|SALES_PRICE_INVALID|SALES_PRICE_REVISION_INVALID/.test(
        msg,
      )
    ) {
      try {
        await parent(db, ctx, caseId, true);
      } catch {
        throw new SalesError('FORBIDDEN', 403);
      }
      const committed = await db
        .prepare(
          'SELECT id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
        )
        .bind(m.agencyId, ctx.userId, key)
        .first();
      if (committed) return writeSalesPrice(db, ctx, caseId, priceId, raw, key);
      if (msg.includes('UNIQUE') && msg.includes('sales_prices'))
        throw new SalesError('INSURER_PRICE_EXISTS');
      throw new SalesError('CONFLICT');
    }
    throw error;
  }
  return { data, replayed: false };
}

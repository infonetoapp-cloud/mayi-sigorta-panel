import { evaluateAuthorization, validateMembershipPermissionRows } from '../auth/authorization';
import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import {
  activeMembership,
  isReceiptRace,
  readReceipt,
  RenewalCommandError,
  type ActiveMembership,
  type ReceiptRow,
} from './commands';
import {
  createRenewalInteractionSchema,
  createRenewalQuoteSchema,
  createRenewalQuoteVersionSchema,
  sendRenewalQuoteSchema,
  previewRenewalWhatsAppSchema,
  openRenewalWhatsAppSchema,
} from './validation';
import {
  buildWhatsAppUrl,
  normalizeWhatsAppPhone,
  WHATSAPP_DEFAULT_MESSAGE,
} from './whatsapp-target';

const OPEN_STATES = [
  'CONTACT_PENDING',
  'CONTACTED',
  'QUOTE_PREPARING',
  'QUOTE_SENT',
  'AWAITING_RESPONSE',
] as const;

type PermissionAction =
  | 'renewal.read'
  | 'policy.read'
  | 'customer.read'
  | 'quote.read'
  | 'quote.manage'
  | 'interaction.read'
  | 'interaction.create';

interface RenewalParent {
  readonly agency_id: string;
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly closed_at: string | null;
  readonly renewal_assignee_membership_id: string | null;
  readonly policy_id: string;
  readonly policy_status: string;
  readonly policy_archived_at: string | null;
  readonly policy_assignee_membership_id: string | null;
  readonly policy_insurer_id: string;
  readonly policy_product_id: string;
  readonly policy_payment_method_id: string;
  readonly policy_start_date: string;
  readonly policy_end_date: string;
  readonly policy_gross_premium_minor: number;
  readonly policy_currency: string;
  readonly policy_installment_count: number | null;
  readonly customer_id: string;
  readonly customer_type: 'INDIVIDUAL' | 'COMPANY';
  readonly customer_archived_at: string | null;
  readonly customer_assignee_membership_id: string | null;
  readonly branch_id: string;
  readonly branch_data_classification: 'GENERAL' | 'HEALTH';
}

interface QuoteRow {
  readonly id: string;
  readonly agency_id: string;
  readonly renewal_id: string;
  readonly status: string;
  readonly current_version_id: string | null;
  readonly accepted_version_id: string | null;
  readonly accepted_policy_id: string | null;
  readonly version: number;
}

interface VersionPayload {
  readonly insurerId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly paymentMethodId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly validUntil: string;
  readonly grossPremiumMinor: number;
  readonly currency: string;
  readonly installmentCount: number | null;
  readonly termsSummary: string | null;
}

interface QuoteMutationResult {
  readonly operationId: string;
  readonly quoteId: string;
  readonly quoteVersionId: string;
  readonly versionNumber: number;
  readonly status: 'DRAFT' | 'SENT';
}

interface InteractionResult {
  readonly operationId: string;
  readonly interactionId: string;
  readonly renewalId: string;
  readonly outcome: 'CONTACT_CONFIRMED' | 'ATTEMPT_NO_RESPONSE' | 'WHATSAPP_OPENED' | 'NOTE';
  readonly occurredAt: string;
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function loadParent(
  db: D1Database,
  agencyId: string,
  renewalId: string,
): Promise<RenewalParent | null> {
  return db
    .prepare(
      `SELECT r.agency_id,r.id,r.state,r.version,r.closed_at,
              r.assignee_membership_id AS renewal_assignee_membership_id,
              p.id AS policy_id,p.status AS policy_status,p.archived_at AS policy_archived_at,
              p.assignee_membership_id AS policy_assignee_membership_id,
              p.insurer_id AS policy_insurer_id,p.product_id AS policy_product_id,
              p.payment_method_id AS policy_payment_method_id,p.start_date AS policy_start_date,
              p.end_date AS policy_end_date,p.gross_premium_minor AS policy_gross_premium_minor,
              p.currency AS policy_currency,p.installment_count AS policy_installment_count,
              c.id AS customer_id,c.type AS customer_type,c.archived_at AS customer_archived_at,
              c.assignee_membership_id AS customer_assignee_membership_id,
              b.id AS branch_id,b.data_classification AS branch_data_classification
       FROM renewal_opportunities r
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       WHERE r.agency_id=? AND r.id=?`,
    )
    .bind(agencyId, renewalId)
    .first<RenewalParent>();
}

function resource(parent: RenewalParent): Record<string, unknown> {
  return {
    agencyId: parent.agency_id,
    assigneeMembershipId: parent.policy_assignee_membership_id,
    branchId: parent.branch_id,
    renewalAssigneeMembershipId: parent.renewal_assignee_membership_id,
    customerAssigneeMembershipId: parent.customer_assignee_membership_id,
  };
}

async function authorize(
  db: D1Database,
  context: AuthenticatedUserContext,
  parent: RenewalParent,
  action: PermissionAction,
): Promise<void> {
  const result = await evaluateAuthorization(db, { context, action, resource: resource(parent) });
  if (result.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
  if (parent.branch_data_classification === 'HEALTH') {
    const health = await evaluateAuthorization(db, {
      context,
      action: 'policy.health.read',
      resource: {
        agencyId: parent.agency_id,
        assigneeMembershipId: parent.policy_assignee_membership_id,
        customerAssigneeMembershipId: parent.customer_assignee_membership_id,
        branchId: parent.branch_id,
      },
    });
    if (health.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
    if (action === 'quote.manage' || action === 'interaction.create') {
      const sensitiveWrite = await evaluateAuthorization(db, {
        context,
        action: action === 'quote.manage' ? 'quote.health.manage' : 'interaction.health.create',
        resource: resource(parent),
      });
      if (sensitiveWrite.decision !== 'ALLOW') throw new RenewalCommandError('FORBIDDEN', 403);
    }
  }
}

function authorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  parent: RenewalParent,
  action: PermissionAction,
  expectedVersion: number | null,
): D1PreparedStatement {
  const actionPermissions =
    action === 'quote.manage'
      ? ['quote.manage', 'quote.read']
      : action === 'interaction.create'
        ? ['interaction.create', 'interaction.read']
        : [action];
  const permissions = [
    ...new Set(['renewal.read', 'policy.read', 'customer.read', ...actionPermissions]),
  ];
  const permissionChecks = permissions
    .map((code) => {
      const recordScope =
        code === 'policy.read'
          ? '(source_policy.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)'
          : code === 'customer.read'
            ? 'c.assignee_membership_id=m.id'
            : '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)';
      return `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions permission
          WHERE permission.membership_id=m.id AND permission.permission_code='${code}'
            AND permission.scope IN ('AGENCY','ASSIGNED')
            AND (permission.scope='AGENCY' OR ${recordScope})))`;
    })
    .join(' AND ');
  const readOnly = action === 'interaction.read' || action === 'quote.read';
  const healthCheck = readOnly
    ? `AND EXISTS(SELECT 1 FROM insurance_branches live_branch
        WHERE live_branch.agency_id=source_policy.agency_id AND live_branch.id=source_policy.branch_id
        AND (live_branch.data_classification='GENERAL' OR (live_branch.data_classification='HEALTH'
          AND EXISTS(SELECT 1 FROM membership_permissions hp WHERE hp.membership_id=m.id
            AND hp.permission_code='sensitive.health.read' AND hp.scope='UNSCOPED'))))`
    : parent.branch_data_classification === 'HEALTH'
      ? `AND EXISTS(SELECT 1 FROM membership_permissions sensitive
          WHERE sensitive.membership_id=m.id AND sensitive.permission_code='sensitive.health.read'
            AND sensitive.scope='UNSCOPED')${
              action === 'quote.manage' || action === 'interaction.create'
                ? ` AND EXISTS(SELECT 1 FROM membership_permissions sensitive_write
                  WHERE sensitive_write.membership_id=m.id
                    AND sensitive_write.permission_code='sensitive.health.write'
                    AND sensitive_write.scope='UNSCOPED')`
                : ''
            }`
      : '';
  const versionCheck = expectedVersion === null ? '1' : 'r.version=?';
  const bindings: unknown[] = [
    crypto.randomUUID(),
    context.identityId,
    parent.id,
    active.id,
    active.agencyId,
    context.userId,
    active.permissionVersion,
    parent.id,
  ];
  if (expectedVersion !== null) bindings.push(expectedVersion);
  if (readOnly) bindings.push(active.type);
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
       SELECT ?,1,CASE WHEN EXISTS(
         SELECT 1 FROM agency_memberships m
         JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
         JOIN auth_identities identity ON identity.user_id=u.id AND identity.id=? AND identity.status='ACTIVE'
         JOIN renewal_opportunities r ON r.agency_id=m.agency_id AND r.id=?
         JOIN policies source_policy ON source_policy.agency_id=r.agency_id AND source_policy.id=r.expiring_policy_id
         JOIN customers c ON c.agency_id=source_policy.agency_id AND c.id=source_policy.customer_id
         WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.status='ACTIVE'
           AND m.permission_version=? AND u.status='ACTIVE' AND a.status='ACTIVE'
           AND r.id=? AND ${versionCheck}
           ${readOnly ? "AND m.type=? AND source_policy.status='ACTIVE' AND source_policy.archived_at IS NULL AND c.archived_at IS NULL" : ''}
           AND ${permissionChecks} ${healthCheck}
       ) THEN 1 ELSE 0 END,'MEMBERSHIP_AUTHORIZED'`,
    )
    .bind(...bindings);
}

// Validate the detached set itself, then pin that exact validated set at disclosure.
// Endpoint equality alone does not prevent invalid A -> evaluator-valid B -> invalid A.
const permissionSnapshotSql = `SELECT COALESCE(json_group_array(json_object('id',id,'membership_id',membership_id,'permission_code',permission_code,'scope',scope)),'[]') AS snapshot
  FROM (SELECT id,membership_id,permission_code,scope FROM membership_permissions WHERE membership_id=? ORDER BY id)`;
async function permissionSnapshot(db: D1Database, context: AuthenticatedUserContext) {
  const row = await db
    .prepare(permissionSnapshotSql)
    .bind(activeMembership(context).id)
    .first<{ snapshot: string }>();
  if (!row || typeof row.snapshot !== 'string') throw new RenewalCommandError('FORBIDDEN', 403);
  const rows: unknown = JSON.parse(row.snapshot);
  const active = activeMembership(context);
  if (
    !Array.isArray(rows) ||
    !validateMembershipPermissionRows(rows, active.id, active.type).success
  )
    throw new RenewalCommandError('FORBIDDEN', 403);
  return row.snapshot;
}
function permissionSnapshotAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  snapshot: string,
) {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN ((${permissionSnapshotSql}) COLLATE BINARY)=? THEN 1 ELSE 0 END,'MEMBERSHIP_AUTHORIZED'`,
    )
    .bind(crypto.randomUUID(), activeMembership(context).id, snapshot);
}

/** Final data and live authority share the request-bound session/D1 boundary. */
async function readBatch<T = unknown>(db: D1Database, statements: D1PreparedStatement[]) {
  try {
    const rows = await db.batch<T>(statements);
    if (rows.some((row) => !row.success)) throw new RenewalCommandError('QUERY_FAILED', 500);
    return rows;
  } catch (error) {
    if (
      /LOCAL_SESSION_REVOKED|MEMBERSHIP_AUTHORIZED|OPTIMISTIC_CONCURRENCY_CONFLICT/.test(
        error instanceof Error ? error.message : '',
      )
    )
      throw new RenewalCommandError('FORBIDDEN', 403);
    throw error;
  }
}

function changesAssertion(db: D1Database, code: string): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), code);
}

function receiptInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  id: string,
  action: string,
  key: string,
  fingerprint: string,
  body: unknown,
  status: number,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operation_receipts
       (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
        status,response_status,response_body,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)`,
    )
    .bind(
      id,
      active.agencyId,
      context.userId,
      active.id,
      action,
      key,
      fingerprint,
      status,
      JSON.stringify(body),
      now,
      now,
    );
}

function auditInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  action: string,
  targetId: string,
  key: string,
  now: string,
  changedFields: readonly string[],
  responseHash?: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action,
    targetType: 'renewal_opportunities',
    targetId,
    correlationId: key,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    createdAt: now,
    metadata: { changedFields, responseHash },
  });
  return db
    .prepare(
      `INSERT INTO audit_events
       (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
        correlation_id,idempotency_key,outcome,metadata_json,created_at)
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
    );
}

function validateKey(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new RenewalCommandError('IDEMPOTENCY_KEY_INVALID', 400);
  return value;
}

function mapWriteError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/MEMBERSHIP_AUTHORIZED|FINAL_AUTHORITY/.test(message))
    throw new RenewalCommandError('FORBIDDEN', 403);
  if (/OPTIMISTIC_CONCURRENCY|RENEWAL_QUOTE|RENEWAL_INTERACTION/.test(message))
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  if (/operation_receipts|IDEMPOTENCY_ROW_REPLACEMENT/.test(message))
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  throw error;
}

async function authorizeParent(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  action: PermissionAction,
): Promise<{ active: ActiveMembership; parent: RenewalParent }> {
  const active = activeMembership(context);
  const parent = await loadParent(db, active.agencyId, renewalId);
  if (!parent) throw new RenewalCommandError('NOT_FOUND', 404);
  await authorize(db, context, parent, 'renewal.read');
  await authorize(db, context, parent, 'policy.read');
  await authorize(db, context, parent, 'customer.read');
  await authorize(db, context, parent, action);
  if (
    parent.policy_status !== 'ACTIVE' ||
    parent.policy_archived_at !== null ||
    parent.customer_archived_at !== null
  ) {
    throw new RenewalCommandError('RENEWAL_PARENT_NOT_ACTIVE', 409);
  }
  return { active, parent };
}

function validateVersionPayload(value: VersionPayload): void {
  if (
    !canonicalDate(value.startDate) ||
    !canonicalDate(value.endDate) ||
    value.endDate <= value.startDate ||
    !canonicalTimestamp(value.validUntil) ||
    value.grossPremiumMinor > Number.MAX_SAFE_INTEGER ||
    (value.installmentCount !== null &&
      (!Number.isSafeInteger(value.installmentCount) ||
        value.installmentCount < 2 ||
        value.installmentCount > 36))
  ) {
    throw new RenewalCommandError('VALIDATION_ERROR', 400);
  }
}

async function validateQuoteCatalogs(
  db: D1Database,
  agencyId: string,
  value: VersionPayload,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT product.insurer_id,product.branch_id,product.status AS product_status,
              insurer.status AS insurer_status,branch.status AS branch_status,
              payment.status AS payment_status,payment.supports_installments,payment.max_installments
       FROM insurance_products product
       JOIN insurers insurer ON insurer.agency_id=product.agency_id AND insurer.id=product.insurer_id
       JOIN insurance_branches branch ON branch.agency_id=product.agency_id AND branch.id=product.branch_id
       JOIN payment_methods payment ON payment.agency_id=product.agency_id AND payment.id=?
       WHERE product.agency_id=? AND product.id=?`,
    )
    .bind(value.paymentMethodId, agencyId, value.productId)
    .first<{
      insurer_id: string;
      branch_id: string;
      product_status: string;
      insurer_status: string;
      branch_status: string;
      payment_status: string;
      supports_installments: number;
      max_installments: number;
    }>();
  if (
    !row ||
    row.insurer_id !== value.insurerId ||
    row.branch_id !== value.branchId ||
    row.product_status !== 'ACTIVE' ||
    row.insurer_status !== 'ACTIVE' ||
    row.branch_status !== 'ACTIVE' ||
    row.payment_status !== 'ACTIVE' ||
    (value.installmentCount !== null &&
      (row.supports_installments !== 1 || value.installmentCount > row.max_installments))
  ) {
    throw new RenewalCommandError('QUOTE_CATALOG_INVALID', 409);
  }
}

function quoteResultFromReceipt(receipt: ReceiptRow): QuoteMutationResult {
  try {
    const result = JSON.parse(receipt.response_body ?? '') as QuoteMutationResult;
    if (
      result.operationId !== receipt.id ||
      typeof result.quoteId !== 'string' ||
      typeof result.quoteVersionId !== 'string' ||
      !Number.isSafeInteger(result.versionNumber) ||
      !['DRAFT', 'SENT'].includes(result.status)
    ) {
      throw new Error('invalid receipt');
    }
    return result;
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

export async function listRenewalQuotes(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
): Promise<{ quotes: unknown[]; defaultVersion: VersionPayload }> {
  const grants = await permissionSnapshot(db, context);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'quote.read');
  const quotes = await db
    .prepare(
      `SELECT q.id,q.status,q.current_version_id,q.accepted_version_id,q.accepted_policy_id,
              q.version,q.created_at,q.updated_at
       FROM renewal_quotes q WHERE q.agency_id=? AND q.renewal_id=? ORDER BY q.created_at,q.id`,
    )
    .bind(active.agencyId, parent.id)
    .all<{
      id: string;
      status: string;
      current_version_id: string | null;
      accepted_version_id: string | null;
      accepted_policy_id: string | null;
      version: number;
      created_at: string;
      updated_at: string;
    }>();
  const statements = [
    authorityAssertion(db, context, active, parent, 'quote.read', null),
    permissionSnapshotAssertion(db, context, grants),
  ];
  for (const quote of quotes.results) {
    const versions = db
      .prepare(
        `SELECT version.id,version.version_number,version.insurer_id,version.product_id,
                product.name AS product_name,version.branch_id,version.payment_method_id,
                version.start_date,version.end_date,version.valid_until,version.gross_premium_minor,
                version.currency,version.installment_count,version.terms_summary,version.created_at
         FROM renewal_quote_versions version
         JOIN insurance_products product
           ON product.agency_id=version.agency_id AND product.id=version.product_id
         WHERE version.agency_id=? AND version.quote_id=? ORDER BY version.version_number`,
      )
      .bind(active.agencyId, quote.id);
    const events = db
      .prepare(
        `SELECT id,quote_version_id,event,operation_receipt_id,accepted_policy_id,occurred_at
         FROM renewal_quote_events WHERE agency_id=? AND quote_id=? ORDER BY occurred_at,id`,
      )
      .bind(active.agencyId, quote.id);
    statements.push(versions, events);
  }
  const pages = await readBatch(db, statements);
  const results = quotes.results.map((quote, index) => ({
    ...quote,
    versions: pages[2 + index * 2]!.results,
    events: pages[3 + index * 2]!.results,
  }));
  const nextStartDate = new Date(`${parent.policy_end_date}T00:00:00.000Z`);
  nextStartDate.setUTCDate(nextStartDate.getUTCDate() + 1);
  const nextEndDate = new Date(nextStartDate);
  nextEndDate.setUTCFullYear(nextEndDate.getUTCFullYear() + 1);
  nextEndDate.setUTCDate(nextEndDate.getUTCDate() - 1);
  return {
    quotes: results,
    defaultVersion: {
      insurerId: parent.policy_insurer_id,
      productId: parent.policy_product_id,
      branchId: parent.branch_id,
      paymentMethodId: parent.policy_payment_method_id,
      startDate: nextStartDate.toISOString().slice(0, 10),
      endDate: nextEndDate.toISOString().slice(0, 10),
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      grossPremiumMinor: parent.policy_gross_premium_minor,
      currency: parent.policy_currency,
      installmentCount: parent.policy_installment_count,
      termsSummary: null,
    },
  };
}

export async function createRenewalQuote(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawKey: string,
): Promise<{ data: QuoteMutationResult; replayed: boolean; status: 201 }> {
  const input = createRenewalQuoteSchema.parse(rawInput);
  const key = validateKey(rawKey);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'quote.manage');
  const fingerprint = await computePayloadHash({
    action: 'renewal.quote.create',
    renewalId,
    input,
  });
  const prior = await readReceipt(db, active, context.userId, key);
  if (prior) {
    if (prior.action !== 'renewal.quote.create' || prior.payload_fingerprint !== fingerprint)
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    const result = quoteResultFromReceipt(prior);
    const proof = await db
      .prepare(
        `SELECT count(*) AS count FROM renewal_quotes q JOIN renewal_quote_versions v
           ON v.agency_id=q.agency_id AND v.quote_id=q.id
         WHERE q.agency_id=? AND q.renewal_id=? AND q.id=? AND v.id=? AND v.version_number=1`,
      )
      .bind(active.agencyId, renewalId, result.quoteId, result.quoteVersionId)
      .first<{ count: number }>();
    if (proof?.count !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    return { data: result, replayed: true, status: 201 };
  }
  if (
    !OPEN_STATES.includes(parent.state as (typeof OPEN_STATES)[number]) ||
    parent.closed_at !== null
  )
    throw new RenewalCommandError('RENEWAL_STATE_CONFLICT', 409);
  if (parent.version !== input.expectedRenewalVersion)
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  validateVersionPayload(input.version);
  if (Date.parse(input.version.validUntil) <= Date.now())
    throw new RenewalCommandError('QUOTE_VALID_UNTIL_INVALID', 409);
  await validateQuoteCatalogs(db, active.agencyId, input.version);
  const quoteId = crypto.randomUUID();
  const quoteVersionId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result: QuoteMutationResult = {
    operationId,
    quoteId,
    quoteVersionId,
    versionNumber: 1,
    status: 'DRAFT',
  };
  try {
    await db.batch([
      authorityAssertion(db, context, active, parent, 'quote.manage', input.expectedRenewalVersion),
      receiptInsert(
        db,
        context,
        active,
        operationId,
        'renewal.quote.create',
        key,
        fingerprint,
        result,
        201,
        now,
      ),
      db
        .prepare(
          `INSERT INTO renewal_quotes
           (id,agency_id,renewal_id,status,current_version_id,accepted_version_id,accepted_policy_id,
            version,created_by_user_id,created_by_membership_id,created_at,updated_at)
           VALUES(?,?,?,'DRAFT',NULL,NULL,NULL,1,?,?,?,?)`,
        )
        .bind(quoteId, active.agencyId, renewalId, context.userId, active.id, now, now),
      changesAssertion(db, 'RENEWAL_QUOTE_CONFLICT'),
      db
        .prepare(
          `INSERT INTO renewal_quote_versions
           (id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,
            start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,
            created_by_user_id,created_by_membership_id,created_at)
           VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          quoteVersionId,
          active.agencyId,
          quoteId,
          input.version.insurerId,
          input.version.productId,
          input.version.branchId,
          input.version.paymentMethodId,
          input.version.startDate,
          input.version.endDate,
          input.version.validUntil,
          input.version.grossPremiumMinor,
          input.version.currency,
          input.version.installmentCount,
          input.version.termsSummary,
          context.userId,
          active.id,
          now,
        ),
      changesAssertion(db, 'RENEWAL_QUOTE_VERSION_INVALID'),
      db
        .prepare(
          `UPDATE renewal_quotes SET current_version_id=?,updated_at=?
           WHERE agency_id=? AND id=? AND renewal_id=? AND status='DRAFT' AND current_version_id IS NULL`,
        )
        .bind(quoteVersionId, now, active.agencyId, quoteId, renewalId),
      changesAssertion(db, 'RENEWAL_QUOTE_CONFLICT'),
      auditInsert(db, context, active, 'renewal.quote.created', renewalId, key, now, [
        'quote_created',
        'quote_version_created',
      ]),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, key);
      if (raced) {
        if (raced.action !== 'renewal.quote.create' || raced.payload_fingerprint !== fingerprint)
          throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
        const replayed = quoteResultFromReceipt(raced);
        return { data: replayed, replayed: true, status: 201 };
      }
    }
    mapWriteError(error);
  }
  return { data: result, replayed: false, status: 201 };
}

export async function createRenewalQuoteVersion(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  quoteId: string,
  rawInput: unknown,
  rawKey: string,
): Promise<{ data: QuoteMutationResult; replayed: boolean; status: 201 }> {
  const input = createRenewalQuoteVersionSchema.parse(rawInput);
  const key = validateKey(rawKey);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'quote.manage');
  const fingerprint = await computePayloadHash({
    action: 'renewal.quote.version.create',
    renewalId,
    quoteId,
    input,
  });
  const prior = await readReceipt(db, active, context.userId, key);
  if (prior) {
    if (
      prior.action !== 'renewal.quote.version.create' ||
      prior.payload_fingerprint !== fingerprint
    )
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    const result = quoteResultFromReceipt(prior);
    const proof = await db
      .prepare(
        `SELECT count(*) AS count FROM renewal_quote_versions v JOIN renewal_quotes q
           ON q.agency_id=v.agency_id AND q.id=v.quote_id
         WHERE q.agency_id=? AND q.renewal_id=? AND q.id=? AND v.id=? AND v.version_number=?`,
      )
      .bind(active.agencyId, renewalId, quoteId, result.quoteVersionId, result.versionNumber)
      .first<{ count: number }>();
    if (proof?.count !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    return { data: result, replayed: true, status: 201 };
  }
  if (
    !OPEN_STATES.includes(parent.state as (typeof OPEN_STATES)[number]) ||
    parent.closed_at !== null
  )
    throw new RenewalCommandError('RENEWAL_STATE_CONFLICT', 409);
  const quote = await db
    .prepare(
      `SELECT id,agency_id,renewal_id,status,current_version_id,accepted_version_id,accepted_policy_id,version
       FROM renewal_quotes WHERE agency_id=? AND renewal_id=? AND id=?`,
    )
    .bind(active.agencyId, renewalId, quoteId)
    .first<QuoteRow>();
  if (!quote) throw new RenewalCommandError('NOT_FOUND', 404);
  if (quote.version !== input.expectedQuoteVersion)
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  if (quote.status === 'ACCEPTED')
    throw new RenewalCommandError('RENEWAL_QUOTE_ACCEPTED_IMMUTABLE', 409);
  const original = await db
    .prepare(
      `SELECT insurer_id,product_id FROM renewal_quote_versions
       WHERE agency_id=? AND quote_id=? AND version_number=1`,
    )
    .bind(active.agencyId, quoteId)
    .first<{ insurer_id: string; product_id: string }>();
  if (
    !original ||
    original.insurer_id !== input.version.insurerId ||
    original.product_id !== input.version.productId
  )
    throw new RenewalCommandError('RENEWAL_QUOTE_IDENTITY_CONFLICT', 409);
  validateVersionPayload(input.version);
  if (Date.parse(input.version.validUntil) <= Date.now())
    throw new RenewalCommandError('QUOTE_VALID_UNTIL_INVALID', 409);
  await validateQuoteCatalogs(db, active.agencyId, input.version);
  const latest = await db
    .prepare(
      'SELECT COALESCE(max(version_number),0) AS version FROM renewal_quote_versions WHERE agency_id=? AND quote_id=?',
    )
    .bind(active.agencyId, quoteId)
    .first<{ version: number }>();
  if (!latest) throw new RenewalCommandError('DATABASE_ERROR', 500);
  const quoteVersionId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const versionNumber = latest.version + 1;
  const now = new Date().toISOString();
  const result: QuoteMutationResult = {
    operationId,
    quoteId,
    quoteVersionId,
    versionNumber,
    status: 'DRAFT',
  };
  try {
    await db.batch([
      authorityAssertion(db, context, active, parent, 'quote.manage', parent.version),
      receiptInsert(
        db,
        context,
        active,
        operationId,
        'renewal.quote.version.create',
        key,
        fingerprint,
        result,
        201,
        now,
      ),
      // Keep receipt race reconciliation first; an identity failure rolls it back too.
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
           SELECT ?,1,CASE WHEN EXISTS(
             SELECT 1 FROM renewal_quotes q JOIN renewal_quote_versions original
               ON original.agency_id=q.agency_id AND original.quote_id=q.id
             WHERE q.agency_id=? AND q.renewal_id=? AND q.id=?
               AND original.version_number=1 AND original.insurer_id=? AND original.product_id=?
           ) THEN 1 ELSE 0 END,'RENEWAL_QUOTE_IDENTITY_CONFLICT'`,
        )
        .bind(
          crypto.randomUUID(),
          active.agencyId,
          renewalId,
          quoteId,
          input.version.insurerId,
          input.version.productId,
        ),
      db
        .prepare(
          `INSERT INTO renewal_quote_versions
           (id,agency_id,quote_id,version_number,insurer_id,product_id,branch_id,payment_method_id,
            start_date,end_date,valid_until,gross_premium_minor,currency,installment_count,terms_summary,
            created_by_user_id,created_by_membership_id,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          quoteVersionId,
          active.agencyId,
          quoteId,
          versionNumber,
          input.version.insurerId,
          input.version.productId,
          input.version.branchId,
          input.version.paymentMethodId,
          input.version.startDate,
          input.version.endDate,
          input.version.validUntil,
          input.version.grossPremiumMinor,
          input.version.currency,
          input.version.installmentCount,
          input.version.termsSummary,
          context.userId,
          active.id,
          now,
        ),
      changesAssertion(db, 'RENEWAL_QUOTE_VERSION_INVALID'),
      db
        .prepare(
          `UPDATE renewal_quotes SET current_version_id=?,status='DRAFT',version=version+1,updated_at=?
           WHERE agency_id=? AND renewal_id=? AND id=? AND version=? AND status<>'ACCEPTED'`,
        )
        .bind(quoteVersionId, now, active.agencyId, renewalId, quoteId, input.expectedQuoteVersion),
      changesAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      auditInsert(db, context, active, 'renewal.quote.version.created', renewalId, key, now, [
        'quote_version_created',
        'quote_current_version_changed',
      ]),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, key);
      if (raced) {
        if (
          raced.action !== 'renewal.quote.version.create' ||
          raced.payload_fingerprint !== fingerprint
        )
          throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
        return { data: quoteResultFromReceipt(raced), replayed: true, status: 201 };
      }
    }
    mapWriteError(error);
  }
  return { data: result, replayed: false, status: 201 };
}

export async function sendRenewalQuote(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  quoteId: string,
  rawInput: unknown,
  rawKey: string,
): Promise<{ data: QuoteMutationResult; replayed: boolean; status: 201 }> {
  const input = sendRenewalQuoteSchema.parse(rawInput);
  const key = validateKey(rawKey);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'quote.manage');
  const fingerprint = await computePayloadHash({
    action: 'renewal.quote.send',
    renewalId,
    quoteId,
    input,
  });
  const prior = await readReceipt(db, active, context.userId, key);
  if (prior) {
    if (prior.action !== 'renewal.quote.send' || prior.payload_fingerprint !== fingerprint)
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    const result = quoteResultFromReceipt(prior);
    const proof = await db
      .prepare(
        `SELECT count(*) AS count FROM renewal_quote_events WHERE agency_id=? AND quote_id=?
           AND quote_version_id=? AND event='SENT' AND operation_receipt_id=?`,
      )
      .bind(active.agencyId, quoteId, input.quoteVersionId, prior.id)
      .first<{ count: number }>();
    if (proof?.count !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    return { data: result, replayed: true, status: 201 };
  }
  const quote = await db
    .prepare(
      `SELECT id,agency_id,renewal_id,status,current_version_id,accepted_version_id,accepted_policy_id,version
       FROM renewal_quotes WHERE agency_id=? AND renewal_id=? AND id=?`,
    )
    .bind(active.agencyId, renewalId, quoteId)
    .first<QuoteRow>();
  if (!quote) throw new RenewalCommandError('NOT_FOUND', 404);
  if (
    quote.version !== input.expectedQuoteVersion ||
    quote.current_version_id !== input.quoteVersionId
  )
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  if (!['DRAFT', 'READY'].includes(quote.status))
    throw new RenewalCommandError('RENEWAL_QUOTE_STATE_CONFLICT', 409);
  const version = await db
    .prepare(
      `SELECT id,version_number,valid_until FROM renewal_quote_versions WHERE agency_id=? AND quote_id=? AND id=?`,
    )
    .bind(active.agencyId, quoteId, input.quoteVersionId)
    .first<{ id: string; version_number: number; valid_until: string }>();
  if (!version) throw new RenewalCommandError('NOT_FOUND', 404);
  if (Date.parse(version.valid_until) <= Date.now())
    throw new RenewalCommandError('QUOTE_EXPIRED', 409);
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result: QuoteMutationResult = {
    operationId,
    quoteId,
    quoteVersionId: input.quoteVersionId,
    versionNumber: version.version_number,
    status: 'SENT',
  };
  try {
    await db.batch([
      authorityAssertion(db, context, active, parent, 'quote.manage', parent.version),
      receiptInsert(
        db,
        context,
        active,
        operationId,
        'renewal.quote.send',
        key,
        fingerprint,
        result,
        201,
        now,
      ),
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
           SELECT ?,1,CASE WHEN EXISTS(
             SELECT 1 FROM renewal_quotes q JOIN renewal_quote_versions v
               ON v.agency_id=q.agency_id AND v.quote_id=q.id AND v.id=q.current_version_id
             WHERE q.agency_id=? AND q.renewal_id=? AND q.id=? AND v.id=?
               AND length(v.valid_until)=24
               AND strftime('%Y-%m-%dT%H:%M:%fZ',v.valid_until)=v.valid_until COLLATE BINARY
               AND v.valid_until COLLATE BINARY > strftime('%Y-%m-%dT%H:%M:%fZ','now')
           ) THEN 1 ELSE 0 END,'RENEWAL_QUOTE_EXPIRED'`,
        )
        .bind(crypto.randomUUID(), active.agencyId, renewalId, quoteId, input.quoteVersionId),
      db
        .prepare(
          `INSERT INTO renewal_quote_events
           (id,agency_id,quote_id,quote_version_id,event,operation_receipt_id,accepted_policy_id,
            actor_user_id,actor_membership_id,occurred_at)
           VALUES(?,?,?,?,'SENT',?,NULL,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          active.agencyId,
          quoteId,
          input.quoteVersionId,
          operationId,
          context.userId,
          active.id,
          now,
        ),
      changesAssertion(db, 'RENEWAL_QUOTE_EVENT_INVALID'),
      db
        .prepare(
          `UPDATE renewal_quotes SET status='SENT',version=version+1,updated_at=?
           WHERE agency_id=? AND renewal_id=? AND id=? AND current_version_id=? AND version=?
             AND status IN ('DRAFT','READY')`,
        )
        .bind(
          now,
          active.agencyId,
          renewalId,
          quoteId,
          input.quoteVersionId,
          input.expectedQuoteVersion,
        ),
      changesAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
      auditInsert(db, context, active, 'renewal.quote.sent', renewalId, key, now, ['quote_sent']),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, key);
      if (raced) {
        if (raced.action !== 'renewal.quote.send' || raced.payload_fingerprint !== fingerprint)
          throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
        return { data: quoteResultFromReceipt(raced), replayed: true, status: 201 };
      }
    }
    mapWriteError(error);
  }
  return { data: result, replayed: false, status: 201 };
}

// Shared customer workspace deliberately has no task joins, due times, IDs or workloads.
export async function listCustomerRenewals(
  context: AuthenticatedUserContext,
  db: D1Database,
  customerId: string,
  after = '',
  limit = 20,
  includePolicyId = false,
) {
  const grants = await permissionSnapshot(db, context);
  const active = activeMembership(context);
  const scopes: Record<string, string> = {};
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (after && !/^[A-Za-z0-9_.:-]{1,128}$/.test(after))
  )
    throw new RenewalCommandError('VALIDATION_ERROR', 400);
  for (const action of ['customer.read', 'policy.read', 'renewal.read'] as const) {
    const result = await evaluateAuthorization(db, {
      context,
      action,
      resource: { agencyId: active.agencyId, isCollection: true },
    });
    if (result.decision !== 'ALLOW' || !result.effectiveScope)
      throw new RenewalCommandError('FORBIDDEN', 403);
    scopes[action] = result.effectiveScope;
  }
  const health = await evaluateAuthorization(db, {
    context,
    action: 'policy.health.read',
    resource: { agencyId: active.agencyId, isCollection: true },
  });
  const predicates = [
    'r.agency_id=?',
    'p.customer_id=?',
    'r.id>?',
    'c.archived_at IS NULL',
    'p.archived_at IS NULL',
    'm.id=?',
    'm.user_id=?',
    "m.status='ACTIVE'",
    "u.status='ACTIVE'",
    "a.status='ACTIVE'",
    'm.permission_version=?',
    "EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')",
  ];
  const values: unknown[] = [
    active.agencyId,
    customerId,
    after,
    active.id,
    context.userId,
    active.permissionVersion,
    context.identityId,
  ];
  for (const [code, scope] of Object.entries(scopes)) {
    const assigned =
      code === 'customer.read'
        ? 'c.assignee_membership_id=m.id'
        : code === 'policy.read'
          ? '(p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)'
          : '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)';
    predicates.push(
      `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp WHERE mp.membership_id=m.id AND mp.permission_code=? AND mp.scope=?))`,
    );
    values.push(code, scope);
    if (scope === 'ASSIGNED') predicates.push(assigned);
  }
  if (health.decision !== 'ALLOW') predicates.push("b.data_classification='GENERAL'");
  else {
    predicates.push(
      `(b.data_classification='GENERAL' OR EXISTS(SELECT 1 FROM membership_permissions hp WHERE hp.membership_id=m.id AND hp.permission_code='sensitive.health.read' AND hp.scope='UNSCOPED'))`,
    );
    if (health.effectiveScope === 'ASSIGNED')
      predicates.push(
        "(b.data_classification='GENERAL' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)",
      );
  }
  const query = db
    .prepare(
      `SELECT r.id,r.state,r.version,p.id AS policyId,p.policy_number AS policyNumber,p.end_date AS policyEndDate
    FROM renewal_opportunities r
    JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
    JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    JOIN agency_memberships m ON m.agency_id=r.agency_id
    JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
    WHERE ${predicates.join(' AND ')} ORDER BY r.id LIMIT ?`,
    )
    .bind(...values, limit + 1);
  const [, result] = await readBatch<{
    id: string;
    state: string;
    version: number;
    policyNumber: string;
    policyEndDate: string;
    policyId: string;
  }>(db, [permissionSnapshotAssertion(db, context, grants), query]);
  if (!result?.success) throw new RenewalCommandError('QUERY_FAILED', 500);
  const items = result.results
    .slice(0, limit)
    .map(({ policyId, ...row }) => (includePolicyId ? { ...row, policyId } : row));
  return { items, nextCursor: result.results.length > limit ? items.at(-1)!.id : null };
}

export async function listRenewalInteractions(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
): Promise<{
  interactions: unknown[];
  lastContactAt: string | null;
  lastAttemptAt: string | null;
  customerType: 'INDIVIDUAL' | 'COMPANY';
  companyContacts: Array<{ id: string; displayName: string; role: string | null }>;
}> {
  const grants = await permissionSnapshot(db, context);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'interaction.read');
  const interactionsQuery = db
    .prepare(
      `SELECT i.id,i.outcome,i.channel,i.occurred_at,i.company_contact_id,i.note,
          u.display_name AS author_name
       FROM renewal_interactions i
       LEFT JOIN agency_memberships author ON author.agency_id=i.agency_id
         AND author.id=i.actor_membership_id AND author.user_id=i.actor_user_id
       LEFT JOIN users u ON u.id=author.user_id
       WHERE i.agency_id=? AND i.renewal_id=? ORDER BY i.occurred_at,i.id`,
    )
    .bind(active.agencyId, parent.id);
  const lastContactQuery = db
    .prepare(
      `SELECT max(occurred_at) AS occurred_at FROM renewal_interactions
       WHERE agency_id=? AND renewal_id=? AND outcome='CONTACT_CONFIRMED'`,
    )
    .bind(active.agencyId, parent.id);
  const lastAttemptQuery = db
    .prepare(
      `SELECT max(occurred_at) AS occurred_at FROM renewal_interactions
       WHERE agency_id=? AND renewal_id=? AND outcome IN ('ATTEMPT_NO_RESPONSE','WHATSAPP_OPENED')`,
    )
    .bind(active.agencyId, parent.id);
  const contactsQuery = db
    .prepare(
      `SELECT id,trim(first_name || ' ' || last_name) AS display_name,role
             FROM company_contacts WHERE agency_id=? AND customer_id=? AND status='ACTIVE' AND ?='COMPANY'
             ORDER BY is_primary DESC,last_name,first_name,id`,
    )
    .bind(active.agencyId, parent.customer_id, parent.customer_type);
  const pages = await readBatch(db, [
    authorityAssertion(db, context, active, parent, 'interaction.read', null),
    interactionsQuery,
    lastContactQuery,
    lastAttemptQuery,
    contactsQuery,
    permissionSnapshotAssertion(db, context, grants),
  ]);
  const result = pages[1]!;
  const lastContact = pages[2]!.results[0] as { occurred_at: string | null } | undefined;
  const lastAttempt = pages[3]!.results[0] as { occurred_at: string | null } | undefined;
  const contacts = pages[4]!.results as Array<{
    id: string;
    display_name: string;
    role: string | null;
  }>;
  return {
    interactions: result.results,
    lastContactAt: lastContact?.occurred_at ?? null,
    lastAttemptAt: lastAttempt?.occurred_at ?? null,
    customerType: parent.customer_type,
    companyContacts: contacts.map((contact) => ({
      id: contact.id,
      displayName: contact.display_name,
      role: contact.role,
    })),
  };
}

interface WhatsAppContact {
  readonly phone: string;
  readonly rawPhone: string;
  readonly companyContactId: string | null;
}

async function resolveWhatsAppContact(
  db: D1Database,
  parent: RenewalParent,
  companyContactId: string | null,
): Promise<WhatsAppContact> {
  if (parent.customer_type === 'COMPANY' && !companyContactId)
    throw new RenewalCommandError('COMPANY_CONTACT_REQUIRED', 409);
  if (parent.customer_type === 'INDIVIDUAL' && companyContactId)
    throw new RenewalCommandError('COMPANY_CONTACT_NOT_ALLOWED', 409);
  const row = companyContactId
    ? await db
        .prepare(
          `SELECT phone FROM company_contacts
        WHERE agency_id=? AND customer_id=? AND id=? AND status='ACTIVE'`,
        )
        .bind(parent.agency_id, parent.customer_id, companyContactId)
        .first<{ phone: string | null }>()
    : await db
        .prepare(`SELECT phone FROM customers WHERE agency_id=? AND id=? AND archived_at IS NULL`)
        .bind(parent.agency_id, parent.customer_id)
        .first<{ phone: string | null }>();
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  return { phone: normalizeWhatsAppPhone(row.phone), rawPhone: row.phone!, companyContactId };
}

export async function previewRenewalWhatsApp(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
): Promise<{
  phone: string;
  message: string;
  url: string;
  companyContactId: string | null;
  expectedRenewalVersion: number;
}> {
  const input = previewRenewalWhatsAppSchema.parse(rawInput);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'interaction.create');
  const contact = await resolveWhatsAppContact(db, parent, input.companyContactId);
  const live = await whatsAppAuthorityStatement(
    db,
    context,
    parent,
    active,
    contact,
    parent.version,
    false,
  ).first<{ authorized: number }>();
  if (live?.authorized !== 1) throw new RenewalCommandError('FORBIDDEN', 403);
  return {
    phone: contact.phone,
    message: WHATSAPP_DEFAULT_MESSAGE,
    url: buildWhatsAppUrl(contact.phone, WHATSAPP_DEFAULT_MESSAGE),
    companyContactId: contact.companyContactId,
    expectedRenewalVersion: parent.version,
  };
}

function whatsAppAuthorityStatement(
  db: D1Database,
  context: AuthenticatedUserContext,
  parent: RenewalParent,
  active: ActiveMembership,
  contact: WhatsAppContact,
  expectedVersion: number | null,
  mutating: boolean,
): D1PreparedStatement {
  const permissions = [
    'renewal.read',
    'policy.read',
    'customer.read',
    'interaction.read',
    'interaction.create',
  ];
  const permissionChecks = permissions
    .map((code) => {
      const scope =
        code === 'customer.read'
          ? 'c.assignee_membership_id=m.id'
          : code === 'policy.read'
            ? '(p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)'
            : '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)';
      return `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions permission
      WHERE permission.membership_id=m.id AND permission.permission_code='${code}'
        AND permission.scope IN ('AGENCY','ASSIGNED') AND (permission.scope='AGENCY' OR ${scope})))`;
    })
    .join(' AND ');
  const prefix = mutating
    ? 'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN'
    : 'SELECT CASE WHEN';
  const suffix = mutating
    ? "THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'"
    : 'THEN 1 ELSE 0 END AS authorized';
  const args: unknown[] = mutating ? [crypto.randomUUID()] : [];
  return db
    .prepare(
      `${prefix} EXISTS(
      SELECT 1 FROM renewal_opportunities r
      JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
      JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
      JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
      JOIN agency_memberships m ON m.agency_id=r.agency_id AND m.id=?
      JOIN users u ON u.id=m.user_id AND u.status='ACTIVE'
      JOIN agencies a ON a.id=m.agency_id AND a.status='ACTIVE'
      JOIN auth_identities identity ON identity.user_id=u.id AND identity.id=? AND identity.status='ACTIVE'
      WHERE r.agency_id=? AND r.id=? AND c.id=? AND c.type=?
        AND m.user_id=? AND m.status='ACTIVE' AND m.type=? AND m.permission_version=?
        AND (? IS NULL OR r.version=?) AND ${permissionChecks}
        AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL
        AND b.id=? AND b.data_classification=?
        AND (b.data_classification='GENERAL' OR (
          EXISTS(SELECT 1 FROM membership_permissions health WHERE health.membership_id=m.id
            AND health.permission_code='sensitive.health.read' AND health.scope='UNSCOPED')
          AND EXISTS(SELECT 1 FROM membership_permissions health WHERE health.membership_id=m.id
            AND health.permission_code='sensitive.health.write' AND health.scope='UNSCOPED')))
        AND (m.type='OWNER' OR EXISTS(
          SELECT 1 FROM membership_permissions direct
          JOIN membership_permissions dependency ON dependency.membership_id=direct.membership_id
            AND dependency.permission_code='interaction.read'
          WHERE direct.membership_id=m.id AND direct.permission_code='interaction.create'
            AND (dependency.scope='AGENCY' OR direct.scope=dependency.scope)))
        AND ((? IS NULL AND c.type='INDIVIDUAL' AND c.phone=?) OR
          (c.type='COMPANY' AND EXISTS(SELECT 1 FROM company_contacts cc
            WHERE cc.agency_id=c.agency_id AND cc.customer_id=c.id AND cc.id=?
              AND cc.status='ACTIVE' AND cc.phone=?)))
    ) ${suffix}`,
    )
    .bind(
      ...args,
      active.id,
      context.identityId,
      parent.agency_id,
      parent.id,
      parent.customer_id,
      parent.customer_type,
      context.userId,
      active.type,
      active.permissionVersion,
      expectedVersion,
      expectedVersion,
      parent.branch_id,
      parent.branch_data_classification,
      contact.companyContactId,
      contact.rawPhone,
      contact.companyContactId,
      contact.rawPhone,
    );
}

const whatsAppReceiptSchema = z
  .object({
    operationId: z.string().uuid(),
    interactionId: z.string().uuid(),
    renewalId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    outcome: z.literal('WHATSAPP_OPENED'),
    occurredAt: z.string().datetime(),
  })
  .strict();

export async function openRenewalWhatsApp(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawKey: string,
): Promise<{ data: InteractionResult & { url: string }; replayed: boolean; status: 201 }> {
  const input = openRenewalWhatsAppSchema.parse(rawInput);
  const key = validateKey(rawKey);
  const { active, parent } = await authorizeParent(context, db, renewalId, 'interaction.create');
  const contact = await resolveWhatsAppContact(db, parent, input.companyContactId);
  if (contact.phone !== input.expectedPhone)
    throw new RenewalCommandError('WHATSAPP_PREVIEW_STALE', 409);
  const url = buildWhatsAppUrl(contact.phone, input.message);
  const fingerprint = await computePayloadHash({
    action: 'renewal.whatsapp.open',
    renewalId,
    input,
  });
  const replay = async (receipt: ReceiptRow) => {
    if (receipt.action !== 'renewal.whatsapp.open' || receipt.payload_fingerprint !== fingerprint)
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    if (receipt.status !== 'COMPLETED' || receipt.response_status !== 201)
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    let data: z.infer<typeof whatsAppReceiptSchema>;
    try {
      data = whatsAppReceiptSchema.parse(JSON.parse(receipt.response_body ?? 'null'));
    } catch {
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    }
    if (
      data.operationId !== receipt.id ||
      data.renewalId !== renewalId ||
      !canonicalTimestamp(data.occurredAt)
    )
      throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    const responseHash = await computePayloadHash(data);
    const proof = await db
      .prepare(
        `SELECT count(*) AS count FROM renewal_interactions i
      JOIN audit_events a ON a.agency_id=i.agency_id AND a.target_id=i.renewal_id
        AND a.target_type='renewal_opportunities' AND a.action='renewal.whatsapp.opened'
        AND a.actor_user_id=i.actor_user_id AND a.actor_membership_id=i.actor_membership_id
        AND a.idempotency_key=? AND a.outcome='SUCCESS' AND a.created_at=i.created_at
        AND json_extract(a.metadata_json,'$.responseHash')=?
      WHERE i.agency_id=? AND i.renewal_id=? AND i.id=? AND i.outcome='WHATSAPP_OPENED'
        AND i.channel='WHATSAPP' AND i.note IS NULL AND i.occurred_at=?
        AND i.customer_id=? AND i.company_contact_id IS ? AND i.actor_user_id=? AND i.actor_membership_id=?`,
      )
      .bind(
        key,
        responseHash,
        active.agencyId,
        renewalId,
        data.interactionId,
        data.occurredAt,
        parent.customer_id,
        contact.companyContactId,
        context.userId,
        active.id,
      )
      .first<{ count: number }>();
    if (proof?.count !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    const live = await whatsAppAuthorityStatement(
      db,
      context,
      parent,
      active,
      contact,
      null,
      false,
    ).first<{ authorized: number }>();
    if (live?.authorized !== 1) throw new RenewalCommandError('FORBIDDEN', 403);
    return { data: { ...data, url }, replayed: true, status: 201 as const };
  };
  const prior = await readReceipt(db, active, context.userId, key);
  if (prior) return replay(prior);
  if (parent.version !== input.expectedRenewalVersion)
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
  const now = new Date().toISOString();
  const data: z.infer<typeof whatsAppReceiptSchema> = {
    operationId: crypto.randomUUID(),
    interactionId: crypto.randomUUID(),
    renewalId,
    outcome: 'WHATSAPP_OPENED',
    occurredAt: now,
  };
  const responseHash = await computePayloadHash(data);
  try {
    await db.batch([
      whatsAppAuthorityStatement(
        db,
        context,
        parent,
        active,
        contact,
        input.expectedRenewalVersion,
        true,
      ),
      receiptInsert(
        db,
        context,
        active,
        data.operationId,
        'renewal.whatsapp.open',
        key,
        fingerprint,
        data,
        201,
        now,
      ),
      db
        .prepare(
          `INSERT INTO renewal_interactions
        (id,agency_id,renewal_id,customer_id,company_contact_id,outcome,channel,note,occurred_at,
          actor_user_id,actor_membership_id,created_at)
        VALUES(?,?,?,?,?,'WHATSAPP_OPENED','WHATSAPP',NULL,?,?,?,?)`,
        )
        .bind(
          data.interactionId,
          active.agencyId,
          renewalId,
          parent.customer_id,
          contact.companyContactId,
          now,
          context.userId,
          active.id,
          now,
        ),
      changesAssertion(db, 'RENEWAL_INTERACTION_CONFLICT'),
      auditInsert(
        db,
        context,
        active,
        'renewal.whatsapp.opened',
        renewalId,
        key,
        now,
        ['whatsapp_opened'],
        responseHash,
      ),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, key);
      if (raced) return replay(raced);
    }
    mapWriteError(error);
  }
  return { data: { ...data, url }, replayed: false, status: 201 };
}

export async function createRenewalInteraction(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  rawInput: unknown,
  rawKey: string,
): Promise<{ data: InteractionResult; replayed: boolean; status: 201 }> {
  const input = createRenewalInteractionSchema.parse(rawInput);
  const key = validateKey(rawKey);
  if (!canonicalTimestamp(input.occurredAt))
    throw new RenewalCommandError('INTERACTION_TIMESTAMP_INVALID', 400);
  const normalized = {
    outcome: input.outcome,
    channel: input.channel,
    occurredAt: input.occurredAt,
    companyContactId: input.companyContactId ?? null,
    note: input.note ?? null,
  };
  const { active, parent } = await authorizeParent(context, db, renewalId, 'interaction.create');
  const fingerprint = await computePayloadHash({
    action: 'renewal.interaction.create',
    renewalId,
    input: normalized,
  });
  const prior = await readReceipt(db, active, context.userId, key);
  if (prior) {
    if (prior.action !== 'renewal.interaction.create' || prior.payload_fingerprint !== fingerprint)
      throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
    const data = JSON.parse(prior.response_body ?? 'null') as InteractionResult;
    const proof = await db
      .prepare(
        'SELECT count(*) AS count FROM renewal_interactions WHERE agency_id=? AND renewal_id=? AND id=? AND outcome=? AND occurred_at=?',
      )
      .bind(active.agencyId, renewalId, data.interactionId, data.outcome, data.occurredAt)
      .first<{ count: number }>();
    if (proof?.count !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
    return { data, replayed: true, status: 201 };
  }
  if (parent.customer_type === 'COMPANY' && !normalized.companyContactId)
    throw new RenewalCommandError('COMPANY_CONTACT_REQUIRED', 409);
  if (parent.customer_type === 'INDIVIDUAL' && normalized.companyContactId)
    throw new RenewalCommandError('COMPANY_CONTACT_NOT_ALLOWED', 409);
  const interactionId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const data: InteractionResult = {
    operationId,
    interactionId,
    renewalId,
    outcome: input.outcome,
    occurredAt: input.occurredAt,
  };
  try {
    await db.batch([
      authorityAssertion(db, context, active, parent, 'interaction.create', parent.version),
      receiptInsert(
        db,
        context,
        active,
        operationId,
        'renewal.interaction.create',
        key,
        fingerprint,
        data,
        201,
        now,
      ),
      db
        .prepare(
          `INSERT INTO renewal_interactions
           (id,agency_id,renewal_id,customer_id,company_contact_id,outcome,channel,note,occurred_at,
            actor_user_id,actor_membership_id,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          interactionId,
          active.agencyId,
          renewalId,
          parent.customer_id,
          normalized.companyContactId,
          normalized.outcome,
          normalized.channel,
          normalized.note,
          normalized.occurredAt,
          context.userId,
          active.id,
          now,
        ),
      changesAssertion(db, 'RENEWAL_INTERACTION_CONFLICT'),
      auditInsert(db, context, active, 'renewal.interaction.created', renewalId, key, now, [
        'interaction_created',
        'interaction_outcome',
      ]),
    ]);
  } catch (error) {
    if (isReceiptRace(error)) {
      const raced = await readReceipt(db, active, context.userId, key);
      if (raced) {
        if (
          raced.action !== 'renewal.interaction.create' ||
          raced.payload_fingerprint !== fingerprint
        )
          throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
        return {
          data: JSON.parse(raced.response_body ?? 'null') as InteractionResult,
          replayed: true,
          status: 201,
        };
      }
    }
    mapWriteError(error);
  }
  return { data, replayed: false, status: 201 };
}

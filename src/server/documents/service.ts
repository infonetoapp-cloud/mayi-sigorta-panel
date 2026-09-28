import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import { IdempotencyConflictError } from '../mutations/idempotency';
import {
  DocumentQuarantineError,
  createQuarantineObjectKey,
  prepareQuarantinedDocumentObject,
  writePreparedQuarantinedDocumentObject,
} from './quarantine';

const uploadInputSchema = z
  .object({
    ownerType: z.enum(['CUSTOMER', 'POLICY', 'QUOTE']),
    ownerId: z.string().trim().min(1).max(128),
    classification: z.enum(['GENERAL', 'IDENTITY', 'HEALTH']),
    fileName: z.string().min(1).max(1024),
    declaredContentType: z.string().min(1).max(128),
    file: z.instanceof(Blob),
  })
  .strict();

export type DocumentUploadInput = z.infer<typeof uploadInputSchema>;

export interface DocumentUploadOptions {
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface DocumentUploadReceipt {
  readonly documentId: string;
  readonly versionId: string;
  readonly classification: 'GENERAL' | 'IDENTITY' | 'HEALTH';
  readonly versionNumber: 1;
  readonly state: 'QUARANTINED';
}

export interface DocumentUploadResult {
  readonly status: 202;
  readonly body: DocumentUploadReceipt;
  readonly replayed: boolean;
}

export type DocumentUploadErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CLASSIFICATION_PARENT_MISMATCH'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'UPLOAD_RETRYABLE'
  | 'SERVICE_UNAVAILABLE';

export class DocumentUploadError extends Error {
  constructor(
    readonly code: DocumentUploadErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 503,
  ) {
    super(code);
    this.name = 'DocumentUploadError';
  }
}

interface ActiveMembershipSnapshot {
  readonly id: string;
  readonly agencyId: string;
  readonly type: 'OWNER' | 'MEMBER';
  readonly status: 'ACTIVE';
  readonly permissionVersion: number;
}

interface DocumentParentSnapshot {
  readonly ownerType: 'CUSTOMER' | 'POLICY' | 'QUOTE';
  readonly ownerId: string;
  readonly agencyId: string;
  readonly parentReadScope: 'ASSIGNED' | 'AGENCY';
  readonly policyHealthReadScope: 'ASSIGNED' | 'AGENCY' | null;
  readonly quoteReadScope: 'ASSIGNED' | 'AGENCY' | null;
  readonly parentHealth: boolean;
  readonly branchClassification: 'GENERAL' | 'HEALTH' | null;
  readonly assigneeMembershipId: string | null;
  readonly customerAssigneeMembershipId: string | null;
  readonly renewalAssigneeMembershipId: string | null;
}

interface IdempotencyReceiptRow {
  readonly id: unknown;
  readonly action: unknown;
  readonly status: unknown;
  readonly payload_fingerprint: unknown;
  readonly response_status: unknown;
  readonly response_body: unknown;
}

interface UploadReservation {
  readonly kind: 'DOCUMENT_UPLOAD_RESERVATION';
  readonly documentId: string;
  readonly versionId: string;
  readonly objectKey: string;
  readonly correlationId: string;
}

interface StoredUploadRow {
  readonly document_id: unknown;
  readonly agency_id: unknown;
  readonly owner_type: unknown;
  readonly customer_id: unknown;
  readonly policy_id: unknown;
  readonly quote_id: unknown;
  readonly classification: unknown;
  readonly document_status: unknown;
  readonly created_by_user_id: unknown;
  readonly created_by_membership_id: unknown;
  readonly version_id: unknown;
  readonly version_number: unknown;
  readonly object_key: unknown;
  readonly sha256: unknown;
  readonly size_bytes: unknown;
  readonly file_name: unknown;
  readonly declared_content_type: unknown;
  readonly detected_content_type: unknown;
  readonly version_status: unknown;
}

function activeMembership(context: AuthenticatedUserContext): ActiveMembershipSnapshot {
  const membership = context.memberships[0];
  if (
    !membership ||
    membership.status !== 'ACTIVE' ||
    (membership.type !== 'OWNER' && membership.type !== 'MEMBER') ||
    typeof membership.id !== 'string' ||
    membership.id.trim() === '' ||
    typeof membership.agencyId !== 'string' ||
    membership.agencyId.trim() === '' ||
    !Number.isSafeInteger(membership.permissionVersion) ||
    membership.permissionVersion < 1
  ) {
    throw new DocumentUploadError('FORBIDDEN', 403);
  }
  return Object.freeze({
    id: membership.id,
    agencyId: membership.agencyId,
    type: membership.type,
    status: 'ACTIVE',
    permissionVersion: membership.permissionVersion,
  });
}

function effectiveScope(
  result: Awaited<ReturnType<typeof evaluateAuthorization>>,
): 'ASSIGNED' | 'AGENCY' {
  if (result.decision !== 'ALLOW') {
    if (result.code === 'DATABASE_ERROR') throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
    throw new DocumentUploadError('NOT_FOUND', 404);
  }
  if (result.effectiveScope === 'ASSIGNED' || result.effectiveScope === 'AGENCY') {
    return result.effectiveScope;
  }
  throw new DocumentUploadError('NOT_FOUND', 404);
}

function narrowScope(left: 'ASSIGNED' | 'AGENCY', right: 'ASSIGNED' | 'AGENCY') {
  return left === 'ASSIGNED' || right === 'ASSIGNED' ? 'ASSIGNED' : 'AGENCY';
}

function uploadAction(classification: DocumentUploadInput['classification']): string {
  if (classification === 'IDENTITY') return 'document.identity.upload';
  if (classification === 'HEALTH') return 'document.health.upload';
  return 'document.upload';
}

function parentDocumentFields(parent: DocumentParentSnapshot) {
  return {
    ownerType: parent.ownerType,
    customerId: parent.ownerType === 'CUSTOMER' ? parent.ownerId : null,
    policyId: parent.ownerType === 'POLICY' ? parent.ownerId : null,
    quoteId: parent.ownerType === 'QUOTE' ? parent.ownerId : null,
    ...(parent.assigneeMembershipId !== null
      ? { assigneeMembershipId: parent.assigneeMembershipId }
      : {}),
    ...(parent.customerAssigneeMembershipId !== null
      ? { customerAssigneeMembershipId: parent.customerAssigneeMembershipId }
      : {}),
    ...(parent.renewalAssigneeMembershipId !== null
      ? { renewalAssigneeMembershipId: parent.renewalAssigneeMembershipId }
      : {}),
  };
}

async function resolveDocumentParent(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembershipSnapshot,
  ownerType: DocumentUploadInput['ownerType'],
  ownerId: string,
): Promise<DocumentParentSnapshot> {
  if (ownerType === 'CUSTOMER') {
    const row = await db
      .prepare(
        `SELECT id,agency_id,assignee_membership_id
         FROM customers WHERE id=? AND agency_id=?`,
      )
      .bind(ownerId, membership.agencyId)
      .first<{ id: unknown; agency_id: unknown; assignee_membership_id: unknown }>();
    if (
      !row ||
      row.id !== ownerId ||
      row.agency_id !== membership.agencyId ||
      typeof row.assignee_membership_id !== 'string' ||
      row.assignee_membership_id.trim() === ''
    ) {
      throw new DocumentUploadError('NOT_FOUND', 404);
    }
    const parentReadScope = effectiveScope(
      await evaluateAuthorization(db, {
        context,
        action: 'customer.read',
        resource: {
          agencyId: membership.agencyId,
          id: row.id,
          assigneeMembershipId: row.assignee_membership_id,
        },
      }),
    );
    return {
      ownerType,
      ownerId,
      agencyId: membership.agencyId,
      parentReadScope,
      policyHealthReadScope: null,
      quoteReadScope: null,
      parentHealth: false,
      branchClassification: null,
      assigneeMembershipId: row.assignee_membership_id,
      customerAssigneeMembershipId: null,
      renewalAssigneeMembershipId: null,
    };
  }

  if (ownerType === 'POLICY') {
    const row = await db
      .prepare(
        `SELECT p.id,p.agency_id,p.assignee_membership_id,
                c.assignee_membership_id AS customer_assignee_membership_id,
                b.data_classification AS branch_data_classification
         FROM policies p
         JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
         JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
         WHERE p.id=? AND p.agency_id=?`,
      )
      .bind(ownerId, membership.agencyId)
      .first<{
        id: unknown;
        agency_id: unknown;
        assignee_membership_id: unknown;
        customer_assignee_membership_id: unknown;
        branch_data_classification: unknown;
      }>();
    if (
      !row ||
      row.id !== ownerId ||
      row.agency_id !== membership.agencyId ||
      typeof row.assignee_membership_id !== 'string' ||
      typeof row.customer_assignee_membership_id !== 'string' ||
      (row.branch_data_classification !== 'GENERAL' && row.branch_data_classification !== 'HEALTH')
    ) {
      throw new DocumentUploadError('NOT_FOUND', 404);
    }
    const parentHealth = row.branch_data_classification === 'HEALTH';
    const parentReadScope = effectiveScope(
      await evaluateAuthorization(db, {
        context,
        action: parentHealth ? 'policy.health.read' : 'policy.read',
        resource: {
          agencyId: membership.agencyId,
          id: row.id,
          assigneeMembershipId: row.assignee_membership_id,
          customerAssigneeMembershipId: row.customer_assignee_membership_id,
        },
      }),
    );
    return {
      ownerType,
      ownerId,
      agencyId: membership.agencyId,
      parentReadScope,
      policyHealthReadScope: parentHealth ? parentReadScope : null,
      quoteReadScope: null,
      parentHealth,
      branchClassification: row.branch_data_classification,
      assigneeMembershipId: row.assignee_membership_id,
      customerAssigneeMembershipId: row.customer_assignee_membership_id,
      renewalAssigneeMembershipId: null,
    };
  }

  const row = await db
    .prepare(
      `SELECT q.id,q.agency_id,r.assignee_membership_id AS renewal_assignee_membership_id,
              p.id AS policy_id,p.assignee_membership_id AS policy_assignee_membership_id,
              c.assignee_membership_id AS customer_assignee_membership_id,
              b.data_classification AS branch_data_classification
       FROM renewal_quotes q
       JOIN renewal_opportunities r ON r.agency_id=q.agency_id AND r.id=q.renewal_id
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       WHERE q.id=? AND q.agency_id=?`,
    )
    .bind(ownerId, membership.agencyId)
    .first<{
      id: unknown;
      agency_id: unknown;
      renewal_assignee_membership_id: unknown;
      policy_id: unknown;
      policy_assignee_membership_id: unknown;
      customer_assignee_membership_id: unknown;
      branch_data_classification: unknown;
    }>();
  if (
    !row ||
    row.id !== ownerId ||
    row.agency_id !== membership.agencyId ||
    (typeof row.renewal_assignee_membership_id !== 'string' &&
      row.renewal_assignee_membership_id !== null) ||
    typeof row.policy_id !== 'string' ||
    typeof row.policy_assignee_membership_id !== 'string' ||
    typeof row.customer_assignee_membership_id !== 'string' ||
    (row.branch_data_classification !== 'GENERAL' && row.branch_data_classification !== 'HEALTH')
  ) {
    throw new DocumentUploadError('NOT_FOUND', 404);
  }
  const parentHealth = row.branch_data_classification === 'HEALTH';
  let policyHealthReadScope: 'ASSIGNED' | 'AGENCY' | null = null;
  if (parentHealth) {
    policyHealthReadScope = effectiveScope(
      await evaluateAuthorization(db, {
        context,
        action: 'policy.health.read',
        resource: {
          agencyId: membership.agencyId,
          id: row.policy_id,
          assigneeMembershipId: row.policy_assignee_membership_id,
          customerAssigneeMembershipId: row.customer_assignee_membership_id,
        },
      }),
    );
  }
  const quoteReadScope = effectiveScope(
    await evaluateAuthorization(db, {
      context,
      action: 'quote.read',
      resource: {
        agencyId: membership.agencyId,
        id: row.id,
        renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
        customerAssigneeMembershipId: row.customer_assignee_membership_id,
      },
    }),
  );
  const parentReadScope = policyHealthReadScope
    ? narrowScope(policyHealthReadScope, quoteReadScope)
    : quoteReadScope;

  return {
    ownerType,
    ownerId,
    agencyId: membership.agencyId,
    parentReadScope,
    policyHealthReadScope,
    quoteReadScope,
    parentHealth,
    branchClassification: row.branch_data_classification,
    assigneeMembershipId: null,
    customerAssigneeMembershipId: row.customer_assignee_membership_id,
    renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
  };
}

async function authorizeDocumentUpload(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembershipSnapshot,
  parent: DocumentParentSnapshot,
  documentId: string,
  classification: DocumentUploadInput['classification'],
): Promise<'ASSIGNED' | 'AGENCY'> {
  const result = await evaluateAuthorization(db, {
    context,
    action: uploadAction(classification),
    resource: {
      agencyId: membership.agencyId,
      id: documentId,
      ...parentDocumentFields(parent),
      parentReadAuthorized: true,
    },
  });
  if (result.decision !== 'ALLOW') {
    if (result.code === 'DATABASE_ERROR') throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
    throw new DocumentUploadError('FORBIDDEN', 403);
  }
  if (result.effectiveScope === 'ASSIGNED' || result.effectiveScope === 'AGENCY') {
    return result.effectiveScope;
  }
  throw new DocumentUploadError('FORBIDDEN', 403);
}

function parentExistenceSql(
  parent: DocumentParentSnapshot,
  assignments: { readonly customer: boolean; readonly policy: boolean; readonly quote: boolean },
) {
  if (parent.ownerType === 'CUSTOMER') {
    return `EXISTS (
      SELECT 1 FROM customers parent
      WHERE parent.agency_id=a.id AND parent.id=?
        ${assignments.customer ? 'AND parent.assignee_membership_id=m.id' : ''}
    )`;
  }
  if (parent.ownerType === 'POLICY') {
    return `EXISTS (
      SELECT 1 FROM policies parent
      JOIN customers customer ON customer.agency_id=parent.agency_id AND customer.id=parent.customer_id
      JOIN insurance_branches branch ON branch.agency_id=parent.agency_id AND branch.id=parent.branch_id
      WHERE parent.agency_id=a.id AND parent.id=? AND branch.data_classification=?
        ${assignments.policy ? 'AND (parent.assignee_membership_id=m.id OR customer.assignee_membership_id=m.id)' : ''}
    )`;
  }
  return `EXISTS (
    SELECT 1 FROM renewal_quotes parent
    JOIN renewal_opportunities renewal ON renewal.agency_id=parent.agency_id AND renewal.id=parent.renewal_id
    JOIN policies policy ON policy.agency_id=renewal.agency_id AND policy.id=renewal.expiring_policy_id
    JOIN customers customer ON customer.agency_id=policy.agency_id AND customer.id=policy.customer_id
    JOIN insurance_branches branch ON branch.agency_id=policy.agency_id AND branch.id=policy.branch_id
    WHERE parent.agency_id=a.id AND parent.id=? AND branch.data_classification=?
      ${assignments.quote ? 'AND (renewal.assignee_membership_id=m.id OR customer.assignee_membership_id=m.id)' : ''}
      ${assignments.policy ? 'AND (policy.assignee_membership_id=m.id OR customer.assignee_membership_id=m.id)' : ''}
  )`;
}

function parentMemberGrantSql(parent: DocumentParentSnapshot) {
  if (parent.ownerType === 'CUSTOMER') {
    return `EXISTS (
      SELECT 1 FROM membership_permissions customer_read
      WHERE customer_read.membership_id=m.id AND customer_read.permission_code='customer.read'
        AND customer_read.scope IN ('ASSIGNED','AGENCY')
    )`;
  }
  if (parent.ownerType === 'POLICY') {
    return `EXISTS (
      SELECT 1 FROM membership_permissions policy_read
      WHERE policy_read.membership_id=m.id AND policy_read.permission_code='policy.read'
        AND policy_read.scope IN ('ASSIGNED','AGENCY')
    )`;
  }
  if (!parent.parentHealth) {
    return `EXISTS (
      SELECT 1 FROM membership_permissions quote_read
      WHERE quote_read.membership_id=m.id AND quote_read.permission_code='quote.read'
        AND quote_read.scope IN ('ASSIGNED','AGENCY')
    )`;
  }
  return `EXISTS (
    SELECT 1 FROM membership_permissions quote_read
    JOIN membership_permissions policy_read ON policy_read.membership_id=quote_read.membership_id
      AND policy_read.permission_code='policy.read' AND policy_read.scope IN ('ASSIGNED','AGENCY')
    WHERE quote_read.membership_id=m.id AND quote_read.permission_code='quote.read'
      AND quote_read.scope IN ('ASSIGNED','AGENCY')
  )`;
}

function sensitiveGrantSql(domain: 'identity' | 'health') {
  return `EXISTS (
    SELECT 1 FROM membership_permissions sensitive_read
    WHERE sensitive_read.membership_id=m.id
      AND sensitive_read.permission_code='sensitive.${domain}.read' AND sensitive_read.scope='UNSCOPED'
  ) AND EXISTS (
    SELECT 1 FROM membership_permissions sensitive_write
    WHERE sensitive_write.membership_id=m.id
      AND sensitive_write.permission_code='sensitive.${domain}.write' AND sensitive_write.scope='UNSCOPED'
  )`;
}

function buildUploadAuthorityAssertion(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembershipSnapshot,
  parent: DocumentParentSnapshot,
  documentScope: 'ASSIGNED' | 'AGENCY',
  classification: DocumentUploadInput['classification'],
): D1PreparedStatement {
  const assignments = {
    customer:
      parent.ownerType === 'CUSTOMER' &&
      (documentScope === 'ASSIGNED' || parent.parentReadScope === 'ASSIGNED'),
    policy:
      parent.ownerType === 'POLICY'
        ? documentScope === 'ASSIGNED' || parent.parentReadScope === 'ASSIGNED'
        : parent.ownerType === 'QUOTE' && parent.policyHealthReadScope === 'ASSIGNED',
    quote:
      parent.ownerType === 'QUOTE' &&
      (documentScope === 'ASSIGNED' || parent.quoteReadScope === 'ASSIGNED'),
  };
  const parentExists = parentExistenceSql(parent, assignments);
  const parentReadScopeSql =
    parent.ownerType === 'CUSTOMER'
      ? `(SELECT customer_read.scope FROM membership_permissions customer_read
          WHERE customer_read.membership_id=m.id AND customer_read.permission_code='customer.read')`
      : parent.ownerType === 'POLICY'
        ? `(SELECT policy_read.scope FROM membership_permissions policy_read
            WHERE policy_read.membership_id=m.id AND policy_read.permission_code='policy.read')`
        : parent.parentHealth
          ? `(CASE WHEN EXISTS (
                  SELECT 1 FROM membership_permissions quote_read
                  WHERE quote_read.membership_id=m.id AND quote_read.permission_code='quote.read'
                    AND quote_read.scope='ASSIGNED'
                ) OR EXISTS (
                  SELECT 1 FROM membership_permissions policy_read
                  WHERE policy_read.membership_id=m.id AND policy_read.permission_code='policy.read'
                    AND policy_read.scope='ASSIGNED'
                ) THEN 'ASSIGNED' ELSE 'AGENCY' END)`
          : `(SELECT quote_read.scope FROM membership_permissions quote_read
              WHERE quote_read.membership_id=m.id AND quote_read.permission_code='quote.read')`;
  const documentScopeSql = `(CASE WHEN EXISTS (
      SELECT 1 FROM membership_permissions upload_scope
      WHERE upload_scope.membership_id=m.id AND upload_scope.permission_code='document.upload'
        AND upload_scope.scope='ASSIGNED'
    ) OR EXISTS (
      SELECT 1 FROM membership_permissions read_scope
      WHERE read_scope.membership_id=m.id AND read_scope.permission_code='document.read'
        AND read_scope.scope='ASSIGNED'
    ) THEN 'ASSIGNED' ELSE 'AGENCY' END)`;
  const documentSensitiveSql =
    classification === 'IDENTITY'
      ? sensitiveGrantSql('identity')
      : classification === 'HEALTH'
        ? sensitiveGrantSql('health')
        : '1=1';
  const parentSensitiveSql = parent.parentHealth ? `AND ${sensitiveGrantSql('health')}` : '';
  const documentPermissionSql = `EXISTS (
      SELECT 1 FROM membership_permissions upload_permission
      JOIN membership_permissions read_permission
        ON read_permission.membership_id=upload_permission.membership_id
        AND read_permission.permission_code='document.read'
        AND read_permission.scope IN ('ASSIGNED','AGENCY')
      WHERE upload_permission.membership_id=m.id
        AND upload_permission.permission_code='document.upload'
        AND upload_permission.scope IN ('ASSIGNED','AGENCY')
        AND (upload_permission.scope='ASSIGNED' OR read_permission.scope='AGENCY')
    )`;
  const parentPermissionSql = parentMemberGrantSql(parent);
  const parentScopeMatch = `(${parentReadScopeSql})='${parent.parentReadScope}'`;
  const quoteScopeMatch = parent.quoteReadScope
    ? `(SELECT quote_scope.scope FROM membership_permissions quote_scope
        WHERE quote_scope.membership_id=m.id AND quote_scope.permission_code='quote.read')='${parent.quoteReadScope}'`
    : '1=1';
  const policyHealthScopeMatch = parent.policyHealthReadScope
    ? `(SELECT policy_health_scope.scope FROM membership_permissions policy_health_scope
        WHERE policy_health_scope.membership_id=m.id AND policy_health_scope.permission_code='policy.read')='${parent.policyHealthReadScope}'`
    : '1=1';
  const documentScopeMatch = `${documentScopeSql}='${documentScope}'`;
  const sql = `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS (
      SELECT 1 FROM agency_memberships m
      JOIN users u ON u.id=m.user_id
      JOIN agencies a ON a.id=m.agency_id
      WHERE m.id=? AND m.agency_id=? AND m.user_id=?
        AND m.type=?
        AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
        AND m.permission_version=?
        AND EXISTS (SELECT 1 FROM auth_identities ai
          WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')
        AND ${parentExists}
        AND (
          (m.type='OWNER' ${parentSensitiveSql} AND ${documentSensitiveSql})
          OR
          (m.type='MEMBER' AND ${documentPermissionSql}
            AND ${documentScopeMatch} AND ${parentScopeMatch}
            AND ${quoteScopeMatch} AND ${policyHealthScopeMatch}
            AND ${parentPermissionSql}
            AND ${documentSensitiveSql}${parentSensitiveSql})
        )
    ) THEN 1 ELSE 0 END,?`;
  const values: unknown[] = [
    crypto.randomUUID(),
    membership.id,
    membership.agencyId,
    context.userId,
    membership.type,
    membership.permissionVersion,
    context.identityId,
    parent.ownerId,
  ];
  if (parent.ownerType !== 'CUSTOMER') values.push(parent.branchClassification);
  values.push('DOCUMENT_UPLOAD_AUTHORIZATION_RACE');
  return db.prepare(sql).bind(...values);
}

function assertResultChanges(db: D1Database, failureCode: string) {
  return db
    .prepare(
      'INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),?',
    )
    .bind(crypto.randomUUID(), failureCode);
}

async function assertCurrentUploadAuthority(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembershipSnapshot,
  parent: DocumentParentSnapshot,
  documentScope: 'ASSIGNED' | 'AGENCY',
  classification: DocumentUploadInput['classification'],
): Promise<void> {
  try {
    await buildUploadAuthorityAssertion(
      db,
      context,
      membership,
      parent,
      documentScope,
      classification,
    ).run();
  } catch (error) {
    const message = String(error);
    if (
      message.includes('DOCUMENT_UPLOAD_AUTHORIZATION_RACE') ||
      message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')
    ) {
      throw new DocumentUploadError('FORBIDDEN', 403);
    }
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseReservation(raw: unknown): UploadReservation | null {
  const value = parseJsonObject(raw);
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'correlationId,documentId,kind,objectKey,versionId'
  ) {
    return null;
  }
  if (
    value.kind !== 'DOCUMENT_UPLOAD_RESERVATION' ||
    typeof value.documentId !== 'string' ||
    typeof value.versionId !== 'string' ||
    typeof value.objectKey !== 'string' ||
    !/^quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.objectKey,
    ) ||
    typeof value.correlationId !== 'string' ||
    value.correlationId.trim() === ''
  ) {
    return null;
  }
  return {
    kind: 'DOCUMENT_UPLOAD_RESERVATION',
    documentId: value.documentId,
    versionId: value.versionId,
    objectKey: value.objectKey,
    correlationId: value.correlationId,
  };
}

function parseCompletedReceipt(raw: unknown): DocumentUploadReceipt | null {
  const value = parseJsonObject(raw);
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'classification,documentId,state,versionId,versionNumber'
  ) {
    return null;
  }
  if (
    typeof value.documentId !== 'string' ||
    typeof value.versionId !== 'string' ||
    (value.classification !== 'GENERAL' &&
      value.classification !== 'IDENTITY' &&
      value.classification !== 'HEALTH') ||
    value.versionNumber !== 1 ||
    value.state !== 'QUARANTINED'
  ) {
    return null;
  }
  return {
    documentId: value.documentId,
    versionId: value.versionId,
    classification: value.classification,
    versionNumber: 1,
    state: 'QUARANTINED',
  };
}

async function loadReceipt(
  db: D1Database,
  membership: ActiveMembershipSnapshot,
  context: AuthenticatedUserContext,
  idempotencyKey: string,
): Promise<IdempotencyReceiptRow | null> {
  return await db
    .prepare(
      `SELECT id,action,status,payload_fingerprint,response_status,response_body
       FROM operation_receipts
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
    )
    .bind(membership.agencyId, context.userId, membership.id, idempotencyKey)
    .first<IdempotencyReceiptRow>();
}

async function prepareUpload(input: DocumentUploadInput) {
  try {
    return await prepareQuarantinedDocumentObject(input.file, {
      fileName: input.fileName,
      declaredContentType: input.declaredContentType,
    });
  } catch (error) {
    if (!(error instanceof DocumentQuarantineError)) {
      throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
    }
    if (error.code === 'PREFLIGHT_REJECTED') {
      if (error.preflightReason === 'SIZE_LIMIT') {
        throw new DocumentUploadError('VALIDATION_ERROR', 413);
      }
      if (
        error.preflightReason === 'UNSUPPORTED_TYPE' ||
        error.preflightReason === 'CONTENT_TYPE_MISMATCH' ||
        error.preflightReason === 'SIGNATURE_MISMATCH'
      ) {
        throw new DocumentUploadError('VALIDATION_ERROR', 415);
      }
      throw new DocumentUploadError('VALIDATION_ERROR', 400);
    }
    if (error.code === 'SIZE_MISMATCH') throw new DocumentUploadError('VALIDATION_ERROR', 400);
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  }
}

async function writeUpload(
  bucket: R2Bucket,
  objectKey: string,
  prepared: Awaited<ReturnType<typeof prepareQuarantinedDocumentObject>>,
) {
  try {
    await writePreparedQuarantinedDocumentObject(bucket, objectKey, prepared);
  } catch {
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  }
}

async function loadStoredUpload(
  db: D1Database,
  membership: ActiveMembershipSnapshot,
  context: AuthenticatedUserContext,
  parent: DocumentParentSnapshot,
  input: DocumentUploadInput,
  prepared: Awaited<ReturnType<typeof prepareQuarantinedDocumentObject>>,
  reservation: UploadReservation,
  expectedStatus: 'PENDING_UPLOAD' | 'COMPLETED',
): Promise<StoredUploadRow> {
  const row = await db
    .prepare(
      `SELECT d.id AS document_id,d.agency_id,d.owner_type,d.customer_id,d.policy_id,d.quote_id,
              d.classification,d.status AS document_status,d.created_by_user_id,d.created_by_membership_id,
              v.id AS version_id,v.version_number,v.object_key,v.sha256,v.size_bytes,v.file_name,
              v.declared_content_type,v.detected_content_type,v.status AS version_status
       FROM documents d JOIN document_versions v
         ON v.agency_id=d.agency_id AND v.document_id=d.id
       WHERE d.agency_id=? AND d.id=? AND v.id=?`,
    )
    .bind(membership.agencyId, reservation.documentId, reservation.versionId)
    .first<StoredUploadRow>();
  const expectedCustomer = parent.ownerType === 'CUSTOMER' ? parent.ownerId : null;
  const expectedPolicy = parent.ownerType === 'POLICY' ? parent.ownerId : null;
  const expectedQuote = parent.ownerType === 'QUOTE' ? parent.ownerId : null;
  const allowedStatuses =
    expectedStatus === 'PENDING_UPLOAD'
      ? ['PENDING_UPLOAD']
      : [
          'QUARANTINED',
          'SCANNING',
          'BACKUP_PENDING',
          'AVAILABLE',
          'REJECTED',
          'SCAN_FAILED',
          'RETIRED',
        ];
  if (
    !row ||
    row.document_id !== reservation.documentId ||
    row.agency_id !== membership.agencyId ||
    row.owner_type !== input.ownerType ||
    row.customer_id !== expectedCustomer ||
    row.policy_id !== expectedPolicy ||
    row.quote_id !== expectedQuote ||
    row.classification !== input.classification ||
    row.document_status !== 'ACTIVE' ||
    row.created_by_user_id !== context.userId ||
    row.created_by_membership_id !== membership.id ||
    row.version_id !== reservation.versionId ||
    row.version_number !== 1 ||
    (reservation.objectKey !== '' && row.object_key !== reservation.objectKey) ||
    row.sha256 !== prepared.sha256 ||
    row.size_bytes !== prepared.sizeBytes ||
    row.file_name !== prepared.fileName ||
    row.declared_content_type !== input.declaredContentType ||
    row.detected_content_type !== prepared.contentType ||
    typeof row.version_status !== 'string' ||
    !allowedStatuses.includes(row.version_status)
  ) {
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  }
  return row;
}

async function finalizeUpload(
  db: D1Database,
  context: AuthenticatedUserContext,
  membership: ActiveMembershipSnapshot,
  parent: DocumentParentSnapshot,
  documentScope: 'ASSIGNED' | 'AGENCY',
  input: DocumentUploadInput,
  action: string,
  fingerprint: string,
  reservation: UploadReservation,
  idempotencyKey: string,
  sha256: string,
): Promise<DocumentUploadResult> {
  const now = new Date().toISOString();
  const receiptBody: DocumentUploadReceipt = {
    documentId: reservation.documentId,
    versionId: reservation.versionId,
    classification: input.classification,
    versionNumber: 1,
    state: 'QUARANTINED',
  };
  const audit = buildSafeAuditRecord({
    agencyId: membership.agencyId,
    actorUserId: context.userId,
    actorMembershipId: membership.id,
    action,
    targetType: 'documents',
    targetId: reservation.documentId,
    correlationId: reservation.correlationId,
    idempotencyKey,
    outcome: 'SUCCESS',
    metadata: { safeCode: input.classification, targetVersion: 1 },
    createdAt: now,
  });
  try {
    await db.batch([
      buildUploadAuthorityAssertion(
        db,
        context,
        membership,
        parent,
        documentScope,
        input.classification,
      ),
      db
        .prepare(
          `INSERT INTO background_jobs
            (id,agency_id,job_type,document_version_id,input_sha256,generation,status,available_at,created_at,updated_at)
           VALUES(?,?,'DOCUMENT_SCAN',?,?,1,'QUEUED',?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          membership.agencyId,
          reservation.versionId,
          sha256,
          now,
          now,
          now,
        ),
      db
        .prepare(
          `UPDATE document_versions SET status='QUARANTINED',updated_at=?
           WHERE agency_id=? AND id=? AND document_id=? AND sha256=? AND status='PENDING_UPLOAD'`,
        )
        .bind(now, membership.agencyId, reservation.versionId, reservation.documentId, sha256),
      assertResultChanges(db, 'DOCUMENT_UPLOAD_VERSION_STATE_RACE'),
      db
        .prepare(
          `UPDATE operation_receipts SET status='COMPLETED',response_status=202,response_body=?,updated_at=?
           WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?
             AND action=? AND payload_fingerprint=? AND status='IN_PROGRESS'`,
        )
        .bind(
          JSON.stringify(receiptBody),
          now,
          membership.agencyId,
          context.userId,
          membership.id,
          idempotencyKey,
          action,
          fingerprint,
        ),
      assertResultChanges(db, 'DOCUMENT_UPLOAD_RECEIPT_RACE'),
      db
        .prepare(
          `INSERT INTO audit_events
            (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
             correlation_id,idempotency_key,outcome,metadata_json,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,'SUCCESS',?,?)`,
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
          idempotencyKey,
          audit.metadataJson,
          audit.createdAt,
        ),
    ]);
  } catch (error) {
    const message = String(error);
    if (
      message.includes('DOCUMENT_UPLOAD_AUTHORIZATION_RACE') ||
      message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')
    ) {
      try {
        await assertCurrentUploadAuthority(
          db,
          context,
          membership,
          parent,
          documentScope,
          input.classification,
        );
      } catch (authorizationError) {
        if (
          authorizationError instanceof DocumentUploadError &&
          authorizationError.code === 'FORBIDDEN'
        ) {
          throw authorizationError;
        }
      }
    }
    throw new DocumentUploadError('UPLOAD_RETRYABLE', 503);
  }

  return { status: 202, body: receiptBody, replayed: false };
}

export async function createDocumentUpload(
  db: D1Database,
  quarantine: R2Bucket,
  context: AuthenticatedUserContext,
  rawInput: unknown,
  options: DocumentUploadOptions,
): Promise<DocumentUploadResult> {
  const parsed = uploadInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new DocumentUploadError('VALIDATION_ERROR', 400);
  const input = parsed.data;
  const membership = activeMembership(context);
  const idempotencyKey = options.idempotencyKey.trim();
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(idempotencyKey) ||
    typeof options.correlationId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(options.correlationId)
  ) {
    throw new DocumentUploadError('VALIDATION_ERROR', 400);
  }

  const parent = await resolveDocumentParent(
    db,
    context,
    membership,
    input.ownerType,
    input.ownerId,
  );
  if (parent.parentHealth && input.classification !== 'HEALTH') {
    throw new DocumentUploadError('CLASSIFICATION_PARENT_MISMATCH', 400);
  }
  const existingReceipt = await loadReceipt(db, membership, context, idempotencyKey);
  let existingReservation: UploadReservation | null = null;
  let existingResponse: DocumentUploadReceipt | null = null;
  if (existingReceipt?.status === 'IN_PROGRESS') {
    existingReservation = parseReservation(existingReceipt.response_body);
  } else if (existingReceipt?.status === 'COMPLETED') {
    existingResponse = parseCompletedReceipt(existingReceipt.response_body);
  }
  const documentId =
    existingReservation?.documentId ?? existingResponse?.documentId ?? crypto.randomUUID();
  const action = uploadAction(input.classification);
  const documentScope = await authorizeDocumentUpload(
    db,
    context,
    membership,
    parent,
    documentId,
    input.classification,
  );
  const prepared = await prepareUpload(input);
  const canonicalInput = {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    classification: input.classification,
    fileName: prepared.fileName,
    declaredContentType: input.declaredContentType,
    detectedContentType: prepared.contentType,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
  };
  const fingerprint = await computePayloadHash(canonicalInput);

  if (existingReceipt) {
    if (existingReceipt.action !== action || existingReceipt.payload_fingerprint !== fingerprint) {
      throw new IdempotencyConflictError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    }
    if (existingReceipt.status === 'COMPLETED') {
      if (!existingResponse || existingReceipt.response_status !== 202) {
        throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
      }
      const completedReservation: UploadReservation = {
        kind: 'DOCUMENT_UPLOAD_RESERVATION',
        documentId: existingResponse.documentId,
        versionId: existingResponse.versionId,
        objectKey: '',
        correlationId: options.correlationId,
      };
      const stored = await loadCompletedUpload(
        db,
        membership,
        context,
        parent,
        input,
        prepared,
        completedReservation,
      );
      if (!stored) throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
      await assertCurrentUploadAuthority(
        db,
        context,
        membership,
        parent,
        documentScope,
        input.classification,
      );
      return { status: 202, body: existingResponse, replayed: true };
    }
    if (existingReceipt.status !== 'IN_PROGRESS' || !existingReservation) {
      throw new IdempotencyConflictError('IDEMPOTENCY_PREVIOUS_EXECUTION_FAILED');
    }
    await loadStoredUpload(
      db,
      membership,
      context,
      parent,
      input,
      prepared,
      existingReservation,
      'PENDING_UPLOAD',
    );
    await writeUpload(quarantine, existingReservation.objectKey, prepared);
    return await finalizeUpload(
      db,
      context,
      membership,
      parent,
      documentScope,
      input,
      action,
      fingerprint,
      existingReservation,
      idempotencyKey,
      prepared.sha256,
    );
  }

  const versionId = crypto.randomUUID();
  const reservation: UploadReservation = {
    kind: 'DOCUMENT_UPLOAD_RESERVATION',
    documentId,
    versionId,
    objectKey: createQuarantineObjectKey(),
    correlationId: options.correlationId,
  };
  const reservationBody = JSON.stringify(reservation);
  const now = new Date().toISOString();
  const receiptId = crypto.randomUUID();
  try {
    await db.batch([
      buildUploadAuthorityAssertion(
        db,
        context,
        membership,
        parent,
        documentScope,
        input.classification,
      ),
      db
        .prepare(
          `INSERT INTO operation_receipts
            (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
             payload_fingerprint,status,response_body,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,'IN_PROGRESS',?,?,?)`,
        )
        .bind(
          receiptId,
          membership.agencyId,
          context.userId,
          membership.id,
          action,
          idempotencyKey,
          fingerprint,
          reservationBody,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO documents
            (id,agency_id,owner_type,customer_id,policy_id,quote_id,classification,
             created_by_user_id,created_by_membership_id,version)
           VALUES(?,?,?,?,?,?,?,?,?,1)`,
        )
        .bind(
          reservation.documentId,
          membership.agencyId,
          input.ownerType,
          input.ownerType === 'CUSTOMER' ? input.ownerId : null,
          input.ownerType === 'POLICY' ? input.ownerId : null,
          input.ownerType === 'QUOTE' ? input.ownerId : null,
          input.classification,
          context.userId,
          membership.id,
        ),
      db
        .prepare(
          `INSERT INTO document_versions
            (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
             declared_content_type,detected_content_type,status,created_by_user_id,created_by_membership_id)
           VALUES(?,?,?,1,?,?,?,?,?,?,'PENDING_UPLOAD',?,?)`,
        )
        .bind(
          reservation.versionId,
          membership.agencyId,
          reservation.documentId,
          reservation.objectKey,
          prepared.sha256,
          prepared.sizeBytes,
          prepared.fileName,
          input.declaredContentType,
          prepared.contentType,
          context.userId,
          membership.id,
        ),
    ]);
  } catch {
    const racedReceipt = await loadReceipt(db, membership, context, idempotencyKey).catch(
      () => null,
    );
    if (racedReceipt) throw new DocumentUploadError('IDEMPOTENCY_IN_PROGRESS', 409);
    try {
      await assertCurrentUploadAuthority(
        db,
        context,
        membership,
        parent,
        documentScope,
        input.classification,
      );
    } catch (authorizationError) {
      if (
        authorizationError instanceof DocumentUploadError &&
        authorizationError.code === 'FORBIDDEN'
      ) {
        throw authorizationError;
      }
    }
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  }

  await writeUpload(quarantine, reservation.objectKey, prepared);
  return await finalizeUpload(
    db,
    context,
    membership,
    parent,
    documentScope,
    input,
    action,
    fingerprint,
    reservation,
    idempotencyKey,
    prepared.sha256,
  );
}

async function loadCompletedUpload(
  db: D1Database,
  membership: ActiveMembershipSnapshot,
  context: AuthenticatedUserContext,
  parent: DocumentParentSnapshot,
  input: DocumentUploadInput,
  prepared: Awaited<ReturnType<typeof prepareQuarantinedDocumentObject>>,
  receipt: UploadReservation,
): Promise<StoredUploadRow | null> {
  try {
    return await loadStoredUpload(
      db,
      membership,
      context,
      parent,
      input,
      prepared,
      receipt,
      'COMPLETED',
    );
  } catch {
    return null;
  }
}

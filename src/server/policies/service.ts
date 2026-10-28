import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization, type AuthorizationResult } from '../auth/authorization';
import {
  captureValidatedPermissions,
  membershipPermissionSnapshotSql,
} from '../auth/permission-snapshot';
import type {
  PolicyAmendmentDto,
  PolicyDetailDto,
  PolicyDto,
  PolicyExternalReferenceDto,
  PolicyListResponseData,
  PolicyPartyDto,
  CustomerAssignmentOptionDto,
} from '../../shared/types';
import {
  parsePolicyCreateInput,
  parsePolicyPatchInput,
  archivePolicySchema,
  policyAmendmentCreateSchema,
  policyAssignSchema,
  policyExternalReferenceCreateSchema,
  policyListQuerySchema,
  policyPartyCreateSchema,
  policyPartyDeactivateSchema,
  secureVariantSchema,
  secureVariantGrantSchema,
  type PolicyCreateInput,
  normalizePolicyNumber,
} from './validation';
import {
  assertPolicyCreateReplayAuthority,
  executePolicyCommand,
  executePolicyVariantCommand,
  findPolicyCommandReplay,
  findPolicyVariantReplay,
  PolicyAuthorizationRaceError,
  PolicyConstraintError,
} from '../mutations/internal/policy-domain-executor';
import {
  executePolicyRelationshipCommand,
  findPolicyRelationshipReplay,
} from '../mutations/internal/policy-relationship-executor';
import { computeEvidenceHash, issueAndPersistSensitiveActionGrant } from '../mutations/grants';
import { computePayloadHash } from '../mutations/canonical';
import { OptimisticConcurrencyError } from '../db/optimistic';

export { PolicyAuthorizationRaceError, PolicyConstraintError };
export class PolicyNotFoundError extends Error {}
export class PolicyForbiddenError extends Error {}

interface Row {
  id: string;
  agency_id: string;
  customer_id: string;
  insurer_id: string;
  product_id: string;
  branch_id: string;
  payment_method_id: string;
  assignee_membership_id: string;
  policy_number: string;
  normalized_policy_number: string;
  start_date: string;
  end_date: string;
  gross_premium_minor: number;
  currency: string;
  installment_count: number | null;
  status: 'ACTIVE' | 'CANCELLED' | 'VOIDED';
  identity_variant: number;
  archived_at: string | null;
  archived_by_membership_id: string | null;
  archive_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  customer_assignee_membership_id?: string;
}

const toDto = (row: Row): PolicyDto => ({
  id: row.id,
  agencyId: row.agency_id,
  customerId: row.customer_id,
  insurerId: row.insurer_id,
  productId: row.product_id,
  branchId: row.branch_id,
  paymentMethodId: row.payment_method_id,
  assigneeMembershipId: row.assignee_membership_id,
  policyNumber: row.policy_number,
  normalizedPolicyNumber: row.normalized_policy_number,
  startDate: row.start_date,
  endDate: row.end_date,
  grossPremiumMinor: row.gross_premium_minor,
  currency: row.currency,
  installmentCount: row.installment_count,
  status: row.status,
  identityVariant: row.identity_variant,
  archivedAt: row.archived_at,
  archivedByMembershipId: row.archived_by_membership_id,
  archiveReason: row.archive_reason,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function membership(context: AuthenticatedUserContext) {
  const active = context.memberships[0];
  if (!active || active.status !== 'ACTIVE') throw new PolicyForbiddenError();
  return active;
}

async function authorize(
  db: D1Database,
  context: AuthenticatedUserContext,
  action: string,
  resource: Record<string, unknown>,
): Promise<AuthorizationResult> {
  const result = await evaluateAuthorization(db, { context, action, resource });
  if (result.decision !== 'ALLOW') throw new PolicyForbiddenError(result.code);
  return result;
}

async function load(db: D1Database, agencyId: string, id: string) {
  return db
    .prepare(
      `SELECT p.*,c.assignee_membership_id AS customer_assignee_membership_id
    FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    WHERE p.agency_id=? AND p.id=?`,
    )
    .bind(agencyId, id)
    .first<Row>();
}

async function classification(db: D1Database, agencyId: string, branchId: string) {
  return db
    .prepare(`SELECT data_classification FROM insurance_branches WHERE agency_id=? AND id=?`)
    .bind(agencyId, branchId)
    .first<{ data_classification: 'GENERAL' | 'HEALTH' }>();
}

function resource(row: Row) {
  return {
    agencyId: row.agency_id,
    assigneeMembershipId: row.assignee_membership_id,
    customerAssigneeMembershipId: row.customer_assignee_membership_id,
    branchId: row.branch_id,
  };
}

const POLICY_CREATE_RECEIPT_KEYS = new Set([
  'id',
  'agencyId',
  'customerId',
  'insurerId',
  'productId',
  'branchId',
  'paymentMethodId',
  'assigneeMembershipId',
  'policyNumber',
  'normalizedPolicyNumber',
  'startDate',
  'endDate',
  'grossPremiumMinor',
  'currency',
  'installmentCount',
  'status',
  'identityVariant',
  'archivedAt',
  'archivedByMembershipId',
  'archiveReason',
  'version',
  'createdAt',
  'updatedAt',
]);

function isCanonicalPolicyId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
}

function isCanonicalDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parsePolicyCreateReceiptDto(value: unknown): PolicyDto | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const dto = value as Record<string, unknown>;
    const keys = Object.keys(dto);
    if (
      keys.length !== POLICY_CREATE_RECEIPT_KEYS.size ||
      keys.some((key) => !POLICY_CREATE_RECEIPT_KEYS.has(key))
    ) {
      return null;
    }
    const textFields = [
      'agencyId',
      'customerId',
      'insurerId',
      'productId',
      'branchId',
      'paymentMethodId',
      'assigneeMembershipId',
      'policyNumber',
      'normalizedPolicyNumber',
    ] as const;
    if (
      !isCanonicalPolicyId(dto.id) ||
      textFields.some(
        (field) =>
          typeof dto[field] !== 'string' ||
          dto[field] === '' ||
          dto[field] !== dto[field]!.trim() ||
          dto[field]!.length > 160,
      ) ||
      typeof dto.policyNumber !== 'string' ||
      dto.normalizedPolicyNumber !== normalizePolicyNumber(dto.policyNumber) ||
      !isCanonicalDateOnly(dto.startDate) ||
      !isCanonicalDateOnly(dto.endDate) ||
      dto.startDate > dto.endDate ||
      typeof dto.grossPremiumMinor !== 'number' ||
      !Number.isSafeInteger(dto.grossPremiumMinor) ||
      dto.grossPremiumMinor < 0 ||
      typeof dto.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(dto.currency) ||
      (dto.installmentCount !== null &&
        (typeof dto.installmentCount !== 'number' ||
          !Number.isSafeInteger(dto.installmentCount) ||
          dto.installmentCount < 1)) ||
      !['ACTIVE', 'CANCELLED', 'VOIDED'].includes(String(dto.status)) ||
      dto.identityVariant !== 0 ||
      dto.archivedAt !== null ||
      dto.archivedByMembershipId !== null ||
      dto.archiveReason !== null ||
      dto.version !== 1 ||
      !isCanonicalIsoTimestamp(dto.createdAt) ||
      dto.updatedAt !== dto.createdAt
    ) {
      return null;
    }
    return dto as unknown as PolicyDto;
  } catch {
    return null;
  }
}

async function loadPolicyCreateAuditTarget(
  db: D1Database,
  input: {
    readonly agencyId: string;
    readonly actorUserId: string;
    readonly actorMembershipId: string;
    readonly idempotencyKey: string;
  },
): Promise<{ targetId: string; responseHash: string | null }> {
  const result = await db
    .prepare(
      `SELECT target_type,target_id,outcome,metadata_json FROM audit_events
       WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=?
         AND action='policy.create' AND idempotency_key=?`,
    )
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey.trim())
    .all<{
      target_type: unknown;
      target_id: unknown;
      outcome: unknown;
      metadata_json: unknown;
    }>();
  if (!result.success || !Array.isArray(result.results) || result.results.length !== 1) {
    throw new PolicyAuthorizationRaceError();
  }
  const evidence = result.results[0];
  if (
    !evidence ||
    evidence.target_type !== 'policies' ||
    evidence.outcome !== 'SUCCESS' ||
    !isCanonicalPolicyId(evidence.target_id)
  ) {
    throw new PolicyAuthorizationRaceError();
  }
  let metadata: unknown;
  try {
    if (typeof evidence.metadata_json !== 'string') throw new Error('INVALID_AUDIT_METADATA');
    metadata = JSON.parse(evidence.metadata_json);
  } catch {
    throw new PolicyAuthorizationRaceError();
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new PolicyAuthorizationRaceError();
  }
  const responseHash = (metadata as Record<string, unknown>).responseHash;
  if (
    responseHash !== undefined &&
    (typeof responseHash !== 'string' || !/^[0-9a-f]{64}$/.test(responseHash))
  ) {
    throw new PolicyAuthorizationRaceError();
  }
  return {
    targetId: evidence.target_id,
    responseHash: typeof responseHash === 'string' ? responseHash : null,
  };
}

async function resolvePolicyCreateReplay(
  context: AuthenticatedUserContext,
  db: D1Database,
  agencyId: string,
  data: PolicyCreateInput,
  idempotencyKey: string,
  completed: { readonly body: unknown; readonly status: number; readonly replayed: boolean },
): Promise<{ data: PolicyDto; status: number; replayed: true }> {
  const active = membership(context);
  const auditEvidence = await loadPolicyCreateAuditTarget(db, {
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    idempotencyKey,
  });
  const replayId = auditEvidence.targetId;
  const original = await load(db, agencyId, replayId);
  if (!original || original.customer_id !== data.customerId) {
    throw new PolicyAuthorizationRaceError();
  }
  const sourceProduct = await db
    .prepare('SELECT insurer_id FROM insurance_products WHERE agency_id=? AND id=?')
    .bind(agencyId, data.productId)
    .first<{ insurer_id: unknown }>();
  if (typeof sourceProduct?.insurer_id !== 'string' || sourceProduct.insurer_id.trim() === '') {
    throw new PolicyAuthorizationRaceError();
  }
  const originalClassification = await classification(db, agencyId, data.branchId);
  if (!originalClassification) throw new PolicyAuthorizationRaceError();
  const createAction =
    originalClassification.data_classification === 'HEALTH'
      ? 'policy.health.create'
      : 'policy.create';

  try {
    await authorize(db, context, 'customer.read', {
      agencyId,
      assigneeMembershipId: original.customer_assignee_membership_id!,
    });
    await authorize(db, context, createAction, {
      ...resource(original),
      isCreate: true,
    });
    await getPolicy(context, db, replayId);
  } catch {
    throw new PolicyAuthorizationRaceError();
  }

  const replayDto = parsePolicyCreateReceiptDto(completed.body);
  const replayCreatedAt = Date.parse(replayDto?.createdAt ?? '');
  const originalCreatedAt = Date.parse(original.created_at);
  const creationTimestampMatches =
    auditEvidence.responseHash !== null
      ? replayDto?.createdAt === original.created_at
      : Number.isFinite(replayCreatedAt) &&
        Number.isFinite(originalCreatedAt) &&
        Math.abs(replayCreatedAt - originalCreatedAt) <= 5_000;
  if (
    !replayDto ||
    completed.status !== 201 ||
    replayDto.id !== replayId ||
    replayDto.agencyId !== agencyId ||
    !creationTimestampMatches ||
    replayDto.customerId !== data.customerId ||
    replayDto.insurerId !== (data.insurerId ?? sourceProduct.insurer_id) ||
    replayDto.assigneeMembershipId !== (data.assigneeMembershipId ?? active.id) ||
    replayDto.productId !== data.productId ||
    replayDto.branchId !== data.branchId ||
    replayDto.paymentMethodId !== data.paymentMethodId ||
    replayDto.policyNumber !== data.policyNumber ||
    replayDto.normalizedPolicyNumber !== data.normalizedPolicyNumber ||
    replayDto.startDate !== data.startDate ||
    replayDto.endDate !== data.endDate ||
    replayDto.grossPremiumMinor !== data.grossPremiumMinor ||
    replayDto.currency !== data.currency ||
    replayDto.installmentCount !== data.installmentCount ||
    replayDto.status !== data.status ||
    (data.insurerId !== undefined && replayDto.insurerId !== data.insurerId)
  ) {
    throw new PolicyAuthorizationRaceError();
  }
  if (
    auditEvidence.responseHash !== null &&
    auditEvidence.responseHash !==
      (await computePayloadHash({ action: 'policy.create', target: replayId, result: replayDto }))
  ) {
    throw new PolicyAuthorizationRaceError();
  }
  await assertPolicyCreateReplayAuthority({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    targetPolicyId: replayId,
    customerId: data.customerId,
    branchId: data.branchId,
    originallyHealthClassified: originalClassification.data_classification === 'HEALTH',
  });
  return { data: replayDto, status: completed.status, replayed: true };
}

async function authorizeCurrentPolicyMutation(
  db: D1Database,
  context: AuthenticatedUserContext,
  id: string,
  action: 'policy.update' | 'policy.assign',
) {
  const active = membership(context);
  const current = await load(db, active.agencyId, id);
  if (!current) throw new PolicyAuthorizationRaceError();
  const permission = await authorize(db, context, action, resource(current));
  if (action === 'policy.assign' && permission.effectiveScope !== 'AGENCY')
    throw new PolicyForbiddenError();
  const branchClass = await classification(db, active.agencyId, current.branch_id);
  if (branchClass?.data_classification === 'HEALTH') {
    await authorize(
      db,
      context,
      action === 'policy.assign' ? 'policy.health.read' : 'policy.health.update',
      resource(current),
    );
  }
  return current;
}

async function validateCatalogs(
  db: D1Database,
  agencyId: string,
  data: PolicyCreateInput,
  insurerId: string,
) {
  const row = await db
    .prepare(
      `SELECT i.status insurer_status,b.status branch_status,b.data_classification,
      p.status product_status,pm.status payment_status,pm.supports_installments,pm.max_installments
    FROM insurance_products p
    JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    JOIN payment_methods pm ON pm.agency_id=p.agency_id AND pm.id=?
    WHERE p.agency_id=? AND p.id=? AND p.insurer_id=? AND p.branch_id=?`,
    )
    .bind(data.paymentMethodId, agencyId, data.productId, insurerId, data.branchId)
    .first<{
      insurer_status: string;
      branch_status: string;
      data_classification: 'GENERAL' | 'HEALTH';
      product_status: string;
      payment_status: string;
      supports_installments: number;
      max_installments: number;
    }>();
  if (
    !row ||
    [row.insurer_status, row.branch_status, row.product_status, row.payment_status].some(
      (x) => x !== 'ACTIVE',
    )
  ) {
    throw new PolicyConstraintError('CATALOG_REFERENCE_NOT_SELECTABLE');
  }
  if (row.supports_installments === 0 && data.installmentCount !== null) {
    throw new PolicyConstraintError('INSTALLMENT_NOT_ALLOWED');
  }
  if (
    row.supports_installments === 1 &&
    (data.installmentCount === null || data.installmentCount > row.max_installments)
  ) {
    throw new PolicyConstraintError('INSTALLMENT_COUNT_INVALID');
  }
  return row.data_classification;
}

export async function createPolicy(
  context: AuthenticatedUserContext,
  db: D1Database,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const data = parsePolicyCreateInput(raw);
  const agencyId = active.agencyId;
  let completed: { body: unknown; status: number; replayed: boolean } | null;
  try {
    completed = await findPolicyCommandReplay({
      db,
      agencyId,
      actorUserId: context.userId,
      actorMembershipId: active.id,
      actorIdentityId: context.identityId,
      permissionVersion: active.permissionVersion,
      idempotencyKey,
      payload: raw,
      action: 'policy.create',
      target: 'new-policy',
      version: null,
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new PolicyAuthorizationRaceError();
    throw error;
  }
  if (completed) {
    return resolvePolicyCreateReplay(context, db, agencyId, data, idempotencyKey, completed);
  }
  const customer = await db
    .prepare(`SELECT id,assignee_membership_id FROM customers WHERE agency_id=? AND id=?`)
    .bind(agencyId, data.customerId)
    .first<{ id: string; assignee_membership_id: string }>();
  if (!customer) throw new PolicyNotFoundError();
  await authorize(db, context, 'customer.read', {
    agencyId,
    assigneeMembershipId: customer.assignee_membership_id,
  });

  const insurerId =
    data.insurerId ??
    (
      await db
        .prepare(`SELECT default_insurer_id FROM agency_settings WHERE agency_id=?`)
        .bind(agencyId)
        .first<{ default_insurer_id: string | null }>()
    )?.default_insurer_id;
  if (!insurerId) throw new PolicyConstraintError('DEFAULT_INSURER_REQUIRED');
  const assignee = data.assigneeMembershipId ?? active.id;
  if (assignee !== active.id) {
    const assignment = await authorize(db, context, 'policy.assign', {
      agencyId,
      assigneeMembershipId: active.id,
      customerAssigneeMembershipId: customer.assignee_membership_id,
    });
    if (assignment.effectiveScope !== 'AGENCY') throw new PolicyForbiddenError();
  }
  const target = await db
    .prepare(`SELECT id FROM agency_memberships WHERE agency_id=? AND id=? AND status='ACTIVE'`)
    .bind(agencyId, assignee)
    .first();
  if (!target) throw new PolicyConstraintError('ASSIGNEE_NOT_ACTIVE');

  const sensitivity = await validateCatalogs(db, agencyId, data, insurerId);
  await authorize(
    db,
    context,
    sensitivity === 'HEALTH' ? 'policy.health.create' : 'policy.create',
    {
      agencyId,
      assigneeMembershipId: assignee,
      customerAssigneeMembershipId: customer.assignee_membership_id,
      isCreate: true,
    },
  );

  const id = crypto.randomUUID();
  const dto = (now: string): PolicyDto => ({
    id,
    agencyId,
    customerId: data.customerId,
    insurerId,
    productId: data.productId,
    branchId: data.branchId,
    paymentMethodId: data.paymentMethodId,
    assigneeMembershipId: assignee,
    policyNumber: data.policyNumber,
    normalizedPolicyNumber: data.normalizedPolicyNumber,
    startDate: data.startDate,
    endDate: data.endDate,
    grossPremiumMinor: data.grossPremiumMinor,
    currency: data.currency,
    installmentCount: data.installmentCount,
    status: data.status,
    identityVariant: 0,
    archivedAt: null,
    archivedByMembershipId: null,
    archiveReason: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const result = await executePolicyCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: raw,
    command: {
      kind: 'create',
      policyId: id,
      customerId: data.customerId,
      requiresAgencyAssign: assignee !== active.id,
      values: [
        data.customerId,
        insurerId,
        data.productId,
        data.branchId,
        data.paymentMethodId,
        assignee,
        data.policyNumber,
        data.normalizedPolicyNumber,
        data.startDate,
        data.endDate,
        data.grossPremiumMinor,
        data.currency,
        data.installmentCount,
        data.status,
      ],
      resource: {
        assigneeMembershipId: assignee,
        customerAssigneeMembershipId: customer.assignee_membership_id,
        branchId: data.branchId,
      },
    },
    result: dto,
    status: 201,
  }).catch((error: unknown) => {
    if (error instanceof SyntaxError) throw new PolicyAuthorizationRaceError();
    throw error;
  });
  if (result.replayed) {
    try {
      return await resolvePolicyCreateReplay(context, db, agencyId, data, idempotencyKey, result);
    } catch (error) {
      if (error instanceof SyntaxError) throw new PolicyAuthorizationRaceError();
      throw error;
    }
  }
  return { data: result.body as PolicyDto, status: result.status, replayed: result.replayed };
}

export async function getPolicy(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<PolicyDetailDto> {
  const active = membership(context);
  const row = await load(db, active.agencyId, id);
  if (!row) throw new PolicyNotFoundError();
  const branchClass = await classification(db, active.agencyId, row.branch_id);
  await authorize(
    db,
    context,
    branchClass?.data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
    resource(row),
  );
  const detail = await db
    .prepare(
      `SELECT c.display_name,i.name insurer_name,i.status insurer_status,
      p.name product_name,p.status product_status,b.name branch_name,b.status branch_status,b.data_classification,
      pm.name payment_name,pm.status payment_status
    FROM policies x
    JOIN customers c ON c.agency_id=x.agency_id AND c.id=x.customer_id
    JOIN insurers i ON i.agency_id=x.agency_id AND i.id=x.insurer_id
    JOIN insurance_products p ON p.agency_id=x.agency_id AND p.id=x.product_id
    JOIN insurance_branches b ON b.agency_id=x.agency_id AND b.id=x.branch_id
    JOIN payment_methods pm ON pm.agency_id=x.agency_id AND pm.id=x.payment_method_id
    WHERE x.agency_id=? AND x.id=?`,
    )
    .bind(active.agencyId, id)
    .first<{
      display_name: string;
      insurer_name: string;
      insurer_status: string;
      product_name: string;
      product_status: string;
      branch_name: string;
      branch_status: string;
      data_classification: string;
      payment_name: string;
      payment_status: string;
    }>();
  if (!detail) throw new PolicyNotFoundError();
  return {
    ...toDto(row),
    customer: { id: row.customer_id, displayName: detail.display_name },
    insurer: {
      id: row.insurer_id,
      name: detail.insurer_name,
      status: detail.insurer_status as 'ACTIVE' | 'INACTIVE',
    },
    product: {
      id: row.product_id,
      name: detail.product_name,
      status: detail.product_status as 'ACTIVE' | 'INACTIVE',
    },
    branch: {
      id: row.branch_id,
      name: detail.branch_name,
      status: detail.branch_status as 'ACTIVE' | 'INACTIVE',
      dataClassification: detail.data_classification as 'GENERAL' | 'HEALTH',
    },
    paymentMethod: {
      id: row.payment_method_id,
      name: detail.payment_name,
      status: detail.payment_status as 'ACTIVE' | 'INACTIVE',
    },
  };
}

export async function updatePolicy(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const existing = await load(db, active.agencyId, id);
  if (!existing) throw new PolicyNotFoundError();
  const parsed = parsePolicyPatchInput(raw);
  await authorize(db, context, 'policy.update', resource(existing));
  const currentClass = await classification(db, active.agencyId, existing.branch_id);
  if (currentClass?.data_classification === 'HEALTH') {
    await authorize(db, context, 'policy.health.update', resource(existing));
  }
  const completed = await findPolicyCommandReplay({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: raw,
    action: 'policy.update',
    target: id,
    version: parsed.expectedVersion,
  });
  if (completed) {
    await authorizeCurrentPolicyMutation(db, context, id, 'policy.update');
    return { data: completed.body as PolicyDto, status: completed.status, replayed: true };
  }
  if (existing.archived_at !== null) throw new PolicyConstraintError('POLICY_ARCHIVED');
  const finalStart = parsed.startDate ?? existing.start_date,
    finalEnd = parsed.endDate ?? existing.end_date;
  if (finalStart > finalEnd) throw new PolicyConstraintError('POLICY_PERIOD_INVALID');

  const catalogChanged = [
    'insurerId',
    'productId',
    'branchId',
    'paymentMethodId',
    'installmentCount',
  ].some((key) => key in parsed);
  let targetClass = currentClass?.data_classification ?? 'GENERAL';
  if (catalogChanged) {
    const finalData: PolicyCreateInput = {
      customerId: existing.customer_id,
      insurerId: parsed.insurerId ?? existing.insurer_id,
      productId: parsed.productId ?? existing.product_id,
      branchId: parsed.branchId ?? existing.branch_id,
      paymentMethodId: parsed.paymentMethodId ?? existing.payment_method_id,
      assigneeMembershipId: existing.assignee_membership_id,
      policyNumber: parsed.policyNumber ?? existing.policy_number,
      normalizedPolicyNumber: parsed.normalizedPolicyNumber ?? existing.normalized_policy_number,
      startDate: finalStart,
      endDate: finalEnd,
      grossPremiumMinor: parsed.grossPremiumMinor ?? existing.gross_premium_minor,
      currency: parsed.currency ?? existing.currency,
      installmentCount:
        parsed.installmentCount !== undefined
          ? parsed.installmentCount
          : existing.installment_count,
      status: parsed.status ?? existing.status,
    };
    targetClass = await validateCatalogs(db, active.agencyId, finalData, finalData.insurerId!);
  }
  if (currentClass?.data_classification !== 'HEALTH' && targetClass === 'HEALTH') {
    await authorize(db, context, 'policy.health.update', resource(existing));
  }

  const changes = {
    ...(parsed.policyNumber !== undefined
      ? {
          policyNumber: parsed.policyNumber,
          normalizedPolicyNumber: parsed.normalizedPolicyNumber!,
        }
      : {}),
    ...(parsed.startDate !== undefined ? { startDate: parsed.startDate } : {}),
    ...(parsed.endDate !== undefined ? { endDate: parsed.endDate } : {}),
    ...(parsed.grossPremiumMinor !== undefined
      ? { grossPremiumMinor: parsed.grossPremiumMinor }
      : {}),
    ...(parsed.currency !== undefined ? { currency: parsed.currency } : {}),
    ...(parsed.installmentCount !== undefined ? { installmentCount: parsed.installmentCount } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.insurerId !== undefined ? { insurerId: parsed.insurerId } : {}),
    ...(parsed.productId !== undefined ? { productId: parsed.productId } : {}),
    ...(parsed.branchId !== undefined ? { branchId: parsed.branchId } : {}),
    ...(parsed.paymentMethodId !== undefined ? { paymentMethodId: parsed.paymentMethodId } : {}),
  };
  const next: PolicyDto = {
    ...toDto(existing),
    ...(parsed.policyNumber !== undefined
      ? {
          policyNumber: parsed.policyNumber,
          normalizedPolicyNumber: parsed.normalizedPolicyNumber!,
        }
      : {}),
    ...(parsed.startDate !== undefined ? { startDate: parsed.startDate } : {}),
    ...(parsed.endDate !== undefined ? { endDate: parsed.endDate } : {}),
    ...(parsed.grossPremiumMinor !== undefined
      ? { grossPremiumMinor: parsed.grossPremiumMinor }
      : {}),
    ...(parsed.currency !== undefined ? { currency: parsed.currency } : {}),
    ...(parsed.installmentCount !== undefined ? { installmentCount: parsed.installmentCount } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.insurerId !== undefined ? { insurerId: parsed.insurerId } : {}),
    ...(parsed.productId !== undefined ? { productId: parsed.productId } : {}),
    ...(parsed.branchId !== undefined ? { branchId: parsed.branchId } : {}),
    ...(parsed.paymentMethodId !== undefined ? { paymentMethodId: parsed.paymentMethodId } : {}),
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  };
  const result = await executePolicyCommand({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: raw,
    command: {
      kind: 'update',
      policyId: id,
      expectedVersion: parsed.expectedVersion,
      changes,
      resource: {
        assigneeMembershipId: existing.assignee_membership_id,
        customerAssigneeMembershipId: existing.customer_assignee_membership_id!,
        branchId: parsed.branchId ?? existing.branch_id,
      },
    },
    result: next,
    status: 200,
  });
  return { data: result.body as PolicyDto, status: result.status, replayed: result.replayed };
}

export async function assignPolicy(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context),
    existing = await load(db, active.agencyId, id);
  if (!existing) throw new PolicyNotFoundError();
  const parsed = policyAssignSchema.parse(raw);
  const permission = await authorize(db, context, 'policy.assign', resource(existing));
  if (permission.effectiveScope !== 'AGENCY') throw new PolicyForbiddenError();
  const branchClass = await classification(db, active.agencyId, existing.branch_id);
  if (branchClass?.data_classification === 'HEALTH')
    await authorize(db, context, 'policy.health.read', resource(existing));
  const completed = await findPolicyCommandReplay({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: raw,
    action: 'policy.assign',
    target: id,
    version: parsed.expectedVersion,
  });
  if (completed) {
    await authorizeCurrentPolicyMutation(db, context, id, 'policy.assign');
    return { data: completed.body as PolicyDto, status: completed.status, replayed: true };
  }
  if (existing.archived_at !== null) throw new PolicyConstraintError('POLICY_ARCHIVED');
  const target = await db
    .prepare(`SELECT id FROM agency_memberships WHERE agency_id=? AND id=? AND status='ACTIVE'`)
    .bind(active.agencyId, parsed.assigneeMembershipId)
    .first();
  if (!target) throw new PolicyConstraintError('ASSIGNEE_NOT_ACTIVE');
  const next: PolicyDto = {
    ...toDto(existing),
    assigneeMembershipId: parsed.assigneeMembershipId,
    version: existing.version + 1,
    updatedAt: new Date().toISOString(),
  };
  const result = await executePolicyCommand({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: raw,
    command: {
      kind: 'assign',
      policyId: id,
      expectedVersion: parsed.expectedVersion,
      assigneeMembershipId: parsed.assigneeMembershipId,
      resource: {
        assigneeMembershipId: existing.assignee_membership_id,
        customerAssigneeMembershipId: existing.customer_assignee_membership_id!,
        branchId: existing.branch_id,
      },
    },
    result: next,
    status: 200,
  });
  return { data: result.body as PolicyDto, status: result.status, replayed: result.replayed };
}

export async function listPolicyAssignmentOptions(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<CustomerAssignmentOptionDto[]> {
  const active = membership(context);
  const existing = await load(db, active.agencyId, id);
  if (!existing) throw new PolicyNotFoundError();
  const permission = await authorize(db, context, 'policy.assign', resource(existing));
  if (permission.effectiveScope !== 'AGENCY') throw new PolicyForbiddenError();
  const branchClass = await classification(db, active.agencyId, existing.branch_id);
  if (branchClass?.data_classification === 'HEALTH') {
    await authorize(db, context, 'policy.health.read', resource(existing));
  }
  const rows = await db
    .prepare(
      `SELECT id,invitation_email,type FROM agency_memberships
       WHERE agency_id=? AND status='ACTIVE' ORDER BY invitation_email,id`,
    )
    .bind(active.agencyId)
    .all<{ id: string; invitation_email: string; type: 'OWNER' | 'MEMBER' }>();
  return rows.results.map((row) => ({
    membershipId: row.id,
    label: row.invitation_email,
    membershipType: row.type,
  }));
}

export async function issuePolicyIdentityVariantGrant(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  raw: unknown,
  idempotencyKey: string,
): Promise<{
  readonly grantEvidenceToken: string;
  readonly grantId: string;
  readonly expiresAt: string;
}> {
  const active = membership(context);
  if (context.assurance !== 'SECURE') throw new PolicyForbiddenError();
  const parsed = secureVariantGrantSchema.parse(raw);
  const existing = await load(db, active.agencyId, id);
  if (!existing) throw new PolicyNotFoundError();
  if (existing.version !== parsed.expectedVersion) throw new OptimisticConcurrencyError(0);
  const permission = await authorize(db, context, 'policy.update', resource(existing));
  if (permission.effectiveScope !== 'AGENCY') throw new PolicyForbiddenError();
  const branchClass = await classification(db, active.agencyId, existing.branch_id);
  if (branchClass?.data_classification === 'HEALTH') {
    await authorize(db, context, 'policy.health.update', resource(existing));
  }
  const payload = { expectedVersion: parsed.expectedVersion, reason: parsed.reason };
  const key = idempotencyKey.trim();
  if (!key) throw new PolicyConstraintError('IDEMPOTENCY_KEY_REQUIRED');
  const payloadHash = await computePayloadHash(payload);
  const evidenceToken = await computePayloadHash({
    purpose: 'policy.identity_variant.grant',
    idempotencyKey: key,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    policyId: id,
  });
  const evidenceHash = await computeEvidenceHash(evidenceToken);
  type GrantReplayRow = {
    id: string;
    expires_at: string;
    status: string;
    agency_id: string;
    actor_user_id: string;
    actor_membership_id: string;
    action: string;
    payload_hash: string;
    target_ids_json: string;
    expected_target_version: number;
    permission_version: number;
  };
  const readReplay = () =>
    db
      .prepare(
        `SELECT id,expires_at,status,agency_id,actor_user_id,actor_membership_id,action,payload_hash,
                target_ids_json,expected_target_version,permission_version
         FROM sensitive_action_grants WHERE evidence_hash=?`,
      )
      .bind(evidenceHash)
      .first<GrantReplayRow>();
  const asReplay = (row: GrantReplayRow | null) => {
    if (!row) return null;
    if (
      row.status !== 'ISSUED' ||
      row.expires_at <= new Date().toISOString() ||
      row.agency_id !== active.agencyId ||
      row.actor_user_id !== context.userId ||
      row.actor_membership_id !== active.id ||
      row.action !== 'policy.identity_variant.create' ||
      row.payload_hash !== payloadHash ||
      row.target_ids_json !== JSON.stringify([id]) ||
      row.expected_target_version !== parsed.expectedVersion ||
      row.permission_version !== active.permissionVersion
    ) {
      throw new PolicyConstraintError('IDEMPOTENCY_CONFLICT');
    }
    return { grantEvidenceToken: evidenceToken, grantId: row.id, expiresAt: row.expires_at };
  };
  const replay = asReplay(await readReplay());
  if (replay) return replay;
  let issued;
  try {
    issued = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId: active.agencyId,
      action: 'policy.identity_variant.create',
      payloadHash,
      targetIds: [id],
      expectedTargetVersion: parsed.expectedVersion,
      evidenceToken,
    });
  } catch (error) {
    const raced = asReplay(await readReplay());
    if (raced) return raced;
    throw error;
  }
  return {
    grantEvidenceToken: issued.grantToken,
    grantId: issued.grantRecord.id,
    expiresAt: issued.grantRecord.expiresAt,
  };
}

export async function createPolicyIdentityVariant(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  if (context.assurance !== 'SECURE') throw new PolicyForbiddenError();
  const parsed = secureVariantSchema.parse(raw);
  const existing = await load(db, active.agencyId, id);
  if (!existing) throw new PolicyNotFoundError();
  const grantPayload = { expectedVersion: parsed.expectedVersion, reason: parsed.reason };
  const base = {
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: grantPayload,
    sourcePolicyId: id,
    expectedVersion: parsed.expectedVersion,
    reason: parsed.reason,
  };
  const replay = await findPolicyVariantReplay(base);
  if (replay) return { data: replay.body as PolicyDto, status: replay.status, replayed: true };
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'policy.identity_variant.create',
    resource: resource(existing),
    secureGrantBinding: {
      evidence: parsed.grantEvidenceToken,
      payload: grantPayload,
      targetIds: [id],
      expectedTargetVersion: parsed.expectedVersion,
    },
  });
  if (authz.decision !== 'ALLOW' || authz.effectiveScope !== 'AGENCY')
    throw new PolicyForbiddenError(authz.code);
  const result = await executePolicyVariantCommand({
    ...base,
    grantToken: parsed.grantEvidenceToken,
    result: (newId: string, variant: number, now: string): PolicyDto => ({
      ...toDto(existing),
      id: newId,
      identityVariant: variant,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  });
  return { data: result.body as PolicyDto, status: result.status, replayed: result.replayed };
}

export async function listPolicies(
  context: AuthenticatedUserContext,
  db: D1Database,
  raw: unknown,
): Promise<PolicyListResponseData> {
  const active = { ...membership(context) },
    query = policyListQuerySchema.parse(raw);
  const actorIdentityId = context.identityId,
    actorUserId = context.userId;
  const grants = await captureValidatedPermissions(db, active.id, active.type);
  if (grants === null) throw new PolicyForbiddenError();
  const access = await authorize(db, context, 'policy.read', {
    agencyId: active.agencyId,
    isCollection: true,
  });
  const healthAccess = await evaluateAuthorization(db, {
    context,
    action: 'policy.health.read',
    resource: { agencyId: active.agencyId, isCollection: true },
  });
  // The request-bound batch also supplies live session/credential-epoch checks.
  const assertion = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
     SELECT ?,1,count(*),'MEMBERSHIP_PERMISSION_NOT_FOUND'
     FROM agency_memberships m JOIN users u ON u.id=m.user_id
     JOIN agencies a ON a.id=m.agency_id
     JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
     WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.type=? AND m.permission_version=?
       AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
       AND ((${membershipPermissionSnapshotSql}) COLLATE BINARY)=?
       AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp
         WHERE mp.membership_id=m.id AND mp.permission_code='policy.read' AND mp.scope=?))
       ${healthAccess.decision === 'ALLOW' ? "AND EXISTS(SELECT 1 FROM membership_permissions hp WHERE hp.membership_id=m.id AND hp.permission_code='sensitive.health.read' AND hp.scope='UNSCOPED')" : ''}`,
    )
    .bind(
      crypto.randomUUID(),
      actorIdentityId,
      active.id,
      active.agencyId,
      actorUserId,
      active.type,
      active.permissionVersion,
      active.id,
      grants,
      access.effectiveScope,
    );
  const where = ['p.agency_id=?'],
    values: unknown[] = [active.agencyId];
  if (access.effectiveScope === 'ASSIGNED') {
    where.push('(p.assignee_membership_id=? OR c.assignee_membership_id=?)');
    values.push(active.id, active.id);
  }
  if (healthAccess.decision !== 'ALLOW') where.push("b.data_classification='GENERAL'");
  if (query.customerId) {
    where.push('p.customer_id=?');
    values.push(query.customerId);
  }
  if (query.insurerId) {
    where.push('p.insurer_id=?');
    values.push(query.insurerId);
  }
  if (query.status) {
    where.push('p.status=?');
    values.push(query.status);
  }
  if (query.search) {
    const normalizedSearch = normalizePolicyNumber(query.search);
    if (query.searchMode === 'exact') {
      where.push('p.normalized_policy_number = ?');
      values.push(normalizedSearch);
    } else {
      where.push('p.normalized_policy_number LIKE ?');
      values.push(`${normalizedSearch}%`);
    }
  }
  if (query.customerSearch) {
    // SQLite lower() is ASCII-only. Catalog text uses explicit Turkish case folding.
    const fold = (column: 'pr.name' | 'i.name') => {
      let expression: string = column;
      for (const [upper, lower] of [
        ['İ', 'i'],
        ['I', 'ı'],
        ['Ç', 'ç'],
        ['Ğ', 'ğ'],
        ['Ö', 'ö'],
        ['Ş', 'ş'],
        ['Ü', 'ü'],
      ])
        expression = `replace(${expression},'${upper}','${lower}')`;
      return `lower(${expression})`;
    };
    const term = query.customerSearch.toLocaleLowerCase('tr-TR');
    const parts = [`instr(${fold('pr.name')},?)>0`, `instr(${fold('i.name')},?)>0`];
    values.push(term, term);
    try {
      const number = normalizePolicyNumber(query.customerSearch);
      parts.push('instr(p.normalized_policy_number,?)>0');
      values.push(number);
    } catch {
      /* Literal punctuation is not a wildcard. */
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (query.endFrom) {
    where.push('p.end_date>=?');
    values.push(query.endFrom);
  }
  if (query.endTo) {
    where.push('p.end_date<=?');
    values.push(query.endTo);
  }
  const sortColumn = query.sort === 'created_at_desc' ? 'p.created_at' : 'p.end_date',
    desc = query.sort !== 'end_date_asc';
  const cursorBinding = query.customerSearch
    ? await computePayloadHash({
        agency: active.agencyId,
        actor: active.id,
        customer: query.customerId!,
        customerSearch: query.customerSearch,
        search: query.search ?? null,
        searchMode: query.searchMode,
        insurer: query.insurerId ?? null,
        status: query.status ?? null,
        endFrom: query.endFrom ?? null,
        endTo: query.endTo ?? null,
        sort: query.sort,
        pageSize: query.pageSize,
      })
    : null;
  if (query.cursor) {
    let tuple: unknown;
    try {
      tuple = JSON.parse(atob(query.cursor));
    } catch {
      throw new PolicyConstraintError('INVALID_CURSOR');
    }
    if (
      !Array.isArray(tuple) ||
      tuple.length !== (cursorBinding ? 3 : 2) ||
      (cursorBinding !== null && tuple[2] !== cursorBinding) ||
      typeof tuple[0] !== 'string' ||
      typeof tuple[1] !== 'string'
    )
      throw new PolicyConstraintError('INVALID_CURSOR');
    const [sort, id] = tuple;
    where.push(
      `(${sortColumn} ${desc ? '<' : '>'} ? OR (${sortColumn}=? AND p.id ${desc ? '<' : '>'} ?))`,
    );
    values.push(sort, sort, id);
  }
  values.push(query.pageSize + 1);
  const statement = db
    .prepare(
      `SELECT p.* ${query.includeLabels ? ',b.name AS branch_name,pr.name AS product_name,i.name AS insurer_name' : ''} FROM policies p
    JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    ${query.includeLabels ? 'JOIN insurance_products pr ON pr.agency_id=p.agency_id AND pr.id=p.product_id JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id' : ''}
    WHERE ${where.join(' AND ')} ORDER BY ${sortColumn} ${desc ? 'DESC' : 'ASC'},p.id ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
    )
    .bind(...values);
  let result: D1Result<Row & { branch_name: string; product_name: string; insurer_name: string }>;
  try {
    result = (
      await db.batch<Row & { branch_name: string; product_name: string; insurer_name: string }>([
        assertion,
        statement,
      ])
    )[1]!;
  } catch (error) {
    if (
      /LOCAL_SESSION_REVOKED|MEMBERSHIP_PERMISSION_NOT_FOUND|OPTIMISTIC_CONCURRENCY_CONFLICT/.test(
        error instanceof Error ? error.message : '',
      )
    )
      throw new PolicyForbiddenError();
    throw error;
  }
  if (!result?.success || !Array.isArray(result.results)) throw new Error('POLICY_QUERY_FAILED');
  const hasMore = result.results.length > query.pageSize,
    items = result.results.slice(0, query.pageSize).map((row) => ({
      ...toDto(row),
      ...(query.includeLabels
        ? {
            labels: {
              branchName: row.branch_name,
              productName: row.product_name,
              insurerName: row.insurer_name,
            },
          }
        : {}),
    })),
    last = items.at(-1);
  const cursorValue = query.sort === 'created_at_desc' ? last?.createdAt : last?.endDate;
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last && cursorValue
        ? btoa(
            JSON.stringify(
              cursorBinding ? [cursorValue, last.id, cursorBinding] : [cursorValue, last.id],
            ),
          )
        : null,
  };
}

async function authorizeRelationshipMutation(
  db: D1Database,
  context: AuthenticatedUserContext,
  action: string,
  policy: Row,
) {
  await authorize(db, context, action, resource(policy));
  if (
    (await classification(db, policy.agency_id, policy.branch_id))?.data_classification === 'HEALTH'
  ) {
    await authorize(
      db,
      context,
      action === 'policy.archive' ? 'policy.health.archive' : 'policy.health.update',
      resource(policy),
    );
  }
}

async function authorizeCurrentRelationshipMutation(
  db: D1Database,
  context: AuthenticatedUserContext,
  policyId: string,
  action: string,
) {
  const active = membership(context);
  const current = await load(db, active.agencyId, policyId);
  if (!current || (action !== 'policy.archive' && current.archived_at !== null))
    throw new PolicyAuthorizationRaceError();
  await authorizeRelationshipMutation(db, context, action, current);
  return current;
}

async function authorizeRelationshipRead(
  db: D1Database,
  context: AuthenticatedUserContext,
  policy: Row,
) {
  await authorize(db, context, 'policy.read', resource(policy));
  if (
    (await classification(db, policy.agency_id, policy.branch_id))?.data_classification === 'HEALTH'
  ) {
    await authorize(db, context, 'policy.health.read', resource(policy));
  }
}

export async function listPolicyParties(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
): Promise<PolicyPartyDto[]> {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  await authorizeRelationshipRead(db, context, policy);
  const rows = await db
    .prepare(
      `SELECT pp.id,pp.agency_id,pp.policy_id,pp.customer_id,c.display_name AS customer_display_name,
            pp.role,pp.status,pp.version,pp.deactivated_at,pp.deactivated_by_membership_id,
            pp.created_at,pp.updated_at
     FROM policy_parties pp JOIN customers c ON c.agency_id=pp.agency_id AND c.id=pp.customer_id
     WHERE pp.agency_id=? AND pp.policy_id=? ORDER BY pp.created_at,pp.id`,
    )
    .bind(active.agencyId, policyId)
    .all<{
      id: string;
      agency_id: string;
      policy_id: string;
      customer_id: string;
      customer_display_name: string;
      role: 'INSURED' | 'BENEFICIARY';
      status: 'ACTIVE' | 'INACTIVE';
      version: number;
      deactivated_at: string | null;
      deactivated_by_membership_id: string | null;
      created_at: string;
      updated_at: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    agencyId: row.agency_id,
    policyId: row.policy_id,
    customerId: row.customer_id,
    customerDisplayName: row.customer_display_name,
    role: row.role,
    status: row.status,
    version: row.version,
    deactivatedAt: row.deactivated_at,
    deactivatedByMembershipId: row.deactivated_by_membership_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listPolicyAmendments(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
): Promise<PolicyAmendmentDto[]> {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  await authorizeRelationshipRead(db, context, policy);
  const rows = await db
    .prepare(
      `SELECT id,agency_id,policy_id,external_reference,effective_date,description,
            premium_difference_minor,currency,created_at
     FROM policy_amendments WHERE agency_id=? AND policy_id=? ORDER BY effective_date,created_at,id`,
    )
    .bind(active.agencyId, policyId)
    .all<{
      id: string;
      agency_id: string;
      policy_id: string;
      external_reference: string;
      effective_date: string;
      description: string;
      premium_difference_minor: number | null;
      currency: string | null;
      created_at: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    agencyId: row.agency_id,
    policyId: row.policy_id,
    externalReference: row.external_reference,
    effectiveDate: row.effective_date,
    description: row.description,
    premiumDifferenceMinor: row.premium_difference_minor,
    currency: row.currency,
    createdAt: row.created_at,
  }));
}

export async function listPolicyExternalReferences(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
): Promise<PolicyExternalReferenceDto[]> {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  await authorizeRelationshipRead(db, context, policy);
  const rows = await db
    .prepare(
      `SELECT id,agency_id,policy_id,source_namespace,external_key,created_at
     FROM policy_external_references WHERE agency_id=? AND policy_id=? ORDER BY created_at,id`,
    )
    .bind(active.agencyId, policyId)
    .all<{
      id: string;
      agency_id: string;
      policy_id: string;
      source_namespace: string;
      external_key: string;
      created_at: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    agencyId: row.agency_id,
    policyId: row.policy_id,
    sourceNamespace: row.source_namespace,
    externalKey: row.external_key,
    createdAt: row.created_at,
  }));
}

function relationshipBase(
  context: AuthenticatedUserContext,
  db: D1Database,
  idempotencyKey: string,
) {
  const active = membership(context);
  return {
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
  };
}

export async function createPolicyParty(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  const data = policyPartyCreateSchema.parse(raw);
  await authorizeRelationshipMutation(db, context, 'policy_party.create', policy);
  const completed = await findPolicyRelationshipReplay({
    ...relationshipBase(context, db, idempotencyKey),
    action: 'policy_party.create',
    target: policyId,
    payload: raw,
    version: data.expectedVersion,
  });
  if (completed) {
    await authorizeCurrentRelationshipMutation(db, context, policyId, 'policy_party.create');
    const replayCustomer = await db
      .prepare('SELECT assignee_membership_id FROM customers WHERE agency_id=? AND id=?')
      .bind(active.agencyId, data.customerId)
      .first<{ assignee_membership_id: string }>();
    if (!replayCustomer) throw new PolicyAuthorizationRaceError();
    await authorize(db, context, 'customer.read', {
      agencyId: active.agencyId,
      assigneeMembershipId: replayCustomer.assignee_membership_id,
    });
    return { data: completed.body as PolicyPartyDto, status: completed.status, replayed: true };
  }
  const customer = await db
    .prepare(
      'SELECT id,display_name,assignee_membership_id FROM customers WHERE agency_id=? AND id=? AND archived_at IS NULL',
    )
    .bind(active.agencyId, data.customerId)
    .first<{ id: string; display_name: string; assignee_membership_id: string }>();
  if (!customer) throw new PolicyConstraintError('CUSTOMER_NOT_FOUND');
  await authorize(db, context, 'customer.read', {
    agencyId: active.agencyId,
    assigneeMembershipId: customer.assignee_membership_id,
  });
  const id = crypto.randomUUID();
  const result = await executePolicyRelationshipCommand({
    ...relationshipBase(context, db, idempotencyKey),
    payload: raw,
    command: {
      kind: 'policy_party.create',
      policyId,
      expectedVersion: data.expectedVersion,
      partyId: id,
      customerId: data.customerId,
      role: data.role,
    },
    result: (now: string): PolicyPartyDto => ({
      id,
      agencyId: active.agencyId,
      policyId,
      customerId: data.customerId,
      customerDisplayName: customer.display_name,
      role: data.role,
      status: 'ACTIVE',
      version: 1,
      deactivatedAt: null,
      deactivatedByMembershipId: null,
      createdAt: now,
      updatedAt: now,
    }),
    status: 201,
  });
  return { data: result.body as PolicyPartyDto, status: result.status, replayed: result.replayed };
}

export async function deactivatePolicyParty(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
  partyId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  const data = policyPartyDeactivateSchema.parse(raw);
  await authorizeRelationshipMutation(db, context, 'policy_party.deactivate', policy);
  const completed = await findPolicyRelationshipReplay({
    ...relationshipBase(context, db, idempotencyKey),
    action: 'policy_party.deactivate',
    target: `${policyId}:${partyId}`,
    payload: raw,
    version: data.expectedVersion,
  });
  if (completed) {
    await authorizeCurrentRelationshipMutation(db, context, policyId, 'policy_party.deactivate');
    return { data: completed.body as PolicyPartyDto, status: completed.status, replayed: true };
  }
  if (policy.archived_at !== null) throw new PolicyConstraintError('POLICY_ARCHIVED');
  const party = await db
    .prepare(
      `SELECT pp.*,c.display_name AS customer_display_name FROM policy_parties pp
              JOIN customers c ON c.agency_id=pp.agency_id AND c.id=pp.customer_id
              WHERE pp.agency_id=? AND pp.policy_id=? AND pp.id=?`,
    )
    .bind(active.agencyId, policyId, partyId)
    .first<{
      id: string;
      agency_id: string;
      policy_id: string;
      customer_id: string;
      customer_display_name: string;
      role: 'INSURED' | 'BENEFICIARY';
      status: 'ACTIVE' | 'INACTIVE';
      version: number;
      deactivated_at: string | null;
      deactivated_by_membership_id: string | null;
      created_at: string;
      updated_at: string;
    }>();
  if (!party) throw new PolicyNotFoundError();
  const result = await executePolicyRelationshipCommand({
    ...relationshipBase(context, db, idempotencyKey),
    payload: raw,
    command: {
      kind: 'policy_party.deactivate',
      policyId,
      partyId,
      expectedVersion: data.expectedVersion,
    },
    result: (now: string): PolicyPartyDto => ({
      id: party.id,
      agencyId: party.agency_id,
      policyId: party.policy_id,
      customerId: party.customer_id,
      customerDisplayName: party.customer_display_name,
      role: party.role,
      status: 'INACTIVE',
      version: party.version + 1,
      deactivatedAt: now,
      deactivatedByMembershipId: active.id,
      createdAt: party.created_at,
      updatedAt: now,
    }),
    status: 200,
  });
  return { data: result.body as PolicyPartyDto, status: result.status, replayed: result.replayed };
}

export async function createPolicyAmendment(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  const data = policyAmendmentCreateSchema.parse(raw);
  const parsedDate = new Date(`${data.effectiveDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== data.effectiveDate
  )
    throw new PolicyConstraintError('INVALID_EFFECTIVE_DATE');
  await authorizeRelationshipMutation(db, context, 'policy_amendment.create', policy);
  const amount = data.premiumDifferenceMinor;
  const id = crypto.randomUUID();
  const result = await executePolicyRelationshipCommand({
    ...relationshipBase(context, db, idempotencyKey),
    payload: raw,
    command: {
      kind: 'policy_amendment.create',
      policyId,
      expectedVersion: data.expectedVersion,
      amendmentId: id,
      externalReference: data.externalReference,
      effectiveDate: data.effectiveDate,
      description: data.description,
      premiumDifferenceMinor: amount,
      currency: data.currency,
    },
    result: (now: string): PolicyAmendmentDto => ({
      id,
      agencyId: active.agencyId,
      policyId,
      externalReference: data.externalReference,
      effectiveDate: data.effectiveDate,
      description: data.description,
      premiumDifferenceMinor: amount,
      currency: data.currency,
      createdAt: now,
    }),
    status: 201,
  });
  return {
    data: result.body as PolicyAmendmentDto,
    status: result.status,
    replayed: result.replayed,
  };
}

export async function createPolicyExternalReference(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  const data = policyExternalReferenceCreateSchema.parse(raw);
  await authorizeRelationshipMutation(db, context, 'policy_external_reference.create', policy);
  const id = crypto.randomUUID();
  const result = await executePolicyRelationshipCommand({
    ...relationshipBase(context, db, idempotencyKey),
    payload: raw,
    command: {
      kind: 'policy_external_reference.create',
      policyId,
      expectedVersion: data.expectedVersion,
      referenceId: id,
      sourceNamespace: data.sourceNamespace,
      externalKey: data.externalKey,
    },
    result: (now: string): PolicyExternalReferenceDto => ({
      id,
      agencyId: active.agencyId,
      policyId,
      sourceNamespace: data.sourceNamespace,
      externalKey: data.externalKey,
      createdAt: now,
    }),
    status: 201,
  });
  return {
    data: result.body as PolicyExternalReferenceDto,
    status: result.status,
    replayed: result.replayed,
  };
}

export async function archivePolicy(
  context: AuthenticatedUserContext,
  db: D1Database,
  policyId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  const active = membership(context);
  const policy = await load(db, active.agencyId, policyId);
  if (!policy) throw new PolicyNotFoundError();
  const data = archivePolicySchema.parse(raw);
  await authorizeRelationshipMutation(db, context, 'policy.archive', policy);
  const result = await executePolicyRelationshipCommand({
    ...relationshipBase(context, db, idempotencyKey),
    payload: raw,
    command: {
      kind: 'policy.archive',
      policyId,
      expectedVersion: data.expectedVersion,
      reasonCode: data.reasonCode,
    },
    result: (now: string): PolicyDto => ({
      ...toDto(policy),
      archivedAt: now,
      archivedByMembershipId: active.id,
      archiveReason: data.reasonCode,
      version: policy.version + 1,
      updatedAt: now,
    }),
    status: 200,
  });
  return { data: result.body as PolicyDto, status: result.status, replayed: result.replayed };
}

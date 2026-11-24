import type { AuthenticatedUserContext } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import { isCanonicalTimestamp, RenewalCommandError } from './command-contract';
import type { ActiveMembership, ReceiptRow, RenewalTaskRow, RenewalVoidResult } from './commands';
import type { voidRenewalRequestSchema } from './validation';

export const VOID_ACTION = 'renewal.void';
type VoidRenewalInput = ReturnType<typeof voidRenewalRequestSchema.parse>;

export function voidFingerprint(renewalId: string, input: VoidRenewalInput): Promise<string> {
  return computePayloadHash({
    action: VOID_ACTION,
    target: renewalId,
    payload: input,
    version: {
      expectedRenewalVersion: input.expectedRenewalVersion,
      expectedTaskVersion: input.expectedTaskVersion,
    },
  });
}

function parseVoidReceipt(
  raw: string | null,
  input: VoidRenewalInput,
  renewalId: string,
  taskId: string,
): RenewalVoidResult {
  if (!raw) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  const result = parsed as Record<string, unknown>;
  const keys = [
    'renewalId',
    'previousState',
    'state',
    'voidReasonCode',
    'primaryTaskId',
    'renewalVersion',
    'taskVersion',
    'closedAt',
  ];
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(result, key)) ||
    result.renewalId !== renewalId ||
    result.primaryTaskId !== taskId ||
    result.state !== 'VOIDED' ||
    result.voidReasonCode !== input.voidReasonCode ||
    ![
      'CONTACT_PENDING',
      'CONTACTED',
      'QUOTE_PREPARING',
      'QUOTE_SENT',
      'AWAITING_RESPONSE',
    ].includes(String(result.previousState)) ||
    result.renewalVersion !== input.expectedRenewalVersion + 1 ||
    result.taskVersion !== input.expectedTaskVersion + 1 ||
    !isCanonicalTimestamp(result.closedAt)
  ) {
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
  return result as unknown as RenewalVoidResult;
}

export function parseVoidReceiptResult(
  receipt: ReceiptRow,
  expectedFingerprint: string,
  input: VoidRenewalInput,
  renewalId: string,
  taskId: string,
): RenewalVoidResult {
  if (
    receipt.action !== VOID_ACTION ||
    receipt.payload_fingerprint !== expectedFingerprint ||
    receipt.status !== 'COMPLETED' ||
    receipt.response_status !== 200
  ) {
    throw new RenewalCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  return parseVoidReceipt(receipt.response_body, input, renewalId, taskId);
}

export function voidRenewalStatement(
  db: D1Database,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: VoidRenewalInput,
  closedAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE renewal_opportunities
       SET state='VOIDED',loss_reason_id=NULL,loss_reason_notes=NULL,void_reason_code=?,
           closed_at=?,closed_by_membership_id=?,version=version+1,updated_at=?
       WHERE agency_id=? AND id=? AND version=?
         AND state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
         AND closed_at IS NULL AND assignee_membership_id IS ?
         AND EXISTS(
           SELECT 1 FROM tasks t
           WHERE t.agency_id=renewal_opportunities.agency_id AND t.renewal_id=renewal_opportunities.id
             AND t.id=? AND t.kind='RENEWAL_FOLLOWUP' AND t.status='COMPLETED'
             AND t.version=? AND t.completed_at=? AND t.completed_by_membership_id=?
         )`,
    )
    .bind(
      input.voidReasonCode,
      closedAt,
      active.id,
      closedAt,
      active.agencyId,
      row.renewal_id,
      row.renewal_version,
      row.renewal_assignee_membership_id,
      row.task_id,
      row.task_version + 1,
      closedAt,
      active.id,
    );
}

export function voidAuditInsert(
  db: D1Database,
  context: AuthenticatedUserContext,
  active: ActiveMembership,
  row: RenewalTaskRow,
  input: VoidRenewalInput,
  idempotencyKey: string,
  closedAt: string,
): D1PreparedStatement {
  const audit = buildSafeAuditRecord({
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    action: 'renewal.voided',
    targetType: 'renewal_opportunities',
    targetId: row.renewal_id,
    correlationId: idempotencyKey,
    idempotencyKey,
    outcome: 'SUCCESS',
    createdAt: closedAt,
    metadata: {
      reasonCode: input.voidReasonCode,
      changedFields: ['state', 'void_reason_code', 'closed_at', 'primary_task_status'],
    },
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

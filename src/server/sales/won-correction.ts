import {
  salesWonCorrectionMutationSchema,
  salesWonCorrectionReceiptSchema,
  salesWonCorrectionSchema,
  type SalesWonCorrection,
  type SalesWonCorrectionResult,
} from '../../shared/sales-won-correction';
import type { AuthenticatedUserContext as Context } from '../auth/identity';
import { RECENT_PASSWORD_MS } from '../auth/session';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import {
  canonicalizeTargetIds,
  computeEvidenceHash,
  issueAndPersistSensitiveActionGrant,
} from '../mutations/grants';
import { casAssertion } from '../renewals/commands';
import { newBusinessTaskQuery } from './new-business-task';
import { member, SalesError } from './service';

const action = 'sales.case.correct_won';
const policyAuthority = `(m.type='OWNER' OR (
  EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='task.create' AND x.scope='UNSCOPED')
  AND (SELECT count(DISTINCT x.permission_code) FROM membership_permissions x WHERE x.membership_id=m.id
    AND x.permission_code IN ('policy.read','policy.update') AND x.scope='AGENCY')=2))`;
const current = `s.result='WON' AND s.active_task_id IS NULL AND s.current_result_id IS NULL
  AND t.status='COMPLETED' AND c.archived_at IS NULL AND s.version=w.case_version`;

function correctionQuery(ctx: Context, caseId: string, taskId?: string) {
  const joins = `JOIN sales_case_policy_results w ON w.agency_id=s.agency_id AND w.case_id=s.id
    AND w.task_id=t.id AND w.task_version=t.version
    JOIN policies p ON p.agency_id=w.agency_id AND p.id=w.policy_id
      AND p.customer_id=s.customer_id AND p.branch_id=s.branch_id`;
  const q = newBusinessTaskQuery(ctx, caseId, taskId, joins);
  return { args: q.args, sql: `${q.sql} AND ${policyAuthority}` };
}

function securePredicate(ctx: Context) {
  if (ctx.assurance !== 'SECURE' || !ctx.sessionHash)
    throw new SalesError('SECURE_ASSURANCE_REQUIRED', 403);
  return {
    sql: `EXISTS(SELECT 1 FROM local_sessions verified WHERE verified.token_hash=? AND verified.user_id=u.id
      AND verified.membership_id=m.id AND verified.recent_password_at<=unixepoch('subsec')*1000
      AND verified.recent_password_at>unixepoch('subsec')*1000-?)`,
    args: [ctx.sessionHash, RECENT_PASSWORD_MS],
  };
}

type Expected = Omit<SalesWonCorrection, 'replacementDueAt' | 'notes'>;
export async function readSalesWonCorrectionContext(db: D1Database, ctx: Context, caseId: string) {
  // The completed task is selected from the issuance evidence, never from an arbitrary shared task.
  const actor = member(ctx);
  const prior = await db
    .prepare(
      `SELECT w.task_id FROM sales_cases s JOIN sales_case_policy_results w
    ON w.agency_id=s.agency_id AND w.case_id=s.id AND w.case_version=s.version
    WHERE s.agency_id=? AND s.id=? AND s.result='WON' AND s.context_kind='NEW_BUSINESS'`,
    )
    .bind(actor.agencyId, caseId)
    .first<{ task_id: string }>();
  if (!prior) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  const q = correctionQuery(ctx, caseId, prior.task_id);
  const result = await db
    .prepare(
      `SELECT s.version expectedCaseVersion,w.receipt_id expectedIssueReceiptId,
    t.id expectedTaskId,t.version expectedTaskVersion,p.id expectedPolicyId,p.version expectedPolicyVersion,
    p.policy_number policyNumber ${q.sql} AND ${current}`,
    )
    .bind(...q.args)
    .first<Expected & { policyNumber: string }>();
  if (!result) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  return result;
}

function boundQuery(ctx: Context, caseId: string, command: SalesWonCorrection) {
  const q = correctionQuery(ctx, caseId, command.expectedTaskId);
  const secure = securePredicate(ctx);
  return {
    sql: `${q.sql} AND ${current} AND ${secure.sql} AND s.version=? AND w.receipt_id=?
      AND t.version=? AND p.id=? AND p.version=?`,
    args: [
      ...q.args,
      ...secure.args,
      command.expectedCaseVersion,
      command.expectedIssueReceiptId,
      command.expectedTaskVersion,
      command.expectedPolicyId,
      command.expectedPolicyVersion,
    ],
  };
}

const fingerprint = (caseId: string, command: SalesWonCorrection) =>
  computePayloadHash({ action, targetId: caseId, command });

export async function issueSalesWonCorrectionGrant(
  db: D1Database,
  ctx: Context,
  caseId: string,
  input: unknown,
  key: string,
  secret: string,
) {
  const command = salesWonCorrectionSchema.parse(input);
  const q = boundQuery(ctx, caseId, command);
  if (
    !(await db
      .prepare(`SELECT 1 ${q.sql}`)
      .bind(...q.args)
      .first())
  )
    throw new SalesError('CONFLICT');
  if (command.replacementDueAt <= new Date().toISOString())
    throw new SalesError('REOPEN_DATE_INVALID', 400);
  if (secret.length < 32) throw new SalesError('GRANT_KEY_UNAVAILABLE', 500);
  const actor = member(ctx);
  const payloadHash = await fingerprint(caseId, command);
  const encoder = new TextEncoder();
  const master = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  const signingKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('mayi-sigorta-v1'),
      info: encoder.encode('sales-won-correction/grant-evidence'),
    },
    master,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const binding = JSON.stringify([
    'sales-won-correction-grant/v1',
    actor.agencyId,
    actor.id,
    ctx.userId,
    ctx.identityId,
    caseId,
    key,
  ]);
  const token = Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, encoder.encode(binding))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const evidenceHash = await computeEvidenceHash(token);
  const targets = [caseId, command.expectedTaskId, command.expectedPolicyId];
  const targetJson = canonicalizeTargetIds(targets);
  const existing = async () => {
    const grant = await db
      .prepare(
        `SELECT id,payload_hash,status,expires_at,permission_version
      FROM sensitive_action_grants WHERE evidence_hash=? AND action=? AND agency_id=?
        AND actor_user_id=? AND actor_membership_id=? AND target_ids_json=? AND expected_target_version=?`,
      )
      .bind(
        evidenceHash,
        action,
        actor.agencyId,
        ctx.userId,
        actor.id,
        targetJson,
        command.expectedCaseVersion,
      )
      .first<{
        id: string;
        payload_hash: string;
        status: string;
        expires_at: string;
        permission_version: number;
      }>();
    if (!grant) return null;
    if (
      grant.payload_hash !== payloadHash ||
      grant.permission_version !== actor.permissionVersion ||
      grant.status !== 'ISSUED' ||
      grant.expires_at <= new Date().toISOString()
    )
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    return {
      grantId: grant.id,
      grantEvidenceToken: token,
      expiresAt: grant.expires_at,
      replayed: true,
    };
  };
  const saved = await existing();
  if (saved) return saved;
  try {
    const { grantRecord } = await issueAndPersistSensitiveActionGrant(db, ctx, {
      agencyId: actor.agencyId,
      action,
      targetIds: targets,
      expectedTargetVersion: command.expectedCaseVersion,
      payloadHash,
      evidenceToken: token,
    });
    return {
      grantId: grantRecord.id,
      grantEvidenceToken: token,
      expiresAt: grantRecord.expiresAt,
      replayed: false,
    };
  } catch (error) {
    const raced = await existing();
    if (raced) return raced;
    if (/sensitive_action_grants.evidence_hash/i.test(String(error)))
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    throw error;
  }
}

async function readReceipt(db: D1Database, ctx: Context, key: string) {
  const actor = member(ctx);
  return db
    .prepare(
      `SELECT id,action,payload_fingerprint,response_body FROM operation_receipts
    WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=? AND status='COMPLETED'`,
    )
    .bind(actor.agencyId, ctx.userId, actor.id, key)
    .first<{ id: string; action: string; payload_fingerprint: string; response_body: string }>();
}

async function verifyCorrection(
  db: D1Database,
  ctx: Context,
  caseId: string,
  receipt: NonNullable<Awaited<ReturnType<typeof readReceipt>>>,
) {
  if (receipt.action !== action) throw new SalesError('OPERATION_NOT_FOUND', 404);
  const { command, grantId, result } = salesWonCorrectionReceiptSchema.parse(
    JSON.parse(receipt.response_body),
  );
  if (
    result.caseId !== caseId ||
    result.operationId !== receipt.id ||
    receipt.payload_fingerprint !== (await fingerprint(caseId, command))
  )
    throw new SalesError('OPERATION_NOT_FOUND', 404);
  const q = correctionQuery(ctx, caseId, command.expectedTaskId);
  const actor = member(ctx);
  const proof = await db
    .prepare(
      `SELECT 1 ${q.sql} AND w.receipt_id=? AND w.case_version=?
    AND t.status='COMPLETED' AND p.id=? AND p.version>=?
    AND EXISTS(SELECT 1 FROM sensitive_action_grants g WHERE g.id=? AND g.agency_id=s.agency_id
      AND g.actor_user_id=u.id AND g.actor_membership_id=m.id AND g.action=? AND g.status='CONSUMED'
      AND g.consumed_operation_id=? AND g.payload_hash=?)
    AND EXISTS(SELECT 1 FROM sales_case_history h WHERE h.agency_id=s.agency_id AND h.case_id=s.id
      AND h.receipt_id=? AND h.event_code='CASE_WON_CORRECTED' AND h.case_version=? AND h.task_id=?
      AND h.created_at=? AND h.actor_membership_id=m.id AND h.actor_user_id=u.id)
    AND EXISTS(SELECT 1 FROM audit_events ev WHERE ev.agency_id=s.agency_id AND ev.correlation_id=?
      AND ev.action=? AND ev.outcome='SUCCESS' AND ev.actor_membership_id=? AND ev.target_id=s.id
      AND json_extract(ev.metadata_json,'$.responseHash')=?)`,
    )
    .bind(
      ...q.args,
      command.expectedIssueReceiptId,
      command.expectedCaseVersion,
      command.expectedPolicyId,
      command.expectedPolicyVersion,
      grantId,
      action,
      receipt.id,
      receipt.payload_fingerprint,
      receipt.id,
      result.caseVersion,
      result.taskId,
      result.correctedAt,
      receipt.id,
      action,
      actor.id,
      await computePayloadHash(result),
    )
    .first();
  if (!proof) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return result;
}

export async function readSalesWonCorrectionOperation(
  db: D1Database,
  ctx: Context,
  caseId: string,
  key: string,
) {
  const saved = await readReceipt(db, ctx, key);
  if (!saved) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return verifyCorrection(db, ctx, caseId, saved);
}

export async function correctSalesWon(
  db: D1Database,
  ctx: Context,
  caseId: string,
  input: unknown,
  key: string,
) {
  const { command, grantId, grantEvidenceToken } = salesWonCorrectionMutationSchema.parse(input);
  const q = boundQuery(ctx, caseId, command);
  const actor = member(ctx);
  const hash = await fingerprint(caseId, command);
  const replay = async (saved: NonNullable<Awaited<ReturnType<typeof readReceipt>>>) => {
    if (saved.action !== action || saved.payload_fingerprint !== hash)
      throw new SalesError('IDEMPOTENCY_CONFLICT');
    return { data: await verifyCorrection(db, ctx, caseId, saved), replayed: true };
  };
  const saved = await readReceipt(db, ctx, key);
  if (saved) return replay(saved);
  const target = await db
    .prepare(`SELECT s.customer_id ${q.sql}`)
    .bind(...q.args)
    .first<{ customer_id: string }>();
  if (!target) {
    const raced = await readReceipt(db, ctx, key);
    if (raced) return replay(raced);
    throw new SalesError('CONFLICT');
  }
  const now = new Date().toISOString();
  if (command.replacementDueAt <= now) throw new SalesError('REOPEN_DATE_INVALID', 400);
  const result: SalesWonCorrectionResult = {
    operationId: crypto.randomUUID(),
    caseId,
    caseVersion: command.expectedCaseVersion + 1,
    taskId: crypto.randomUUID(),
    taskVersion: 1,
    dueAt: command.replacementDueAt,
    correctedAt: now,
  };
  const evidence = await computeEvidenceHash(grantEvidenceToken);
  const targets = canonicalizeTargetIds([caseId, command.expectedTaskId, command.expectedPolicyId]);
  const audit = buildSafeAuditRecord({
    agencyId: actor.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: actor.id,
    action,
    targetType: 'sales_cases',
    targetId: caseId,
    correlationId: result.operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: { responseHash: await computePayloadHash(result) },
    createdAt: now,
  });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
        SELECT ?,1,count(*),'OPTIMISTIC_CONCURRENCY_CONFLICT' ${q.sql}`,
        )
        .bind(crypto.randomUUID(), ...q.args),
      db
        .prepare(
          `UPDATE sensitive_action_grants SET status='CONSUMED',consumed_at=?,consumed_operation_id=?,updated_at=?
        WHERE id=? AND evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=?
          AND action=? AND payload_hash=? AND target_ids_json=? AND expected_target_version=? AND permission_version=?
          AND assurance='SECURE_GRANT' AND status='ISSUED' AND issued_at<=? AND expires_at>?`,
        )
        .bind(
          now,
          result.operationId,
          now,
          grantId,
          evidence,
          actor.agencyId,
          ctx.userId,
          actor.id,
          action,
          hash,
          targets,
          command.expectedCaseVersion,
          actor.permissionVersion,
          now,
          now,
        ),
      casAssertion(db, 'SENSITIVE_GRANT_CONSUMPTION_FAILED'),
      db
        .prepare(
          `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
        payload_fingerprint,status,response_status,response_body,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'COMPLETED',200,?,?,?)`,
        )
        .bind(
          result.operationId,
          actor.agencyId,
          ctx.userId,
          actor.id,
          action,
          key,
          hash,
          JSON.stringify({ command, grantId, result }),
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,
        created_by_user_id,created_by_membership_id,created_at,updated_at)
        VALUES(?,?,?,'GENERAL','Teklif çalışması',?,?,'USER',?,?,?,?)`,
        )
        .bind(
          result.taskId,
          actor.agencyId,
          target.customer_id,
          result.dueAt,
          actor.id,
          ctx.userId,
          actor.id,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose,created_at)
        VALUES(?,?,?,?,'ACTIVE_CONTACT',?)`,
        )
        .bind(crypto.randomUUID(), actor.agencyId, caseId, result.taskId, now),
      db
        .prepare(
          `INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,
        reason_code,notes,actor_user_id,actor_membership_id,receipt_id,created_at)
        VALUES(?,?,?,?,'CASE_WON_CORRECTED',?,'INCORRECT_WON',?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          actor.agencyId,
          caseId,
          result.caseVersion,
          result.taskId,
          command.notes,
          ctx.userId,
          actor.id,
          result.operationId,
          now,
        ),
      db
        .prepare(
          `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
        correlation_id,idempotency_key,outcome,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    const raced = await readReceipt(db, ctx, key);
    if (raced) return replay(raced);
    if (/SENSITIVE_GRANT_CONSUMPTION_FAILED/.test(String(error)))
      throw new SalesError('SECURE_GRANT_INVALID', 403);
    if (/OPTIMISTIC_CONCURRENCY_CONFLICT|SALES_WON_CORRECTION_CONFLICT/.test(String(error)))
      throw new SalesError('CONFLICT');
    throw error;
  }
  return { data: result, replayed: false };
}

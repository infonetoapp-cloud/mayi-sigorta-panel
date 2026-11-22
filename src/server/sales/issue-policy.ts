import { z } from 'zod';
import {
  issuePolicySchema,
  issuePolicyResultSchema,
  issuePolicyContextSchema,
  type IssuePolicyCommand as Command,
  type IssuePolicyResult as Result,
  type IssuePolicyContext,
} from '../../shared/sales-issued-policy';
import type { WonPriceOption, WonPriceOptions } from '../../shared/renewal-won-price';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import { buildSafeAuditRecord } from '../mutations/audit';
import { computePayloadHash } from '../mutations/canonical';
import { parsePolicyCreateInput } from '../policies/validation';
import {
  authorizeWonPolicyTargets,
  casAssertion,
  loadWonPolicy,
  validateWonPolicyCatalogs,
  wonAuditStatement,
  wonPolicyCreateAuthorityAssertion,
  wonPolicyReadAssertion,
  wonPolicyVersionAssertion,
} from '../renewals/commands';
import { member, SalesError } from './service';
import {
  newBusinessTaskQuery,
  openNewBusinessTask,
  readNewBusinessTask,
  type NewBusinessTask,
} from './new-business-task';

const action = 'sales.case.issue_policy';
const issueReady = `${openNewBusinessTask} AND b.status='ACTIVE'`;
const policyTermsSchema = z.strictObject({
  insurerId: z.string().trim().min(1).max(128),
  amount: z.number().int().safe().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});
export const issuePolicyReceiptSchema = z.strictObject({
  command: issuePolicySchema,
  result: issuePolicyResultSchema,
  policyTerms: policyTermsSchema,
});
type Context = AuthenticatedUserContext;
export async function readIssuePolicyContext(db: D1Database, ctx: Context, caseId: string) {
  const q = newBusinessTaskQuery(ctx, caseId);
  const data = await db
    .prepare(
      `SELECT s.id caseId,s.version caseVersion,t.id taskId,t.version taskVersion,
    c.id customerId,c.display_name customerName,b.id branchId,b.name branchName,
    c.assignee_membership_id customerAssignee,(s.data_classification='HEALTH' OR b.data_classification='HEALTH') health
    ${q.sql} AND ${issueReady}`,
    )
    .bind(...q.args)
    .first<
      Omit<IssuePolicyContext, 'canCreate'> & { customerAssignee: string | null; health: number }
    >();
  if (!data) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  const { customerAssignee, health, ...context } = data;
  const actor = member(ctx);
  const resource = {
    agencyId: actor.agencyId,
    branchId: context.branchId,
    assigneeMembershipId: actor.id,
    customerAssigneeMembershipId: customerAssignee,
  };
  const create = await evaluateAuthorization(db, {
    context: ctx,
    action: health ? 'policy.health.create' : 'policy.create',
    resource: { ...resource, isCreate: true },
  });
  const read = await evaluateAuthorization(db, {
    context: ctx,
    action: health ? 'policy.health.read' : 'policy.read',
    resource,
  });
  return issuePolicyContextSchema.parse({
    ...context,
    canCreate: create.decision === 'ALLOW' && read.decision === 'ALLOW',
  });
}

const acceptedPrice = `e.event_code='CUSTOMER_ACCEPTED'
  AND EXISTS(SELECT 1 FROM sales_price_events old WHERE old.agency_id=e.agency_id AND old.case_id=e.case_id
    AND old.revision_id=e.revision_id AND old.event_code='SHARED' AND old.case_version<e.case_version)
  AND NOT EXISTS(SELECT 1 FROM sales_price_events newer WHERE newer.agency_id=e.agency_id AND newer.case_id=e.case_id
    AND newer.revision_id=e.revision_id AND newer.case_version>e.case_version)`;

export async function listIssuePrices(
  db: D1Database,
  ctx: Context,
  caseId: string,
  after: string,
): Promise<WonPriceOptions> {
  const q = newBusinessTaskQuery(ctx, caseId);
  const { results } = await db
    .prepare(
      `WITH allowed AS (
      SELECT s.agency_id,s.id,s.version,s.branch_id ${q.sql} AND ${issueReady})
    SELECT s.id caseId,s.version expectedCaseVersion,v.id revisionId,e.id acceptanceEventId,
      i.id insurerId,i.name insurerName,s.branch_id branchId,v.amount_minor amountMinor,v.currency,
      v.offered_start_date startDate,v.offered_end_date endDate
    FROM allowed s JOIN sales_prices p ON p.agency_id=s.agency_id AND p.case_id=s.id
    JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id
    JOIN sales_price_revisions v ON v.agency_id=p.agency_id AND v.id=p.current_revision_id AND v.price_id=p.id
    JOIN sales_price_events e ON e.agency_id=v.agency_id AND e.case_id=p.case_id AND e.revision_id=v.id
    WHERE i.id>? AND e.case_version<=s.version AND ${acceptedPrice} ORDER BY i.id LIMIT 21`,
    )
    .bind(...q.args, after)
    .all<Omit<WonPriceOption, 'source'> & Omit<WonPriceOption['source'], 'kind'>>();
  const options = results
    .slice(0, 20)
    .map(
      ({ caseId, expectedCaseVersion, revisionId, acceptanceEventId, ...row }): WonPriceOption => ({
        ...row,
        source: {
          kind: 'PRICE_REVISION',
          caseId,
          expectedCaseVersion,
          revisionId,
          acceptanceEventId,
        },
      }),
    );
  return { options, nextAfter: results.length > 20 ? options[19]!.insurerId : null };
}

async function requirePermission(
  db: D1Database,
  ctx: Context,
  permission: string,
  resource: Record<string, unknown>,
) {
  const decision = await evaluateAuthorization(db, { context: ctx, action: permission, resource });
  if (decision.decision !== 'ALLOW') throw new SalesError('FORBIDDEN', 403);
  return decision.effectiveScope;
}

interface Terms {
  insurerId: string;
  amount: number;
  currency: string;
  startDate: string | null;
  endDate: string | null;
}
function priceQuery(
  ctx: Context,
  caseId: string,
  input: Command,
  accepted: Extract<Command['source'], { kind: 'PRICE_REVISION' }>,
) {
  return {
    sql: `FROM sales_prices p JOIN sales_price_revisions v ON v.agency_id=p.agency_id AND v.id=p.current_revision_id AND v.price_id=p.id
      JOIN sales_price_events e ON e.agency_id=v.agency_id AND e.case_id=p.case_id AND e.revision_id=v.id
      WHERE p.agency_id=? AND p.case_id=? AND v.id=? AND e.id=? AND e.case_version<=? AND ${acceptedPrice}`,
    args: [
      member(ctx).agencyId,
      caseId,
      accepted.revisionId,
      accepted.acceptanceEventId,
      input.expectedCaseVersion,
    ],
  };
}

async function authorizeCreate(
  db: D1Database,
  ctx: Context,
  row: NewBusinessTask,
  policy: ReturnType<typeof parsePolicyCreateInput>,
) {
  const actor = member(ctx);
  const assignee = policy.assigneeMembershipId ?? actor.id;
  const resource = {
    agencyId: actor.agencyId,
    branchId: row.branchId,
    assigneeMembershipId: assignee,
    customerAssigneeMembershipId: row.customerAssignee,
  };
  if (
    assignee !== actor.id &&
    (await requirePermission(db, ctx, 'policy.assign', {
      ...resource,
      assigneeMembershipId: actor.id,
    })) !== 'AGENCY'
  )
    throw new SalesError('FORBIDDEN', 403);
  await requirePermission(db, ctx, row.health ? 'policy.health.create' : 'policy.create', {
    ...resource,
    isCreate: true,
  });
  await requirePermission(db, ctx, row.health ? 'policy.health.read' : 'policy.read', resource);
  return assignee;
}

async function replay(
  db: D1Database,
  ctx: Context,
  row: NewBusinessTask,
  query: ReturnType<typeof newBusinessTaskQuery>,
  input: Command,
  caseId: string,
  key: string,
  hash: string,
) {
  const actor = member(ctx);
  const prior = await db
    .prepare(
      'SELECT id,action,payload_fingerprint,response_body,actor_membership_id FROM operation_receipts WHERE agency_id=? AND actor_user_id=? AND idempotency_key=?',
    )
    .bind(actor.agencyId, ctx.userId, key)
    .first<{
      id: string;
      action: string;
      payload_fingerprint: string;
      response_body: string;
      actor_membership_id: string;
    }>();
  if (!prior) return null;
  if (prior.action !== action || prior.payload_fingerprint !== hash)
    throw new SalesError('IDEMPOTENCY_CONFLICT');
  if (prior.actor_membership_id !== actor.id) throw new SalesError('FORBIDDEN', 403);
  const parsed = issuePolicyReceiptSchema.safeParse(JSON.parse(prior.response_body));
  if (!parsed.success) throw new SalesError('OPERATION_NOT_FOUND', 404);
  const result = parsed.data.result;
  if (
    result.operationId !== prior.id ||
    result.caseId !== caseId ||
    result.taskId !== input.expectedTaskId ||
    result.caseVersion !== input.expectedCaseVersion + 1 ||
    result.taskVersion !== input.expectedTaskVersion + 1 ||
    result.createdPolicy !== (input.result.kind === 'CREATE_POLICY') ||
    (await computePayloadHash({ action, targetId: caseId, input: parsed.data.command })) !== hash
  )
    throw new SalesError('OPERATION_NOT_FOUND', 404);
  const target = await loadWonPolicy(db, actor.agencyId, result.policyId);
  if (!target || target.customer_id !== row.customerId || target.version < result.policyVersion)
    throw new SalesError('OPERATION_NOT_FOUND', 404);
  await authorizeWonPolicyTargets(db, ctx, actor.agencyId, [target]);
  if (input.result.kind === 'CREATE_POLICY')
    await authorizeCreate(db, ctx, row, parsePolicyCreateInput(input.result.policy));
  const proof = await db
    .prepare(
      `SELECT a.id ${query.sql}
    AND t.status='COMPLETED' AND t.version=? AND t.completed_at=? AND t.completed_by_membership_id=?
    AND EXISTS(SELECT 1 FROM sales_case_policy_results w JOIN sales_case_history h
      ON h.agency_id=w.agency_id AND h.case_id=w.case_id AND h.receipt_id=w.receipt_id
      WHERE w.receipt_id=? AND w.agency_id=s.agency_id AND w.case_id=s.id AND w.policy_id=?
        AND w.case_version=? AND w.task_id=t.id AND w.task_version=t.version AND w.policy_version=?
        AND ((s.version=w.case_version AND s.result='WON' AND s.active_task_id IS NULL)
          OR (s.version>w.case_version AND EXISTS(SELECT 1 FROM sales_case_history correction
            WHERE correction.agency_id=w.agency_id AND correction.case_id=w.case_id
              AND correction.case_version=w.case_version+1 AND correction.event_code='CASE_WON_CORRECTED')))
        AND h.event_code='WON' AND h.case_version=w.case_version AND h.task_id=t.id AND h.created_at=t.completed_at)
    AND EXISTS(SELECT 1 FROM audit_events ev WHERE ev.agency_id=s.agency_id AND ev.correlation_id=?
      AND ev.idempotency_key=? AND ev.actor_user_id=u.id AND ev.actor_membership_id=m.id
      AND ev.target_type='sales_cases' AND ev.target_id=s.id AND ev.action=? AND ev.outcome='SUCCESS'
      AND ev.created_at=t.completed_at AND json_extract(ev.metadata_json,'$.responseHash')=?)`,
    )
    .bind(
      ...query.args,
      result.taskVersion,
      result.closedAt,
      actor.id,
      prior.id,
      result.policyId,
      result.caseVersion,
      result.policyVersion,
      prior.id,
      key,
      action,
      await computePayloadHash({ result, policyTerms: parsed.data.policyTerms }),
    )
    .first();
  if (!proof) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return { data: result, replayed: true };
}

export async function issueSalesPolicy(
  db: D1Database,
  ctx: Context,
  caseId: string,
  raw: unknown,
  key: string,
): Promise<{ data: Result; replayed: boolean }> {
  const input = issuePolicySchema.parse(raw);
  const actor = member(ctx);
  const query = newBusinessTaskQuery(ctx, caseId, input.expectedTaskId);
  const hash = await computePayloadHash({ action, targetId: caseId, input });
  const row = await readNewBusinessTask(db, query);
  const saved = await replay(db, ctx, row, query, input, caseId, key, hash);
  if (saved) return saved;
  if (
    !row.open ||
    !row.activeBranch ||
    row.caseVersion !== input.expectedCaseVersion ||
    row.taskVersion !== input.expectedTaskVersion
  )
    throw new SalesError('CONFLICT');
  const now = new Date().toISOString();
  const assert = (where: string, args: unknown[], code: string) =>
    db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
      SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${where}) THEN 1 ELSE 0 END,?`,
      )
      .bind(crypto.randomUUID(), ...args, code);
  const statements = [
    assert(query.sql, query.args, 'MEMBERSHIP_PERMISSION_NOT_FOUND'),
    assert(
      `${query.sql} AND ${issueReady} AND s.version=? AND t.version=?`,
      [...query.args, row.caseVersion, row.taskVersion],
      'OPTIMISTIC_CONCURRENCY_CONFLICT',
    ),
  ];
  let policyId: string, policyVersion: number, actual: Terms;
  if (input.result.kind === 'CREATE_POLICY') {
    let p: ReturnType<typeof parsePolicyCreateInput>;
    try {
      p = parsePolicyCreateInput(input.result.policy);
    } catch {
      throw new SalesError('POLICY_INPUT_INVALID', 400);
    }
    if (
      p.customerId !== row.customerId ||
      p.branchId !== row.branchId ||
      !p.insurerId ||
      p.status !== 'ACTIVE'
    )
      throw new SalesError('POLICY_TARGET_INVALID', 400);
    const classification = await validateWonPolicyCatalogs(db, actor.agencyId, p, p.insurerId);
    const assignee = await authorizeCreate(db, ctx, row, p);
    policyId = crypto.randomUUID();
    policyVersion = 1;
    actual = {
      insurerId: p.insurerId,
      amount: p.grossPremiumMinor,
      currency: p.currency,
      startDate: p.startDate,
      endDate: p.endDate,
    };
    statements.push(
      wonPolicyCreateAuthorityAssertion(db, ctx, actor, {
        customerId: row.customerId,
        customerAssigneeMembershipId: row.customerAssignee,
        assigneeMembershipId: assignee,
        requiresAgencyAssign: assignee !== actor.id,
        branchId: row.branchId,
        classification,
      }),
      db
        .prepare(
          `INSERT INTO policies
      (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
       policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,installment_count,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`,
        )
        .bind(
          policyId,
          actor.agencyId,
          p.customerId,
          p.insurerId,
          p.productId,
          p.branchId,
          p.paymentMethodId,
          assignee,
          p.policyNumber,
          p.normalizedPolicyNumber,
          p.startDate,
          p.endDate,
          p.grossPremiumMinor,
          p.currency,
          p.installmentCount,
          now,
          now,
        ),
    );
  } else {
    const target = await loadWonPolicy(db, actor.agencyId, input.result.policyId);
    if (
      !target ||
      target.customer_id !== row.customerId ||
      target.branch_id !== row.branchId ||
      target.status !== 'ACTIVE' ||
      target.archived_at ||
      target.version !== input.result.expectedPolicyVersion
    )
      throw new SalesError('POLICY_TARGET_INVALID');
    const [authorized] = await authorizeWonPolicyTargets(db, ctx, actor.agencyId, [target]);
    policyId = target.id;
    policyVersion = target.version;
    const terms = await db
      .prepare(
        `SELECT insurer_id insurerId,gross_premium_minor amount,currency,start_date startDate,end_date endDate
      FROM policies WHERE agency_id=? AND id=? AND version=?`,
      )
      .bind(actor.agencyId, policyId, policyVersion)
      .first<Terms>();
    if (!terms) throw new SalesError('CONFLICT');
    actual = terms;
    statements.push(
      wonPolicyReadAssertion(db, ctx, actor, authorized!),
      wonPolicyVersionAssertion(db, actor.agencyId, target),
    );
  }
  if (input.source.kind === 'PRICE_REVISION') {
    const price = priceQuery(ctx, caseId, input, input.source);
    const terms = await db
      .prepare(
        `SELECT p.insurer_id insurerId,v.amount_minor amount,v.currency,
      v.offered_start_date startDate,v.offered_end_date endDate ${price.sql}`,
      )
      .bind(...price.args)
      .first<Terms>();
    if (!terms) throw new SalesError('PRICE_ACCEPTANCE_INVALID');
    if (terms.insurerId !== actual.insurerId) throw new SalesError('PRICE_POLICY_MISMATCH');
    const differs =
      terms.amount !== actual.amount ||
      terms.currency !== actual.currency ||
      (terms.startDate !== null &&
        (terms.startDate !== actual.startDate || terms.endDate !== actual.endDate));
    if (differs !== !!input.differenceReasonCode)
      throw new SalesError(
        differs ? 'POLICY_DIFFERENCE_REASON_REQUIRED' : 'POLICY_DIFFERENCE_REASON_UNEXPECTED',
        400,
      );
    statements.splice(2, 0, assert(price.sql, price.args, 'OPTIMISTIC_CONCURRENCY_CONFLICT'));
  } else if (input.differenceReasonCode) {
    throw new SalesError('POLICY_DIFFERENCE_REASON_UNEXPECTED', 400);
  }

  const data: Result = {
    operationId: crypto.randomUUID(),
    caseId,
    caseVersion: row.caseVersion + 1,
    taskId: input.expectedTaskId,
    taskVersion: row.taskVersion + 1,
    policyId,
    policyVersion,
    createdPolicy: input.result.kind === 'CREATE_POLICY',
    closedAt: now,
  };
  const policyTerms = policyTermsSchema.parse(actual);
  const audit = buildSafeAuditRecord({
    agencyId: actor.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: actor.id,
    action,
    targetType: 'sales_cases',
    targetId: caseId,
    correlationId: data.operationId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    metadata: { responseHash: await computePayloadHash({ result: data, policyTerms }) },
    createdAt: now,
  });
  statements.push(
    db
      .prepare(
        `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
      status,response_status,response_body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'COMPLETED',?,?,?,?)`,
      )
      .bind(
        data.operationId,
        actor.agencyId,
        ctx.userId,
        actor.id,
        action,
        key,
        hash,
        data.createdPolicy ? 201 : 200,
        JSON.stringify({ command: input, result: data, policyTerms }),
        now,
        now,
      ),
    db
      .prepare(
        'INSERT INTO sales_case_policy_results(receipt_id,agency_id,case_id,case_version,task_id,task_version,policy_id,policy_version) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        data.operationId,
        actor.agencyId,
        caseId,
        data.caseVersion,
        data.taskId,
        data.taskVersion,
        policyId,
        policyVersion,
      ),
    db
      .prepare(
        "UPDATE sales_cases SET result='WON',active_task_id=NULL,version=version+1,updated_at=? WHERE agency_id=? AND id=? AND version=?",
      )
      .bind(now, actor.agencyId, caseId, row.caseVersion),
    casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    db
      .prepare(
        `UPDATE tasks SET status='COMPLETED',completed_at=?,completed_by_membership_id=?,version=version+1,updated_at=?
      WHERE agency_id=? AND id=? AND version=? AND status='OPEN'`,
      )
      .bind(now, actor.id, now, actor.agencyId, data.taskId, row.taskVersion),
    casAssertion(db, 'OPTIMISTIC_CONCURRENCY_CONFLICT'),
    db
      .prepare(
        `INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,actor_user_id,actor_membership_id,receipt_id,created_at)
      VALUES(?,?,?,?,'WON',?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(),
        actor.agencyId,
        caseId,
        data.caseVersion,
        data.taskId,
        ctx.userId,
        actor.id,
        data.operationId,
        now,
      ),
  );
  if (data.createdPolicy)
    statements.push(
      wonAuditStatement(db, ctx, actor, 'policy.create', 'policies', policyId, key, now, {
        salesCaseId: caseId,
      }),
    );
  statements.push(
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
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (/MEMBERSHIP_PERMISSION/.test(message)) throw new SalesError('FORBIDDEN', 403);
    if (!/UNIQUE|OPTIMISTIC|SALES_POLICY_RESULT|POLICY_(ACTIVE_CATALOG|INSTALLMENT)/.test(message))
      throw error;
    const raced = await replay(db, ctx, row, query, input, caseId, key, hash);
    if (raced) return raced;
    throw new SalesError('CONFLICT');
  }
  return { data, replayed: false };
}

export async function readIssuePolicyOperation(
  db: D1Database,
  ctx: Context,
  caseId: string,
  key: string,
) {
  const actor = member(ctx);
  const found = await db
    .prepare(
      `SELECT response_body FROM operation_receipts WHERE agency_id=? AND actor_user_id=?
    AND actor_membership_id=? AND idempotency_key=? AND action=? AND status='COMPLETED'`,
    )
    .bind(actor.agencyId, ctx.userId, actor.id, key, action)
    .first<{ response_body: string }>();
  if (!found) throw new SalesError('OPERATION_NOT_FOUND', 404);
  const saved = issuePolicyReceiptSchema.parse(JSON.parse(found.response_body));
  if (saved.result.caseId !== caseId) throw new SalesError('OPERATION_NOT_FOUND', 404);
  const query = newBusinessTaskQuery(ctx, caseId, saved.command.expectedTaskId);
  const row = await readNewBusinessTask(db, query);
  const hash = await computePayloadHash({ action, targetId: caseId, input: saved.command });
  const result = await replay(db, ctx, row, query, saved.command, caseId, key, hash);
  if (!result) throw new SalesError('OPERATION_NOT_FOUND', 404);
  return result.data;
}

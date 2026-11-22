import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { computePayloadHash } from '../mutations/canonical';
import { buildSafeAuditRecord } from '../mutations/audit';
import { RenewalCommandError, type RenewalWonResult } from '../renewals/commands';
import { acceptedPriceSourceSchema } from '../renewals/validation';
import { member, salesGate } from './service';
import type { WonPriceOption, WonPriceOptions } from '../../shared/renewal-won-price';

type Selection = z.infer<typeof acceptedPriceSourceSchema>;
export type PriceEvidence = Selection & { policyId: string };
type Target = {
  id: string;
  customerId: string;
  insurerId: string;
  branchId: string;
  grossPremiumMinor: number;
  currency: string;
  startDate: string;
  endDate: string;
};

const joins = `FROM sales_cases s
 JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id AND r.expiring_policy_id=s.source_policy_id
 JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.customer_id=c.id AND t.kind='RENEWAL_FOLLOWUP'
 JOIN sales_prices sp ON sp.agency_id=s.agency_id AND sp.case_id=s.id
 JOIN sales_price_revisions v ON v.agency_id=sp.agency_id AND v.price_id=sp.id
 JOIN sales_price_events e ON e.agency_id=v.agency_id AND e.revision_id=v.id AND e.case_id=s.id
 JOIN agency_memberships m ON m.agency_id=s.agency_id
 JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;

const latestAcceptance = `AND e.event_code='CUSTOMER_ACCEPTED' AND e.case_version<=s.version
 AND EXISTS(SELECT 1 FROM sales_price_events shared WHERE shared.agency_id=e.agency_id AND shared.case_id=e.case_id
 AND shared.revision_id=e.revision_id AND shared.event_code='SHARED' AND shared.case_version<e.case_version)
 AND NOT EXISTS(SELECT 1 FROM sales_price_events newer WHERE newer.agency_id=e.agency_id AND newer.case_id=e.case_id
 AND newer.revision_id=e.revision_id AND newer.case_version>e.case_version AND newer.case_version<=s.version)`;

export async function listWonPriceOptions(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  renewalId: string,
  after: string,
): Promise<WonPriceOptions> {
  const actor = member(ctx);
  const gate = salesGate(ctx, true, 'update', true);
  const { results } = await db
    .prepare(
      `SELECT s.id caseId,s.version expectedCaseVersion,v.id revisionId,e.id acceptanceEventId,
       i.id insurerId,i.name insurerName,s.branch_id branchId,v.amount_minor amountMinor,
       v.currency,v.offered_start_date startDate,v.offered_end_date endDate
       ${joins} JOIN insurers i ON i.agency_id=sp.agency_id AND i.id=sp.insurer_id
       WHERE s.agency_id=? AND r.id=? AND s.context_kind='RENEWAL' AND s.current_result_id IS NULL
       AND r.closed_at IS NULL AND t.status='OPEN' AND sp.current_revision_id=v.id AND i.id>?
       ${latestAcceptance} AND ${gate.sql} ORDER BY i.id LIMIT 21`,
    )
    .bind(actor.agencyId, renewalId, after, ...gate.args)
    .all<Omit<WonPriceOption, 'source'> & Omit<Selection, 'kind'>>();
  const options = results
    .slice(0, 20)
    .map(
      ({
        caseId,
        expectedCaseVersion,
        revisionId,
        acceptanceEventId,
        ...price
      }): WonPriceOption => ({
        ...price,
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

function priceEvidenceQuery(
  ctx: AuthenticatedUserContext,
  renewalId: string,
  taskId: string,
  source: Selection,
  current: boolean,
  extraJoin = '',
) {
  const actor = member(ctx),
    gate = salesGate(ctx, true, 'update', true);
  return {
    sql: `${joins} ${extraJoin}
 WHERE s.agency_id=? AND s.id=? AND s.context_kind='RENEWAL' AND r.id=? AND t.id=? AND v.id=? AND e.id=?
 AND e.event_code='CUSTOMER_ACCEPTED' AND (e.case_version<=?) AND s.version>=?
 AND EXISTS(SELECT 1 FROM sales_price_events shared WHERE shared.agency_id=e.agency_id AND shared.case_id=e.case_id
 AND shared.revision_id=e.revision_id AND shared.event_code='SHARED' AND shared.case_version<e.case_version)
 AND NOT EXISTS(SELECT 1 FROM sales_price_events newer WHERE newer.agency_id=e.agency_id AND newer.case_id=e.case_id
 AND newer.revision_id=e.revision_id AND newer.case_version>e.case_version AND newer.case_version<=?)
 ${current ? "AND s.version=? AND s.current_result_id IS NULL AND sp.current_revision_id=v.id AND t.status='OPEN' AND r.closed_at IS NULL" : ''} AND ${gate.sql}`,
    args: [
      actor.agencyId,
      source.caseId,
      renewalId,
      taskId,
      source.revisionId,
      source.acceptanceEventId,
      source.expectedCaseVersion,
      source.expectedCaseVersion,
      source.expectedCaseVersion,
      ...(current ? [source.expectedCaseVersion] : []),
      ...gate.args,
    ],
  };
}

export async function prepareWonPrice(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  renewalId: string,
  taskId: string,
  taskVersion: number,
  source: Selection,
  target: Target,
  differenceReason: string | undefined,
) {
  const q = priceEvidenceQuery(ctx, renewalId, taskId, source, true);
  const price = (
    await db.batch<{
      customerId: string;
      branchId: string;
      insurerId: string;
      amount: number;
      currency: string;
      startDate: string | null;
      endDate: string | null;
    }>([
      db
        .prepare(
          `SELECT s.customer_id customerId,s.branch_id branchId,sp.insurer_id insurerId,v.amount_minor amount,v.currency,v.offered_start_date startDate,v.offered_end_date endDate ${q.sql} AND t.version=?`,
        )
        .bind(...q.args, taskVersion),
    ])
  )[0]!.results[0];
  if (!price) throw new RenewalCommandError('PRICE_ACCEPTANCE_INVALID', 409);
  if (
    price.customerId !== target.customerId ||
    price.branchId !== target.branchId ||
    price.insurerId !== target.insurerId
  )
    throw new RenewalCommandError('PRICE_POLICY_MISMATCH', 409);
  const differs =
    price.amount !== target.grossPremiumMinor ||
    price.currency !== target.currency ||
    (price.startDate !== null &&
      (price.startDate !== target.startDate || price.endDate !== target.endDate));
  if (differs && !differenceReason)
    throw new RenewalCommandError('QUOTE_DIFFERENCE_REASON_REQUIRED', 400);
  if (!differs && differenceReason)
    throw new RenewalCommandError('QUOTE_DIFFERENCE_REASON_UNEXPECTED', 400);
  return {
    evidence: { ...source, policyId: target.id },
    assertion: db
      .prepare(
        `INSERT INTO d1_cas_assertions(id,expected,actual)
    SELECT ?,1,CASE WHEN EXISTS(SELECT 1 ${q.sql} AND t.version=?) THEN 1 ELSE 0 END`,
      )
      .bind(crypto.randomUUID(), ...q.args, taskVersion),
  };
}
export async function wonPriceAudit(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  result: RenewalWonResult,
  receiptId: string,
  key: string,
) {
  const actor = member(ctx);
  const audit = buildSafeAuditRecord({
    agencyId: actor.agencyId,
    actorUserId: ctx.userId,
    actorMembershipId: actor.id,
    action: 'sales.price.policy_linked',
    targetType: 'renewal_opportunities',
    targetId: result.renewalId,
    correlationId: receiptId,
    idempotencyKey: key,
    outcome: 'SUCCESS',
    createdAt: result.closedAt,
    metadata: { responseHash: await computePayloadHash(result) },
  });
  return db
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
    );
}
export async function assertWonPriceReplay(
  db: D1Database,
  ctx: AuthenticatedUserContext,
  result: RenewalWonResult,
  receiptId: string,
  key: string,
) {
  const source = result.acceptedPriceEvidence;
  if (!source) return;
  const actor = member(ctx),
    q = priceEvidenceQuery(
      ctx,
      result.renewalId,
      result.primaryTaskId,
      source,
      false,
      `
 JOIN audit_events audit ON audit.agency_id=s.agency_id AND audit.target_type='renewal_opportunities'
 AND audit.target_id=r.id AND audit.action='sales.price.policy_linked' AND audit.outcome='SUCCESS'
 AND audit.correlation_id=? AND audit.idempotency_key=? AND audit.actor_user_id=? AND audit.actor_membership_id=? AND audit.created_at=?`,
    );
  const proof = (
    await db.batch<{ responseHash: string }>([
      db
        .prepare(
          `SELECT json_extract(audit.metadata_json,'$.responseHash') responseHash ${q.sql}
 AND EXISTS(SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=s.agency_id AND l.renewal_id=r.id AND l.new_policy_id=? AND l.allocation_operation_id=? AND l.status IN ('ACTIVE','SUPERSEDED'))`,
        )
        .bind(
          receiptId,
          key,
          ctx.userId,
          actor.id,
          result.closedAt,
          ...q.args,
          source.policyId,
          receiptId,
        ),
    ])
  )[0]!.results;
  if (proof.length !== 1 || proof[0]!.responseHash !== (await computePayloadHash(result)))
    throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
}

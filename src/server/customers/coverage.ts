import { evaluatePortfolioRead } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import type { CustomerCoverageSummary, CoveragePolicy } from '../../shared/customer-coverage';
export class CustomerCoverageError extends Error {
  constructor(readonly status: 400 | 404 | 503) {
    super('CUSTOMER_COVERAGE_UNAVAILABLE');
  }
}
interface SummaryRow {
  customerId: string;
  activePolicyCount: number;
  expiredPolicyCount: number;
  scheduledPolicyCount: number;
  cancelledPolicyCount: number;
  voidedPolicyCount: number;
  archivedPolicyCount: number;
  invalidPeriodPolicyCount: number;
  typesJson: string;
  typeCount: number;
  policiesJson: string;
}
/** One bounded page, one aggregate SELECT, one final authorization/session batch.
 * Catalog joins are historical labels under policy authority, not selectable options.
 * No Task/renewal/party join; policyholder identity is p.customer_id exclusively. */
export async function readCustomerCoverage(
  db: D1Database,
  original: AuthenticatedUserContext,
  customerIds: readonly string[],
): Promise<Map<string, CustomerCoverageSummary>> {
  const member = original.memberships[0];
  if (!member || member.status !== 'ACTIVE') throw new CustomerCoverageError(404);
  const context: AuthenticatedUserContext = {
    userId: original.userId,
    identityId: original.identityId,
    assurance: original.assurance,
    ...(original.sessionHash ? { sessionHash: original.sessionHash } : {}),
    memberships: [{ ...member }],
  };
  const active = context.memberships[0]!;
  const ids = [...new Set(customerIds)];
  if (ids.length > 20 || ids.some((id) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))
    throw new CustomerCoverageError(400);
  const {
    primary: customer,
    related: policy,
    health,
  } = await evaluatePortfolioRead(db, context, active.agencyId, 'coverage');
  if (
    customer.decision !== 'ALLOW' ||
    !['ASSIGNED', 'AGENCY'].includes(customer.effectiveScope ?? '')
  )
    throw new CustomerCoverageError(404);
  const allowed =
    policy?.decision === 'ALLOW' && ['ASSIGNED', 'AGENCY'].includes(policy.effectiveScope ?? '');
  const healthAllowed = allowed && health?.decision === 'ALLOW';
  const settings = await db
    .prepare(
      "SELECT COALESCE(s.timezone,'Europe/Istanbul') AS timezone FROM agencies a LEFT JOIN agency_settings s ON s.agency_id=a.id WHERE a.id=? AND a.status='ACTIVE'",
    )
    .bind(active.agencyId)
    .first<{ timezone: string }>();
  if (!settings) throw new CustomerCoverageError(404);
  let day: string;
  try {
    day = new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    throw new CustomerCoverageError(503);
  }
  const make = (available: boolean): CustomerCoverageSummary => ({
    available,
    asOfDate: day,
    timezone: settings.timezone,
    activePolicyCount: available ? 0 : null,
    expiredPolicyCount: available ? 0 : null,
    scheduledPolicyCount: available ? 0 : null,
    cancelledPolicyCount: available ? 0 : null,
    voidedPolicyCount: available ? 0 : null,
    archivedPolicyCount: available ? 0 : null,
    invalidPeriodPolicyCount: available ? 0 : null,
    types: [],
    additionalTypeCount: 0,
    nearestExpiry: null,
    policies: [],
  });
  const result = new Map(ids.map((id) => [id, make(allowed)]));
  const slots = ids.map(() => '?').join(',');
  const grantChecks = [
    "(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions cp WHERE cp.membership_id=m.id AND cp.permission_code='customer.read' AND cp.scope=?))",
  ];
  const grantValues: unknown[] = [customer.effectiveScope];
  if (allowed) {
    grantChecks.push(
      "(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions pp WHERE pp.membership_id=m.id AND pp.permission_code='policy.read' AND pp.scope=?))",
    );
    grantValues.push(policy.effectiveScope);
  }
  if (healthAllowed)
    grantChecks.push(
      "EXISTS(SELECT 1 FROM membership_permissions hp WHERE hp.membership_id=m.id AND hp.permission_code='sensitive.health.read' AND hp.scope='UNSCOPED')",
    );
  // Even an empty page must recheck current actor authority; IDs are server-selected.
  const assertion = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
    WHERE m.id=? AND m.user_id=? AND m.agency_id=? AND m.type=? AND m.permission_version=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND ${grantChecks.join(' AND ')}
    AND (SELECT COUNT(*) FROM customers c WHERE c.agency_id=m.agency_id ${ids.length ? `AND c.id IN (${slots})` : 'AND 0'} ${customer.effectiveScope === 'ASSIGNED' ? 'AND c.assignee_membership_id=m.id' : ''})=?) THEN 1 ELSE 0 END,'MEMBERSHIP_PERMISSION_NOT_FOUND'`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      active.id,
      context.userId,
      active.agencyId,
      active.type,
      active.permissionVersion,
      ...grantValues,
      ...ids,
      ids.length,
    );
  const predicates = ['p.agency_id=?', `p.customer_id IN (${slots || 'NULL'})`];
  const bindings: unknown[] = [day, active.agencyId, ...ids];
  if (customer.effectiveScope === 'ASSIGNED') {
    predicates.push('c.assignee_membership_id=?');
    bindings.push(active.id);
  }
  if (policy?.effectiveScope === 'ASSIGNED') {
    predicates.push('(p.assignee_membership_id=? OR c.assignee_membership_id=?)');
    bindings.push(active.id, active.id);
  }
  if (!healthAllowed) predicates.push("b.data_classification='GENERAL'");
  else if (health?.effectiveScope === 'ASSIGNED') {
    predicates.push(
      "(b.data_classification='GENERAL' OR p.assignee_membership_id=? OR c.assignee_membership_id=?)",
    );
    bindings.push(active.id, active.id);
  }
  const query = db
    .prepare(
      `WITH cfg(day) AS (VALUES(?)), visible AS (
    SELECT p.id,p.customer_id,p.policy_number,p.start_date,p.end_date,p.branch_id,b.name AS branchName,pr.name AS productName,i.name AS insurerName,
    CASE WHEN p.archived_at IS NOT NULL THEN 'ARCHIVED' WHEN p.status='CANCELLED' THEN 'CANCELLED' WHEN p.status='VOIDED' THEN 'VOIDED'
      WHEN date(p.start_date,'+0 days') IS NULL OR date(p.end_date,'+0 days') IS NULL OR date(p.start_date,'+0 days')<>p.start_date OR date(p.end_date,'+0 days')<>p.end_date THEN 'INVALID_PERIOD'
      WHEN p.end_date<cfg.day THEN 'EXPIRED' WHEN p.start_date>cfg.day THEN 'SCHEDULED' ELSE 'IN_FORCE' END AS coverageState
    FROM policies p JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    JOIN insurance_products pr ON pr.agency_id=p.agency_id AND pr.id=p.product_id AND pr.insurer_id=p.insurer_id AND pr.branch_id=p.branch_id
    JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id CROSS JOIN cfg WHERE ${predicates.join(' AND ')}),
    totals AS (SELECT customer_id,SUM(coverageState='IN_FORCE') AS activePolicyCount,SUM(coverageState='EXPIRED') AS expiredPolicyCount,SUM(coverageState='SCHEDULED') AS scheduledPolicyCount,SUM(coverageState='CANCELLED') AS cancelledPolicyCount,SUM(coverageState='VOIDED') AS voidedPolicyCount,SUM(coverageState='ARCHIVED') AS archivedPolicyCount,SUM(coverageState='INVALID_PERIOD') AS invalidPeriodPolicyCount FROM visible GROUP BY customer_id),
    branches AS (SELECT customer_id,branch_id,branchName,COUNT(*) AS n FROM visible WHERE coverageState='IN_FORCE' GROUP BY customer_id,branch_id,branchName),
    ranked_types AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY customer_id ORDER BY n DESC,branchName COLLATE NOCASE,branch_id) AS rn FROM branches),
    type_counts AS (SELECT customer_id,COUNT(*) AS typeCount FROM branches GROUP BY customer_id),
    type_labels AS (SELECT customer_id,json_group_array(json_object('label',branchName,'count',n)) AS typesJson FROM (SELECT * FROM ranked_types WHERE rn<=3 ORDER BY customer_id,rn) GROUP BY customer_id),
    ranked_policies AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY customer_id ORDER BY end_date,id) AS rn FROM visible WHERE coverageState='IN_FORCE'),
    previews AS (SELECT customer_id,json_group_array(json_object('policyId',id,'policyNumber',policy_number,'branchName',branchName,'productName',productName,'insurerName',insurerName,'startDate',start_date,'endDate',end_date)) AS policiesJson FROM (SELECT * FROM ranked_policies WHERE rn<=3 ORDER BY customer_id,rn) GROUP BY customer_id)
    SELECT t.customer_id AS customerId,t.activePolicyCount,t.expiredPolicyCount,t.scheduledPolicyCount,t.cancelledPolicyCount,t.voidedPolicyCount,t.archivedPolicyCount,t.invalidPeriodPolicyCount,COALESCE(l.typesJson,'[]') AS typesJson,COALESCE(tc.typeCount,0) AS typeCount,COALESCE(v.policiesJson,'[]') AS policiesJson FROM totals t LEFT JOIN type_labels l USING(customer_id) LEFT JOIN type_counts tc USING(customer_id) LEFT JOIN previews v USING(customer_id)`,
    )
    .bind(...bindings);
  try {
    const rows = await db.batch<SummaryRow>([assertion, ...(allowed && ids.length ? [query] : [])]);
    if (allowed && ids.length) {
      const page = rows[1];
      if (!page?.success) throw new CustomerCoverageError(503);
      for (const row of page.results) {
        const policies = JSON.parse(row.policiesJson) as CoveragePolicy[];
        const types = JSON.parse(row.typesJson) as CustomerCoverageSummary['types'];
        result.set(row.customerId, {
          ...make(true),
          activePolicyCount: row.activePolicyCount,
          expiredPolicyCount: row.expiredPolicyCount,
          scheduledPolicyCount: row.scheduledPolicyCount,
          cancelledPolicyCount: row.cancelledPolicyCount,
          voidedPolicyCount: row.voidedPolicyCount,
          archivedPolicyCount: row.archivedPolicyCount,
          invalidPeriodPolicyCount: row.invalidPeriodPolicyCount,
          types,
          additionalTypeCount: Math.max(0, row.typeCount - 3),
          policies,
          nearestExpiry: policies[0] ?? null,
        });
      }
    }
    return result;
  } catch (error) {
    if (
      /LOCAL_SESSION_REVOKED|MEMBERSHIP_PERMISSION_NOT_FOUND/.test(
        error instanceof Error ? error.message : '',
      )
    )
      throw new CustomerCoverageError(404);
    throw new CustomerCoverageError(503);
  }
}

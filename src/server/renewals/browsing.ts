import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization } from '../auth/authorization';
import { activeMembership, RenewalCommandError } from './commands';
import { computePayloadHash } from '../mutations/canonical';
import { isCanonicalDateOnly } from '../policies/validation';
import type {
  RenewalBrowseItem,
  RenewalBrowseDetail,
  RenewalBrowsePage,
} from '../../shared/renewal-browsing';
import { vehicleFieldsSchema } from '../../shared/vehicles';
const key = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const renewalBrowseQuery = z
  .object({
    view: z.enum(['OPEN', 'CLOSED', 'ALL']).default('OPEN'),
    q: z.string().trim().max(80).default(''),
    customerId: key.optional(),
    from: z.string().refine(isCanonicalDateOnly).optional(),
    to: z.string().refine(isCanonicalDateOnly).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to);
type Query = z.infer<typeof renewalBrowseQuery>;
const open = "r.state NOT IN ('WON','LOST','VOIDED')";
interface Row {
  id: string;
  state: RenewalBrowseItem['state'];
  version: number;
  closed_at: string | null;
  customer_id: string;
  display_name: string;
  policy_id: string;
  policy_number: string;
  start_date: string;
  end_date: string;
  insurer_name: string;
  branch_name: string;
  gross_premium_minor: number;
  currency: string;
  customer_archived_at: string | null;
  policy_archived_at: string | null;
  policy_status: 'ACTIVE' | 'CANCELLED' | 'VOIDED';
  phone: string | null;
  email: string | null;
  reference_name: string | null;
  insurer_number: string | null;
  vehicle_id: string | null;
  vehicle_version: number | null;
  details_json: string | null;
}
/** Common records only. Never joins, filters by, returns or guesses another employee's Task. */
async function selection(context: AuthenticatedUserContext, db: D1Database) {
  const active = activeMembership(context),
    where = [
      'r.agency_id=?',
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
    active.id,
    context.userId,
    active.permissionVersion,
    context.identityId,
  ];
  const scopes: Record<string, string> = {};
  for (const action of ['customer.read', 'policy.read', 'renewal.read'] as const) {
    const permission = await evaluateAuthorization(db, {
      context,
      action,
      resource: { agencyId: active.agencyId, isCollection: true },
    });
    if (permission.decision !== 'ALLOW' || !permission.effectiveScope)
      throw new RenewalCommandError('FORBIDDEN', 403);
    scopes[action] = permission.effectiveScope;
    where.push(
      "(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code=? AND x.scope=?))",
    );
    values.push(action, permission.effectiveScope);
    if (permission.effectiveScope === 'ASSIGNED')
      where.push(
        action === 'customer.read'
          ? 'c.assignee_membership_id=m.id'
          : action === 'policy.read'
            ? '(p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)'
            : '(r.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)',
      );
  }
  const health = await evaluateAuthorization(db, {
    context,
    action: 'policy.health.read',
    resource: { agencyId: active.agencyId, isCollection: true },
  });
  if (health.decision !== 'ALLOW') where.push("b.data_classification='GENERAL'");
  else {
    where.push(
      "(b.data_classification='GENERAL' OR EXISTS(SELECT 1 FROM membership_permissions hp WHERE hp.membership_id=m.id AND hp.permission_code='sensitive.health.read' AND hp.scope='UNSCOPED'))",
    );
    if (health.effectiveScope === 'ASSIGNED')
      where.push(
        "(b.data_classification='GENERAL' OR p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id)",
      );
  }
  return {
    active,
    where,
    values,
    scopes,
    health: health.decision === 'ALLOW' ? health.effectiveScope : null,
  };
}
const columns = `r.id,r.state,r.version,r.closed_at,p.customer_id,c.display_name,p.id AS policy_id,p.policy_number,p.start_date,p.end_date,i.name AS insurer_name,b.name AS branch_name,p.gross_premium_minor,p.currency,c.archived_at AS customer_archived_at,p.archived_at AS policy_archived_at,p.status AS policy_status`;
const from = `FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id JOIN insurers i ON i.agency_id=p.agency_id AND i.id=p.insurer_id JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id JOIN agency_memberships m ON m.agency_id=r.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;
function item(row: Row): RenewalBrowseItem {
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    closedAt: row.closed_at,
    customer: { id: row.customer_id, displayName: row.display_name },
    policy: {
      id: row.policy_id,
      number: row.policy_number,
      startDate: row.start_date,
      endDate: row.end_date,
      insurerName: row.insurer_name,
      branchName: row.branch_name,
      grossPremiumMinor: row.gross_premium_minor,
      currency: row.currency,
      status: row.policy_status,
    },
    isOpen:
      !['WON', 'LOST', 'VOIDED'].includes(row.state) &&
      row.policy_status === 'ACTIVE' &&
      !row.customer_archived_at &&
      !row.policy_archived_at,
    parentArchived: !!row.customer_archived_at || !!row.policy_archived_at,
  };
}
export async function browseRenewals(
  context: AuthenticatedUserContext,
  db: D1Database,
  query: Query,
): Promise<RenewalBrowsePage> {
  const scope = await selection(context, db),
    { where, values } = scope;
  if (query.view === 'OPEN')
    where.push(open, 'c.archived_at IS NULL', 'p.archived_at IS NULL', "p.status='ACTIVE'");
  if (query.view === 'CLOSED') where.push("r.state IN ('WON','LOST','VOIDED')");
  if (query.customerId) {
    where.push('c.id=?');
    values.push(query.customerId);
  }
  if (query.from) {
    where.push('p.end_date>=?');
    values.push(query.from);
  }
  if (query.to) {
    where.push('p.end_date<=?');
    values.push(query.to);
  }
  if (query.q) {
    where.push(
      `(instr(${turkishNameSql('c.display_name')},?)>0 OR instr(lower(p.policy_number),?)>0)`,
    );
    values.push(turkishNameTerm(query.q), query.q.toLowerCase());
  }
  const { cursor: ignored, ...filters } = query;
  void ignored;
  const binding = await computePayloadHash({
    agency: scope.active.agencyId,
    member: scope.active.id,
    user: context.userId,
    permissionVersion: scope.active.permissionVersion,
    scopes: scope.scopes,
    health: scope.health,
    filters,
  });
  if (query.cursor) {
    let cursor: { date: string; id: string; binding: string };
    try {
      cursor = z
        .object({
          date: z.string().refine(isCanonicalDateOnly),
          id: key,
          binding: z.string().length(64),
        })
        .strict()
        .parse(JSON.parse(atob(query.cursor)));
    } catch {
      throw new RenewalCommandError('INVALID_CURSOR', 400);
    }
    if (cursor.binding !== binding) throw new RenewalCommandError('INVALID_CURSOR', 400);
    where.push('(p.end_date>? OR (p.end_date=? AND r.id>?))');
    values.push(cursor.date, cursor.date, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT ${columns} ${from} WHERE ${where.join(' AND ')} ORDER BY p.end_date,r.id LIMIT ?`,
    )
    .bind(...values, query.limit + 1)
    .all<Row>();
  if (!rows.success) throw new RenewalCommandError('QUERY_FAILED', 500);
  const current = rows.results.slice(0, query.limit),
    last = current.at(-1);
  return {
    items: current.map(item),
    nextCursor:
      rows.results.length > query.limit && last
        ? btoa(JSON.stringify({ date: last.end_date, id: last.id, binding }))
        : null,
  };
}
export async function readRenewal(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<RenewalBrowseDetail> {
  if (!key.safeParse(id).success) throw new RenewalCommandError('NOT_FOUND', 404);
  const { where, values } = await selection(context, db);
  where.push('r.id=?');
  values.push(id);
  const row = await db
    .prepare(
      `SELECT ${columns},c.phone,c.email,c.reference_name,
 (SELECT CASE WHEN count(*)=1 THEN min(e.external_key) ELSE NULL END FROM external_customer_references e WHERE e.agency_id=c.agency_id AND e.customer_id=c.id AND e.source_namespace='insurer:'||p.insurer_id) AS insurer_number,
 s.vehicle_id,s.vehicle_version,s.details_json ${from} LEFT JOIN policy_vehicle_snapshots s ON s.agency_id=p.agency_id AND s.policy_id=p.id WHERE ${where.join(' AND ')} LIMIT 1`,
    )
    .bind(...values)
    .first<Row>();
  if (!row) throw new RenewalCommandError('NOT_FOUND', 404);
  return {
    ...item(row),
    phone: row.phone,
    email: row.email,
    referenceName: row.reference_name,
    insurerCustomerNumber: row.insurer_number,
    vehicle: row.vehicle_id
      ? {
          vehicleId: row.vehicle_id,
          vehicleVersion: row.vehicle_version!,
          details: vehicleFieldsSchema.parse(JSON.parse(row.details_json!)),
        }
      : null,
  };
}
import { turkishNameSql, turkishNameTerm } from '../db/turkish-search';

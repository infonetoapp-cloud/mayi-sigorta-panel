import type { AuthenticatedUserContext as Context } from '../auth/identity';
import { member, salesGate, SalesError } from './service';

export interface NewBusinessTask {
  taskId: string;
  customerId: string;
  customerAssignee: string | null;
  branchId: string;
  health: number;
  caseVersion: number;
  taskVersion: number;
  open: number;
  activeBranch: number;
}

export function newBusinessTaskQuery(
  ctx: Context,
  caseId: string,
  taskId?: string,
  extraJoins = '',
) {
  const actor = member(ctx);
  const gate = salesGate(ctx, true, 'update');
  return {
    sql: `FROM sales_cases s
      JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
      JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
      JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id
      JOIN tasks t ON t.agency_id=l.agency_id AND t.id=l.task_id AND t.customer_id=s.customer_id
      JOIN agency_memberships m ON m.agency_id=s.agency_id
      JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
      ${extraJoins}
      WHERE s.agency_id=? AND s.id=? AND t.id=${taskId ? '?' : 's.active_task_id'} AND s.context_kind='NEW_BUSINESS'
      AND t.kind='GENERAL' AND t.policy_id IS NULL AND t.renewal_id IS NULL AND (${gate.sql})
      ${
        ctx.sessionHash
          ? `AND EXISTS(SELECT 1 FROM local_sessions ls JOIN local_credentials lc
        ON lc.user_id=ls.user_id AND lc.identity_id=ls.identity_id
        WHERE ls.token_hash=? AND ls.user_id=u.id AND ls.identity_id=? AND ls.membership_id=m.id
        AND ls.revoked_at IS NULL AND ls.kind='NORMAL' AND ls.expires_at>unixepoch()*1000
        AND ls.last_seen_at>unixepoch()*1000-28800000 AND ls.credential_version=lc.credential_version
        AND ls.permission_version=m.permission_version AND lc.login_enabled=1 AND lc.must_change_password=0)`
          : ''
      }`,
    args: [
      actor.agencyId,
      caseId,
      ...(taskId ? [taskId] : []),
      ...gate.args,
      ...(ctx.sessionHash ? [ctx.sessionHash, ctx.identityId] : []),
    ],
  };
}
export const openNewBusinessTask = `s.result='OPEN' AND s.current_result_id IS NULL AND s.active_task_id=t.id
  AND t.status='OPEN' AND c.archived_at IS NULL`;

export async function readNewBusinessTask(
  db: D1Database,
  query: ReturnType<typeof newBusinessTaskQuery>,
) {
  const row = await db
    .prepare(
      `SELECT t.id taskId,s.customer_id customerId,c.assignee_membership_id customerAssignee,s.branch_id branchId,
    (s.data_classification='HEALTH' OR b.data_classification='HEALTH') health,
    s.version caseVersion,t.version taskVersion,(b.status='ACTIVE') activeBranch,
    CASE WHEN ${openNewBusinessTask} THEN 1 ELSE 0 END open ${query.sql}`,
    )
    .bind(...query.args)
    .first<NewBusinessTask>();
  if (!row) throw new SalesError('TASK_NOT_ACCESSIBLE', 404);
  return row;
}

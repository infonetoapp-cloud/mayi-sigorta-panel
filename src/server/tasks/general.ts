import type { AuthenticatedUserContext } from '../auth/identity';
/** Same bounded due/id ordering as renewal rows. Actual GENERAL Tasks, no synthetic renewal. */
export function generalTaskSelect(
  ctx: AuthenticatedUserContext,
  queue: string,
  cursor: { dueAt: string; taskId: string } | null,
  exactId?: string,
) {
  const m = ctx.memberships[0]!;
  const scope = (code: string, assigned: string) =>
    `(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='${code}' AND (x.scope='AGENCY' OR (x.scope='ASSIGNED' AND ${assigned}))))`;
  const where = [
    `t.agency_id=?`,
    `m.id=?`,
    `m.user_id=?`,
    `m.permission_version=?`,
    `m.type=?`,
    `m.status='ACTIVE'`,
    `u.status='ACTIVE'`,
    `a.status='ACTIVE'`,
    `EXISTS(SELECT 1 FROM auth_identities ai WHERE ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE')`,
    `t.kind='GENERAL'`,
    `t.status='OPEN'`,
    `c.archived_at IS NULL`,
    scope('task.read', 't.assignee_membership_id=m.id'),
    `(m.type='OWNER' OR t.assignee_membership_id=m.id)`,
    scope('customer.read', 'c.assignee_membership_id=m.id'),
    `(s.id IS NULL OR (s.result='OPEN' AND s.active_task_id=t.id AND ${scope('quote.read', 'c.assignee_membership_id=m.id')}))`,
    `(gp.id IS NULL OR ${scope('policy.read', 'gp.assignee_membership_id=m.id OR c.assignee_membership_id=m.id')})`,
    `(coalesce(s.data_classification,'GENERAL')<>'HEALTH' AND coalesce(b.data_classification,'GENERAL')<>'HEALTH' AND coalesce(pb.data_classification,'GENERAL')<>'HEALTH' OR EXISTS(SELECT 1 FROM membership_permissions h WHERE h.membership_id=m.id AND h.permission_code='sensitive.health.read' AND h.scope='UNSCOPED'))`,
  ];
  const args: unknown[] = [
    m.agencyId,
    m.id,
    ctx.userId,
    m.permissionVersion,
    m.type,
    ctx.identityId,
  ];
  if (queue === 'UNASSIGNED') where.push('t.assignee_membership_id IS NULL');
  if (queue === 'WORK' && m.type === 'OWNER') where.push('t.assignee_membership_id IS NOT NULL');
  const reassignment = `EXISTS(SELECT 1 FROM agency_memberships old JOIN users ou ON ou.id=old.user_id WHERE old.id=t.assignee_membership_id AND (old.status<>'ACTIVE' OR ou.status<>'ACTIVE'))`;
  if (queue === 'REASSIGNMENT') where.push(reassignment, "m.type='OWNER'");
  if (cursor) {
    where.push('(t.due_at>? OR(t.due_at=? AND t.id>?))');
    args.push(cursor.dueAt, cursor.dueAt, cursor.taskId);
  }
  if (exactId) {
    where.push('t.id=?');
    args.push(exactId);
  }
  return {
    sql: `SELECT t.id task_id,t.agency_id,t.customer_id,NULL renewal_id,t.title task_title,t.due_at,t.assignee_membership_id task_assignee_membership_id,t.version task_version,NULL renewal_assignee_membership_id,NULL renewal_state,NULL renewal_version,NULL policy_id,NULL policy_number,NULL policy_end_date,b.name policy_branch_name,NULL policy_insurer_name,NULL policy_insurer_customer_number,CASE WHEN ${reassignment} THEN 1 ELSE 0 END needs_reassignment,0 can_read_policy,c.display_name customer_display_name,NULL customer_email,NULL customer_phone,'GENERAL' task_kind,s.id case_id
 FROM tasks t JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id JOIN agency_memberships m ON m.agency_id=t.agency_id JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
 LEFT JOIN sales_case_tasks l ON l.agency_id=t.agency_id AND l.task_id=t.id LEFT JOIN sales_cases s ON s.agency_id=l.agency_id AND s.id=l.case_id LEFT JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 LEFT JOIN policies gp ON gp.agency_id=t.agency_id AND gp.id=t.policy_id LEFT JOIN insurance_branches pb ON pb.agency_id=gp.agency_id AND pb.id=gp.branch_id WHERE ${where.join(' AND ')}`,
    args,
  };
}

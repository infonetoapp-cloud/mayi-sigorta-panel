import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import type {
  TaskStatisticsCounts,
  TaskStatisticsData,
  TaskStatisticsEmployee,
} from '../../shared/task-statistics';
import { TaskForbiddenError, TaskValidationError } from './errors';

export const taskStatisticsQuerySchema = z
  .object({
    view: z.enum(['self', 'team']).default('self'),
    membershipId: z.string().min(1).max(128).optional(),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();

/** Fixed operational view, not a generic report resolver or caller-selected query. */
export async function readTaskStatistics(
  db: D1Database,
  original: AuthenticatedUserContext,
  raw: unknown,
): Promise<TaskStatisticsData> {
  const query = taskStatisticsQuerySchema.parse(raw);
  const member = original.memberships[0];
  if (!member || member.status !== 'ACTIVE') throw new TaskForbiddenError();
  const context: AuthenticatedUserContext = {
    userId: original.userId,
    identityId: original.identityId,
    assurance: original.assurance,
    memberships: [{ ...member }],
  };
  const active = context.memberships[0]!;
  const team = query.view === 'team';
  if ((team || (query.membershipId && query.membershipId !== active.id)) && active.type !== 'OWNER')
    throw new TaskForbiddenError();
  if ((query.cursor && !team) || (team && query.membershipId)) throw new TaskForbiddenError();
  const subject = query.membershipId ?? active.id;
  const resource = { agencyId: active.agencyId, isCollection: true, parentReadAuthorized: true };
  const scopes = new Map<string, string>();
  for (const action of ['customer.read', 'policy.read', 'renewal.read', 'task.read']) {
    const result = await evaluateAuthorization(db, { context, action, resource });
    if (
      result.decision !== 'ALLOW' ||
      !['ASSIGNED', 'AGENCY'].includes(result.effectiveScope ?? '')
    )
      throw new TaskForbiddenError();
    scopes.set(action, result.effectiveScope!);
  }
  const report = team ? 'report.management' : 'report.operations';
  const reportResult = await evaluateAuthorization(
    db,
    {
      context,
      action: report,
      resource: { agencyId: active.agencyId, taskAssigneeMembershipId: active.id },
    },
    {
      resolvers: {
        report_scope_resolver: ({ agencyId, membershipId, permissionCode, resource: value }) => {
          const record = value as Record<string, unknown> | null;
          return (
            (permissionCode === 'report.operations' || permissionCode === 'report.management') &&
            record?.agencyId === agencyId &&
            record.taskAssigneeMembershipId === membershipId
          );
        },
      },
    },
  );
  if (reportResult.decision !== 'ALLOW' || !reportResult.effectiveScope)
    throw new TaskForbiddenError();
  scopes.set(report, reportResult.effectiveScope);
  const health = await evaluateAuthorization(db, {
    context,
    action: 'policy.health.read',
    resource,
  });
  const healthScope = health.decision === 'ALLOW' ? health.effectiveScope : null;
  if (healthScope) scopes.set('sensitive.health.read', 'UNSCOPED');

  // Recheck every permission used by this fixed query and the current actor kind inside
  // the final batch. The request-bound DB adds live session + credential-epoch checks.
  const checks = [...scopes].map(([code]) =>
    code === 'sensitive.health.read'
      ? 'EXISTS(SELECT 1 FROM membership_permissions mp WHERE mp.membership_id=m.id AND mp.permission_code=? AND mp.scope=?)'
      : "(m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions mp WHERE mp.membership_id=m.id AND mp.permission_code=? AND mp.scope=?))",
  );
  const assertion = db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,count(*),'MEMBERSHIP_PERMISSION_NOT_FOUND'
    FROM agency_memberships m JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id
    JOIN auth_identities ai ON ai.user_id=u.id AND ai.id=? AND ai.status='ACTIVE'
    WHERE m.id=? AND m.agency_id=? AND m.user_id=? AND m.type=? AND m.permission_version=?
      AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE' AND ${checks.join(' AND ')}`,
    )
    .bind(
      crypto.randomUUID(),
      context.identityId,
      active.id,
      active.agencyId,
      context.userId,
      active.type,
      active.permissionVersion,
      ...[...scopes].flat(),
    );

  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const start = new Date(`${date}T00:00:00+03:00`);
  const tomorrow = new Date(start.getTime() + 86400000).toISOString();
  const completionStart = new Date(start.getTime() - 29 * 86400000).toISOString();
  const bindings: (string | number)[] = [active.agencyId];
  const filters = ['t.agency_id=?'];
  if (scopes.get('customer.read') === 'ASSIGNED') {
    filters.push('c.assignee_membership_id=?');
    bindings.push(active.id);
  }
  if (scopes.get('policy.read') === 'ASSIGNED') {
    filters.push('(p.id IS NULL OR p.assignee_membership_id=? OR c.assignee_membership_id=?)');
    bindings.push(active.id, active.id);
  }
  if (scopes.get('renewal.read') === 'ASSIGNED') {
    filters.push('(r.id IS NULL OR r.assignee_membership_id=? OR c.assignee_membership_id=?)');
    bindings.push(active.id, active.id);
  }
  if (!healthScope) filters.push("(p.id IS NULL OR b.data_classification='GENERAL')");
  else if (healthScope === 'ASSIGNED') {
    filters.push(
      "(p.id IS NULL OR b.data_classification='GENERAL' OR p.assignee_membership_id=? OR c.assignee_membership_id=?)",
    );
    bindings.push(active.id, active.id);
  }
  if (!team) {
    filters.push(
      "((t.status='OPEN' AND t.assignee_membership_id=?) OR (t.status='COMPLETED' AND t.completed_by_membership_id=?))",
    );
    bindings.push(subject, subject);
  }
  const cte = `WITH scoped AS (
    SELECT t.* FROM tasks t JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
    LEFT JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
    LEFT JOIN policies p ON p.agency_id=t.agency_id AND p.id=COALESCE(t.policy_id,r.expiring_policy_id)
    LEFT JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
    WHERE ${filters.join(' AND ')}
      AND (t.status='COMPLETED' OR (c.archived_at IS NULL
        AND (p.id IS NULL OR (p.status='ACTIVE' AND p.archived_at IS NULL))
        AND (r.id IS NULL OR (r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED') AND t.assignee_membership_id IS r.assignee_membership_id))))
  ), activity AS (
    SELECT CASE WHEN status='OPEN' THEN assignee_membership_id ELSE completed_by_membership_id END AS member_id,
      CASE WHEN status='OPEN' AND due_at<? THEN 1 ELSE 0 END AS overdue,
      CASE WHEN status='OPEN' AND due_at>=? AND due_at<? THEN 1 ELSE 0 END AS dueToday,
      CASE WHEN status='OPEN' AND due_at>=? THEN 1 ELSE 0 END AS upcoming,
      CASE WHEN status='COMPLETED' AND completed_at>=? AND completed_at<=? THEN 1 ELSE 0 END AS completedLast30Days
    FROM scoped
  )`;
  const cteBindings = [
    ...bindings,
    start.toISOString(),
    start.toISOString(),
    tomorrow,
    tomorrow,
    completionStart,
    now.toISOString(),
  ];
  const sums = `COALESCE(sum(overdue),0) AS overdue,COALESCE(sum(dueToday),0) AS dueToday,COALESCE(sum(upcoming),0) AS upcoming,COALESCE(sum(completedLast30Days),0) AS completedLast30Days`;
  const summary = db.prepare(`${cte} SELECT ${sums} FROM activity`).bind(...cteBindings);
  const employees = db
    .prepare(
      `${cte} SELECT m.id AS membershipId,u.display_name AS displayName,m.status,u.status='ACTIVE' AS userActive,${sums}
    FROM agency_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN activity ON member_id=m.id
    WHERE m.agency_id=? AND m.id>? GROUP BY m.id ORDER BY m.id LIMIT 51`,
    )
    .bind(...cteBindings, active.agencyId, query.cursor ?? '');
  const unassigned = db
    .prepare(`${cte} SELECT ${sums} FROM activity WHERE member_id IS NULL`)
    .bind(...cteBindings);
  let results: D1Result[];
  try {
    results = await db.batch([assertion, summary, ...(team ? [employees, unassigned] : [])]);
  } catch (error) {
    if (
      /LOCAL_SESSION_REVOKED|MEMBERSHIP_PERMISSION_NOT_FOUND|OPTIMISTIC_CONCURRENCY_CONFLICT/.test(
        error instanceof Error ? error.message : '',
      )
    )
      throw new TaskForbiddenError();
    throw error;
  }
  if (results.some((result) => !result.success))
    throw new TaskValidationError('STATISTICS_QUERY_FAILED');
  const summaryRow = results[1]?.results[0] as unknown as TaskStatisticsCounts | undefined;
  if (!summaryRow) throw new TaskValidationError('STATISTICS_QUERY_FAILED');
  const rows = (results[2]?.results ?? []) as unknown as (Omit<
    TaskStatisticsEmployee,
    'userActive'
  > & { userActive: number })[];
  const page = rows.slice(0, 50);
  const unassignedRow = results[3]?.results[0] as unknown as TaskStatisticsCounts | undefined;
  return {
    view: query.view,
    canSeeTeam: active.type === 'OWNER',
    timezone: 'Europe/Istanbul',
    todayLocalDate: date,
    completionStart,
    now: now.toISOString(),
    summary: summaryRow,
    employees: page.map((row) => ({ ...row, userActive: row.userActive === 1 })),
    unassigned: unassignedRow
      ? {
          overdue: unassignedRow.overdue,
          dueToday: unassignedRow.dueToday,
          upcoming: unassignedRow.upcoming,
        }
      : null,
    nextCursor: rows.length > 50 ? page.at(-1)!.membershipId : null,
  };
}

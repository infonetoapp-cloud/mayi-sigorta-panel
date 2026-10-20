import { evaluateAuthorization, type EffectiveScope } from '../auth/authorization';
import type { AuthenticatedUserContext } from '../auth/identity';
import type {
  CustomerAssignmentOptionDto,
  RenewalTaskAssignmentDto,
  RenewalTaskReplacementCompletionDto,
  TodayTaskDto,
  TodayTasksResponseData,
} from '../../shared/types';
import {
  executeRenewalTaskAssignment,
  lookupRenewalTaskAssignmentReplay,
} from '../mutations/internal/renewal-task-executor';
import {
  executeRenewalTaskReplacementCompletion,
  lookupRenewalTaskCompletionReplay,
} from '../mutations/internal/renewal-task-completion-executor';
import {
  renewalTaskAssignSchema,
  renewalTaskCompleteSchema,
  type TodayTasksQuery,
} from './validation';
import {
  TaskForbiddenError,
  TaskNotFoundError,
  TaskReplayNotAuthorizedError,
  TaskValidationError,
} from './errors';

interface ActiveMembership {
  readonly id: string;
  readonly agencyId: string;
  readonly type: 'OWNER' | 'MEMBER';
  readonly status: 'ACTIVE';
  readonly permissionVersion: number;
}

interface TodayTaskRow {
  task_id: string;
  agency_id: string;
  customer_id: string;
  renewal_id: string;
  task_title: string;
  due_at: string;
  needs_reassignment: number;
  task_assignee_membership_id: string | null;
  task_version: number;
  renewal_assignee_membership_id: string | null;
  renewal_state: TodayTaskDto['renewalState'];
  renewal_version: number;
  policy_id: string | null;
  policy_number: string;
  policy_end_date: string;
  can_read_policy: number;
  customer_display_name: string;
  customer_email: string | null;
  customer_phone: string | null;
}

interface RenewalTaskScopeRow {
  agency_id: string;
  renewal_id: string;
  task_id: string;
  task_assignee_membership_id: string | null;
  task_status: 'OPEN' | 'COMPLETED';
  task_version: number;
  renewal_assignee_membership_id: string | null;
  policy_assignee_membership_id: string | null;
  branch_data_classification: 'GENERAL' | 'HEALTH';
  customer_assignee_membership_id: string;
  renewal_state: TodayTaskDto['renewalState'];
  renewal_closed_at: string | null;
  renewal_version: number;
}

function activeMembership(context: AuthenticatedUserContext): ActiveMembership {
  const active = context.memberships[0];
  if (!active || active.status !== 'ACTIVE') throw new TaskForbiddenError();
  return active as ActiveMembership;
}

async function authorize(
  db: D1Database,
  context: AuthenticatedUserContext,
  action: string,
  resource: Record<string, unknown>,
) {
  const result = await evaluateAuthorization(db, { context, action, resource });
  if (result.decision !== 'ALLOW' || !result.effectiveScope) throw new TaskForbiddenError();
  return result;
}

async function loadOpenPrimaryTaskForRenewal(
  db: D1Database,
  agencyId: string,
  renewalId: string,
  taskId: string,
): Promise<RenewalTaskScopeRow | null> {
  return db
    .prepare(
      `SELECT t.agency_id,t.renewal_id,t.id AS task_id,
          t.assignee_membership_id AS task_assignee_membership_id,t.status AS task_status,
          t.version AS task_version,r.assignee_membership_id AS renewal_assignee_membership_id,
          p.assignee_membership_id AS policy_assignee_membership_id,
          b.data_classification AS branch_data_classification,
          c.assignee_membership_id AS customer_assignee_membership_id,r.state AS renewal_state,
          r.closed_at AS renewal_closed_at,r.version AS renewal_version
       FROM tasks t
       JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
       WHERE t.agency_id=? AND r.id=? AND t.id=?
         AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN'
         AND t.assignee_membership_id IS r.assignee_membership_id
         AND r.closed_at IS NULL AND r.state NOT IN ('WON','LOST','VOIDED')
         AND p.status='ACTIVE' AND p.archived_at IS NULL AND c.archived_at IS NULL
       LIMIT 1`,
    )
    .bind(agencyId, renewalId, taskId)
    .first<RenewalTaskScopeRow>();
}

async function loadPrimaryTaskForCompletion(
  db: D1Database,
  agencyId: string,
  renewalId: string,
  taskId: string,
): Promise<RenewalTaskScopeRow | null> {
  return db
    .prepare(
      `SELECT t.agency_id,t.renewal_id,t.id AS task_id,
          t.assignee_membership_id AS task_assignee_membership_id,t.status AS task_status,
          t.version AS task_version,r.assignee_membership_id AS renewal_assignee_membership_id,
          p.assignee_membership_id AS policy_assignee_membership_id,
          b.data_classification AS branch_data_classification,
          c.assignee_membership_id AS customer_assignee_membership_id,r.state AS renewal_state,
          r.closed_at AS renewal_closed_at,r.version AS renewal_version
       FROM tasks t
       JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
       WHERE t.agency_id=? AND r.id=? AND t.id=? AND t.kind='RENEWAL_FOLLOWUP'
         AND (t.status='COMPLETED' OR t.assignee_membership_id IS r.assignee_membership_id)
         AND p.archived_at IS NULL AND c.archived_at IS NULL`,
    )
    .bind(agencyId, renewalId, taskId)
    .first<RenewalTaskScopeRow>();
}

function renewalResource(row: RenewalTaskScopeRow): Record<string, unknown> {
  return {
    agencyId: row.agency_id,
    renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
    customerAssigneeMembershipId: row.customer_assignee_membership_id,
  };
}

function taskResource(row: RenewalTaskScopeRow): Record<string, unknown> {
  return {
    ...renewalResource(row),
    taskAssigneeMembershipId: row.task_assignee_membership_id,
    policyAssigneeMembershipId: row.policy_assignee_membership_id,
    parentReadAuthorized: true,
  };
}

async function authorizeTaskParents(
  db: D1Database,
  context: AuthenticatedUserContext,
  row: RenewalTaskScopeRow,
): Promise<void> {
  await authorize(db, context, 'customer.read', {
    agencyId: row.agency_id,
    assigneeMembershipId: row.customer_assignee_membership_id,
  });
  await authorize(
    db,
    context,
    row.branch_data_classification === 'HEALTH' ? 'policy.health.read' : 'policy.read',
    {
      agencyId: row.agency_id,
      assigneeMembershipId: row.policy_assignee_membership_id,
      customerAssigneeMembershipId: row.customer_assignee_membership_id,
    },
  );
  await authorize(db, context, 'renewal.read', renewalResource(row));
}

interface TaskCursorBinding {
  readonly queue: 'WORK' | 'UNASSIGNED' | 'REASSIGNMENT';
  readonly agencyId: string;
  readonly membershipId: string;
  readonly permissionVersion: number;
  readonly taskReadScope: 'ASSIGNED' | 'AGENCY';
  readonly renewalReadScope: 'ASSIGNED' | 'AGENCY';
  readonly customerReadScope: 'ASSIGNED' | 'AGENCY';
  readonly policyReadScope: 'ASSIGNED' | 'AGENCY';
  readonly policyHealthReadScope: 'ASSIGNED' | 'AGENCY' | null;
}

interface TaskCursor extends TaskCursorBinding {
  readonly dueAt: string;
  readonly taskId: string;
}

function parseCursor(cursor: string | undefined, expected: TaskCursorBinding): TaskCursor | null {
  if (!cursor) return null;
  try {
    const tuple: unknown = JSON.parse(atob(cursor));
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 11 ||
      tuple[0] !== expected.queue ||
      tuple[1] !== expected.agencyId ||
      tuple[2] !== expected.membershipId ||
      tuple[3] !== expected.permissionVersion ||
      tuple[4] !== expected.taskReadScope ||
      tuple[5] !== expected.renewalReadScope ||
      tuple[6] !== expected.customerReadScope ||
      tuple[7] !== expected.policyReadScope ||
      tuple[8] !== expected.policyHealthReadScope ||
      typeof tuple[9] !== 'string' ||
      typeof tuple[10] !== 'string' ||
      !Number.isFinite(Date.parse(tuple[9])) ||
      new Date(tuple[9]).toISOString() !== tuple[9] ||
      tuple[10].trim() !== tuple[10] ||
      tuple[10].length === 0 ||
      tuple[10].length > 128
    ) {
      throw new Error('INVALID_CURSOR');
    }
    return { ...expected, dueAt: tuple[9], taskId: tuple[10] };
  } catch {
    throw new TaskValidationError('INVALID_CURSOR');
  }
}

function localDate(value: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
  } catch {
    throw new TaskValidationError('TIMEZONE_INVALID');
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new TaskValidationError('TIMEZONE_INVALID');
  return `${year}-${month}-${day}`;
}

function cursorFor(row: TodayTaskRow, binding: TaskCursorBinding): string {
  return btoa(
    JSON.stringify([
      binding.queue,
      binding.agencyId,
      binding.membershipId,
      binding.permissionVersion,
      binding.taskReadScope,
      binding.renewalReadScope,
      binding.customerReadScope,
      binding.policyReadScope,
      binding.policyHealthReadScope,
      row.due_at,
      row.task_id,
    ]),
  );
}

interface TaskPage {
  readonly items: readonly TodayTaskDto[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

// Keep unavailable assignees attached until an explicit authorized assignment.
const needsReassignmentSql = `t.assignee_membership_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM agency_memberships previous_m JOIN users previous_u ON previous_u.id=previous_m.user_id
  WHERE previous_m.agency_id=t.agency_id AND previous_m.id=t.assignee_membership_id
    AND (previous_m.status IN ('SUSPENDED','INACTIVE') OR previous_u.status<>'ACTIVE'))`;

async function loadTaskPage(input: {
  readonly exactTaskId?: string;
  readonly context: AuthenticatedUserContext;
  readonly db: D1Database;
  readonly active: ReturnType<typeof activeMembership>;
  readonly taskReadScope: EffectiveScope;
  readonly renewalReadScope: EffectiveScope;
  readonly customerReadScope: EffectiveScope;
  readonly policyReadScope: EffectiveScope;
  readonly policyHealthReadScope: 'ASSIGNED' | 'AGENCY' | null;
  readonly canSeeUnassigned: boolean;
  readonly cursor: TaskCursor | null;
  readonly limit: number;
  readonly queue: 'WORK' | 'UNASSIGNED' | 'REASSIGNMENT';
  readonly now: Date;
  readonly todayLocalDate: string;
  readonly timezone: string;
}): Promise<TaskPage> {
  const where = [
    't.agency_id=?',
    "t.kind='RENEWAL_FOLLOWUP'",
    "t.status='OPEN'",
    't.assignee_membership_id IS r.assignee_membership_id',
    "r.state NOT IN ('WON','LOST','VOIDED')",
    'r.closed_at IS NULL',
    "p.status='ACTIVE'",
    'p.archived_at IS NULL',
    'c.archived_at IS NULL',
    `EXISTS(
      SELECT 1 FROM agency_memberships live_m
      JOIN users live_u ON live_u.id=live_m.user_id
      JOIN agencies live_a ON live_a.id=live_m.agency_id
      WHERE live_m.id=? AND live_m.agency_id=t.agency_id AND live_m.user_id=?
        AND live_m.status='ACTIVE' AND live_u.status='ACTIVE' AND live_a.status='ACTIVE'
        AND live_m.permission_version=?
        AND EXISTS(SELECT 1 FROM auth_identities live_ai
          WHERE live_ai.id=? AND live_ai.user_id=live_u.id AND live_ai.status='ACTIVE')
        AND (live_m.type='OWNER' OR (
          EXISTS(SELECT 1 FROM membership_permissions task_permission
            WHERE task_permission.membership_id=live_m.id
              AND task_permission.permission_code='task.read' AND task_permission.scope=?)
          AND EXISTS(SELECT 1 FROM membership_permissions renewal_permission
            WHERE renewal_permission.membership_id=live_m.id
              AND renewal_permission.permission_code='renewal.read' AND renewal_permission.scope=?)
        ))
    )`,
  ];
  const values: unknown[] = [
    input.policyReadScope,
    input.policyReadScope,
    input.active.id,
    input.active.id,
    input.policyHealthReadScope ?? 'NONE',
    input.policyHealthReadScope ?? 'NONE',
    input.active.id,
    input.active.id,
    input.active.agencyId,
    input.active.id,
    input.context.userId,
    input.active.permissionVersion,
    input.context.identityId,
    input.taskReadScope,
    input.renewalReadScope,
  ];
  if (input.queue === 'UNASSIGNED') {
    where.push('t.assignee_membership_id IS NULL');
  } else if (input.queue === 'REASSIGNMENT') {
    where.push(`(${needsReassignmentSql})`);
    where.push(`EXISTS(SELECT 1 FROM agency_memberships owner_m WHERE owner_m.id=?
      AND owner_m.agency_id=t.agency_id AND owner_m.type='OWNER' AND owner_m.status='ACTIVE')`);
    values.push(input.active.id);
  } else if (input.canSeeUnassigned) {
    where.push('t.assignee_membership_id IS NOT NULL');
  }
  if (input.active.type !== 'OWNER' || input.taskReadScope === 'ASSIGNED') {
    where.push('t.assignee_membership_id=?');
    values.push(input.active.id);
  }
  if (input.renewalReadScope === 'ASSIGNED') {
    where.push('(r.assignee_membership_id=? OR c.assignee_membership_id=?)');
    values.push(input.active.id, input.active.id);
  }
  if (input.customerReadScope === 'ASSIGNED') {
    where.push('c.assignee_membership_id=?');
    values.push(input.active.id);
  }
  if (input.policyReadScope === 'ASSIGNED') {
    where.push('(p.assignee_membership_id=? OR c.assignee_membership_id=?)');
    values.push(input.active.id, input.active.id);
  }
  if (input.policyHealthReadScope === null) {
    where.push("b.data_classification='GENERAL'");
  } else if (input.policyHealthReadScope === 'ASSIGNED') {
    where.push(
      "(b.data_classification='GENERAL' OR p.assignee_membership_id=? OR c.assignee_membership_id=?)",
    );
    values.push(input.active.id, input.active.id);
  }
  if (input.exactTaskId !== undefined) {
    where.push('t.id=?');
    values.push(input.exactTaskId);
  }
  if (input.cursor) {
    where.push('(t.due_at>? OR (t.due_at=? AND t.id>?))');
    values.push(input.cursor.dueAt, input.cursor.dueAt, input.cursor.taskId);
  }
  values.push(input.limit + 1);

  const statement = input.db
    .prepare(
      `SELECT t.id AS task_id,t.agency_id,t.customer_id,t.renewal_id,t.title AS task_title,
          t.due_at,t.assignee_membership_id AS task_assignee_membership_id,t.version AS task_version,
          r.assignee_membership_id AS renewal_assignee_membership_id,r.state AS renewal_state,
          r.version AS renewal_version,p.id AS policy_id,p.policy_number,p.end_date AS policy_end_date,
          CASE WHEN ${needsReassignmentSql} THEN 1 ELSE 0 END AS needs_reassignment,
          CASE
            WHEN b.data_classification='GENERAL' AND ?='AGENCY' THEN 1
            WHEN b.data_classification='GENERAL' AND ?='ASSIGNED'
              AND (p.assignee_membership_id=? OR c.assignee_membership_id=?) THEN 1
            WHEN b.data_classification='HEALTH' AND ?='AGENCY' THEN 1
            WHEN b.data_classification='HEALTH' AND ?='ASSIGNED'
              AND (p.assignee_membership_id=? OR c.assignee_membership_id=?) THEN 1
            ELSE 0
          END AS can_read_policy,
          c.display_name AS customer_display_name,COALESCE(cc.email,c.email) AS customer_email,
          COALESCE(cc.phone,c.phone) AS customer_phone
       FROM tasks t
       JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       LEFT JOIN company_contacts cc ON cc.agency_id=c.agency_id AND cc.customer_id=c.id
         AND cc.status='ACTIVE' AND cc.is_primary=1
       WHERE ${where.join(' AND ')}
       ORDER BY t.due_at ASC,t.id ASC LIMIT ?`,
    )
    .bind(...values);
  // The exact-context read uses the request-bound batch's live session assertion.
  // Ordinary queue semantics are unchanged; no portfolio scan or alternate-ID lookup.
  const result =
    input.exactTaskId === undefined
      ? await statement.all<TodayTaskRow>()
      : (await input.db.batch<TodayTaskRow>([statement]))[0]!;
  if (!result.success || !Array.isArray(result.results)) {
    throw new TaskValidationError('TASK_QUERY_FAILED');
  }
  const hasMore = result.results.length > input.limit;
  const rows = result.results.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => toDto(row, input.now, input.todayLocalDate, input.timezone)),
    hasMore,
    nextCursor:
      hasMore && last
        ? cursorFor(last, {
            queue: input.queue,
            agencyId: input.active.agencyId,
            membershipId: input.active.id,
            permissionVersion: input.active.permissionVersion,
            taskReadScope: input.taskReadScope as 'ASSIGNED' | 'AGENCY',
            renewalReadScope: input.renewalReadScope as 'ASSIGNED' | 'AGENCY',
            customerReadScope: input.customerReadScope as 'ASSIGNED' | 'AGENCY',
            policyReadScope: input.policyReadScope as 'ASSIGNED' | 'AGENCY',
            policyHealthReadScope: input.policyHealthReadScope,
          })
        : null,
  };
}

function toDto(
  row: TodayTaskRow,
  now: Date,
  todayLocalDate: string,
  timezone: string,
): TodayTaskDto {
  const dueDate = new Date(row.due_at);
  if (!Number.isFinite(dueDate.getTime()) || dueDate.toISOString() !== row.due_at) {
    throw new TaskValidationError('TASK_DATA_INVALID');
  }
  const localDueDate = localDate(dueDate, timezone);
  return {
    taskId: row.task_id,
    renewalId: row.renewal_id,
    customerId: row.customer_id,
    customerDisplayName: row.customer_display_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    policyId: row.can_read_policy === 1 ? row.policy_id : null,
    policyNumber: row.can_read_policy === 1 ? row.policy_number : null,
    policyEndDate: row.can_read_policy === 1 ? row.policy_end_date : null,
    title: row.task_title,
    dueAt: row.due_at,
    assigneeMembershipId: row.task_assignee_membership_id,
    taskVersion: row.task_version,
    renewalAssigneeMembershipId: row.renewal_assignee_membership_id,
    renewalState: row.renewal_state,
    renewalVersion: row.renewal_version,
    bucket:
      dueDate.getTime() < now.getTime()
        ? 'OVERDUE'
        : localDueDate === todayLocalDate
          ? 'TODAY'
          : 'UPCOMING',
    isUnassigned: row.task_assignee_membership_id === null,
    needsReassignment: row.needs_reassignment === 1,
  };
}

export async function listTodayTasks(
  context: AuthenticatedUserContext,
  db: D1Database,
  query: TodayTasksQuery,
  exactTaskId?: string,
): Promise<TodayTasksResponseData> {
  const active = activeMembership(context);
  const collectionResource = { agencyId: active.agencyId, isCollection: true };
  const renewalRead = await authorize(db, context, 'renewal.read', collectionResource);
  const customerRead = await authorize(db, context, 'customer.read', collectionResource);
  const policyRead = await authorize(db, context, 'policy.read', collectionResource);
  const policyHealthRead = await evaluateAuthorization(db, {
    context,
    action: 'policy.health.read',
    resource: collectionResource,
  });
  const policyHealthReadScope =
    policyHealthRead.decision === 'ALLOW' &&
    (policyHealthRead.effectiveScope === 'ASSIGNED' || policyHealthRead.effectiveScope === 'AGENCY')
      ? policyHealthRead.effectiveScope
      : null;
  const taskRead = await authorize(db, context, 'task.read', {
    ...collectionResource,
    parentReadAuthorized: true,
  });
  const taskAssign = await evaluateAuthorization(db, {
    context,
    action: 'task.assign',
    resource: { ...collectionResource, parentReadAuthorized: true },
  });
  const renewalAssign = await evaluateAuthorization(db, {
    context,
    action: 'renewal.assign',
    resource: collectionResource,
  });
  const canAssign =
    taskAssign.decision === 'ALLOW' &&
    taskAssign.effectiveScope === 'AGENCY' &&
    renewalAssign.decision === 'ALLOW' &&
    renewalAssign.effectiveScope === 'AGENCY';
  const canSeeUnassigned =
    active.type === 'OWNER' &&
    taskRead.effectiveScope === 'AGENCY' &&
    renewalRead.effectiveScope === 'AGENCY';
  const canSeeReassignment = active.type === 'OWNER' && canSeeUnassigned && canAssign;
  if (query.needsReassignment && !canSeeReassignment) throw new TaskForbiddenError();

  const agency = await db
    .prepare(
      `SELECT a.status,COALESCE(s.timezone,'Europe/Istanbul') AS timezone
       FROM agencies a LEFT JOIN agency_settings s ON s.agency_id=a.id WHERE a.id=?`,
    )
    .bind(active.agencyId)
    .first<{ status: string; timezone: string }>();
  if (!agency || agency.status !== 'ACTIVE') throw new TaskForbiddenError();

  const now = new Date();
  const nowIso = now.toISOString();
  const todayLocalDate = localDate(now, agency.timezone);
  const cursorScopes = {
    agencyId: active.agencyId,
    membershipId: active.id,
    permissionVersion: active.permissionVersion,
    taskReadScope: taskRead.effectiveScope as 'ASSIGNED' | 'AGENCY',
    renewalReadScope: renewalRead.effectiveScope as 'ASSIGNED' | 'AGENCY',
    customerReadScope: customerRead.effectiveScope as 'ASSIGNED' | 'AGENCY',
    policyReadScope: policyRead.effectiveScope as 'ASSIGNED' | 'AGENCY',
    policyHealthReadScope,
  };
  const workQueue = query.needsReassignment ? 'REASSIGNMENT' : 'WORK';
  const workCursor = parseCursor(query.cursor, { ...cursorScopes, queue: workQueue });
  const unassignedCursor = parseCursor(query.unassignedCursor, {
    ...cursorScopes,
    queue: 'UNASSIGNED',
  });
  if (unassignedCursor && !canSeeUnassigned) throw new TaskForbiddenError();
  const pageInput = {
    exactTaskId,
    context,
    db,
    active,
    taskReadScope: taskRead.effectiveScope as EffectiveScope,
    renewalReadScope: renewalRead.effectiveScope as EffectiveScope,
    customerReadScope: customerRead.effectiveScope as EffectiveScope,
    policyReadScope: policyRead.effectiveScope as EffectiveScope,
    policyHealthReadScope,
    canSeeUnassigned,
    limit: query.limit,
    now,
    todayLocalDate,
    timezone: agency.timezone,
  };
  const workPage = await loadTaskPage({ ...pageInput, cursor: workCursor, queue: workQueue });
  const unassignedPage = canSeeUnassigned
    ? await loadTaskPage({ ...pageInput, cursor: unassignedCursor, queue: 'UNASSIGNED' })
    : { items: [], hasMore: false, nextCursor: null };

  return {
    items: workPage.items,
    hasMore: workPage.hasMore,
    nextCursor: workPage.nextCursor,
    unassignedItems: unassignedPage.items,
    unassignedHasMore: unassignedPage.hasMore,
    unassignedNextCursor: unassignedPage.nextCursor,
    canSeeUnassigned,
    canSeeReassignment,
    canAssign,
    timezone: agency.timezone,
    todayLocalDate,
    now: nowIso,
  };
}

export async function listRenewalTaskAssignmentOptions(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  taskId: string,
): Promise<CustomerAssignmentOptionDto[]> {
  const active = activeMembership(context);
  const row = await loadOpenPrimaryTaskForRenewal(db, active.agencyId, renewalId, taskId);
  if (!row) throw new TaskNotFoundError();

  await authorizeTaskParents(db, context, row);
  const parent = renewalResource(row);
  const renewalRead = await authorize(db, context, 'renewal.read', parent);
  const taskRead = await authorize(db, context, 'task.read', taskResource(row));
  const renewalAssign = await authorize(db, context, 'renewal.assign', parent);
  const taskAssign = await authorize(db, context, 'task.assign', taskResource(row));
  if (renewalRead.effectiveScope !== 'AGENCY' || taskRead.effectiveScope !== 'AGENCY') {
    throw new TaskForbiddenError();
  }
  if (renewalAssign.effectiveScope !== 'AGENCY' || taskAssign.effectiveScope !== 'AGENCY') {
    throw new TaskForbiddenError();
  }

  const options = await db
    .prepare(
      `SELECT m.id,m.invitation_email,m.type
       FROM agency_memberships m
       JOIN users u ON u.id=m.user_id
       JOIN agencies a ON a.id=m.agency_id
       JOIN tasks t ON t.agency_id=m.agency_id AND t.id=?
       JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
       JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
       JOIN insurance_branches b ON b.agency_id=p.agency_id AND b.id=p.branch_id
       JOIN customers c ON c.agency_id=t.agency_id AND c.id=t.customer_id
       WHERE m.agency_id=? AND r.id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND a.status='ACTIVE'
         AND EXISTS(SELECT 1 FROM auth_identities ai
           WHERE ai.user_id=u.id AND ai.status='ACTIVE')
         AND (b.data_classification='GENERAL' OR EXISTS(
           SELECT 1 FROM membership_permissions hr
           WHERE hr.membership_id=m.id AND hr.permission_code='sensitive.health.read'
             AND hr.scope='UNSCOPED'))
         AND (m.type='OWNER' OR (
           EXISTS(SELECT 1 FROM membership_permissions tr
             WHERE tr.membership_id=m.id AND tr.permission_code='task.read'
               AND tr.scope IN ('AGENCY','ASSIGNED'))
           AND EXISTS(SELECT 1 FROM membership_permissions rr
             WHERE rr.membership_id=m.id AND rr.permission_code='renewal.read'
               AND rr.scope IN ('AGENCY','ASSIGNED'))
           AND EXISTS(SELECT 1 FROM membership_permissions cr
             WHERE cr.membership_id=m.id AND cr.permission_code='customer.read'
               AND (cr.scope='AGENCY' OR
                 (cr.scope='ASSIGNED' AND c.assignee_membership_id=m.id)))
           AND EXISTS(SELECT 1 FROM membership_permissions pr
             WHERE pr.membership_id=m.id AND pr.permission_code='policy.read'
               AND (pr.scope='AGENCY' OR
                 (pr.scope='ASSIGNED'
                   AND (p.assignee_membership_id=m.id OR c.assignee_membership_id=m.id))))
         ))
       ORDER BY m.invitation_email,m.id`,
    )
    .bind(taskId, active.agencyId, renewalId)
    .all<{
      id: string;
      invitation_email: string;
      type: 'OWNER' | 'MEMBER';
    }>();
  if (!options.success || !Array.isArray(options.results)) {
    throw new TaskValidationError('ASSIGNMENT_OPTIONS_QUERY_FAILED');
  }
  return options.results.map((option) => ({
    membershipId: option.id,
    label: option.invitation_email,
    membershipType: option.type,
  }));
}

export async function assignRenewalTask(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  taskId: string,
  raw: unknown,
  idempotencyKey: string,
): Promise<{ data: RenewalTaskAssignmentDto; replayed: boolean }> {
  const active = activeMembership(context);
  const parsed = renewalTaskAssignSchema.parse(raw);
  const replay = await lookupRenewalTaskAssignmentReplay({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    idempotencyKey,
    payload: parsed,
    renewalId,
    taskId,
    expectedRenewalVersion: parsed.expectedRenewalVersion,
    expectedTaskVersion: parsed.expectedTaskVersion,
    assigneeMembershipId: parsed.assigneeMembershipId,
  });
  const row = await loadPrimaryTaskForCompletion(db, active.agencyId, renewalId, taskId);
  if (!row) {
    if (replay) throw new TaskReplayNotAuthorizedError();
    throw new TaskNotFoundError();
  }

  await authorizeTaskParents(db, context, row);
  const parent = renewalResource(row);
  const renewalRead = await authorize(db, context, 'renewal.read', parent);
  const taskRead = await authorize(db, context, 'task.read', taskResource(row));
  const renewalAssign = await authorize(db, context, 'renewal.assign', parent);
  const taskAssign = await authorize(db, context, 'task.assign', taskResource(row));
  if (
    renewalRead.effectiveScope !== 'AGENCY' ||
    taskRead.effectiveScope !== 'AGENCY' ||
    renewalAssign.effectiveScope !== 'AGENCY' ||
    taskAssign.effectiveScope !== 'AGENCY'
  ) {
    throw new TaskForbiddenError();
  }

  return executeRenewalTaskAssignment({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: parsed,
    renewalId,
    taskId: row.task_id,
    expectedRenewalVersion: parsed.expectedRenewalVersion,
    expectedTaskVersion: parsed.expectedTaskVersion,
    previousAssigneeMembershipId: row.renewal_assignee_membership_id,
    assigneeMembershipId: parsed.assigneeMembershipId,
  });
}

export async function completeRenewalTaskWithReplacement(
  context: AuthenticatedUserContext,
  db: D1Database,
  renewalId: string,
  taskId: string,
  raw: unknown,
  idempotencyKey: string,
): Promise<{ data: RenewalTaskReplacementCompletionDto; replayed: boolean }> {
  const active = activeMembership(context);
  const parsed = renewalTaskCompleteSchema.parse(raw);
  const replay = await lookupRenewalTaskCompletionReplay({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    idempotencyKey,
    payload: parsed,
    renewalId,
    taskId,
    expectedRenewalVersion: parsed.expectedRenewalVersion,
    expectedTaskVersion: parsed.expectedTaskVersion,
    replacementDueAt: parsed.replacementDueAt,
  });
  const row = await loadPrimaryTaskForCompletion(db, active.agencyId, renewalId, taskId);
  if (!row) {
    if (replay) throw new TaskReplayNotAuthorizedError();
    throw new TaskNotFoundError();
  }

  await authorizeTaskParents(db, context, row);
  const parent = renewalResource(row);
  const task = taskResource(row);
  const renewalRead = await authorize(db, context, 'renewal.read', parent);
  const taskRead = await authorize(db, context, 'task.read', task);
  const taskUpdate = await authorize(db, context, 'task.update', task);
  const taskCreate = await evaluateAuthorization(db, {
    context,
    action: 'task.create',
    resource: task,
  });
  if (taskCreate.decision !== 'ALLOW') throw new TaskForbiddenError();
  if (
    (taskUpdate.effectiveScope !== 'AGENCY' && taskUpdate.effectiveScope !== 'ASSIGNED') ||
    (taskRead.effectiveScope !== 'AGENCY' && taskRead.effectiveScope !== 'ASSIGNED') ||
    (renewalRead.effectiveScope !== 'AGENCY' && renewalRead.effectiveScope !== 'ASSIGNED')
  ) {
    throw new TaskForbiddenError();
  }

  const result = await executeRenewalTaskReplacementCompletion({
    db,
    agencyId: active.agencyId,
    actorUserId: context.userId,
    actorMembershipId: active.id,
    actorIdentityId: context.identityId,
    permissionVersion: active.permissionVersion,
    idempotencyKey,
    payload: parsed,
    renewalId,
    taskId,
    expectedRenewalVersion: parsed.expectedRenewalVersion,
    expectedTaskVersion: parsed.expectedTaskVersion,
    replacementTaskId: replay?.replacementTaskId ?? crypto.randomUUID(),
    replacementDueAt: parsed.replacementDueAt,
    replacementAssigneeMembershipId: row.renewal_assignee_membership_id,
    taskUpdateScope: taskUpdate.effectiveScope,
    taskReadScope: taskRead.effectiveScope,
    renewalReadScope: renewalRead.effectiveScope,
  });
  if (result.replayed) {
    const replacement = await loadPrimaryTaskForCompletion(
      db,
      active.agencyId,
      renewalId,
      result.data.replacementTaskId,
    );
    if (!replacement) throw new TaskReplayNotAuthorizedError();
    try {
      const replayParent = renewalResource(replacement);
      await authorize(db, context, 'renewal.read', replayParent);
      const replayTask = taskResource(replacement);
      await authorize(db, context, 'task.read', replayTask);
      const replayCreate = await evaluateAuthorization(db, {
        context,
        action: 'task.create',
        resource: replayTask,
      });
      if (replayCreate.decision !== 'ALLOW') throw new TaskReplayNotAuthorizedError();
    } catch (error) {
      if (error instanceof TaskForbiddenError) throw new TaskReplayNotAuthorizedError();
      throw error;
    }
  }
  return result;
}

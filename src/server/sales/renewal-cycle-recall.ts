import type { AuthenticatedUserContext } from '../auth/identity';
import {
  RenewalCommandError,
  type RenewalReopenResult,
  type RenewalTaskRow,
} from '../renewals/commands';
import type { ReopenRenewalInput } from '../renewals/validation';
import { member, salesGate } from './service';

export type CycleRecall = NonNullable<ReopenRenewalInput['salesCycle']> & {
  successorTaskId: string | null;
};

const authorityJoins = `JOIN customers c ON c.agency_id=s.agency_id AND c.id=s.customer_id
 JOIN insurance_branches b ON b.agency_id=s.agency_id AND b.id=s.branch_id
 JOIN agency_memberships m ON m.agency_id=s.agency_id
 JOIN users u ON u.id=m.user_id JOIN agencies a ON a.id=m.agency_id`;

async function recallableTask(
  db: D1Database,
  context: AuthenticatedUserContext,
  current: { id: string; revision: string; successor: string | null },
) {
  const actor = member(context);
  const taskGate = salesGate(context, true, 'update');
  return current.successor
    ? (
        await db.batch<{ taskId: string; dueAt: string }>([
          db
            .prepare(
              `SELECT t.id taskId,t.due_at dueAt FROM sales_cases s ${authorityJoins}
      JOIN tasks t ON t.agency_id=s.agency_id AND t.id=s.active_task_id AND t.customer_id=s.customer_id
      JOIN sales_case_tasks l ON l.agency_id=s.agency_id AND l.case_id=s.id AND l.task_id=t.id AND l.purpose='NEXT_CYCLE'
      WHERE s.agency_id=? AND s.id=? AND s.predecessor_case_id=? AND s.origin_result_revision_id=?
      AND s.result='OPEN' AND s.version=1 AND t.status='OPEN' AND t.version=1 AND t.kind='GENERAL'
      AND t.assignee_membership_id=m.id AND ${taskGate.sql}`,
            )
            .bind(
              actor.agencyId,
              current.successor,
              current.id,
              current.revision,
              ...taskGate.args,
            ),
        ])
      )[0]!.results[0]
    : null;
}

export async function readCycleActionContext(
  db: D1Database,
  context: AuthenticatedUserContext,
  row: RenewalTaskRow,
  mode: 'close' | 'reopen',
) {
  const actor = member(context);
  const candidate = await db
    .prepare('SELECT id FROM sales_cases WHERE agency_id=? AND renewal_id=?')
    .bind(actor.agencyId, row.renewal_id)
    .first<{ id: string }>();
  if (!candidate) return null;
  const gate = salesGate(context, true, mode === 'close' ? 'update' : false, true);
  const taskJoin =
    mode === 'close'
      ? "JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.id=? AND t.status='OPEN' AND t.version=?"
      : '';
  const args = mode === 'close' ? [row.task_id, row.task_version] : [];
  const saved = (
    await db.batch<{
      id: string;
      version: number;
      revision: string | null;
      successor: string | null;
      canCreate: number;
    }>([
      db
        .prepare(
          `SELECT s.id,s.version,v.id revision,v.followup_case_id successor,
 CASE WHEN b.status='ACTIVE' AND (m.type='OWNER' OR EXISTS(SELECT 1 FROM membership_permissions x WHERE x.membership_id=m.id AND x.permission_code='task.create' AND x.scope='UNSCOPED')) THEN 1 ELSE 0 END canCreate
 FROM sales_cases s ${authorityJoins}
 JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id ${taskJoin}
 LEFT JOIN sales_case_result_revisions v ON v.agency_id=s.agency_id AND v.case_id=s.id AND v.id=s.current_result_id
 WHERE s.agency_id=? AND s.id=? AND r.version=? AND ${gate.sql}`,
        )
        .bind(...args, actor.agencyId, candidate.id, row.renewal_version, ...gate.args),
    ])
  )[0]!.results[0];
  if (!saved) throw new RenewalCommandError('NOT_FOUND', 404);
  if (mode === 'close') {
    if (saved.revision) throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);
    return {
      caseId: saved.id,
      expectedCaseVersion: saved.version,
      canCreateFollowup: saved.canCreate === 1,
    };
  }
  if (!saved.revision) return null;
  const task = await recallableTask(db, context, { ...saved, revision: saved.revision });
  return {
    caseId: saved.id,
    expectedCaseVersion: saved.version,
    resultRevisionId: saved.revision,
    successorCaseId: task ? saved.successor : null,
    successorDueAt: task?.dueAt ?? null,
    canRecall: !saved.successor || !!task,
  };
}

export async function prepareCycleRecall(
  db: D1Database,
  context: AuthenticatedUserContext,
  row: RenewalTaskRow,
  input: ReopenRenewalInput,
  reopenedAt: string,
  receiptId: string,
) {
  const actor = member(context);
  const current = await db
    .prepare(
      `SELECT s.id,s.version,v.id revision,v.followup_case_id successor
    FROM sales_cases s JOIN sales_case_result_revisions v ON v.agency_id=s.agency_id AND v.case_id=s.id AND v.id=s.current_result_id
    WHERE s.agency_id=? AND s.renewal_id=?`,
    )
    .bind(actor.agencyId, row.renewal_id)
    .first<{ id: string; version: number; revision: string; successor: string | null }>();
  const expected = input.salesCycle;
  if (!current && !expected) return null;
  if (!expected || !current) throw new RenewalCommandError('SALES_CYCLE_REOPEN_REQUIRED', 409);
  if (
    current.id !== expected.caseId ||
    current.version !== expected.expectedCaseVersion ||
    current.revision !== expected.resultRevisionId ||
    current.successor !== expected.successorCaseId
  )
    throw new RenewalCommandError('OPTIMISTIC_CONCURRENCY_CONFLICT', 409);

  const sourceGate = salesGate(context, true, false, true);
  const sourceProof = db
    .prepare(
      `SELECT s.id FROM sales_cases s ${authorityJoins}
    JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id WHERE s.agency_id=? AND s.id=? AND ${sourceGate.sql}`,
    )
    .bind(actor.agencyId, current.id, ...sourceGate.args);
  if (!(await db.batch([sourceProof]))[0]!.results.length)
    throw new RenewalCommandError('FORBIDDEN', 403);

  const successor = await recallableTask(db, context, current);
  const taskGate = salesGate(context, true, 'update');
  if (current.successor && !successor)
    throw new RenewalCommandError('SALES_CYCLE_SUCCESSOR_UNAVAILABLE', 409);

  const result: CycleRecall = { ...expected, successorTaskId: successor?.taskId ?? null };
  const changed = () =>
    db
      .prepare('INSERT INTO d1_cas_assertions(id,expected,actual) VALUES(?,1,changes())')
      .bind(crypto.randomUUID());
  const history = (caseId: string, version: number, event: string, taskId: string) =>
    db
      .prepare(
        'INSERT INTO sales_case_history(id,agency_id,case_id,case_version,event_code,task_id,actor_user_id,actor_membership_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        actor.agencyId,
        caseId,
        version,
        event,
        taskId,
        context.userId,
        actor.id,
        receiptId,
        reopenedAt,
      );
  const statements: D1PreparedStatement[] = [];
  if (successor && current.successor) {
    statements.push(
      db
        .prepare(
          `UPDATE sales_cases SET result='VOIDED',active_task_id=NULL,version=2,updated_at=?
        WHERE agency_id=? AND id=? AND version=1 AND result='OPEN' AND active_task_id=?
        AND EXISTS(SELECT 1 FROM sales_cases s ${authorityJoins}
          JOIN tasks t ON t.agency_id=s.agency_id AND t.id=s.active_task_id
          WHERE s.id=sales_cases.id AND t.version=1 AND t.status='OPEN' AND t.assignee_membership_id=m.id AND ${taskGate.sql})`,
        )
        .bind(reopenedAt, actor.agencyId, current.successor, successor.taskId, ...taskGate.args),
      changed(),
      db
        .prepare(
          `UPDATE tasks SET status='COMPLETED',version=2,updated_at=?,completed_at=?,completed_by_membership_id=?
        WHERE agency_id=? AND id=? AND version=1 AND kind='GENERAL' AND status='OPEN' AND assignee_membership_id=?`,
        )
        .bind(reopenedAt, reopenedAt, actor.id, actor.agencyId, successor.taskId, actor.id),
      changed(),
      history(current.successor, 2, 'NEXT_CYCLE_RECALLED', successor.taskId),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE sales_cases SET current_result_id=NULL,version=version+1,updated_at=?
      WHERE agency_id=? AND id=? AND version=? AND current_result_id=?
      AND EXISTS(SELECT 1 FROM sales_cases s ${authorityJoins} JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id WHERE s.id=sales_cases.id AND ${sourceGate.sql})`,
      )
      .bind(
        reopenedAt,
        actor.agencyId,
        current.id,
        current.version,
        current.revision,
        ...sourceGate.args,
      ),
    changed(),
    history(current.id, current.version + 1, 'LOSS_REOPENED', row.task_id),
  );
  return { result, statements };
}

export async function assertCycleRecallReplay(
  db: D1Database,
  context: AuthenticatedUserContext,
  result: RenewalReopenResult,
  key: string,
) {
  const cycle = result.salesCycle;
  if (!cycle) return;
  const actor = member(context),
    sourceGate = salesGate(context, true, false, true);
  const source = (
    await db.batch<{ id: string }>([
      db
        .prepare(
          `SELECT o.id FROM sales_cases s ${authorityJoins}
    JOIN renewal_opportunities r ON r.agency_id=s.agency_id AND r.id=s.renewal_id
    JOIN sales_case_result_revisions v ON v.agency_id=s.agency_id AND v.case_id=s.id AND v.id=?
    JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.case_version=? AND h.event_code='LOSS_REOPENED'
    JOIN operation_receipts o ON o.id=h.receipt_id AND o.agency_id=s.agency_id AND o.action='renewal.reopen'
    WHERE s.agency_id=? AND s.id=? AND s.renewal_id=? AND v.task_id=? AND h.task_id=v.task_id AND h.created_at=?
    AND o.actor_user_id=? AND o.actor_membership_id=? AND o.idempotency_key=? AND v.followup_case_id IS ? AND ${sourceGate.sql}`,
        )
        .bind(
          cycle.resultRevisionId,
          cycle.expectedCaseVersion + 1,
          actor.agencyId,
          cycle.caseId,
          result.renewalId,
          result.closedTaskId,
          result.reopenedAt,
          context.userId,
          actor.id,
          key,
          cycle.successorCaseId,
          ...sourceGate.args,
        ),
    ])
  )[0]!.results;
  if (source.length !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  if (cycle.successorCaseId) {
    const taskGate = salesGate(context, true, 'update');
    const child = (
      await db.batch([
        db
          .prepare(
            `SELECT 1 FROM sales_cases s ${authorityJoins}
      JOIN sales_case_history h ON h.agency_id=s.agency_id AND h.case_id=s.id AND h.event_code='NEXT_CYCLE_RECALLED' AND h.case_version=2
      JOIN tasks t ON t.agency_id=s.agency_id AND t.id=h.task_id AND t.customer_id=s.customer_id AND t.kind='GENERAL'
      WHERE s.agency_id=? AND s.id=? AND s.origin_result_revision_id=? AND s.result='VOIDED'
      AND h.receipt_id=? AND t.id=? AND t.status='COMPLETED' AND t.completed_at=? AND t.completed_by_membership_id=? AND t.assignee_membership_id=m.id AND ${taskGate.sql}`,
          )
          .bind(
            actor.agencyId,
            cycle.successorCaseId,
            cycle.resultRevisionId,
            source[0]!.id,
            cycle.successorTaskId,
            result.reopenedAt,
            actor.id,
            ...taskGate.args,
          ),
      ])
    )[0]!.results;
    if (child.length !== 1) throw new RenewalCommandError('REPLAY_NOT_AUTHORIZED', 404);
  }
}

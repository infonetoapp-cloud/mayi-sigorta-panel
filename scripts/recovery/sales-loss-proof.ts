import { closeRenewalLostSchema, reopenRenewalSchema } from '../../src/server/renewals/validation';
import {
  salesLossReceiptSchema,
  salesLossCommandSchema,
  salesLossResultSchema,
} from '../../src/shared/sales-loss';
import { computePayloadHash } from '../../src/server/mutations/canonical';
import { verifySalesReopenRecovery } from './sales-reopen-proof';
type Row = Record<string, unknown>;
/** Restored history must prove both sides of the single close/successor command. */
export async function verifySalesLossRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  try {
    const manual = await verifySalesReopenRecovery(query);
    const results = await query('SELECT * FROM sales_case_result_revisions'),
      cases = await query('SELECT * FROM sales_cases'),
      tasks = await query('SELECT * FROM tasks'),
      links = await query('SELECT * FROM sales_case_tasks'),
      history = await query('SELECT * FROM sales_case_history'),
      reasons = await query('SELECT * FROM loss_reasons'),
      members = await query('SELECT id,agency_id,user_id FROM agency_memberships'),
      branches = await query('SELECT * FROM insurance_branches'),
      renewals = await query('SELECT * FROM renewal_opportunities'),
      renewalHistory = await query('SELECT * FROM renewal_state_history'),
      renewalAudits = await query(
        "SELECT * FROM audit_events WHERE action='renewal.closed_lost' AND outcome='SUCCESS'",
      ),
      receipts = await query(
        "SELECT * FROM operation_receipts WHERE action='sales.case.close_lost' OR (action='renewal.close_lost' AND json_type(response_body,'$.salesCycle')='object')",
      ),
      audits = await query(
        "SELECT * FROM audit_events WHERE action IN ('sales.case.close_lost','sales.renewal.close_lost_cycle') AND outcome='SUCCESS'",
      );
    const recallReceipts = await query(
        "SELECT * FROM operation_receipts WHERE action='renewal.reopen' AND json_type(response_body,'$.salesCycle')='object'",
      ),
      reopenAudits = await query(
        "SELECT * FROM audit_events WHERE action='renewal.reopened' AND outcome='SUCCESS'",
      );
    const recalls = new Map<unknown, unknown>(),
      recalledChildren = new Set<unknown>();
    for (const receipt of recallReceipts) {
      const body = JSON.parse(String(receipt.response_body)),
        cycle = body.salesCycle;
      const input = reopenRenewalSchema.parse(body.cycleCommand);
      const expected = input.salesCycle;
      if (
        !expected ||
        Object.keys(cycle).length !== 5 ||
        cycle.caseId !== expected.caseId ||
        cycle.expectedCaseVersion !== expected.expectedCaseVersion ||
        cycle.resultRevisionId !== expected.resultRevisionId ||
        cycle.successorCaseId !== expected.successorCaseId ||
        body.renewalVersion !== input.expectedRenewalVersion + 1 ||
        body.closedTaskVersion !== input.expectedTaskVersion ||
        body.taskVersion !== 1 ||
        receipt.payload_fingerprint !==
          (await computePayloadHash({
            action: 'renewal.reopen',
            target: body.renewalId,
            payload: input,
            version: {
              expectedRenewalVersion: input.expectedRenewalVersion,
              expectedTaskVersion: input.expectedTaskVersion,
            },
          }))
      )
        reject();
      const revision = results.find(
        (v) => v.agency_id === receipt.agency_id && v.id === cycle.resultRevisionId,
      );
      const source = cases.find(
        (s) =>
          s.agency_id === receipt.agency_id &&
          s.id === cycle.caseId &&
          s.renewal_id === body.renewalId &&
          s.context_kind === 'RENEWAL',
      );
      const events = history.filter(
        (h) => h.agency_id === receipt.agency_id && h.receipt_id === receipt.id,
      );
      const sourceEvent = events.find(
        (h) => h.case_id === cycle.caseId && h.event_code === 'LOSS_REOPENED',
      );
      const closedTask = tasks.find(
        (t) => t.agency_id === receipt.agency_id && t.id === body.closedTaskId,
      );
      const newTask = tasks.find(
        (t) => t.agency_id === receipt.agency_id && t.id === body.primaryTaskId,
      );
      const reopen = renewalHistory.find(
        (h) =>
          h.agency_id === receipt.agency_id &&
          h.renewal_id === body.renewalId &&
          h.created_at === body.reopenedAt &&
          h.actor_user_id === receipt.actor_user_id &&
          h.actor_membership_id === receipt.actor_membership_id &&
          h.from_state === 'LOST' &&
          h.to_state === body.state &&
          h.reason_code === 'REOPEN',
      );
      const audit = reopenAudits.find(
        (a) =>
          a.agency_id === receipt.agency_id &&
          a.target_id === body.renewalId &&
          a.idempotency_key === receipt.idempotency_key &&
          a.actor_user_id === receipt.actor_user_id &&
          a.actor_membership_id === receipt.actor_membership_id &&
          a.created_at === body.reopenedAt &&
          JSON.parse(String(a.metadata_json)).referenceId === body.primaryTaskId &&
          JSON.parse(String(a.metadata_json)).reasonCode === input.reopenReasonCode,
      );
      if (
        !revision ||
        !source ||
        !sourceEvent ||
        !closedTask ||
        !newTask ||
        !reopen ||
        !audit ||
        recalls.has(revision.id) ||
        receipt.status !== 'COMPLETED' ||
        receipt.response_status !== 200 ||
        receipt.created_at !== body.reopenedAt ||
        body.previousState !== 'LOST' ||
        revision.case_id !== source.id ||
        revision.followup_case_id !== cycle.successorCaseId ||
        revision.task_id !== closedTask.id ||
        closedTask.status !== 'COMPLETED' ||
        closedTask.version !== revision.task_version ||
        body.closedTaskVersion !== revision.task_version ||
        closedTask.completed_at !== revision.created_at ||
        body.terminalClosedAt !== revision.created_at ||
        newTask.kind !== 'RENEWAL_FOLLOWUP' ||
        Number(newTask.version) < 1 ||
        (newTask.version === 1 && newTask.due_at !== input.replacementDueAt) ||
        newTask.renewal_id !== source.renewal_id ||
        newTask.customer_id !== source.customer_id ||
        newTask.created_at !== body.reopenedAt ||
        newTask.created_by_user_id !== receipt.actor_user_id ||
        newTask.created_by_membership_id !== receipt.actor_membership_id ||
        sourceEvent.task_id !== revision.task_id ||
        sourceEvent.case_version !== cycle.expectedCaseVersion + 1 ||
        Number(sourceEvent.case_version) <= Number(revision.case_version) ||
        Number(source.version) < Number(sourceEvent.case_version) ||
        source.current_result_id === revision.id ||
        events.some(
          (h) =>
            h.created_at !== body.reopenedAt ||
            h.actor_user_id !== receipt.actor_user_id ||
            h.actor_membership_id !== receipt.actor_membership_id ||
            h.notes !== null ||
            h.reason_code !== null,
        )
      )
        reject();
      if (cycle.successorCaseId) {
        const child = cases.find(
          (s) => s.agency_id === receipt.agency_id && s.id === cycle.successorCaseId,
        );
        const task = tasks.find(
          (t) => t.agency_id === receipt.agency_id && t.id === cycle.successorTaskId,
        );
        const event = events.find(
          (h) => h.case_id === cycle.successorCaseId && h.event_code === 'NEXT_CYCLE_RECALLED',
        );
        if (
          events.length !== 2 ||
          !child ||
          !task ||
          !event ||
          child.result !== 'VOIDED' ||
          child.active_task_id !== null ||
          child.version !== 2 ||
          child.current_result_id !== null ||
          child.origin_result_revision_id !== revision!.id ||
          child.updated_at !== body.reopenedAt ||
          event.case_version !== 2 ||
          event.task_id !== task.id ||
          task.status !== 'COMPLETED' ||
          task.version !== 2 ||
          task.completed_at !== body.reopenedAt ||
          task.completed_by_membership_id !== receipt.actor_membership_id ||
          task.assignee_membership_id !== receipt.actor_membership_id ||
          recalledChildren.has(child.id)
        )
          reject();
        recalledChildren.add(child!.id);
      } else if (events.length !== 1 || cycle.successorTaskId !== null) reject();
      recalls.set(revision!.id, sourceEvent!.id);
    }
    if (
      history.filter((h) => h.event_code === 'LOSS_REOPENED').length !== recalls.size ||
      history.filter((h) => h.event_code === 'NEXT_CYCLE_RECALLED').length !==
        recalledChildren.size ||
      cases.some(
        (s) =>
          s.result === 'VOIDED' &&
          !recalledChildren.has(s.id) &&
          !manual.successors.has(s.id) &&
          !history.some(
            (h) => h.agency_id === s.agency_id && h.case_id === s.id && h.event_code === 'VOIDED',
          ),
      )
    )
      reject();
    const verified = new Set<unknown>(),
      children = new Set<unknown>();
    for (const rev of results) {
      const s = cases.find((s) => s.agency_id === rev.agency_id && s.id === rev.case_id),
        t = tasks.find((t) => t.agency_id === rev.agency_id && t.id === rev.task_id),
        o = receipts.find((o) => o.agency_id === rev.agency_id && o.id === rev.receipt_id),
        reason = reasons.find((l) => l.agency_id === rev.agency_id && l.id === rev.loss_reason_id);
      if (!s || !t || !o || !reason || verified.has(o.id)) reject();
      const raw = JSON.parse(String(o!.response_body)),
        isRenewal = o!.action === 'renewal.close_lost';
      const recalled = isRenewal ? recalls.has(rev.id) : manual.revisions.has(rev.id);
      const main = isRenewal ? closeRenewalLostSchema.parse(raw.cycleCommand) : null;
      const saved = isRenewal
          ? {
              targetId: main!.salesCycle!.caseId,
              result: salesLossResultSchema.parse(raw.salesCycle),
              command: salesLossCommandSchema.parse({
                expectedCaseVersion: main!.salesCycle!.expectedCaseVersion,
                expectedTaskId: main!.expectedPrimaryTaskId,
                expectedTaskVersion: main!.expectedTaskVersion,
                lossReasonId: main!.lossReasonId,
                notes: main!.salesCycle!.notes,
                nextCycle: main!.salesCycle!.nextCycle,
              }),
            }
          : salesLossReceiptSchema.parse(raw),
        c = saved.command,
        r = saved.result;
      if (isRenewal) {
        const rr = renewals.find((rr) => rr.agency_id === s!.agency_id && rr.id === s!.renewal_id);
        const rootHistory = renewalHistory.filter(
          (h) =>
            h.agency_id === s!.agency_id &&
            h.renewal_id === s!.renewal_id &&
            h.created_at === r.closedAt &&
            h.from_state === raw.previousState &&
            h.to_state === 'LOST' &&
            h.actor_user_id === o!.actor_user_id &&
            h.actor_membership_id === o!.actor_membership_id &&
            h.loss_reason_id === c.lossReasonId &&
            h.loss_reason_notes === main!.lossReasonNotes &&
            h.reason_code === 'LOST',
        );
        const rootAudit = renewalAudits.filter(
          (a) =>
            a.agency_id === s!.agency_id &&
            a.target_type === 'renewal_opportunities' &&
            a.target_id === s!.renewal_id &&
            a.actor_user_id === o!.actor_user_id &&
            a.actor_membership_id === o!.actor_membership_id &&
            a.idempotency_key === o!.idempotency_key &&
            a.created_at === r.closedAt &&
            JSON.parse(String(a.metadata_json)).lossReasonId === c.lossReasonId,
        );
        if (
          !rr ||
          !main!.salesCycle ||
          Object.keys(raw).length !== 10 ||
          raw.renewalId !== s!.renewal_id ||
          raw.state !== 'LOST' ||
          (!recalled &&
            (rr!.state !== 'LOST' ||
              rr!.closed_at !== r.closedAt ||
              rr!.closed_by_membership_id !== o!.actor_membership_id)) ||
          raw.closedAt !== r.closedAt ||
          raw.primaryTaskId !== r.taskId ||
          raw.lossReasonId !== c.lossReasonId ||
          raw.renewalVersion !== main!.expectedRenewalVersion + 1 ||
          (recalled
            ? Number(rr.version) <= raw.renewalVersion
            : rr.version !== raw.renewalVersion) ||
          raw.taskVersion !== r.taskVersion ||
          t!.renewal_id !== rr.id ||
          rootHistory.length !== 1 ||
          rootAudit.length !== 1
        )
          reject();
      }
      const expectedFingerprint = isRenewal
        ? await computePayloadHash({
            action: o!.action,
            target: raw.renewalId,
            payload: main,
            version: {
              expectedRenewalVersion: main!.expectedRenewalVersion,
              expectedTaskVersion: main!.expectedTaskVersion,
            },
          })
        : await computePayloadHash({ action: o!.action, targetId: saved.targetId, input: c });
      const hs = history.filter(
          (h) => h.agency_id === s!.agency_id && h.case_id === s!.id && h.receipt_id === o!.id,
        ),
        h = hs[0];
      const proof = audits.filter(
        (a) =>
          a.agency_id === s!.agency_id &&
          a.correlation_id === o!.id &&
          a.action === (isRenewal ? 'sales.renewal.close_lost_cycle' : o!.action) &&
          a.target_type === 'sales_cases' &&
          a.target_id === s!.id &&
          a.actor_user_id === o!.actor_user_id &&
          a.actor_membership_id === o!.actor_membership_id &&
          a.idempotency_key === o!.idempotency_key &&
          a.created_at === r.closedAt,
      );
      if (
        rev.kind !== 'LOST' ||
        rev.result_no !==
          results.filter(
            (v) =>
              v.agency_id === rev.agency_id &&
              v.case_id === rev.case_id &&
              Number(v.case_version) <= Number(rev.case_version),
          ).length ||
        s!.context_kind !== (isRenewal ? 'RENEWAL' : 'NEW_BUSINESS') ||
        (isRenewal ? s!.result !== null : !recalled && s!.result !== 'LOST') ||
        (!recalled && s!.current_result_id !== rev.id) ||
        ((isRenewal || !recalled) && s!.active_task_id !== null) ||
        (isRenewal || recalled
          ? Number(s!.version) < r.caseVersion
          : Number(s!.version) !== r.caseVersion) ||
        rev.case_version !== r.caseVersion ||
        r.caseVersion !== c.expectedCaseVersion + 1 ||
        saved.targetId !== s!.id ||
        r.caseId !== s!.id ||
        r.resultRevisionId !== rev.id ||
        r.operationId !== o!.id ||
        r.taskId !== t!.id ||
        c.expectedTaskId !== t!.id ||
        r.taskVersion !== c.expectedTaskVersion + 1 ||
        rev.task_version !== r.taskVersion ||
        t!.kind !== (isRenewal ? 'RENEWAL_FOLLOWUP' : 'GENERAL') ||
        t!.customer_id !== s!.customer_id ||
        t!.policy_id !== null ||
        (!isRenewal && t!.renewal_id !== null) ||
        t!.status !== 'COMPLETED' ||
        Number(t!.version) < r.taskVersion ||
        t!.completed_at !== r.closedAt ||
        t!.completed_by_membership_id !== rev.actor_membership_id ||
        (!isRenewal &&
          !links.some(
            (l) => l.agency_id === s!.agency_id && l.case_id === s!.id && l.task_id === t!.id,
          )) ||
        c.lossReasonId !== rev.loss_reason_id ||
        c.notes !== rev.notes ||
        rev.created_at !== r.closedAt ||
        rev.actor_user_id !== o!.actor_user_id ||
        rev.actor_membership_id !== o!.actor_membership_id ||
        !members.some(
          (m) =>
            m.agency_id === s!.agency_id &&
            m.id === rev.actor_membership_id &&
            m.user_id === rev.actor_user_id,
        ) ||
        o!.status !== 'COMPLETED' ||
        o!.response_status !== 200 ||
        o!.created_at !== r.closedAt ||
        hs.length !== 1 ||
        !h ||
        h.event_code !== 'LOST' ||
        h.case_version !== r.caseVersion ||
        h.task_id !== t!.id ||
        h.reason_code !== reason!.code ||
        h.notes !== rev.notes ||
        h.created_at !== r.closedAt ||
        h.actor_user_id !== rev.actor_user_id ||
        h.actor_membership_id !== rev.actor_membership_id ||
        proof.length !== 1 ||
        JSON.parse(String(proof[0]!.metadata_json)).responseHash !==
          (await computePayloadHash(r)) ||
        o!.payload_fingerprint !== expectedFingerprint
      )
        reject();
      if (c.nextCycle.mode === 'FOLLOW_UP') {
        const next = c.nextCycle,
          f = r.followup;
        if (
          !f ||
          rev.followup_case_id !== f.caseId ||
          rev.exception_code !== null ||
          children.has(f.caseId) ||
          f.dueAt !== next.dueAt ||
          f.cycleDate !== next.cycleDate ||
          f.dateBasis !== next.dateBasis ||
          next.dueAt <= r.closedAt ||
          (next.cycleDate &&
            (next.cycleDate <
              new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(
                new Date(r.closedAt),
              ) ||
              (s!.cycle_date && next.cycleDate <= String(s!.cycle_date))))
        )
          reject();
        const child = cases.find((x) => x.agency_id === s!.agency_id && x.id === f!.caseId),
          task = tasks.find((t) => t.agency_id === s!.agency_id && t.id === f!.taskId),
          branch = branches.find((b) => b.agency_id === s!.agency_id && b.id === s!.branch_id),
          ch = history.filter(
            (h) => h.agency_id === s!.agency_id && h.case_id === f!.caseId && h.case_version === 1,
          ),
          l = links.filter(
            (l) =>
              l.agency_id === s!.agency_id && l.case_id === f!.caseId && l.task_id === f!.taskId,
          );
        if (
          !child ||
          !task ||
          !branch ||
          child.predecessor_case_id !== s!.id ||
          child.origin_result_revision_id !== rev.id ||
          child.customer_id !== s!.customer_id ||
          child.branch_id !== s!.branch_id ||
          child.context_kind !== 'NEW_BUSINESS' ||
          (s!.data_classification === 'HEALTH' && child.data_classification !== 'HEALTH') ||
          !['GENERAL', 'HEALTH'].includes(String(child.data_classification)) ||
          child.cycle_date !== next.cycleDate ||
          child.date_basis !== next.dateBasis ||
          child.created_at !== r.closedAt ||
          child.created_by_user_id !== rev.actor_user_id ||
          child.created_by_membership_id !== rev.actor_membership_id ||
          task.kind !== 'GENERAL' ||
          task.customer_id !== s!.customer_id ||
          task.policy_id !== null ||
          task.renewal_id !== null ||
          task.created_at !== r.closedAt ||
          task.created_by_user_id !== rev.actor_user_id ||
          task.created_by_membership_id !== rev.actor_membership_id ||
          Number(task.version) < 1 ||
          (task.version === 1 &&
            (task.due_at !== next.dueAt ||
              task.assignee_membership_id !== rev.actor_membership_id)) ||
          ch.length !== 1 ||
          ch[0]!.event_code !== 'CREATED_NEXT_CYCLE' ||
          ch[0]!.receipt_id !== o!.id ||
          ch[0]!.task_id !== task.id ||
          ch[0]!.notes !== null ||
          ch[0]!.reason_code !== null ||
          ch[0]!.created_at !== r.closedAt ||
          ch[0]!.actor_user_id !== rev.actor_user_id ||
          ch[0]!.actor_membership_id !== rev.actor_membership_id ||
          l.length !== 1 ||
          l[0]!.purpose !== 'NEXT_CYCLE' ||
          l[0]!.created_at !== r.closedAt
        )
          reject();
        children.add(f!.caseId);
      } else if (
        r.followup !== null ||
        rev.followup_case_id !== null ||
        rev.exception_code !== c.nextCycle.exceptionCode ||
        !c.notes
      )
        reject();
      verified.add(o!.id);
    }
    if (
      verified.size !== receipts.length ||
      audits.length !== receipts.length ||
      history.filter((h) => h.event_code === 'LOST').length !== results.length ||
      history.filter((h) => h.event_code === 'CREATED_NEXT_CYCLE').length !== children.size ||
      cases.some(
        (s) =>
          (s.predecessor_case_id != null || s.origin_result_revision_id != null) &&
          !children.has(s.id),
      ) ||
      cases.some(
        (s) =>
          s.context_kind === 'RENEWAL' &&
          s.current_result_id != null &&
          !results.some(
            (r) =>
              r.agency_id === s.agency_id && r.case_id === s.id && r.id === s.current_result_id,
          ),
      ) ||
      cases.some(
        (s) =>
          s.context_kind === 'NEW_BUSINESS' &&
          (s.result === 'LOST'
            ? !results.some(
                (r) =>
                  r.agency_id === s.agency_id && r.case_id === s.id && r.id === s.current_result_id,
              )
            : s.current_result_id != null),
      )
    )
      reject();
  } catch {
    reject();
  }
}

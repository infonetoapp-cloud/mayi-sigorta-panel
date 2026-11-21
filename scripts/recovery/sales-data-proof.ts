import {
  salesReceiptSchema,
  salesCreateSchema,
  salesFollowupSchema,
  salesAdoptSchema,
} from '../../src/shared/sales';
import { computePayloadHash } from '../../src/server/mutations/canonical';
type Row = Record<string, unknown>;
export async function verifySalesRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  const cases = await query('SELECT * FROM sales_cases'),
    links = await query('SELECT * FROM sales_case_tasks'),
    history = await query('SELECT * FROM sales_case_history'),
    tasks = await query('SELECT * FROM tasks'),
    renewals = await query('SELECT * FROM renewal_opportunities'),
    policies = await query('SELECT * FROM policies'),
    branches = await query('SELECT * FROM insurance_branches'),
    members = await query('SELECT id,agency_id,user_id FROM agency_memberships'),
    results = await query('SELECT * FROM sales_case_result_revisions');
  const receipts = await query(
      "SELECT * FROM operation_receipts WHERE action IN ('sales.case.create','sales.case.followup','sales.case.adopt')",
    ),
    audits = await query(
      "SELECT * FROM audit_events WHERE action IN ('sales.case.create','sales.case.followup','sales.case.adopt') AND outcome='SUCCESS'",
    );
  const verified = new Set<unknown>();
  for (const s of cases) {
    const allHistory = history
      .filter((h) => h.agency_id === s.agency_id && h.case_id === s.id)
      .sort((a, b) => Number(a.case_version) - Number(b.case_version));
    if (
      allHistory.length !== s.version ||
      allHistory.some((h, i) => h.case_version !== i + 1) ||
      allHistory.at(-1)?.created_at !== s.updated_at
    )
      reject();
    if (s.context_kind === 'RENEWAL') {
      const renewal = renewals.find((r) => r.agency_id === s.agency_id && r.id === s.renewal_id),
        policy = policies.find(
          (p) => p.agency_id === s.agency_id && p.id === renewal?.expiring_policy_id,
        ),
        branch = branches.find((b) => b.agency_id === s.agency_id && b.id === s.branch_id),
        ls = links.filter((l) => l.agency_id === s.agency_id && l.case_id === s.id),
        hs = allHistory.filter((h) => h.event_code === 'ADOPTED');
      if (
        !renewal ||
        !policy ||
        !branch ||
        s.result !== null ||
        s.active_task_id !== null ||
        Number(s.version) < 1 ||
        s.source_policy_id !== policy.id ||
        s.customer_id !== policy.customer_id ||
        s.branch_id !== policy.branch_id ||
        !['GENERAL', 'HEALTH'].includes(String(s.data_classification)) ||
        (s.data_classification === 'HEALTH' && branch.data_classification !== 'HEALTH') ||
        ls.length !== 1 ||
        ls[0]!.purpose !== 'ACTIVE_CONTACT' ||
        hs.length !== 1
      )
        reject();
      const h = hs[0]!,
        o = receipts.find((r) => r.id === h.receipt_id && r.agency_id === s.agency_id);
      if (!o || verified.has(o.id)) reject();
      const saved = salesReceiptSchema.parse(JSON.parse(String(o!.response_body))),
        command = salesAdoptSchema.parse(saved.command),
        r = saved.result,
        task = tasks.find(
          (t) => t.agency_id === s.agency_id && t.id === command.expectedPrimaryTaskId,
        );
      if (
        !task ||
        task.kind !== 'RENEWAL_FOLLOWUP' ||
        task.customer_id !== s.customer_id ||
        task.renewal_id !== s.renewal_id ||
        task.policy_id !== null ||
        Number(task.version) < command.expectedPrimaryTaskVersion ||
        Number(renewal!.version) < command.expectedVersion ||
        saved.targetId !== s.customer_id ||
        command.renewalId !== s.renewal_id ||
        r.taskId !== task.id ||
        r.taskVersion !== command.expectedPrimaryTaskVersion ||
        r.caseId !== s.id ||
        r.caseVersion !== 1 ||
        r.operationId !== o!.id ||
        ls[0]!.task_id !== task.id ||
        ls[0]!.created_at !== h.created_at ||
        h.case_version !== 1 ||
        h.event_code !== 'ADOPTED' ||
        h.task_id !== task.id ||
        h.reason_code !== null ||
        h.notes !== null ||
        s.created_at !== h.created_at ||
        s.created_by_user_id !== h.actor_user_id ||
        s.created_by_membership_id !== h.actor_membership_id ||
        o!.action !== 'sales.case.adopt' ||
        o!.status !== 'COMPLETED' ||
        o!.response_status !== 201 ||
        o!.actor_user_id !== h.actor_user_id ||
        o!.actor_membership_id !== h.actor_membership_id ||
        o!.created_at !== h.created_at ||
        !members.some(
          (m) =>
            m.agency_id === s.agency_id &&
            m.id === h.actor_membership_id &&
            m.user_id === h.actor_user_id,
        ) ||
        (await computePayloadHash({
          action: o!.action,
          targetId: saved.targetId,
          input: saved.command,
        })) !== o!.payload_fingerprint
      )
        reject();
      // Admission records the existing Task's historical version/due date. Later
      // renewal reschedule, close or reopen commands remain the sole authority;
      // they may change that Task or create a replacement primary Task.
      const proof = audits.filter(
        (a) =>
          a.agency_id === s.agency_id &&
          a.correlation_id === o!.id &&
          a.target_type === 'sales_cases' &&
          a.target_id === s.id &&
          a.action === o!.action &&
          a.idempotency_key === o!.idempotency_key &&
          a.actor_user_id === h.actor_user_id &&
          a.actor_membership_id === h.actor_membership_id &&
          a.created_at === h.created_at,
      );
      if (
        proof.length !== 1 ||
        JSON.parse(String(proof[0]!.metadata_json)).responseHash !== (await computePayloadHash(r))
      )
        reject();
      verified.add(o!.id);
      continue;
    }
    if (
      s.context_kind !== 'NEW_BUSINESS' ||
      !['OPEN', 'LOST', 'VOIDED', 'WON'].includes(String(s.result)) ||
      !['GENERAL', 'HEALTH'].includes(String(s.data_classification))
    )
      reject();
    const outcome = results.find(
        (r) => r.agency_id === s.agency_id && r.case_id === s.id && r.id === s.current_result_id,
      ),
      successor = s.predecessor_case_id != null,
      task = tasks.find(
        (t) =>
          t.agency_id === s.agency_id &&
          t.id ===
            (s.result === 'LOST'
              ? outcome?.task_id
              : s.result === 'VOIDED'
                ? allHistory.find((h) =>
                    ['VOIDED', 'NEXT_CYCLE_RECALLED', 'CASE_NEXT_CYCLE_RECALLED'].includes(
                      String(h.event_code),
                    ),
                  )?.task_id
                : s.result === 'WON'
                  ? allHistory.find((h) => h.event_code === 'WON' && h.case_version === s.version)
                      ?.task_id
                  : s.active_task_id),
      ),
      ls = links.filter((l) => l.agency_id === s.agency_id && l.case_id === s.id),
      hs = allHistory.filter((h) => h.event_code === 'CREATED' || h.event_code === 'RESCHEDULED');
    const firstTask = allHistory[0]?.task_id;
    const replacements = allHistory.filter((h) =>
      ['CASE_LOSS_REOPENED', 'CASE_WON_CORRECTED'].includes(String(h.event_code)),
    );
    const expectedLinks = new Map<unknown, string>([
      [firstTask, successor ? 'NEXT_CYCLE' : 'ACTIVE_CONTACT'],
    ]);
    for (const replacement of replacements)
      expectedLinks.set(replacement.task_id, 'ACTIVE_CONTACT');
    const checkedTasks = new Map<unknown, Row>();
    for (const link of ls) {
      const linkedTask = tasks.find((t) => t.agency_id === s.agency_id && t.id === link.task_id);
      if (
        !linkedTask ||
        linkedTask.kind !== 'GENERAL' ||
        linkedTask.customer_id !== s.customer_id ||
        linkedTask.policy_id !== null ||
        linkedTask.renewal_id !== null ||
        (linkedTask.id !== task?.id && linkedTask.status !== 'COMPLETED') ||
        link.purpose !== expectedLinks.get(link.task_id)
      )
        reject();
      checkedTasks.set(link.task_id, linkedTask!);
    }
    if (
      !task ||
      task.kind !== 'GENERAL' ||
      task.customer_id !== s.customer_id ||
      task.policy_id !== null ||
      task.renewal_id !== null ||
      task.status !== (s.result === 'OPEN' ? 'OPEN' : 'COMPLETED') ||
      (['LOST', 'WON'].includes(String(s.result)) && s.active_task_id !== null) ||
      (s.result === 'OPEN' && s.current_result_id !== null) ||
      expectedLinks.size !== replacements.length + 1 ||
      checkedTasks.size !== expectedLinks.size ||
      task.id !== (replacements.at(-1)?.task_id ?? firstTask) ||
      (!successor && !hs.length)
    )
      reject();
    const previousTaskVersions = new Map(replacements.map((h) => [h.task_id, 1]));
    previousTaskVersions.set(firstTask, successor ? 1 : 0);
    for (const [index, h] of hs.entries()) {
      const o = receipts.find((r) => r.id === h.receipt_id && r.agency_id === s.agency_id);
      if (!o || verified.has(o.id)) reject();
      const saved = salesReceiptSchema.parse(JSON.parse(String(o!.response_body))),
        r = saved.result,
        creation = !successor && index === 0,
        savedTask = checkedTasks.get(h.task_id);
      if (
        (creation && h.case_version !== 1) ||
        r.caseVersion !== h.case_version ||
        r.caseId !== s.id ||
        !savedTask ||
        r.taskId !== h.task_id ||
        r.operationId !== o!.id ||
        h.event_code !== (creation ? 'CREATED' : 'RESCHEDULED') ||
        o!.action !== (creation ? 'sales.case.create' : 'sales.case.followup') ||
        o!.status !== 'COMPLETED' ||
        o!.response_status !== (creation ? 201 : 200) ||
        o!.actor_user_id !== h.actor_user_id ||
        o!.actor_membership_id !== h.actor_membership_id ||
        o!.created_at !== h.created_at ||
        !members.some(
          (m) =>
            m.agency_id === s.agency_id &&
            m.id === h.actor_membership_id &&
            m.user_id === h.actor_user_id,
        ) ||
        (await computePayloadHash({
          action: o!.action,
          targetId: saved.targetId,
          input: saved.command,
        })) !== o!.payload_fingerprint
      )
        reject();
      if (creation) {
        const c = salesCreateSchema.parse(saved.command);
        if (
          saved.targetId !== s.customer_id ||
          c.branchId !== s.branch_id ||
          c.cycleDate !== s.cycle_date ||
          c.dateBasis !== s.date_basis ||
          c.followup.dueAt !== r.dueAt ||
          r.taskVersion !== 1 ||
          s.created_at !== h.created_at ||
          s.created_by_membership_id !== h.actor_membership_id ||
          s.created_by_user_id !== h.actor_user_id ||
          savedTask!.created_by_membership_id !== h.actor_membership_id ||
          savedTask!.created_by_user_id !== h.actor_user_id
        )
          reject();
      } else {
        const c = salesFollowupSchema.parse(saved.command);
        if (
          saved.targetId !== s.id ||
          c.expectedCaseVersion !== Number(h.case_version) - 1 ||
          c.expectedTaskId !== h.task_id ||
          c.expectedTaskVersion <
            (previousTaskVersions.get(h.task_id) ?? Number.MAX_SAFE_INTEGER) ||
          r.taskVersion !== c.expectedTaskVersion + 1 ||
          r.dueAt !== c.dueAt ||
          h.reason_code !== c.reasonCode ||
          h.notes !== c.notes
        )
          reject();
      }
      if (
        !hs.slice(index + 1).some((later) => later.task_id === h.task_id) &&
        (savedTask!.due_at !== r.dueAt || Number(savedTask!.version) < r.taskVersion)
      )
        reject();
      const proof = audits.filter(
        (a) =>
          a.agency_id === s.agency_id &&
          a.correlation_id === o!.id &&
          a.target_type === 'sales_cases' &&
          a.target_id === s.id &&
          a.action === o!.action &&
          a.idempotency_key === o!.idempotency_key &&
          a.actor_user_id === h.actor_user_id &&
          a.actor_membership_id === h.actor_membership_id &&
          a.created_at === h.created_at,
      );
      if (
        proof.length !== 1 ||
        JSON.parse(String(proof[0]!.metadata_json)).responseHash !== (await computePayloadHash(r))
      )
        reject();
      verified.add(o!.id);
      previousTaskVersions.set(h.task_id, r.taskVersion);
    }
  }
  if (
    verified.size !== receipts.length ||
    audits.length !== receipts.length ||
    history.filter((h) => ['CREATED', 'RESCHEDULED', 'ADOPTED'].includes(String(h.event_code)))
      .length !== receipts.length ||
    history.some(
      (h) =>
        ![
          'CREATED',
          'RESCHEDULED',
          'ADOPTED',
          'PRICE_CREATED',
          'PRICE_REVISED',
          'PRICE_SHARED',
          'PRICE_ACCEPTED',
          'PRICE_ACCEPTANCE_REVOKED',
          'LOST',
          'WON',
          'VOIDED',
          'CREATED_NEXT_CYCLE',
          'LOSS_REOPENED',
          'NEXT_CYCLE_RECALLED',
          'CASE_LOSS_REOPENED',
          'CASE_WON_CORRECTED',
          'CASE_NEXT_CYCLE_RECALLED',
        ].includes(String(h.event_code)),
    )
  )
    reject();
  for (const l of links)
    if (!cases.some((s) => s.id === l.case_id && s.agency_id === l.agency_id)) reject();
}

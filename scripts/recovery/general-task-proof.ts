import {
  generalAssignSchema,
  generalCompleteSchema,
  generalRescheduleSchema,
  generalTaskReceiptSchema,
} from '../../src/shared/task-general';
import { computePayloadHash } from '../../src/server/mutations/canonical';

type Row = Record<string, unknown>;

/** Read-only proof for the three GENERAL commands; old legacy Tasks need no invented receipts. */
export async function verifyGeneralTaskRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
): Promise<void> {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  try {
    const receipts = await query(
        "SELECT * FROM operation_receipts WHERE action IN ('task.general.reschedule','task.general.complete','task.general.assign')",
      ),
      audits = await query(
        "SELECT * FROM audit_events WHERE action IN ('task.general.reschedule','task.general.complete','task.general.assign') AND outcome='SUCCESS'",
      ),
      tasks = await query('SELECT * FROM tasks'),
      members = await query('SELECT id,agency_id,user_id FROM agency_memberships'),
      links = await query('SELECT * FROM sales_case_tasks'),
      customers = await query('SELECT id,agency_id FROM customers'),
      policies = await query('SELECT id,agency_id,customer_id FROM policies');
    const verifiedAudits = new Set<unknown>(),
      versions = new Set<string>(),
      histories = new Map<
        string,
        { receipt: Row; saved: ReturnType<typeof generalTaskReceiptSchema.parse> }[]
      >();
    for (const receipt of receipts) {
      const saved = generalTaskReceiptSchema.parse(JSON.parse(String(receipt.response_body))),
        result = saved.result,
        task = tasks.find((t) => t.agency_id === receipt.agency_id && t.id === result.taskId),
        kind = String(receipt.action).slice('task.general.'.length),
        schema =
          kind === 'reschedule'
            ? generalRescheduleSchema
            : kind === 'complete'
              ? generalCompleteSchema
              : generalAssignSchema,
        command = schema.parse(saved.command),
        key = `${String(receipt.agency_id)}:${result.taskId}`,
        versionKey = `${key}:${result.taskVersion}`;
      if (!task) throw Error('OPERATIONAL_RECOVERY_INVALID');
      if (
        task.kind !== 'GENERAL' ||
        task.renewal_id !== null ||
        !customers.some((c) => c.agency_id === receipt.agency_id && c.id === task.customer_id) ||
        (task.policy_id !== null &&
          !policies.some(
            (p) =>
              p.agency_id === receipt.agency_id &&
              p.id === task.policy_id &&
              p.customer_id === task.customer_id,
          )) ||
        !Number.isSafeInteger(task.version) ||
        Number(task.version) < result.taskVersion ||
        saved.targetId !== task.id ||
        result.operationId !== receipt.id ||
        result.taskVersion !== command.expectedTaskVersion + 1 ||
        receipt.status !== 'COMPLETED' ||
        receipt.response_status !== 200 ||
        !members.some(
          (m) =>
            m.agency_id === receipt.agency_id &&
            m.id === receipt.actor_membership_id &&
            m.user_id === receipt.actor_user_id,
        ) ||
        (result.assigneeMembershipId !== null &&
          !members.some(
            (m) => m.agency_id === receipt.agency_id && m.id === result.assigneeMembershipId,
          )) ||
        versions.has(versionKey) ||
        String(task.created_at) > String(receipt.created_at) ||
        String(task.updated_at) < String(receipt.created_at) ||
        (kind !== 'assign' &&
          links.some((l) => l.agency_id === receipt.agency_id && l.task_id === task.id)) ||
        result.status !== (kind === 'complete' ? 'COMPLETED' : 'OPEN') ||
        (kind === 'reschedule' && result.dueAt !== generalRescheduleSchema.parse(command).dueAt) ||
        (kind === 'assign' &&
          result.assigneeMembershipId !==
            generalAssignSchema.parse(command).assigneeMembershipId) ||
        (await computePayloadHash({
          action: receipt.action,
          targetId: saved.targetId,
          input: saved.command,
        })) !== receipt.payload_fingerprint
      )
        reject();
      if (
        result.taskVersion === task.version &&
        (task.status !== result.status ||
          task.due_at !== result.dueAt ||
          task.assignee_membership_id !== result.assigneeMembershipId)
      )
        reject();
      if (
        kind === 'complete' &&
        (task.status !== 'COMPLETED' ||
          task.completed_at !== receipt.created_at ||
          task.completed_by_membership_id !== receipt.actor_membership_id)
      )
        reject();
      const proof = audits.filter(
        (a) =>
          a.agency_id === receipt.agency_id &&
          a.action === receipt.action &&
          a.target_type === 'tasks' &&
          a.target_id === task.id &&
          a.correlation_id === receipt.id &&
          a.idempotency_key === receipt.idempotency_key &&
          a.actor_user_id === receipt.actor_user_id &&
          a.actor_membership_id === receipt.actor_membership_id &&
          a.created_at === receipt.created_at,
      );
      if (
        proof.length !== 1 ||
        verifiedAudits.has(proof[0]!.id) ||
        JSON.parse(String(proof[0]!.metadata_json)).reasonCode !== command.reasonCode ||
        JSON.parse(String(proof[0]!.metadata_json)).targetVersion !== result.taskVersion ||
        JSON.parse(String(proof[0]!.metadata_json)).responseHash !==
          (await computePayloadHash(result))
      )
        reject();
      verifiedAudits.add(proof[0]!.id);
      versions.add(versionKey);
      const history = histories.get(key) ?? [];
      history.push({ receipt, saved });
      histories.set(key, history);
    }
    if (verifiedAudits.size !== audits.length || audits.length !== receipts.length) reject();
    for (const history of histories.values()) {
      history.sort((a, b) => a.saved.result.taskVersion - b.saved.result.taskVersion);
      for (let i = 1; i < history.length; i++) {
        const previous = history[i - 1]!,
          current = history[i]!;
        if (
          String(previous.receipt.created_at) > String(current.receipt.created_at) ||
          previous.saved.result.status === 'COMPLETED'
        )
          reject();
        // Case followup/other existing commands may legitimately occupy intervening versions.
        if (current.saved.command.expectedTaskVersion !== previous.saved.result.taskVersion)
          continue;
        if (
          current.receipt.action !== 'task.general.reschedule' &&
          current.saved.result.dueAt !== previous.saved.result.dueAt
        )
          reject();
        if (
          current.receipt.action !== 'task.general.assign' &&
          current.saved.result.assigneeMembershipId !== previous.saved.result.assigneeMembershipId
        )
          reject();
      }
    }
  } catch {
    reject();
  }
}

import {
  policyLifecycleReceiptSchema,
  cancellationReasons,
} from '../../src/shared/policy-cancellation';
import { computePayloadHash } from '../../src/server/mutations/canonical';
type Row = Record<string, unknown>;
/** Imported historical rows precede triggers; verify command evidence independently. */
export async function verifyPolicyLifecycleRecovery(
  query: (sql: string) => readonly Row[] | Promise<readonly Row[]>,
) {
  const reject = (): never => {
    throw Error('OPERATIONAL_RECOVERY_INVALID');
  };
  const events = await query(
    "SELECT *,'CANCELLED' final_status FROM policy_cancellations UNION ALL SELECT *,'VOIDED' FROM policy_void_events",
  );
  const targets = await query('SELECT * FROM policy_lifecycle_targets');
  const receipts = await query(
    "SELECT * FROM operation_receipts WHERE action IN ('policy.cancel','policy.void')",
  );
  const audits = await query(
    "SELECT * FROM audit_events WHERE action IN ('policy.cancel','policy.void') AND outcome='SUCCESS'",
  );
  const policies = await query('SELECT * FROM policies'),
    renewals = await query('SELECT * FROM renewal_opportunities'),
    tasks = await query('SELECT * FROM tasks');
  const states = await query('SELECT * FROM renewal_state_history'),
    losses = await query('SELECT * FROM loss_reasons');
  const memberships = await query('SELECT id,agency_id,user_id FROM agency_memberships');
  const seen = new Set<unknown>();
  for (const event of events) {
    const receipt = receipts.find(
      (r) => r.id === event.receipt_id && r.agency_id === event.agency_id,
    );
    if (!receipt || seen.has(receipt.id)) reject();
    seen.add(receipt!.id);
    const saved = policyLifecycleReceiptSchema.parse(JSON.parse(String(receipt!.response_body))),
      { result: r, command: c } = saved;
    const action = event.final_status === 'CANCELLED' ? 'policy.cancel' : 'policy.void';
    const policy = policies.find(
      (p) => p.agency_id === event.agency_id && p.id === event.policy_id,
    );
    if (
      !policy ||
      policy.status !== event.final_status ||
      Number(policy.version) < r.policyVersion ||
      r.operationId !== receipt!.id ||
      r.eventId !== event.id ||
      r.policyId !== event.policy_id ||
      r.status !== event.final_status ||
      event.before_version !== c.expectedPolicyVersion ||
      event.after_version !== c.expectedPolicyVersion + 1 ||
      r.policyVersion !== event.after_version ||
      receipt!.action !== action ||
      receipt!.status !== 'COMPLETED' ||
      receipt!.response_status !== 200 ||
      receipt!.actor_membership_id !== event.actor_membership_id ||
      receipt!.actor_user_id !== event.actor_user_id ||
      !memberships.some(
        (m) =>
          m.agency_id === event.agency_id &&
          m.id === event.actor_membership_id &&
          m.user_id === event.actor_user_id,
      ) ||
      (await computePayloadHash({ action, policyId: r.policyId, input: c })) !==
        receipt!.payload_fingerprint
    )
      reject();
    if (
      event.event_date !== c.cancellationDate ||
      event.reason_code !== c.reasonCode ||
      event.notes !== c.reasonNotes ||
      !/^\d{4}-\d{2}-\d{2}T/.test(String(event.created_at)) ||
      (c.cancellationDate > String(event.created_at).slice(0, 10) &&
        c.cancellationDate >
          new Date(Date.parse(String(event.created_at)) + 10800000).toISOString().slice(0, 10))
    )
      reject();
    if (
      r.status === 'CANCELLED' &&
      (c.cancellationDate < String(policy!.start_date) ||
        c.cancellationDate > String(policy!.end_date) ||
        !(c.reasonCode in cancellationReasons) ||
        (c.reasonCode === 'OTHER' && !c.reasonNotes))
    )
      reject();
    if (r.status === 'VOIDED' && !['DUPLICATE', 'TECHNICAL_ERROR'].includes(c.reasonCode)) reject();
    const links = targets.filter(
      (t) =>
        t.agency_id === event.agency_id &&
        (r.status === 'CANCELLED' ? t.cancellation_id === event.id : t.void_event_id === event.id),
    );
    if (c.expectedRenewal) {
      const expected = c.expectedRenewal,
        renewal = renewals.find((v) => v.agency_id === event.agency_id && v.id === expected.id),
        task = tasks.find(
          (v) => v.agency_id === event.agency_id && v.id === expected.primaryTaskId,
        );
      if (
        links.length !== 2 ||
        r.closedRenewalId !== expected.id ||
        r.completedTaskId !== expected.primaryTaskId ||
        !links.some(
          (t) =>
            t.renewal_id === expected.id &&
            t.task_id === null &&
            t.before_version === expected.version &&
            t.after_version === expected.version + 1,
        ) ||
        !links.some(
          (t) =>
            t.task_id === expected.primaryTaskId &&
            t.renewal_id === null &&
            t.before_version === expected.taskVersion &&
            t.after_version === expected.taskVersion + 1,
        ) ||
        !renewal ||
        renewal.expiring_policy_id !== r.policyId ||
        renewal.state !== (r.status === 'CANCELLED' ? 'LOST' : 'VOIDED') ||
        renewal.version !== expected.version + 1 ||
        !task ||
        task.renewal_id !== renewal.id ||
        task.kind !== 'RENEWAL_FOLLOWUP' ||
        task.status !== 'COMPLETED' ||
        task.completed_at !== event.created_at ||
        task.completed_by_membership_id !== event.actor_membership_id ||
        renewal.closed_at !== event.created_at ||
        renewal.closed_by_membership_id !== event.actor_membership_id ||
        task.version !== expected.taskVersion + 1
      )
        reject();
      if (
        !states.some(
          (s) =>
            s.agency_id === event.agency_id &&
            s.renewal_id === expected.id &&
            s.to_state === renewal!.state &&
            s.actor_membership_id === event.actor_membership_id &&
            s.created_at === event.created_at,
        )
      )
        reject();
      if (
        r.status === 'CANCELLED' &&
        (!losses.some(
          (l) =>
            l.agency_id === event.agency_id &&
            l.id === event.loss_reason_id &&
            l.code === c.reasonCode,
        ) ||
          event.loss_reason_id !== c.lossReasonId ||
          renewal!.loss_reason_id !== c.lossReasonId)
      )
        reject();
    } else if (
      links.length ||
      r.closedRenewalId ||
      r.completedTaskId ||
      event.loss_reason_id !== null
    )
      reject();
    const proof = audits.filter(
      (a) =>
        a.agency_id === event.agency_id &&
        a.action === action &&
        a.target_type === 'policies' &&
        a.target_id === r.policyId &&
        a.idempotency_key === receipt!.idempotency_key &&
        a.actor_membership_id === event.actor_membership_id &&
        a.actor_user_id === event.actor_user_id &&
        a.created_at === event.created_at,
    );
    if (
      proof.length !== 1 ||
      JSON.parse(String(proof[0]!.metadata_json)).responseHash !== (await computePayloadHash(r))
    )
      reject();
  }
  if (seen.size !== receipts.length || audits.length !== receipts.length) reject();
  for (const t of targets) {
    if (
      (t.cancellation_id === null) === (t.void_event_id === null) ||
      (t.renewal_id === null) === (t.task_id === null) ||
      !events.some(
        (e) => e.agency_id === t.agency_id && e.id === (t.cancellation_id ?? t.void_event_id),
      )
    )
      reject();
  }
}

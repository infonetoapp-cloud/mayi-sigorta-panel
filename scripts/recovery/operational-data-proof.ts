import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalizePayload } from '../../src/server/mutations/canonical';

// Offline, read-only retrospective checks. Imported triggers protect future writes,
// not historical rows loaded before those triggers. This grants no publication.
type Row = Record<string, unknown>;
type Query = (sql: string) => readonly Row[] | Promise<readonly Row[]>;
const reject = (): never => {
  throw new Error('OPERATIONAL_RECOVERY_INVALID');
};
const dateOnly = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) &&
      new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value,
  );
const instant = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const continuation = z.strictObject({
  through: dateOnly,
  lowerDate: dateOnly,
  upperDate: dateOnly,
  timezone: z.string().min(1).max(128),
  windowDays: z.number().int().min(1).max(120),
  key: z.strictObject({ endDate: dateOnly, policyId: z.string().min(1).max(128) }).nullable(),
});
const cursor = z.strictObject({
  agency_id: z.string().min(1),
  last_successful_local_date: dateOnly.nullable(),
  continuation_json: z.string().max(2048).nullable(),
  last_attempt_order: z.number().int().safe().nonnegative(),
  version: z.number().int().safe().positive(),
  updated_at: z.string().min(1),
});
const note = z.strictObject({
  id: z.string().uuid(),
  content: z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => value.trim() === value && !value.includes('\0')),
  authorName: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim() === value)
    .nullable(),
  createdAt: instant,
});

export async function verifyOperationalRecovery(query: Query): Promise<void> {
  try {
    const notes = await query(`SELECT n.*,m.user_id AS membership_user_id,
      r.agency_id AS receipt_agency,r.actor_user_id AS receipt_user,r.actor_membership_id AS receipt_member,
      r.action AS receipt_action,r.status AS receipt_status,r.response_status,r.response_body,r.created_at AS receipt_created_at,r.payload_fingerprint,
      (SELECT count(*) FROM audit_events a WHERE a.agency_id=n.agency_id AND a.actor_user_id=n.author_user_id
        AND a.actor_membership_id=n.author_membership_id AND a.action='customer.note.created'
        AND a.target_type='customer_notes' AND a.target_id=n.id AND a.idempotency_key=r.idempotency_key
        AND a.outcome='SUCCESS' AND a.created_at=n.created_at
        AND json_extract(a.metadata_json,'$.customerId')=n.customer_id) AS audit_count
      FROM customer_notes n LEFT JOIN agency_memberships m ON m.agency_id=n.agency_id AND m.id=n.author_membership_id
      LEFT JOIN operation_receipts r ON r.id=n.operation_receipt_id`);
    for (const row of notes) {
      note.parse({
        id: row.id,
        content: row.content,
        authorName: row.author_name,
        createdAt: row.created_at,
      });
      const response = z
        .strictObject({ id: z.string().uuid() })
        .parse(JSON.parse(String(row.response_body)));
      const fingerprint = createHash('sha256')
        .update(
          canonicalizePayload({
            action: 'customer.note.create',
            customerId: row.customer_id,
            content: row.content,
          }),
        )
        .digest('hex');
      if (
        row.membership_user_id !== row.author_user_id ||
        row.receipt_agency !== row.agency_id ||
        row.receipt_user !== row.author_user_id ||
        row.receipt_member !== row.author_membership_id ||
        row.receipt_action !== 'customer.note.create' ||
        row.receipt_status !== 'COMPLETED' ||
        row.response_status !== 201 ||
        row.receipt_created_at !== row.created_at ||
        response.id !== row.id ||
        row.payload_fingerprint !== fingerprint ||
        row.audit_count !== 1
      )
        reject();
      // Never compare author_name with today's display name or require active authors:
      // the immutable historical snapshot is protected by the manifest fingerprint.
    }
    if (
      (
        await query(`SELECT r.id FROM operation_receipts r WHERE r.action='customer.note.create'
      AND (SELECT count(*) FROM customer_notes n WHERE n.operation_receipt_id=r.id)<>1
      UNION ALL SELECT a.id FROM audit_events a WHERE a.action='customer.note.created' AND a.outcome='SUCCESS'
      AND NOT EXISTS(SELECT 1 FROM customer_notes n JOIN operation_receipts r ON r.id=n.operation_receipt_id
        WHERE n.id=a.target_id AND n.agency_id=a.agency_id AND a.target_type='customer_notes'
          AND a.actor_user_id=n.author_user_id AND a.actor_membership_id=n.author_membership_id
          AND a.idempotency_key=r.idempotency_key AND a.created_at=n.created_at
          AND json_extract(a.metadata_json,'$.customerId')=n.customer_id) LIMIT 1`)
      ).length
    )
      reject();

    for (const row of await query('SELECT * FROM renewal_generation_cursors')) {
      const saved = cursor.parse(row);
      const normalized = saved.updated_at.includes('T')
        ? saved.updated_at
        : saved.updated_at.replace(' ', 'T') + 'Z';
      if (!Number.isFinite(Date.parse(normalized))) reject();
      if (saved.continuation_json === null) continue;
      const pending = continuation.parse(JSON.parse(saved.continuation_json));
      const upper = new Date(
        Date.parse(pending.through + 'T00:00:00.000Z') + pending.windowDays * 86400000,
      )
        .toISOString()
        .slice(0, 10);
      new Intl.DateTimeFormat('en-GB', { timeZone: pending.timezone }).format(new Date(0));
      if (
        pending.lowerDate > pending.through ||
        pending.upperDate !== upper ||
        (saved.last_successful_local_date !== null &&
          pending.lowerDate !== saved.last_successful_local_date) ||
        (pending.key &&
          (pending.key.endDate < pending.lowerDate || pending.key.endDate > pending.upperDate))
      )
        reject();
      // A checkpoint key is a scan position, not a frozen policy identity. Policies
      // may move behind it; the generator's final global sweep handles that case.
    }
    if (
      (
        await query(`SELECT a.id FROM system_audit_events a WHERE a.system_actor_code='renewal-generation'
      AND a.action='renewal.generate' AND a.outcome='SUCCESS' AND (a.target_type<>'renewal_opportunities'
        OR a.reason_code<>'POLICY_EXPIRING' OR NOT EXISTS(SELECT 1 FROM renewal_opportunities r
          JOIN renewal_generation_cursors g ON g.agency_id=r.agency_id
          WHERE r.agency_id=a.agency_id AND r.id=a.target_id AND a.idempotency_key=('renewal-policy:'||r.expiring_policy_id))) LIMIT 1`)
      ).length
    )
      reject();
    if (
      (
        await query(`SELECT r.id FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
      WHERE (EXISTS(SELECT 1 FROM renewal_generation_cursors g WHERE g.agency_id=r.agency_id AND g.continuation_json IS NOT NULL)
        OR EXISTS(SELECT 1 FROM system_audit_events a WHERE a.agency_id=r.agency_id AND a.target_id=r.id
          AND a.system_actor_code='renewal-generation' AND a.action='renewal.generate' AND a.outcome='SUCCESS'))
      AND ((SELECT count(*) FROM renewal_state_history h WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id
        AND h.from_state IS NULL AND h.to_state='CONTACT_PENDING' AND h.actor_kind='SYSTEM'
        AND h.actor_user_id IS NULL AND h.actor_membership_id IS NULL AND h.reason_code='POLICY_EXPIRING')<>1
        OR NOT EXISTS(SELECT 1 FROM tasks t WHERE t.agency_id=r.agency_id AND t.renewal_id=r.id
          AND t.customer_id=p.customer_id AND t.kind='RENEWAL_FOLLOWUP' AND t.actor_kind='SYSTEM')
        OR (SELECT count(*) FROM system_audit_events a WHERE a.agency_id=r.agency_id AND a.target_id=r.id
          AND a.system_actor_code='renewal-generation' AND a.action='renewal.generate' AND a.target_type='renewal_opportunities'
          AND a.idempotency_key=('renewal-policy:'||r.expiring_policy_id) AND a.outcome='SUCCESS' AND a.reason_code='POLICY_EXPIRING')<>1) LIMIT 1`)
      ).length
    )
      reject();
  } catch {
    reject();
  }
}

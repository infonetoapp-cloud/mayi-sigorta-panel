export { openDemo, DEMO_USERS } from '../../scripts/demo/application';
import { ensureRenewalForPolicy } from '../../src/server/renewals/generation';
export async function seedQueuePages(db: D1Database) {
  for (const [kind, count] of [
    ['work', 16],
    ['unassigned', 21],
  ] as const)
    for (let n = 0; n < count; n++) {
      const id = `queue-smoke-${kind}-${n}`,
        number = `QUEUE-${kind.toUpperCase()}-${n}`;
      await db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) SELECT ?,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,?,?,?,start_date,end_date,gross_premium_minor,currency FROM policies WHERE id='demo-policy-0'",
        )
        .bind(id, 'demo-member-ahmet', number, number)
        .run();
      await ensureRenewalForPolicy(db, 'demo-agency', id);
      if (kind === 'unassigned')
        await db.batch([
          db
            .prepare(
              'UPDATE tasks SET assignee_membership_id=NULL,version=version+1 WHERE renewal_id IN(SELECT id FROM renewal_opportunities WHERE expiring_policy_id=?)',
            )
            .bind(id),
          db
            .prepare(
              'UPDATE renewal_opportunities SET assignee_membership_id=NULL,version=version+1 WHERE expiring_policy_id=?',
            )
            .bind(id),
        ]);
    }
}

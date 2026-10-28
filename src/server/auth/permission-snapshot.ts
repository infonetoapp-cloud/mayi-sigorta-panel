import { validateMembershipPermissionRows } from './authorization';
/** SQL contains no request text. Its exact detached row set is validated before evaluator awaits. */
export const membershipPermissionSnapshotSql = `SELECT COALESCE(json_group_array(json_object('id',id,'membership_id',membership_id,'permission_code',permission_code,'scope',scope)),'[]') AS snapshot FROM (SELECT id,membership_id,permission_code,scope FROM membership_permissions WHERE membership_id=? ORDER BY id)`;
export async function captureValidatedPermissions(
  db: D1Database,
  membershipId: string,
  type: 'OWNER' | 'MEMBER',
): Promise<string | null> {
  const row = await db
    .prepare(membershipPermissionSnapshotSql)
    .bind(membershipId)
    .first<{ snapshot: string }>();
  if (!row || typeof row.snapshot !== 'string') return null;
  const rows: unknown = JSON.parse(row.snapshot);
  return Array.isArray(rows) && validateMembershipPermissionRows(rows, membershipId, type).success
    ? row.snapshot
    : null;
}

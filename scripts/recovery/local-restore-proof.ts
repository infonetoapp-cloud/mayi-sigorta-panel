import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync, constants, type SQLInputValue } from 'node:sqlite';
import { getPlatformProxy } from 'wrangler';
import { z } from 'zod';
import { canonicalizePayload } from '../../src/server/mutations/canonical';
import { verifyHistoryChain, type RestoreHistoryEdge } from './renewal-history-proof';
import {
  documentBackupObjectKey,
  backupAbortable,
} from '../../src/server/documents/backup-storage';
import { MAX_DOCUMENT_UPLOAD_BYTES } from '../../src/server/documents/validation';
import {
  MAX_DOCUMENT_IMAGE_PIXELS,
  MAX_DOCUMENT_JPEG_PIXELS,
  MAX_DOCUMENT_JPEG_SIDE,
  MAX_DOCUMENT_PDF_PAGES,
  MAX_DOCUMENT_PNG_DECOMPRESSED_BYTES,
  REQUIRED_CONTENT_INSPECTION_VERSION,
} from '../../src/server/documents/content-inspection';
import {
  computeIdentitySearchHash,
  decryptIdentity,
  validateIdentityFormat,
  type IdentityCryptoConfig,
} from '../../src/server/security/identity-crypto';

// Offline recovery harness only. No Worker import, route, live binding, Queue or cutover capability.
export const RESTORE_LIMITS = Object.freeze({
  exportBytes: 8 * 1024 * 1024,
  objects: 100,
  rows: 10000,
  durationMs: 120000,
});
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const key = z
  .string()
  .regex(/^backup\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const objectSchema = z.strictObject({
  copyId: id,
  agencyId: id,
  documentId: id,
  documentVersionId: id,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  objectKey: key,
  sha256: digest,
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_UPLOAD_BYTES),
});
const moneySchema = z.record(
  z.string().regex(/^[A-Z]{3}$/u),
  z.string().regex(/^-?(0|[1-9][0-9]*)$/u),
);
const manifestSchema = z.strictObject({
  format: z.literal('mayi-local-restore-v1'),
  appVersion: z.literal('0.1.0'),
  schemaVersion: z.literal('0019'),
  createdAt: z.iso.datetime({ precision: 3 }),
  bookmark: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  dbExportSha256: digest,
  expectedObjectCount: z.number().int().min(0).max(RESTORE_LIMITS.objects),
  completion: z.literal('COMPLETE'),
  objects: z.array(objectSchema).max(RESTORE_LIMITS.objects),
  rowCounts: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*$/u),
    z.number().int().min(0).max(RESTORE_LIMITS.rows),
  ),
  money: z.strictObject({
    policies: moneySchema,
    amendments: moneySchema,
    allocations: moneySchema,
    quotes: moneySchema,
  }),
});
export type RestoreManifest = z.infer<typeof manifestSchema>;
export interface LocalRestoreInput {
  readonly manifestJson: string;
  readonly exportSql: string;
  // Recovery-only read capability; NOT injected into CRM runtime backup writer.
  readonly backup: Pick<R2Bucket, 'get'>;
  readonly recoveryKeys?: ReadonlyMap<number, IdentityCryptoConfig>;
}
export interface RestoreReport {
  manifestId: string | null;
  appVersion: string | null;
  schemaVersion: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  verdict: 'PASS' | 'FAIL';
  code: string;
  publication: 'SEALED_EXTERNAL_CONTROL_PLANE_PENDING';
  checks: {
    dbHash: boolean;
    schema: boolean;
    rows: boolean;
    foreignKeys: boolean;
    domain: boolean;
    objects: boolean;
    recoveryKeys: boolean;
  };
  rowCounts: Record<string, number>;
  money: RestoreManifest['money'];
  objectCount: number;
  checksums: Array<{
    copyId: string;
    sha256: string;
    sourceVerified: boolean;
    restoredVerified: boolean;
  }>;
}
class RestoreFailure extends Error {}
const fail = (code: string): never => {
  throw new RestoreFailure(code);
};

/** Native local export interleaves table DDL/data in alphabetical order. D1 keeps
 * FK enforcement on, so replay tables/indexes first, then data with deferred FKs,
 * then triggers. SQLite is a syntax/value decoder, not the proof DB. */
function orderedD1Import(exportSql: string): string {
  const staging = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: false,
    allowExtension: false,
  });
  try {
    staging.setAuthorizer((action, arg1, arg2) => {
      if (
        [constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_SELECT].includes(action)
      )
        return constants.SQLITE_DENY;
      if (
        action === constants.SQLITE_PRAGMA &&
        !['foreign_keys', 'defer_foreign_keys'].includes(arg1 ?? '')
      )
        return constants.SQLITE_DENY;
      if (
        action === constants.SQLITE_FUNCTION &&
        ['load_extension', 'readfile', 'writefile'].includes(arg2 ?? '')
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    staging.exec(exportSql);
    staging.setAuthorizer(null);
    const integrity = staging.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok')
      return fail('DB_CONSTRAINT_FAILED');
    const definitions = staging
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name",
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    const sql = ['PRAGMA defer_foreign_keys=ON;'];
    for (const row of definitions.filter((r) => r.type === 'table')) sql.push(`${row.sql};`);
    for (const row of definitions.filter((r) => r.type === 'index')) sql.push(`${row.sql};`);
    let count = 0;
    for (const table of definitions.filter((r) => r.type === 'table')) {
      if (!/^[a-z][a-z0-9_]*$/u.test(table.name)) return fail('SCHEMA_INVALID');
      const n = Number(staging.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get()!.n);
      count += n;
      if (count > RESTORE_LIMITS.rows) return fail('RESOURCE_LIMIT');
      const values = staging.prepare(`SELECT * FROM "${table.name}"`);
      values.setReadBigInts(true);
      for (const row of values.iterate()) {
        const literal = (value: SQLInputValue): string => {
          if (value === null) return 'NULL';
          if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
          if (typeof value === 'bigint' || typeof value === 'number') return String(value);
          return `X'${Buffer.from(value as Uint8Array).toString('hex')}'`;
        };
        sql.push(
          `INSERT INTO "${table.name}" VALUES(${Object.values(row).map(literal).join(',')});`,
        );
      }
    }
    for (const row of definitions.filter((r) => r.type !== 'table' && r.type !== 'index'))
      sql.push(`${row.sql};`);
    const result = sql.join('\n');
    if (Buffer.byteLength(result) > RESTORE_LIMITS.exportBytes) return fail('RESOURCE_LIMIT');
    return result;
  } finally {
    staging.close();
  }
}

export function parseRestoreManifest(json: string): RestoreManifest {
  try {
    if (Buffer.byteLength(json) > 65536) return fail('MANIFEST_INVALID');
    const m = manifestSchema.parse(JSON.parse(json));
    if (m.objects.length !== m.expectedObjectCount) return fail('MANIFEST_INVALID');
    for (const field of ['copyId', 'objectKey'] as const) {
      if (new Set(m.objects.map((o) => o[field])).size !== m.objects.length)
        return fail('MANIFEST_DUPLICATE');
    }
    if (Object.values(m.rowCounts).reduce((a, b) => a + b, 0) > RESTORE_LIMITS.rows)
      return fail('RESOURCE_LIMIT');
    // Reject even exact duplicate version/generation entries; one immutable copy per run.
    if (
      new Set(
        m.objects.map((o) => canonicalizePayload([o.agencyId, o.documentVersionId, o.generation])),
      ).size !== m.objects.length
    )
      return fail('MANIFEST_DUPLICATE');
    m.objects.sort((a, b) => a.objectKey.localeCompare(b.objectKey, 'en'));
    for (const o of m.objects)
      if (documentBackupObjectKey(o) !== o.objectKey) return fail('MANIFEST_OBJECT_IDENTITY');
    return m;
  } catch (error) {
    if (error instanceof RestoreFailure) throw error;
    return fail('MANIFEST_INVALID');
  }
}
export function restoreManifestId(json: string): string {
  return sha(canonicalizePayload(parseRestoreManifest(json)));
}
async function rows<T>(db: D1Database, sql: string): Promise<T[]> {
  const result = await db.prepare(sql).all<T>();
  if (!result.success || result.results.length > RESTORE_LIMITS.rows)
    return fail('DB_QUERY_FAILED');
  return result.results;
}
async function schema(db: D1Database) {
  const definitions = await rows<{ type: string; name: string; tbl_name: string; sql: string }>(
    db,
    `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name`,
  );
  return definitions.map((row) => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sqlHash: sha(row.sql),
  }));
}
export async function collectRestoreExpectations(
  db: D1Database,
): Promise<Pick<RestoreManifest, 'rowCounts' | 'money' | 'objects'>> {
  const tables = await rows<{ name: string }>(
    db,
    `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`,
  );
  const rowCounts: Record<string, number> = {};
  for (const { name } of tables) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) return fail('SCHEMA_INVALID');
    const count = await db.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>();
    rowCounts[name] = count!.n;
  }
  if (Object.values(rowCounts).reduce((a, b) => a + b, 0) > RESTORE_LIMITS.rows)
    return fail('RESOURCE_LIMIT');
  const money: RestoreManifest['money'] = {
    policies: {},
    amendments: {},
    allocations: {},
    quotes: {},
  };
  for (const [kind, sql] of [
    ['policies', 'SELECT currency,CAST(gross_premium_minor AS TEXT) AS amount FROM policies'],
    [
      'amendments',
      'SELECT currency,CAST(premium_difference_minor AS TEXT) AS amount FROM policy_amendments WHERE premium_difference_minor IS NOT NULL',
    ],
    [
      'allocations',
      "SELECT currency,CAST(allocated_new_premium_minor AS TEXT) AS amount FROM renewal_policy_links WHERE status='ACTIVE'",
    ],
    [
      'quotes',
      'SELECT currency,CAST(gross_premium_minor AS TEXT) AS amount FROM renewal_quote_versions',
    ],
  ] as const) {
    for (const row of await rows<{ currency: string; amount: string }>(db, sql)) {
      money[kind][row.currency] = (
        BigInt(money[kind][row.currency] ?? '0') + BigInt(row.amount)
      ).toString();
    }
  }
  const objects = await rows<z.infer<typeof objectSchema>>(
    db,
    `SELECT c.id AS copyId,c.agency_id AS agencyId,v.document_id AS documentId,c.document_version_id AS documentVersionId,j.generation,c.object_key AS objectKey,c.backup_sha256 AS sha256,v.size_bytes AS sizeBytes
    FROM document_backup_copies c JOIN document_versions v ON v.agency_id=c.agency_id AND v.id=c.document_version_id
    JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id
    JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id ORDER BY c.object_key`,
  );
  if (objects.length > RESTORE_LIMITS.objects) return fail('RESOURCE_LIMIT');
  return { rowCounts, money, objects };
}

// Structural metadata must not erase a version's real historical scan provenance.
// Only versions with neither scan jobs nor scan evidence can omit legacy scan proof.
const historicalScanProofRequired = `(v.validation_version IS NULL
  OR EXISTS(SELECT 1 FROM background_jobs history WHERE history.agency_id=v.agency_id
    AND history.document_version_id=v.id AND history.job_type='DOCUMENT_SCAN')
  OR EXISTS(SELECT 1 FROM document_scan_evidence history WHERE history.agency_id=v.agency_id
    AND history.document_version_id=v.id))`;

// Read-only post-import domain checks; imported triggers do not retrospectively validate data.
const domainQueries = [
  `SELECT c.id FROM company_contacts c JOIN customers p ON p.agency_id=c.agency_id AND p.id=c.customer_id WHERE p.type<>'COMPANY' LIMIT 1`,
  `SELECT r.id FROM renewal_opportunities r JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
    WHERE (p.status IN ('CANCELLED','VOIDED') OR p.archived_at IS NOT NULL) AND
      (r.state NOT IN ('WON','LOST','VOIDED') OR EXISTS(SELECT 1 FROM tasks t
        WHERE t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN')) LIMIT 1`,
  `SELECT j.id FROM background_jobs j WHERE j.completed_at IS NOT NULL AND (
    julianday(j.completed_at)<julianday(j.created_at) OR EXISTS(SELECT 1 FROM background_job_runs r
      WHERE r.agency_id=j.agency_id AND r.job_id=j.id AND (r.completed_at IS NULL
        OR julianday(j.completed_at)<julianday(r.completed_at)))) LIMIT 1`,
  `SELECT p.id FROM policies p JOIN insurance_products i ON i.agency_id=p.agency_id AND i.id=p.product_id
    WHERE i.insurer_id<>p.insurer_id OR i.branch_id<>p.branch_id LIMIT 1`,
  `SELECT p.id FROM policies p WHERE NOT EXISTS(SELECT 1 FROM payment_methods m
    WHERE m.agency_id=p.agency_id AND m.id=p.payment_method_id AND
      ((m.supports_installments=0 AND p.installment_count IS NULL) OR
       (m.supports_installments=1 AND p.installment_count IS NOT NULL AND p.installment_count BETWEEN 2 AND m.max_installments))) LIMIT 1`,
  `SELECT t.id FROM tasks t JOIN policies p ON p.agency_id=t.agency_id AND p.id=t.policy_id WHERE t.customer_id<>p.customer_id LIMIT 1`,
  `SELECT t.id FROM tasks t JOIN renewal_opportunities r ON r.agency_id=t.agency_id AND r.id=t.renewal_id
    JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
    WHERE t.customer_id<>p.customer_id OR (t.status='OPEN' AND (t.assignee_membership_id IS NOT r.assignee_membership_id OR r.state IN ('WON','LOST','VOIDED'))) LIMIT 1`,
  `SELECT r.id FROM renewal_opportunities r WHERE (r.state NOT IN ('WON','LOST','VOIDED') AND
    (SELECT count(*) FROM tasks t WHERE t.agency_id=r.agency_id AND t.renewal_id=r.id AND t.kind='RENEWAL_FOLLOWUP' AND t.status='OPEN')<>1)
    OR (SELECT count(*) FROM renewal_state_history h WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id AND h.from_state IS NULL)<>1
    OR NOT EXISTS(SELECT 1 FROM renewal_state_history h WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id AND h.to_state=r.state
      AND h.created_at=(SELECT max(x.created_at) FROM renewal_state_history x WHERE x.agency_id=r.agency_id AND x.renewal_id=r.id)) LIMIT 1`,
  `SELECT r.id FROM renewal_opportunities r WHERE r.state IN ('WON','LOST','VOIDED') AND NOT EXISTS(
    SELECT 1 FROM renewal_state_history h WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id
      AND h.to_state=r.state AND h.from_state IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE')
      AND h.created_at=r.closed_at AND h.actor_membership_id=r.closed_by_membership_id
      AND h.loss_reason_id IS r.loss_reason_id AND h.loss_reason_notes IS r.loss_reason_notes AND h.void_reason_code IS r.void_reason_code
      AND h.created_at=(SELECT max(x.created_at) FROM renewal_state_history x WHERE x.agency_id=r.agency_id AND x.renewal_id=r.id)) LIMIT 1`,
  // WON links retain historical success after later Policy cancellation/archive (plan 6.4).
  // Current Policy usability remains required for allocations on open renewals.
  // SUPERSEDED links retain their immutable currency after later Policy correction.
  `SELECT l.id FROM renewal_policy_links l JOIN renewal_opportunities r ON r.agency_id=l.agency_id AND r.id=l.renewal_id
    JOIN policies p ON p.agency_id=l.agency_id AND p.id=l.new_policy_id
    JOIN policies old ON old.agency_id=r.agency_id AND old.id=r.expiring_policy_id
    JOIN operation_receipts receipt ON receipt.id=l.allocation_operation_id
    WHERE receipt.agency_id<>l.agency_id OR p.id=old.id OR (l.status='ACTIVE' AND l.currency<>p.currency)
      OR (p.customer_id=old.customer_id AND l.different_policyholder_reason_code IS NOT NULL)
      OR (p.customer_id<>old.customer_id AND l.different_policyholder_reason_code IS NULL)
      OR (l.status='ACTIVE' AND (r.state IN ('LOST','VOIDED') OR
        (r.state<>'WON' AND (p.status<>'ACTIVE' OR p.archived_at IS NOT NULL)))) LIMIT 1`,
  `SELECT p.id FROM policies p JOIN renewal_policy_links l ON l.agency_id=p.agency_id AND l.new_policy_id=p.id AND l.status='ACTIVE'
    GROUP BY p.agency_id,p.id HAVING sum(l.allocated_new_premium_minor)>p.gross_premium_minor OR
      (EXISTS(SELECT 1 FROM renewal_policy_links x JOIN renewal_opportunities r ON r.agency_id=x.agency_id AND r.id=x.renewal_id
        WHERE x.agency_id=p.agency_id AND x.new_policy_id=p.id AND x.status='ACTIVE' AND r.state='WON') AND sum(l.allocated_new_premium_minor)<>p.gross_premium_minor) LIMIT 1`,
  `SELECT r.id FROM renewal_opportunities r WHERE r.state='WON' AND NOT EXISTS(SELECT 1 FROM renewal_policy_links l WHERE l.agency_id=r.agency_id AND l.renewal_id=r.id AND l.status='ACTIVE') LIMIT 1`,
  `SELECT l.id FROM renewal_policy_links l WHERE l.supersedes_link_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM renewal_policy_links previous WHERE previous.agency_id=l.agency_id AND previous.id=l.supersedes_link_id
      AND previous.status='SUPERSEDED' AND previous.renewal_id=l.renewal_id AND previous.new_policy_id=l.new_policy_id) LIMIT 1`,
  `WITH RECURSIVE chain(agency,src,dst) AS (
    SELECT agency_id,id,supersedes_link_id FROM renewal_policy_links WHERE supersedes_link_id IS NOT NULL
    UNION SELECT c.agency,c.src,l.supersedes_link_id FROM chain c JOIN renewal_policy_links l
      ON l.agency_id=c.agency AND l.id=c.dst WHERE l.supersedes_link_id IS NOT NULL)
    SELECT src FROM chain WHERE src=dst LIMIT 1`,
  `WITH RECURSIVE edges(agency,src,dst) AS (SELECT l.agency_id,r.expiring_policy_id,l.new_policy_id FROM renewal_policy_links l JOIN renewal_opportunities r ON r.agency_id=l.agency_id AND r.id=l.renewal_id WHERE l.status='ACTIVE'),
    reach(agency,src,dst) AS (SELECT * FROM edges UNION SELECT r.agency,r.src,e.dst FROM reach r JOIN edges e ON e.agency=r.agency AND e.src=r.dst)
    SELECT src FROM reach WHERE src=dst LIMIT 1`,
  `SELECT h.id FROM renewal_state_history h JOIN agency_memberships m ON m.agency_id=h.agency_id AND m.id=h.actor_membership_id WHERE m.user_id<>h.actor_user_id LIMIT 1`,
  `SELECT h.id FROM renewal_state_history h WHERE NOT (
    (h.to_state='LOST' AND h.reason_code='LOST' AND h.loss_reason_id IS NOT NULL AND h.void_reason_code IS NULL
      AND EXISTS(SELECT 1 FROM loss_reasons l WHERE l.agency_id=h.agency_id AND l.id=h.loss_reason_id AND
        ((l.code='OTHER' AND h.loss_reason_notes IS NOT NULL AND length(trim(h.loss_reason_notes)) BETWEEN 1 AND 500)
          OR (l.code<>'OTHER' AND h.loss_reason_notes IS NULL))))
    OR (h.to_state='VOIDED' AND h.void_reason_code IS NOT NULL AND h.reason_code=h.void_reason_code
      AND h.void_reason_code IN ('TECHNICAL_ERROR','DUPLICATE','NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE')
      AND h.loss_reason_id IS NULL AND h.loss_reason_notes IS NULL)
    OR (h.to_state NOT IN ('LOST','VOIDED') AND h.loss_reason_id IS NULL AND h.loss_reason_notes IS NULL AND h.void_reason_code IS NULL)) LIMIT 1`,
  `SELECT a.id FROM audit_events a JOIN agency_memberships m ON m.agency_id=a.agency_id AND m.id=a.actor_membership_id WHERE m.user_id<>a.actor_user_id LIMIT 1`,
  `SELECT d.id FROM documents d JOIN agency_memberships m ON m.agency_id=d.agency_id AND m.id=d.created_by_membership_id WHERE m.user_id<>d.created_by_user_id LIMIT 1`,
  `SELECT v.id FROM document_versions v JOIN agency_memberships m ON m.agency_id=v.agency_id AND m.id=v.created_by_membership_id WHERE m.user_id<>v.created_by_user_id LIMIT 1`,
  `SELECT j.id FROM background_jobs j WHERE j.job_type IN ('DOCUMENT_SCAN','DOCUMENT_BACKUP') AND (
    NOT EXISTS(SELECT 1 FROM document_versions v WHERE v.agency_id=j.agency_id AND v.id=j.document_version_id AND v.sha256=j.input_sha256)
    OR j.generation<>(SELECT count(*) FROM background_jobs prior WHERE prior.agency_id=j.agency_id
      AND prior.job_type=j.job_type AND prior.document_version_id=j.document_version_id AND prior.input_sha256=j.input_sha256 AND prior.generation<=j.generation)
    OR EXISTS(SELECT 1 FROM background_jobs prior WHERE prior.agency_id=j.agency_id AND prior.job_type=j.job_type
      AND prior.document_version_id=j.document_version_id AND prior.input_sha256=j.input_sha256
      AND prior.generation<j.generation AND prior.status IN ('QUEUED','RUNNING','RETRY_WAIT'))) LIMIT 1`,
  `SELECT j.id FROM background_jobs j WHERE j.status='QUEUED' AND j.attempt_count<>0 LIMIT 1`,
  `SELECT r.id FROM background_job_runs r JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
    WHERE julianday(r.started_at)<julianday(j.created_at)
      OR (r.completed_at IS NOT NULL AND julianday(r.completed_at)<julianday(r.started_at))
      OR (r.status='RUNNING' AND (j.status<>'RUNNING' OR r.attempt_number<>j.attempt_count OR r.lease_token_hash<>j.lease_token_hash))
      OR EXISTS(SELECT 1 FROM background_job_runs prior WHERE prior.agency_id=r.agency_id AND prior.job_id=r.job_id
        AND prior.attempt_number<r.attempt_number AND (prior.completed_at IS NULL OR julianday(prior.completed_at)>julianday(r.started_at))) LIMIT 1`,
  `SELECT j.id FROM background_jobs j WHERE j.attempt_count<>(SELECT count(*) FROM background_job_runs r WHERE r.agency_id=j.agency_id AND r.job_id=j.id)
    OR j.attempt_count<>(SELECT coalesce(max(r.attempt_number),0) FROM background_job_runs r WHERE r.agency_id=j.agency_id AND r.job_id=j.id)
    OR (j.status='RUNNING' AND NOT EXISTS(SELECT 1 FROM background_job_runs r WHERE r.agency_id=j.agency_id AND r.job_id=j.id AND r.attempt_number=j.attempt_count AND r.status='RUNNING' AND r.lease_token_hash=j.lease_token_hash)) LIMIT 1`,
  `SELECT j.id FROM background_jobs j WHERE
    (j.status='COMPLETED' AND NOT EXISTS(SELECT 1 FROM background_job_runs r
      WHERE r.agency_id=j.agency_id AND r.job_id=j.id AND r.attempt_number=j.attempt_count AND r.completed_at IS NOT NULL
        AND ((j.job_type='DOCUMENT_SCAN' AND r.status IN ('SUCCEEDED','INFECTED','PERMANENT_ERROR','STALE'))
          OR (j.job_type='DOCUMENT_BACKUP' AND r.status='SUCCEEDED')
          OR (j.job_type IN ('DOCUMENT_RECONCILE','DOCUMENT_RESTORE') AND r.status IN ('SUCCEEDED','PERMANENT_ERROR','STALE')))))
    OR (j.status='DEAD' AND NOT EXISTS(SELECT 1 FROM background_job_runs r
      WHERE r.agency_id=j.agency_id AND r.job_id=j.id AND r.attempt_number=j.attempt_count AND r.status<>'RUNNING' AND r.completed_at IS NOT NULL
        AND (j.attempt_count=j.max_attempts OR (j.job_type='DOCUMENT_BACKUP' AND j.attempt_count>=1 AND r.status='PERMANENT_ERROR'
          AND r.reason_code=j.last_error_code AND r.reason_code IN (
            'BACKUP_IDENTITY_INVALID','BACKUP_INPUT_MISMATCH','BACKUP_OBJECT_IDENTITY_MISMATCH','BACKUP_LENGTH_MISMATCH',
            'BACKUP_CHECKSUM_MISMATCH','BACKUP_SOURCE_IDENTITY_INVALID','BACKUP_SOURCE_METADATA_MISMATCH','BACKUP_SOURCE_LENGTH_MISMATCH',
            'BACKUP_SOURCE_CHECKSUM_MISMATCH','BACKUP_PROOF_MISMATCH','BACKUP_PREREQUISITES_CHANGED')))))
    OR (j.status='RETRY_WAIT' AND (j.attempt_count>=j.max_attempts OR NOT EXISTS(SELECT 1 FROM background_job_runs r WHERE r.agency_id=j.agency_id AND r.job_id=j.id
      AND r.attempt_number=j.attempt_count AND r.status<>'RUNNING' AND r.completed_at IS NOT NULL))) LIMIT 1`,
  // Copies bind generation through their exact run/job; the copy table has no generation column.
  `SELECT j.id FROM background_jobs j JOIN background_job_runs r ON r.agency_id=j.agency_id AND r.job_id=j.id AND r.attempt_number=j.attempt_count
    WHERE j.status='COMPLETED' AND (
      (j.job_type='DOCUMENT_BACKUP' AND NOT EXISTS(SELECT 1 FROM document_backup_copies c WHERE c.agency_id=j.agency_id
        AND c.document_version_id=j.document_version_id AND c.job_run_id=r.id))
      OR (j.job_type='DOCUMENT_SCAN' AND r.status<>'STALE' AND NOT EXISTS(SELECT 1 FROM document_scan_evidence e
        WHERE e.agency_id=j.agency_id AND e.document_version_id=j.document_version_id AND e.job_run_id=r.id))) LIMIT 1`,
  `SELECT v.id FROM document_versions v WHERE v.version_number<>(SELECT count(*) FROM document_versions previous
    WHERE previous.agency_id=v.agency_id AND previous.document_id=v.document_id AND previous.version_number<=v.version_number) LIMIT 1`,
  `SELECT v.id FROM document_versions v WHERE
    (v.validation_version IS NULL AND v.validation_result IS NOT NULL)
    OR (v.validation_version IS NOT NULL AND (v.validation_result IS NULL
      OR v.validation_version<>'m4-content-inspection-v1'
      OR v.status NOT IN ('BACKUP_PENDING','AVAILABLE','SCAN_FAILED','RETIRED'))) LIMIT 1`,
  `SELECT e.id FROM document_scan_evidence e JOIN document_versions v ON v.agency_id=e.agency_id AND v.id=e.document_version_id
    JOIN background_job_runs r ON r.agency_id=e.agency_id AND r.id=e.job_run_id JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
    WHERE e.sha256<>v.sha256 OR j.input_sha256<>v.sha256 OR j.document_version_id<>v.id OR j.job_type<>'DOCUMENT_SCAN'
      OR j.status<>'COMPLETED' OR j.attempt_count<>r.attempt_number OR r.completed_at IS NULL
      OR julianday(e.scanned_at)<julianday(r.started_at) OR julianday(e.scanned_at)>julianday(r.completed_at)
      OR (e.outcome='INFECTED' AND r.status<>'INFECTED')
      OR (e.outcome='INVALID' AND r.status<>'PERMANENT_ERROR')
      OR (e.outcome='ERROR' AND r.status NOT IN ('RETRYABLE_ERROR','PERMANENT_ERROR','STALE'))
      OR (e.outcome='CLEAN' AND (r.status<>'SUCCEEDED' OR e.content_inspection_version<>'m4-content-inspection-v1' OR e.content_inspection_result IS NULL
        OR e.signature_updated_at IS NULL OR julianday(e.signature_updated_at)>julianday(e.scanned_at)
        OR julianday(e.signature_updated_at)<julianday(e.scanned_at,'-48 hours'))) LIMIT 1`,
  `SELECT c.id FROM document_backup_copies c JOIN document_versions v ON v.agency_id=c.agency_id AND v.id=c.document_version_id
    JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
    WHERE c.source_sha256<>v.sha256 OR c.backup_sha256<>v.sha256 OR j.input_sha256<>v.sha256 OR j.document_version_id<>v.id OR j.job_type<>'DOCUMENT_BACKUP'
      OR j.status<>'COMPLETED' OR j.attempt_count<>r.attempt_number OR r.status<>'SUCCEEDED'
      OR julianday(c.created_at)<julianday(j.completed_at) OR julianday(c.created_at)<julianday(r.completed_at)
      OR (${historicalScanProofRequired} AND NOT EXISTS(SELECT 1 FROM document_scan_evidence e JOIN background_job_runs sr ON sr.agency_id=e.agency_id AND sr.id=e.job_run_id
        JOIN background_jobs sj ON sj.agency_id=sr.agency_id AND sj.id=sr.job_id
        WHERE e.agency_id=c.agency_id AND e.document_version_id=v.id AND e.sha256=v.sha256 AND e.outcome='CLEAN' AND sr.status='SUCCEEDED'
          AND julianday(e.scanned_at)<=julianday(r.started_at) AND julianday(sr.completed_at)<=julianday(r.started_at)
          AND NOT EXISTS(SELECT 1 FROM background_jobs later WHERE later.agency_id=sj.agency_id AND later.job_type='DOCUMENT_SCAN'
            AND later.document_version_id=v.id AND later.input_sha256=v.sha256 AND later.generation>sj.generation
            AND julianday(later.created_at)<=julianday(c.created_at)))) LIMIT 1`,
  `SELECT v.id FROM document_versions v WHERE v.status='AVAILABLE' AND (
    NOT EXISTS(SELECT 1 FROM document_backup_copies c JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
      WHERE c.agency_id=v.agency_id AND c.document_version_id=v.id AND j.generation=(SELECT max(x.generation) FROM background_jobs x WHERE x.agency_id=v.agency_id AND x.document_version_id=v.id AND x.job_type='DOCUMENT_BACKUP') AND j.status='COMPLETED')
    OR (${historicalScanProofRequired} AND NOT EXISTS(SELECT 1 FROM document_scan_evidence e JOIN background_job_runs r ON r.agency_id=e.agency_id AND r.id=e.job_run_id JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
      WHERE e.agency_id=v.agency_id AND e.document_version_id=v.id AND e.outcome='CLEAN' AND j.status='COMPLETED' AND j.generation=(SELECT max(x.generation) FROM background_jobs x WHERE x.agency_id=v.agency_id AND x.document_version_id=v.id AND x.job_type='DOCUMENT_SCAN')))) LIMIT 1`,
  `SELECT d.id FROM documents d WHERE d.current_version_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM document_versions v WHERE v.id=d.current_version_id AND v.agency_id=d.agency_id AND v.document_id=d.id
      AND v.status='AVAILABLE' AND v.version_number=(SELECT max(latest.version_number) FROM document_versions latest
        WHERE latest.agency_id=d.agency_id AND latest.document_id=d.id)) LIMIT 1`,
  `SELECT q.id FROM renewal_quotes q WHERE (q.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM renewal_quote_versions v
      WHERE v.agency_id=q.agency_id AND v.quote_id=q.id AND v.id=q.current_version_id))
    OR (q.status='SENT' AND NOT EXISTS(SELECT 1 FROM renewal_quote_events e WHERE e.agency_id=q.agency_id AND e.quote_id=q.id
      AND e.quote_version_id=q.current_version_id AND e.event='SENT'))
    OR (q.status='ACCEPTED' AND NOT EXISTS(SELECT 1 FROM renewal_quote_events e WHERE e.agency_id=q.agency_id AND e.quote_id=q.id
      AND e.quote_version_id=q.accepted_version_id AND e.accepted_policy_id=q.accepted_policy_id AND e.event='ACCEPTED')) LIMIT 1`,
  `SELECT v.id FROM renewal_quote_versions v JOIN insurance_products p ON p.agency_id=v.agency_id AND p.id=v.product_id
    JOIN payment_methods m ON m.agency_id=v.agency_id AND m.id=v.payment_method_id
    WHERE p.insurer_id<>v.insurer_id OR p.branch_id<>v.branch_id OR (v.installment_count IS NOT NULL AND
      (m.supports_installments<>1 OR v.installment_count NOT BETWEEN 2 AND m.max_installments)) LIMIT 1`,
  `SELECT v.quote_id FROM renewal_quote_versions v GROUP BY v.agency_id,v.quote_id HAVING count(*)<>max(v.version_number) LIMIT 1`,
  `SELECT e.id FROM renewal_quote_events e JOIN operation_receipts receipt ON receipt.id=e.operation_receipt_id
    WHERE receipt.agency_id<>e.agency_id OR (e.event='SENT' AND (receipt.action<>'renewal.quote.send' OR receipt.status<>'COMPLETED' OR receipt.response_status NOT IN (200,201)))
      OR (e.event='ACCEPTED' AND (receipt.action<>'renewal.close_won' OR receipt.status<>'COMPLETED' OR receipt.response_status NOT IN (200,201)
        OR NOT EXISTS(SELECT 1 FROM renewal_quote_events sent WHERE sent.agency_id=e.agency_id AND sent.quote_id=e.quote_id AND sent.quote_version_id=e.quote_version_id
          AND sent.event='SENT' AND sent.occurred_at<=e.occurred_at))) LIMIT 1`,
  `SELECT i.id FROM renewal_interactions i JOIN renewal_opportunities r ON r.agency_id=i.agency_id AND r.id=i.renewal_id
    JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id JOIN customers c ON c.agency_id=p.agency_id AND c.id=p.customer_id
    WHERE i.customer_id<>c.id OR (c.type='INDIVIDUAL' AND i.company_contact_id IS NOT NULL)
      OR (c.type='COMPANY' AND NOT EXISTS(SELECT 1 FROM company_contacts contact WHERE contact.id=i.company_contact_id
        AND contact.agency_id=i.agency_id AND contact.customer_id=c.id)) LIMIT 1`,
  `SELECT id FROM renewal_quotes q WHERE NOT EXISTS(SELECT 1 FROM agency_memberships m WHERE m.agency_id=q.agency_id AND m.id=q.created_by_membership_id AND m.user_id=q.created_by_user_id)
    UNION ALL SELECT id FROM renewal_quote_versions v WHERE NOT EXISTS(SELECT 1 FROM agency_memberships m WHERE m.agency_id=v.agency_id AND m.id=v.created_by_membership_id AND m.user_id=v.created_by_user_id)
    UNION ALL SELECT id FROM renewal_quote_events e WHERE NOT EXISTS(SELECT 1 FROM agency_memberships m WHERE m.agency_id=e.agency_id AND m.id=e.actor_membership_id AND m.user_id=e.actor_user_id)
    UNION ALL SELECT id FROM renewal_interactions i WHERE NOT EXISTS(SELECT 1 FROM agency_memberships m WHERE m.agency_id=i.agency_id AND m.id=i.actor_membership_id AND m.user_id=i.actor_user_id) LIMIT 1`,
];

async function verifyRenewalHistory(db: D1Database) {
  const history = await rows<
    RestoreHistoryEdge & {
      agency_id: string;
      renewal_id: string;
      actor_membership_id: string | null;
      loss_reason_id: string | null;
      loss_reason_notes: string | null;
      void_reason_code: string | null;
    }
  >(
    db,
    'SELECT id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at,actor_membership_id,loss_reason_id,loss_reason_notes,void_reason_code FROM renewal_state_history',
  );
  const grouped = new Map<string, typeof history>();
  for (const edge of history) {
    const key = canonicalizePayload([edge.agency_id, edge.renewal_id]);
    const group = grouped.get(key) ?? [];
    group.push(edge);
    grouped.set(key, group);
  }
  for (const renewal of await rows<{
    id: string;
    agency_id: string;
    state: string;
    closed_at: string | null;
    closed_by_membership_id: string | null;
    loss_reason_id: string | null;
    loss_reason_notes: string | null;
    void_reason_code: string | null;
  }>(
    db,
    'SELECT id,agency_id,state,closed_at,closed_by_membership_id,loss_reason_id,loss_reason_notes,void_reason_code FROM renewal_opportunities',
  )) {
    try {
      const endings = verifyHistoryChain(
        grouped.get(canonicalizePayload([renewal.agency_id, renewal.id])) ?? [],
        renewal.state,
      );
      if (
        ['WON', 'LOST', 'VOIDED'].includes(renewal.state) &&
        !endings.some(
          (e) =>
            e.created_at === renewal.closed_at &&
            e.actor_membership_id === renewal.closed_by_membership_id &&
            e.loss_reason_id === renewal.loss_reason_id &&
            e.loss_reason_notes === renewal.loss_reason_notes &&
            e.void_reason_code === renewal.void_reason_code,
        )
      )
        return fail('DB_DOMAIN_FAILED');
    } catch {
      return fail('DB_DOMAIN_FAILED');
    }
  }
}

async function verifyInspectionEvidence(db: D1Database) {
  const dimension = z.number().int().positive();
  const inspectionSchema = z.union([
    z.strictObject({
      valid: z.literal(true),
      format: z.literal('PDF'),
      pageCount: dimension.max(MAX_DOCUMENT_PDF_PAGES),
    }),
    z
      .strictObject({
        valid: z.literal(true),
        format: z.literal('JPEG'),
        width: dimension.max(MAX_DOCUMENT_JPEG_SIDE),
        height: dimension.max(MAX_DOCUMENT_JPEG_SIDE),
        pixelCount: dimension.max(MAX_DOCUMENT_JPEG_PIXELS),
      })
      .refine((v) => v.pixelCount === v.width * v.height),
    z
      .strictObject({
        valid: z.literal(true),
        format: z.literal('PNG'),
        width: dimension,
        height: dimension,
        pixelCount: dimension.max(MAX_DOCUMENT_IMAGE_PIXELS),
        decompressedBytes: dimension.max(MAX_DOCUMENT_PNG_DECOMPRESSED_BYTES),
      })
      .refine((v) => v.pixelCount === v.width * v.height),
  ]);
  const formats: Record<string, string> = {
    'application/pdf': 'PDF',
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
  };
  for (const e of await rows<{
    outcome: string;
    content_inspection_version: string | null;
    content_inspection_result: string | null;
    detected_content_type: string;
    raw_shape_valid: number;
  }>(
    db,
    `WITH inspection AS (
       SELECT e.outcome,e.content_inspection_version,e.content_inspection_result,v.detected_content_type
       FROM document_scan_evidence e JOIN document_versions v ON v.agency_id=e.agency_id AND v.id=e.document_version_id
       UNION ALL SELECT 'STRUCTURAL',v.validation_version,v.validation_result,v.detected_content_type FROM document_versions v
       WHERE v.validation_version IS NOT NULL OR v.validation_result IS NOT NULL
     ) SELECT inspection.*, CASE WHEN typeof(content_inspection_result)='text'
       AND length(content_inspection_result) BETWEEN 1 AND 256 THEN
       CASE WHEN json_valid(content_inspection_result)=1 THEN
       CASE WHEN json_type(content_inspection_result)='object'
         AND NOT EXISTS(SELECT 1 FROM json_each(content_inspection_result) GROUP BY key HAVING count(*)>1)
         AND NOT EXISTS(SELECT 1 FROM json_each(content_inspection_result)
           WHERE (key='valid' AND type<>'true') OR (key='format' AND type<>'text')
             OR (key NOT IN ('valid','format') AND type<>'integer'))
       THEN 1 ELSE 0 END ELSE 0 END ELSE 0 END AS raw_shape_valid FROM inspection`,
  )) {
    if (e.outcome !== 'CLEAN' && e.outcome !== 'STRUCTURAL') {
      if (e.content_inspection_result !== null || e.content_inspection_version !== null)
        return fail('DB_DOMAIN_FAILED');
      continue;
    }
    try {
      if (
        e.raw_shape_valid !== 1 ||
        e.content_inspection_version !== REQUIRED_CONTENT_INSPECTION_VERSION ||
        !e.content_inspection_result ||
        e.content_inspection_result.length > 256
      )
        return fail('DB_DOMAIN_FAILED');
      const result = inspectionSchema.parse(JSON.parse(e.content_inspection_result));
      if (result.format !== formats[e.detected_content_type]) return fail('DB_DOMAIN_FAILED');
    } catch {
      return fail('DB_DOMAIN_FAILED');
    }
  }
}
async function verifyBackupCompletionAudits(db: D1Database) {
  const copies = await rows<{
    id: string;
    agency_id: string;
    document_version_id: string;
    job_id: string;
    run_id: string;
    attempt: number;
    generation: number;
    sha256: string;
    created_at: string;
  }>(
    db,
    `
    SELECT c.id,c.agency_id,c.document_version_id,j.id AS job_id,r.id AS run_id,r.attempt_number AS attempt,j.generation,c.backup_sha256 AS sha256,c.created_at
    FROM document_backup_copies c JOIN background_job_runs r ON r.agency_id=c.agency_id AND r.id=c.job_run_id
    JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id`,
  );
  const metadataSchema = z.strictObject({
    jobId: id,
    runId: id,
    attempt: z.number().int().min(1).max(5),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: digest,
  });
  const seen = new Set<string>();
  for (const audit of await rows<{
    agency_id: string;
    system_actor_code: string;
    target_type: string;
    target_id: string;
    correlation_id: string;
    idempotency_key: string;
    outcome: string;
    reason_code: string;
    metadata_json: string;
    created_at: string;
  }>(
    db,
    "SELECT agency_id,system_actor_code,target_type,target_id,correlation_id,idempotency_key,outcome,reason_code,metadata_json,created_at FROM system_audit_events WHERE action='document.backup.completed'",
  )) {
    try {
      if (
        audit.system_actor_code !== 'document-backup' ||
        audit.target_type !== 'document_versions' ||
        audit.outcome !== 'SUCCESS' ||
        audit.reason_code !== 'BACKUP_VERIFIED' ||
        audit.metadata_json.length > 2048
      )
        return fail('DB_DOMAIN_FAILED');
      const meta = metadataSchema.parse(JSON.parse(audit.metadata_json));
      const matching = copies.filter(
        (c) => c.agency_id === audit.agency_id && c.run_id === audit.correlation_id,
      );
      if (matching.length !== 1) return fail('DB_DOMAIN_FAILED');
      const copy = matching[0]!;
      if (
        seen.has(copy.id) ||
        !Number.isFinite(Date.parse(audit.created_at)) ||
        new Date(audit.created_at).toISOString() !== audit.created_at ||
        audit.created_at < copy.created_at ||
        audit.target_id !== copy.document_version_id ||
        audit.idempotency_key !== copy.job_id ||
        meta.jobId !== copy.job_id ||
        meta.runId !== copy.run_id ||
        meta.attempt !== copy.attempt ||
        meta.generation !== copy.generation ||
        meta.sha256 !== copy.sha256
      )
        return fail('DB_DOMAIN_FAILED');
      seen.add(copy.id);
    } catch {
      return fail('DB_DOMAIN_FAILED');
    }
  }
  if (seen.size !== copies.length) return fail('DB_DOMAIN_FAILED');
}
async function verifyRecoveryKeys(db: D1Database, keys: LocalRestoreInput['recoveryKeys']) {
  const envelopeSchema = z
    .strictObject({
      type: z.enum(['INDIVIDUAL', 'COMPANY']),
      identity_type: z.enum(['TCKN', 'VKN']),
      identity_ciphertext: z.string().regex(/^(?:[0-9a-f]{20}|[0-9a-f]{22})$/iu),
      identity_iv: z.string().regex(/^[0-9a-f]{24}$/iu),
      identity_tag: z.string().regex(/^[0-9a-f]{32}$/iu),
      identity_search_hash: digest,
      identity_key_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .refine(
      (r) =>
        (r.type === 'INDIVIDUAL' &&
          r.identity_type === 'TCKN' &&
          r.identity_ciphertext.length === 22) ||
        (r.type === 'COMPANY' && r.identity_type === 'VKN' && r.identity_ciphertext.length === 20),
    );
  for (const raw of await rows<Record<string, unknown>>(
    db,
    'SELECT type,identity_type,identity_ciphertext,identity_iv,identity_tag,identity_search_hash,identity_key_version FROM customers',
  )) {
    if (
      [
        'identity_type',
        'identity_ciphertext',
        'identity_iv',
        'identity_tag',
        'identity_search_hash',
        'identity_key_version',
      ].every((k) => raw[k] === null)
    )
      continue;
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) return fail('IDENTITY_ENVELOPE_INVALID');
    const row = parsed.data;
    const config = keys?.get(row.identity_key_version);
    if (!config || config.keyVersion !== row.identity_key_version)
      return fail('RECOVERY_KEY_MISSING');
    try {
      const plaintext = await decryptIdentity(
        {
          ciphertext: row.identity_ciphertext,
          iv: row.identity_iv,
          tag: row.identity_tag,
          keyVersion: row.identity_key_version,
        },
        config,
      );
      if (
        !validateIdentityFormat(row.identity_type, plaintext) ||
        (await computeIdentitySearchHash(plaintext, config)) !== row.identity_search_hash
      )
        return fail('RECOVERY_KEY_INVALID');
    } catch {
      return fail('RECOVERY_KEY_INVALID');
    }
  }
}
async function objectBytes(
  bucket: Pick<R2Bucket, 'get'>,
  entry: RestoreManifest['objects'][number],
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reading = bucket.get(entry.objectKey);
  let object: R2ObjectBody | null;
  try {
    object = await backupAbortable(reading, signal);
  } catch (error) {
    void reading.then((late) => late?.body.cancel()).catch(() => undefined);
    throw error;
  }
  if (!object) return fail('OBJECT_MISSING');
  const reader = object.body.getReader();
  try {
    if (
      object.size !== entry.sizeBytes ||
      object.customMetadata?.agencyId !== entry.agencyId ||
      object.customMetadata?.documentVersionId !== entry.documentVersionId ||
      object.customMetadata?.generation !== String(entry.generation) ||
      object.customMetadata?.sha256 !== entry.sha256
    )
      return fail('OBJECT_IDENTITY_MISMATCH');
    const bytes = new Uint8Array(entry.sizeBytes);
    const hash = createHash('sha256');
    let length = 0;
    while (true) {
      const { done, value } = await backupAbortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > entry.sizeBytes) return fail('OBJECT_LENGTH_MISMATCH');
      bytes.set(value, length - value.byteLength);
      hash.update(value);
    }
    if (length !== entry.sizeBytes) return fail('OBJECT_LENGTH_MISMATCH');
    if (hash.digest('hex') !== entry.sha256) return fail('OBJECT_CHECKSUM_MISMATCH');
    return bytes;
  } finally {
    // Cancellation is best-effort: an uncooperative source must not keep the
    // deadline/error report or the harness-owned target cleanup pending.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function runLocalRestoreProof(input: LocalRestoreInput): Promise<RestoreReport> {
  const start = Date.now();
  const report: RestoreReport = {
    manifestId: null,
    appVersion: null,
    schemaVersion: null,
    startedAt: new Date(start).toISOString(),
    endedAt: '',
    durationMs: 0,
    verdict: 'FAIL',
    code: 'RESTORE_IO_FAILED',
    publication: 'SEALED_EXTERNAL_CONTROL_PLANE_PENDING',
    checks: {
      dbHash: false,
      schema: false,
      rows: false,
      foreignKeys: false,
      domain: false,
      objects: false,
      recoveryKeys: false,
    },
    rowCounts: {},
    money: { policies: {}, amendments: {}, allocations: {}, quotes: {} },
    objectCount: 0,
    checksums: [],
  };
  const signal = AbortSignal.timeout(RESTORE_LIMITS.durationMs);
  let directory: string | undefined;
  let dispose: (() => Promise<void>) | undefined;
  try {
    signal.throwIfAborted();
    const manifest = parseRestoreManifest(input.manifestJson);
    report.manifestId = sha(canonicalizePayload(manifest));
    report.appVersion = manifest.appVersion;
    report.schemaVersion = manifest.schemaVersion;
    const exportSql = input.exportSql;
    if (typeof exportSql !== 'string' || Buffer.byteLength(exportSql) > RESTORE_LIMITS.exportBytes)
      return fail('EXPORT_INVALID');
    if (sha(exportSql) !== manifest.dbExportSha256) return fail('DB_EXPORT_HASH_MISMATCH');
    report.checks.dbHash = true;
    // The caller cannot supply a target DB, directory, config, bucket or serving binding.
    directory = mkdtempSync(join(tmpdir(), 'mayi-sealed-restore-'));
    const configPath = join(directory, 'wrangler.json');
    const state = join(directory, 'state');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'mayi-sealed-local-restore',
        compatibility_date: '2026-09-01',
        compatibility_flags: ['nodejs_compat'],
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'sealed-target',
            database_id: '00000000-0000-0000-0000-000000000889',
          },
          {
            binding: 'REFERENCE',
            database_name: 'schema-reference',
            database_id: '00000000-0000-0000-0000-000000000890',
          },
        ],
        r2_buckets: [{ binding: 'RESTORED', bucket_name: 'sealed-restored-objects' }],
      }),
    );
    const dump = join(directory, 'snapshot.sql');
    try {
      writeFileSync(dump, orderedD1Import(exportSql));
    } catch (error) {
      if (error instanceof RestoreFailure) throw error;
      return fail('DB_IMPORT_FAILED');
    }
    const imported = spawnSync(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'execute',
        'DB',
        '--local',
        '--config',
        configPath,
        '--persist-to',
        state,
        '--file',
        dump,
        '--yes',
      ],
      {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
      },
    );
    if (imported.status !== 0) return fail('DB_IMPORT_FAILED');
    const acquiring = getPlatformProxy<{
      DB: D1Database;
      REFERENCE: D1Database;
      RESTORED: R2Bucket;
    }>({
      configPath,
      envFiles: [],
      persist: { path: join(state, 'v3') },
      remoteBindings: false,
    });
    type Platform = Awaited<typeof acquiring>;
    let platform: Platform;
    try {
      platform = await backupAbortable(acquiring, signal);
    } catch (error) {
      const target = directory;
      void acquiring
        .then(async (late) => {
          await late.dispose();
          rmSync(target, { recursive: true, force: true });
        })
        .catch(() => undefined);
      throw error;
    }
    dispose = platform.dispose;
    for (const name of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
      .sort()) {
      for (const sql of readFileSync(resolve('db/migrations', name), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean)) {
        signal.throwIfAborted();
        await platform.env.REFERENCE.prepare(sql).run();
      }
    }
    const db = platform.env.DB;
    if (
      canonicalizePayload(await schema(db)) !==
      canonicalizePayload(await schema(platform.env.REFERENCE))
    )
      return fail('SCHEMA_MISMATCH');
    report.checks.schema = true;
    // D1 denies integrity_check. Table CHECKs and all unique indexes are enforced
    // during the actual D1 import; decoder integrity_check is additional evidence.
    if ((await rows(db, 'PRAGMA foreign_key_check')).length) return fail('DB_FK_FAILED');
    report.checks.foreignKeys = true;
    const actual = await collectRestoreExpectations(db);
    report.rowCounts = actual.rowCounts;
    report.money = actual.money;
    if (canonicalizePayload(actual.rowCounts) !== canonicalizePayload(manifest.rowCounts))
      return fail('DB_ROW_COUNT_MISMATCH');
    report.checks.rows = true;
    if (canonicalizePayload(actual.money) !== canonicalizePayload(manifest.money))
      return fail('DB_MONEY_MISMATCH');
    for (const sql of domainQueries)
      if ((await rows(db, sql)).length) return fail('DB_DOMAIN_FAILED');
    await verifyInspectionEvidence(db);
    await verifyRenewalHistory(db);
    await verifyBackupCompletionAudits(db);
    report.checks.domain = true;
    if (canonicalizePayload(actual.objects) !== canonicalizePayload(manifest.objects))
      return fail('DB_OBJECT_MAPPING_MISMATCH');
    await verifyRecoveryKeys(db, input.recoveryKeys);
    report.checks.recoveryKeys = true;
    for (const entry of manifest.objects) {
      signal.throwIfAborted();
      const bytes = await objectBytes(input.backup, entry, signal);
      await backupAbortable(
        platform.env.RESTORED.put(entry.objectKey, bytes, {
          onlyIf: { etagDoesNotMatch: '*' },
          sha256: entry.sha256,
          customMetadata: {
            agencyId: entry.agencyId,
            documentVersionId: entry.documentVersionId,
            generation: String(entry.generation),
            sha256: entry.sha256,
          },
          httpMetadata: { cacheControl: 'private, no-store' },
        }),
        signal,
      );
      await objectBytes(platform.env.RESTORED, entry, signal);
      report.checksums.push({
        copyId: entry.copyId,
        sha256: entry.sha256,
        sourceVerified: true,
        restoredVerified: true,
      });
      report.objectCount++;
    }
    // Fresh, harness-owned namespace starts empty. Exact list cross-check catches surplus output.
    const stored = await platform.env.RESTORED.list({ limit: RESTORE_LIMITS.objects + 1 });
    if (
      stored.truncated ||
      canonicalizePayload(stored.objects.map((o) => o.key).sort()) !==
        canonicalizePayload(manifest.objects.map((o) => o.objectKey).sort())
    )
      return fail('RESTORED_OBJECT_SURPLUS');
    report.checks.objects = true;
    // Verification never authorizes publication. Current canonical authority must be externally
    // reapplied/validated, with offboarding and deletion tombstones, in a distinct cutover operation.
    signal.throwIfAborted();
    report.verdict = 'PASS';
    report.code = 'VERIFIED_SEALED';
  } catch (error) {
    report.code = signal.aborted
      ? 'RESTORE_TIMEOUT'
      : error instanceof RestoreFailure
        ? error.message
        : 'RESTORE_IO_FAILED';
  } finally {
    try {
      await dispose?.();
      if (directory) rmSync(directory, { recursive: true, force: true });
    } catch {
      report.verdict = 'FAIL';
      report.code = 'TARGET_CLEANUP_FAILED';
    }
    report.endedAt = new Date().toISOString();
    report.durationMs = Date.now() - start;
  }
  return report;
}

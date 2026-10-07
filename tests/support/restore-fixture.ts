import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getPlatformProxy } from 'wrangler';
import { createSyntheticPdf } from '../fixtures/documents';
import { createR2DocumentBackupAdapter } from '../../src/server/documents/backup-storage';
import { processDocumentBackupMessage } from '../../src/server/documents/backup';
import type { DocumentJobQueueMessage } from '../../src/server/documents/queue';
import {
  encryptIdentity,
  parseIdentityCryptoConfig,
} from '../../src/server/security/identity-crypto';
import {
  collectRestoreExpectations,
  type LocalRestoreInput,
} from '../../scripts/recovery/local-restore-proof';

export interface RestoreFixture {
  input(): LocalRestoreInput;
  readonly db: D1Database;
  readonly backup: R2Bucket;
  readonly primary: R2Bucket;
  readonly exportSql: string;
  dispose(): Promise<void>;
}

export async function createRestoreFixture(validated = false): Promise<RestoreFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'mayi-restore-source-'));
  const configPath = join(directory, 'wrangler.json');
  const state = join(directory, '.wrangler', 'state');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'mayi-synthetic-restore-source',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'source',
          database_id: '00000000-0000-0000-0000-000000000888',
        },
      ],
      r2_buckets: [
        { binding: 'PRIMARY', bucket_name: 'source-primary' },
        { binding: 'BACKUP', bucket_name: 'source-backup' },
      ],
    }),
  );
  const options = {
    configPath,
    envFiles: [],
    persist: { path: join(state, 'v3') },
    remoteBindings: false,
  };
  let platform = await getPlatformProxy<{ DB: D1Database; PRIMARY: R2Bucket; BACKUP: R2Bucket }>(
    options,
  );
  const db = platform.env.DB;
  for (const file of readdirSync('db/migrations')
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
    .sort()) {
    for (const sql of readFileSync(resolve('db/migrations', file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  }
  await db.batch([
    db.prepare("INSERT INTO agencies(id,status) VALUES('backup-agency','PROVISIONING')"),
    db.prepare("INSERT INTO users(id,status) VALUES('backup-user','INACTIVE')"),
    db.prepare(`INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
      VALUES('backup-member','backup-agency','backup-user','OWNER','INVITED','synthetic@example.test','2099-01-01T00:00:00.000Z')`),
    db.prepare(
      `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email) VALUES('restore-identity','backup-user','https://synthetic.cloudflareaccess.com','restore-subject','synthetic@example.test')`,
    ),
  ]);
  await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='backup-user'").run();
  await db
    .prepare(
      "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-09-01T00:00:00.000Z',version=2,permission_version=2 WHERE id='backup-member'",
    )
    .run();
  await db
    .prepare(
      "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-09-01T00:00:00.000Z',activated_at='2026-09-01T00:00:00.000Z',version=2 WHERE id='backup-agency'",
    )
    .run();
  const keys = parseIdentityCryptoConfig({
    IDENTITY_ENCRYPTION_KEY: '11'.repeat(32),
    IDENTITY_HMAC_KEY: '22'.repeat(32),
    IDENTITY_KEY_VERSION: 1,
  });
  const encrypted = await encryptIdentity('10000000000', keys);
  await db
    .prepare(
      `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id,identity_type,identity_ciphertext,identity_iv,identity_tag,identity_search_hash,identity_key_version)
    VALUES('backup-customer','backup-agency','INDIVIDUAL','Synthetic','Synthetic','Customer','backup-member','TCKN',?,?,?,?,?)`,
    )
    .bind(
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      encrypted.searchHash,
      encrypted.keyVersion,
    )
    .run();
  await db.batch([
    db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('restore-insurer','backup-agency','SYN','Synthetic')",
    ),
    db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('restore-branch','backup-agency','AUTO','Synthetic','GENERAL')",
    ),
    db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('restore-product','backup-agency','restore-insurer','restore-branch','AUTO','Synthetic')",
    ),
    db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('restore-payment','backup-agency','CASH','Synthetic',0,12)",
    ),
  ]);
  for (const [id, start, end] of [
    ['restore-old', '2025-10-25', '2026-10-24'],
    ['restore-new', '2026-10-25', '2027-10-24'],
  ]) {
    await db
      .prepare(
        `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
    VALUES(?,'backup-agency','backup-customer','restore-insurer','restore-product','restore-branch','restore-payment','backup-member',?,?,?, ?,10000,'TRY')`,
      )
      .bind(id, id, id, start, end)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id) VALUES('restore-renewal','backup-agency','restore-old','backup-member')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO renewal_state_history(id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code) VALUES('restore-history','backup-agency','restore-renewal',NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING')",
    )
    .run();
  await db
    .prepare(
      `INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind)
    VALUES('restore-task','backup-agency','backup-customer','restore-renewal','RENEWAL_FOLLOWUP','Synthetic','2026-10-01T00:00:00.000Z','backup-member','SYSTEM')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO operation_receipts(id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,status)
    VALUES('restore-operation','backup-agency','backup-user','backup-member','renewal.policy-links.allocate','synthetic-restore',?,'IN_PROGRESS')`,
    )
    .bind('a'.repeat(64))
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_policy_links(id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,allocation_operation_id,created_by_membership_id)
    VALUES('restore-link','backup-agency','restore-renewal','restore-new',10000,'TRY','restore-operation','backup-member')`,
    )
    .run();
  const bytes = createSyntheticPdf();
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const doc = await seedDocument(db, platform.env.PRIMARY, bytes, checksum, validated);
  const result = await processDocumentBackupMessage(
    db,
    platform.env.PRIMARY,
    createR2DocumentBackupAdapter(platform.env.BACKUP),
    doc.message,
  );
  if (result !== 'COMPLETED') throw new Error('SYNTHETIC_BACKUP_FAILED');
  const expectations = await collectRestoreExpectations(db);
  await platform.dispose();
  const dumpPath = join(directory, 'export.sql');
  const output = spawnSync(
    process.execPath,
    [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'export',
      'DB',
      '--local',
      '--config',
      configPath,
      '--output',
      dumpPath,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  if (output.status !== 0)
    throw new Error(`LOCAL_EXPORT_FAILED: ${output.stdout} ${output.stderr}`);
  const exportSql = readFileSync(dumpPath, 'utf8');
  platform = await getPlatformProxy<{ DB: D1Database; PRIMARY: R2Bucket; BACKUP: R2Bucket }>(
    options,
  );
  const manifest = {
    format: 'mayi-local-restore-v1',
    appVersion: '0.1.0',
    schemaVersion: '0020',
    createdAt: new Date().toISOString(),
    bookmark: 'synthetic-paused-native-export',
    dbExportSha256: createHash('sha256').update(exportSql).digest('hex'),
    expectedObjectCount: expectations.objects.length,
    completion: 'COMPLETE',
    ...expectations,
  };
  return {
    db: platform.env.DB,
    backup: platform.env.BACKUP,
    primary: platform.env.PRIMARY,
    exportSql,
    input: () => ({
      manifestJson: JSON.stringify(manifest),
      exportSql,
      backup: { get: platform.env.BACKUP.get.bind(platform.env.BACKUP) },
      recoveryKeys: new Map([[1, keys]]),
    }),
    async dispose() {
      await platform.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function seedDocument(
  db: D1Database,
  source: R2Bucket,
  bytes: Uint8Array<ArrayBuffer>,
  checksum: string,
  validated: boolean,
) {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const scanId = crypto.randomUUID();
  const scanRunId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const key = `quarantine/${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id)
    VALUES(?,'backup-agency','CUSTOMER','backup-customer','backup-user','backup-member')`,
    )
    .bind(documentId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id)
    VALUES(?,'backup-agency',?,1,?,?,?,'synthetic.pdf','application/pdf','backup-user','backup-member')`,
    )
    .bind(versionId, documentId, key, checksum, bytes.byteLength)
    .run();
  if (validated) {
    await db
      .prepare(
        `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256) VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?)`,
      )
      .bind(jobId, versionId, checksum)
      .run();
    await db
      .prepare(
        `UPDATE document_versions SET status='BACKUP_PENDING',validation_version='m4-content-inspection-v1',validation_result='{"valid":true,"format":"PDF","pageCount":1}' WHERE id=?`,
      )
      .bind(versionId)
      .run();
    await source.put(key, bytes, {
      customMetadata: { sha256: checksum },
      httpMetadata: { contentType: 'application/pdf' },
    });
    const message: DocumentJobQueueMessage = {
      jobId,
      jobType: 'DOCUMENT_BACKUP',
      generation: 1,
      documentVersionId: versionId,
      inputSha256: checksum,
    };
    return { documentId, versionId, scanId, scanRunId, jobId, key, message };
  }
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
    VALUES(?,'backup-agency','DOCUMENT_SCAN',?,?)`,
    )
    .bind(scanId, versionId, checksum)
    .run();
  await db
    .prepare("UPDATE document_versions SET status='QUARANTINED' WHERE id=?")
    .bind(versionId)
    .run();
  await db
    .prepare(
      `UPDATE background_jobs SET status='RUNNING',attempt_count=1,lease_token_hash=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+150 seconds') WHERE id=?`,
    )
    .bind('a'.repeat(64), scanId)
    .run();
  await db
    .prepare(
      `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
    VALUES(?,'backup-agency',?,1,?)`,
    )
    .bind(scanRunId, scanId, 'a'.repeat(64))
    .run();
  await db
    .prepare("UPDATE document_versions SET status='SCANNING' WHERE id=?")
    .bind(versionId)
    .run();
  await db
    .prepare(
      `UPDATE background_job_runs SET status='SUCCEEDED',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    )
    .bind(scanRunId)
    .run();
  await db
    .prepare(
      `UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    )
    .bind(scanId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_scan_evidence(id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,signature_version,signature_updated_at,scanned_at,content_inspection_version,content_inspection_result)
    SELECT ?,'backup-agency',?,?,?,'CLEAN','synthetic-engine','synthetic-signature',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),completed_at,'m4-content-inspection-v1','{"format":"PDF","pageCount":1,"valid":true}' FROM background_job_runs WHERE id=?`,
    )
    .bind(crypto.randomUUID(), versionId, scanRunId, checksum, scanRunId)
    .run();
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
    VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?)`,
    )
    .bind(jobId, versionId, checksum)
    .run();
  await db
    .prepare("UPDATE document_versions SET status='BACKUP_PENDING' WHERE id=?")
    .bind(versionId)
    .run();
  await source.put(key, bytes, {
    customMetadata: { sha256: checksum },
    httpMetadata: { contentType: 'application/pdf' },
  });
  const message: DocumentJobQueueMessage = {
    jobId,
    jobType: 'DOCUMENT_BACKUP',
    generation: 1,
    documentVersionId: versionId,
    inputSha256: checksum,
  };
  return { documentId, versionId, scanId, scanRunId, jobId, key, message };
}

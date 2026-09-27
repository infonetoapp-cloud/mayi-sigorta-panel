// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

type CommandResult = { status: number | null; stdout: string; stderr: string };
const root = resolve(__dirname, '..');
const migrations = readdirSync(resolve(root, 'db/migrations'))
  .filter((file) => /^\d{4}_.*\.sql$/.test(file))
  .sort();
let runnerDir = '';
let configPath = '';
let stateDir = '';

function run(args: string[]): CommandResult {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  return spawnSync(process.execPath, [wrangler, ...args, '--config', configPath], {
    cwd: root,
    encoding: 'utf8',
  });
}

function execute(sql: string): CommandResult {
  return run([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    stateDir,
    '--command',
    sql,
    '--json',
  ]);
}

function expectSuccess(result: CommandResult): void {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe('M4 belge metadata/version gerçek yerel D1 şeması', () => {
  beforeAll(() => {
    runnerDir = mkdtempSync(join(tmpdir(), 'mayi-documents-m4-'));
    const migrationsDir = join(runnerDir, 'migrations');
    stateDir = join(runnerDir, 'state');
    mkdirSync(migrationsDir);
    mkdirSync(stateDir);
    for (const migration of migrations) {
      copyFileSync(resolve(root, 'db/migrations', migration), join(migrationsDir, migration));
    }
    configPath = join(runnerDir, 'wrangler.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'mayi-documents-m4-local',
        compatibility_date: '2026-09-01',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'mayi-documents-m4-local',
            database_id: '00000000-0000-0000-0000-000000000015',
            migrations_dir: migrationsDir,
          },
        ],
      }),
    );
  });

  afterAll(() => {
    if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  });

  it('saklar yalnız metaveriyi, sürümü ve karantina durumunu; içerik kanıtı değişmez ve çapraz acente bağlanamaz', () => {
    const applied = run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir]);
    expectSuccess(applied);

    const columns = execute("PRAGMA table_info('document_versions')");
    expectSuccess(columns);
    const columnRows = JSON.parse(columns.stdout) as Array<{ results: Array<{ name: string }> }>;
    const names = columnRows.flatMap((item) => item.results.map((row) => row.name));
    expect(names).toEqual(
      expect.arrayContaining([
        'agency_id',
        'document_id',
        'version_number',
        'object_key',
        'sha256',
        'size_bytes',
        'status',
      ]),
    );
    expect(names).not.toEqual(expect.arrayContaining(['bytes', 'content', 'body', 'binary_data']));

    expectSuccess(
      execute(`
        INSERT INTO agencies(id,status) VALUES('agency-a','PROVISIONING');
        INSERT INTO users(id,status) VALUES('user-a','INACTIVE');
        INSERT INTO agency_memberships
          (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
        VALUES('membership-a','agency-a','user-a','OWNER','INVITED','a@example.test','2099-01-01T00:00:00.000Z');
        INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
        VALUES('customer-a','agency-a','INDIVIDUAL','Synthetic Customer','Synthetic','Customer','membership-a');
        INSERT INTO documents
          (id,agency_id,owner_type,customer_id,classification,created_by_user_id,created_by_membership_id)
        VALUES('document-a','agency-a','CUSTOMER','customer-a','GENERAL','user-a','membership-a');
        INSERT INTO document_versions
          (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,
           created_by_user_id,created_by_membership_id)
        VALUES('version-a','agency-a','document-a',1,'quarantine/00000000-0000-4000-8000-000000000001',
          '${'a'.repeat(64)}',128,'synthetic.pdf','application/pdf','user-a','membership-a');
      `),
    );

    const unparseableDocumentTimestamp = execute(`
      INSERT INTO documents
        (id,agency_id,owner_type,customer_id,classification,created_by_user_id,
         created_by_membership_id,created_at)
      VALUES('document-invalid-time','agency-a','CUSTOMER','customer-a','GENERAL','user-a',
        'membership-a',printf('%024s','x'))
    `);
    expect(unparseableDocumentTimestamp.status).not.toBe(0);
    expect(
      `${unparseableDocumentTimestamp.stdout}\\n${unparseableDocumentTimestamp.stderr}`,
    ).toContain('documents_timestamps_valid');

    const unparseableVersionTimestamp = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id,created_at)
      VALUES('version-invalid-time','agency-a','document-a',2,
        'quarantine/00000000-0000-4000-8000-000000000105','${'e'.repeat(64)}',128,
        'invalid-time.pdf','application/pdf','user-a','membership-a',printf('%024s','x'))
    `);
    expect(unparseableVersionTimestamp.status).not.toBe(0);
    expect(
      `${unparseableVersionTimestamp.stdout}\\n${unparseableVersionTimestamp.stderr}`,
    ).toContain('document_versions_timestamps_valid');

    const tooFewScanAttempts = execute(`
      INSERT INTO background_jobs
        (id,agency_id,job_type,document_version_id,input_sha256,generation,max_attempts)
      VALUES('scan-job-too-few-attempts','agency-a','DOCUMENT_SCAN','version-a','${'a'.repeat(64)}',1,4)
    `);
    expect(tooFewScanAttempts.status).not.toBe(0);
    expect(`${tooFewScanAttempts.stdout}\\n${tooFewScanAttempts.stderr}`).toContain(
      'background_jobs_attempts_bounded',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-a','agency-a','DOCUMENT_SCAN','version-a','${'a'.repeat(64)}',1);
        UPDATE document_versions SET status='QUARANTINED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='version-a' AND status='PENDING_UPLOAD';
      `),
    );

    const unversionedClassificationCorrection = execute(
      "UPDATE documents SET classification='HEALTH' WHERE id='document-a'",
    );
    expect(unversionedClassificationCorrection.status).not.toBe(0);
    expect(
      `${unversionedClassificationCorrection.stdout}\\n${unversionedClassificationCorrection.stderr}`,
    ).toContain('DOCUMENT_VERSION_CONFLICT');
    expectSuccess(
      execute(`
        UPDATE documents SET classification='HEALTH',version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='document-a';
        UPDATE documents SET classification='GENERAL',version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='document-a';
      `),
    );

    const documentVersionRollback = execute(
      "UPDATE documents SET version=version-1 WHERE agency_id='agency-a' AND id='document-a'",
    );
    expect(documentVersionRollback.status).not.toBe(0);
    expect(`${documentVersionRollback.stdout}\\n${documentVersionRollback.stderr}`).toContain(
      'DOCUMENT_VERSION_TRANSITION_INVALID',
    );

    const seededAvailableVersion = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,status,created_by_user_id,created_by_membership_id)
      VALUES('version-seeded-clean','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000002',
        '${'b'.repeat(64)}',128,'seeded.pdf','application/pdf','AVAILABLE','user-a','membership-a')
    `);
    expect(seededAvailableVersion.status).not.toBe(0);
    expect(`${seededAvailableVersion.stdout}\n${seededAvailableVersion.stderr}`).toContain(
      'DOCUMENT_VERSION_INSERT_INVALID',
    );

    const quarantinedCurrentPointer = execute(
      "UPDATE documents SET current_version_id='version-a',version=version+1 WHERE id='document-a'",
    );
    expect(quarantinedCurrentPointer.status).not.toBe(0);
    expect(`${quarantinedCurrentPointer.stdout}\n${quarantinedCurrentPointer.stderr}`).toContain(
      'DOCUMENT_CURRENT_VERSION_INVALID',
    );

    const unsafeFilename = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES('version-unsafe','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000003',
        '${'b'.repeat(64)}',128,'../unsafe.pdf','application/pdf','user-a','membership-a')
    `);
    expect(unsafeFilename.status).not.toBe(0);
    expect(`${unsafeFilename.stdout}\\n${unsafeFilename.stderr}`).toContain(
      'document_versions_file_name_shape',
    );

    const unsafeHeaderFilename = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES('version-header','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000005',
        '${'b'.repeat(64)}',128,'unsafe${'\t'}"name.pdf','application/pdf','user-a','membership-a')
    `);
    expect(unsafeHeaderFilename.status).not.toBe(0);
    expect(`${unsafeHeaderFilename.stdout}\\n${unsafeHeaderFilename.stderr}`).toContain(
      'document_versions_file_name_shape',
    );

    const unsafeSingleQuoteFilename = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES('version-single-quote','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000006',
        '${'b'.repeat(64)}',128,char(39)||'Neil.pdf','application/pdf','user-a','membership-a')
    `);
    expect(unsafeSingleQuoteFilename.status).not.toBe(0);
    expect(`${unsafeSingleQuoteFilename.stdout}\\n${unsafeSingleQuoteFilename.stderr}`).toContain(
      'document_versions_file_name_shape',
    );

    const unsafeC1Filename = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES('version-c1','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000007',
        '${'b'.repeat(64)}',128,char(133)||'name.pdf','application/pdf','user-a','membership-a')
    `);
    expect(unsafeC1Filename.status).not.toBe(0);
    expect(`${unsafeC1Filename.stdout}\\n${unsafeC1Filename.stderr}`).toContain(
      'document_versions_file_name_shape',
    );

    const unsafeObjectKey = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES('version-key','agency-a','document-a',2,'quarantine/../customer-name.pdf',
        '${'b'.repeat(64)}',128,'safe.pdf','application/pdf','user-a','membership-a')
    `);
    expect(unsafeObjectKey.status).not.toBe(0);
    expect(`${unsafeObjectKey.stdout}\\n${unsafeObjectKey.stderr}`).toContain(
      'document_versions_object_key_private_shape',
    );

    const deceptiveExtension = execute(`
      INSERT INTO document_versions
        (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
         detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES('version-deceptive','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000004',
        '${'c'.repeat(64)}',128,'image.png','application/pdf','user-a','membership-a')
    `);
    expect(deceptiveExtension.status).not.toBe(0);
    expect(`${deceptiveExtension.stdout}\n${deceptiveExtension.stderr}`).toContain(
      'document_versions_type_extension_consistent',
    );

    expectSuccess(execute("INSERT INTO users(id,status) VALUES('user-b','INACTIVE')"));
    const mismatchedCreator = execute(`
      INSERT INTO documents
        (id,agency_id,owner_type,customer_id,classification,created_by_user_id,created_by_membership_id)
      VALUES('document-actor-mismatch','agency-a','CUSTOMER','customer-a','GENERAL',
        'user-b','membership-a')
    `);
    expect(mismatchedCreator.status).not.toBe(0);
    expect(`${mismatchedCreator.stdout}\n${mismatchedCreator.stderr}`).toContain(
      'DOCUMENT_CREATOR_MEMBERSHIP_MISMATCH',
    );

    const staleChecksumJob = execute(`
      INSERT INTO background_jobs
        (id,agency_id,job_type,document_version_id,input_sha256,generation)
      VALUES('scan-job-stale','agency-a','DOCUMENT_SCAN','version-a','${'b'.repeat(64)}',1)
    `);
    expect(staleChecksumJob.status).not.toBe(0);
    expect(`${staleChecksumJob.stdout}\\n${staleChecksumJob.stderr}`).toContain(
      'BACKGROUND_JOB_INSERT_INVALID',
    );

    const orphanReconcileJob = execute(`
      INSERT INTO background_jobs(id,agency_id,job_type)
      VALUES('reconcile-orphan','missing-agency','DOCUMENT_RECONCILE')
    `);
    expect(orphanReconcileJob.status).not.toBe(0);

    const invalidAvailableAt = execute(`
      INSERT INTO background_jobs(id,agency_id,job_type,available_at)
      VALUES('reconcile-invalid-time','agency-a','DOCUMENT_RECONCILE','not-a-timestamp')
    `);
    expect(invalidAvailableAt.status).not.toBe(0);
    expect(`${invalidAvailableAt.stdout}\\n${invalidAvailableAt.stderr}`).toContain(
      'background_jobs_timestamps_valid',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type,available_at)
        VALUES('reconcile-canonical-time','agency-a','DOCUMENT_RECONCILE',
          strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `),
    );
    const unparseable24CharAvailableAt = execute(`
      INSERT INTO background_jobs(id,agency_id,job_type,available_at)
      VALUES('reconcile-unparseable-time','agency-a','DOCUMENT_RECONCILE',printf('%024s','x'))
    `);
    expect(unparseable24CharAvailableAt.status).not.toBe(0);
    expect(
      `${unparseable24CharAvailableAt.stdout}\\n${unparseable24CharAvailableAt.stderr}`,
    ).toContain('background_jobs_timestamps_valid');
    const impossibleCalendarAvailableAt = execute(`
      INSERT INTO background_jobs(id,agency_id,job_type,available_at)
      VALUES('reconcile-impossible-calendar','agency-a','DOCUMENT_RECONCILE',
        '2024-02-30T12:34:56.789Z')
    `);
    expect(impossibleCalendarAvailableAt.status).not.toBe(0);
    expect(
      `${impossibleCalendarAvailableAt.stdout}\\n${impossibleCalendarAvailableAt.stderr}`,
    ).toContain('background_jobs_timestamps_valid');

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type)
        VALUES('reconcile-invalid-lease-time','agency-a','DOCUMENT_RECONCILE');
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'c'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
        WHERE id='reconcile-invalid-lease-time';
      `),
    );
    const unparseable24CharLeaseExpiry = execute(`
      UPDATE background_jobs SET lease_expires_at=printf('%024s','x')
      WHERE id='reconcile-invalid-lease-time'
    `);
    expect(unparseable24CharLeaseExpiry.status).not.toBe(0);
    expect(
      `${unparseable24CharLeaseExpiry.stdout}\\n${unparseable24CharLeaseExpiry.stderr}`,
    ).toContain('background_jobs_timestamps_valid');

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type)
          VALUES('reconcile-retry-future','agency-a','DOCUMENT_RECONCILE');
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'d'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
          WHERE id='reconcile-retry-future';
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('reconcile-retry-future-run','agency-a','reconcile-retry-future',1,'${'d'.repeat(64)}');
        UPDATE background_job_runs SET status='RETRYABLE_ERROR',reason_code='TEMPORARY_FAILURE',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='reconcile-retry-future-run';
        UPDATE background_jobs SET status='RETRY_WAIT',lease_token_hash=NULL,
          lease_expires_at=NULL,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-retry-future';
      `),
    );
    const retryWaitClaimTooEarly = execute(`
      UPDATE background_jobs SET status='RUNNING',attempt_count=2,
        lease_token_hash='${'e'.repeat(64)}',
        lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-retry-future'
    `);
    expect(retryWaitClaimTooEarly.status).not.toBe(0);
    expect(`${retryWaitClaimTooEarly.stdout}\\n${retryWaitClaimTooEarly.stderr}`).toContain(
      'BACKGROUND_JOB_RETRY_NOT_DUE',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type,available_at)
        VALUES('reconcile-future','agency-a','DOCUMENT_RECONCILE',
          strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))
      `),
    );
    const prematureQueuedClaim = execute(`
      UPDATE background_jobs SET status='RUNNING',attempt_count=1,
        lease_token_hash='${'9'.repeat(64)}',
        lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
      WHERE id='reconcile-future'
    `);
    expect(prematureQueuedClaim.status).not.toBe(0);
    expect(`${prematureQueuedClaim.stdout}\\n${prematureQueuedClaim.stderr}`).toContain(
      'BACKGROUND_JOB_RETRY_NOT_DUE',
    );
    const rescheduleQueuedJob = execute(`
      UPDATE background_jobs SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id='reconcile-future'
    `);
    expect(rescheduleQueuedJob.status).not.toBe(0);
    expect(`${rescheduleQueuedJob.stdout}\\n${rescheduleQueuedJob.stderr}`).toContain(
      'BACKGROUND_JOB_AVAILABLE_AT_IMMUTABLE',
    );

    const evidenceMutation = execute(
      "UPDATE document_versions SET sha256='" + 'b'.repeat(64) + "' WHERE id='version-a'",
    );
    expect(evidenceMutation.status).not.toBe(0);
    expect(`${evidenceMutation.stdout}\n${evidenceMutation.stderr}`).toContain(
      'DOCUMENT_VERSION_EVIDENCE_IMMUTABLE',
    );

    const quarantineBypass = execute(
      "UPDATE document_versions SET status='AVAILABLE' WHERE id='version-a' AND status='QUARANTINED'",
    );
    expect(quarantineBypass.status).not.toBe(0);
    expect(`${quarantineBypass.stdout}\n${quarantineBypass.stderr}`).toContain(
      'DOCUMENT_VERSION_STATE_TRANSITION_INVALID',
    );

    const crossAgency = execute(`
      INSERT INTO agencies(id,status) VALUES('agency-b','PROVISIONING');
      INSERT INTO documents
        (id,agency_id,owner_type,customer_id,classification,created_by_user_id,created_by_membership_id)
      VALUES('document-b','agency-b','CUSTOMER','customer-a','GENERAL','user-a','membership-a')
    `);
    expect(crossAgency.status).not.toBe(0);

    const rerun = run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir]);
    expectSuccess(rerun);
    expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
  }, 180_000);

  it('tarama kanıtı yalnız tamamlanmış lease sonucuna bağlanır ve eski CLEAN yeni INFECTED sonucunu geçemez', async () => {
    const leaseHash = 'd'.repeat(64);
    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${leaseHash}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-a'
      `),
    );
    const mismatchedRunLease = execute(`
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('scan-run-wrong-lease','agency-a','scan-job-a',1,'${'f'.repeat(64)}')
    `);
    expect(mismatchedRunLease.status).not.toBe(0);
    expect(`${mismatchedRunLease.stdout}\\n${mismatchedRunLease.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_INVALID',
    );
    expectSuccess(
      execute(`
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('scan-run-clean','agency-a','scan-job-a',1,'${leaseHash}');
        UPDATE document_versions SET status='SCANNING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='version-a' AND status='QUARANTINED';
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-run-clean';
      `),
    );
    const cleanEvidence = `INSERT INTO document_scan_evidence
      (id,agency_id,document_version_id,job_run_id,sha256,outcome,
       scanner_engine_version,signature_version,signature_updated_at,scanned_at)
      VALUES('scan-evidence-clean','agency-a','version-a','scan-run-clean','${'a'.repeat(64)}',
        'CLEAN','test-engine','test-signature',
        (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean'),
        (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean'))`;
    const prematureEvidence = execute(cleanEvidence);
    expect(prematureEvidence.status).not.toBe(0);
    expect(`${prematureEvidence.stdout}\n${prematureEvidence.stderr}`).toContain(
      'DOCUMENT_SCAN_EVIDENCE_INVALID',
    );

    expectSuccess(
      execute(`UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-a'`),
    );
    const staleSignatureEvidence = execute(`
      INSERT INTO document_scan_evidence
        (id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,
         signature_version,signature_updated_at,scanned_at)
      VALUES('scan-evidence-stale-signature','agency-a','version-a','scan-run-clean','${'a'.repeat(64)}',
        'CLEAN','test-engine','test-signature',
        strftime('%Y-%m-%dT%H:%M:%fZ','now','-49 hours'),
        (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean'))
    `);
    expect(staleSignatureEvidence.status).not.toBe(0);
    expect(`${staleSignatureEvidence.stdout}\\n${staleSignatureEvidence.stderr}`).toContain(
      'DOCUMENT_SCAN_EVIDENCE_INVALID',
    );

    const noncanonicalFreshSignature = execute(`
      INSERT INTO document_scan_evidence
        (id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,
         signature_version,signature_updated_at,scanned_at)
      VALUES('scan-evidence-offset-fresh','agency-a','version-a','scan-run-clean','${'a'.repeat(64)}',
        'CLEAN','test-engine','test-signature',
        strftime('%Y-%m-%dT%H:%M:%f+12:00','now','-1 hour'),
        (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean'))
    `);
    expect(noncanonicalFreshSignature.status).not.toBe(0);
    expect(`${noncanonicalFreshSignature.stdout}\\n${noncanonicalFreshSignature.stderr}`).toContain(
      'document_scan_evidence_timestamps_valid',
    );

    expectSuccess(
      execute(`
        ${cleanEvidence};
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('backup-job-old-clean','agency-a','DOCUMENT_BACKUP','version-a','${'a'.repeat(64)}',1);
        UPDATE document_versions SET status='BACKUP_PENDING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='version-a' AND status='SCANNING';
      `),
    );

    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'f'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-old-clean';
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('backup-run-clean','agency-a','backup-job-old-clean',1,'${'f'.repeat(64)}');
      `),
    );
    const overlappingBackupGeneration = execute(`
      INSERT INTO background_jobs
        (id,agency_id,job_type,document_version_id,input_sha256,generation)
      VALUES('backup-job-overlap','agency-a','DOCUMENT_BACKUP','version-a','${'a'.repeat(64)}',2)
    `);
    expect(overlappingBackupGeneration.status).not.toBe(0);
    expect(
      `${overlappingBackupGeneration.stdout}\\n${overlappingBackupGeneration.stderr}`,
    ).toContain('BACKGROUND_JOB_INSERT_INVALID');
    expectSuccess(
      execute(`
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-run-clean';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-old-clean';
        INSERT INTO document_backup_copies
          (id,agency_id,document_version_id,job_run_id,source_sha256,object_key,backup_sha256)
        VALUES('backup-copy-clean','agency-a','version-a','backup-run-clean','${'a'.repeat(64)}',
          'backup/00000000-0000-4000-8000-000000000101','${'a'.repeat(64)}');
        UPDATE document_versions SET status='AVAILABLE',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='version-a' AND status='BACKUP_PENDING';
        UPDATE documents SET current_version_id='version-a',version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='document-a';
      `),
    );

    const backupEvidenceDelete = execute(
      "DELETE FROM document_backup_copies WHERE id='backup-copy-clean'",
    );
    expect(backupEvidenceDelete.status).not.toBe(0);
    expect(`${backupEvidenceDelete.stdout}\\n${backupEvidenceDelete.stderr}`).toContain(
      'DOCUMENT_BACKUP_EVIDENCE_IMMUTABLE',
    );

    const unsafeBackupKey = execute(`
      INSERT INTO document_backup_copies
        (id,agency_id,document_version_id,job_run_id,source_sha256,object_key,backup_sha256)
      VALUES('backup-copy-unsafe','agency-a','version-a','backup-run-clean','${'a'.repeat(64)}',
        'backup/../customer-name.pdf','${'a'.repeat(64)}')
    `);
    expect(unsafeBackupKey.status).not.toBe(0);
    expect(`${unsafeBackupKey.stdout}\\n${unsafeBackupKey.stderr}`).toContain(
      'document_backup_copies_object_key_private_shape',
    );

    const pointerRetireBypass = execute(`
      UPDATE document_versions SET status='RETIRED',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-a'
    `);
    expect(pointerRetireBypass.status).not.toBe(0);
    expect(`${pointerRetireBypass.stdout}\\n${pointerRetireBypass.stderr}`).toContain(
      'DOCUMENT_CURRENT_VERSION_CLEAR_REQUIRED',
    );

    expectSuccess(
      execute(`
        INSERT INTO document_versions
          (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
           detected_content_type,created_by_user_id,created_by_membership_id)
        VALUES('version-b','agency-a','document-a',2,'quarantine/00000000-0000-4000-8000-000000000102',
          '${'b'.repeat(64)}',256,'replacement.pdf','application/pdf','user-a','membership-a');
      `),
    );
    const newRevisionState = execute(`
      SELECT document.current_version_id,old_version.status AS old_status,
        new_version.status AS new_status
      FROM documents document
      JOIN document_versions old_version ON old_version.agency_id=document.agency_id
        AND old_version.document_id=document.id AND old_version.id='version-a'
      JOIN document_versions new_version ON new_version.agency_id=document.agency_id
        AND new_version.document_id=document.id AND new_version.id='version-b'
      WHERE document.agency_id='agency-a' AND document.id='document-a'
    `);
    expectSuccess(newRevisionState);
    expect(newRevisionState.stdout).toContain('"current_version_id": null');
    expect(newRevisionState.stdout).toContain('"old_status": "AVAILABLE"');
    expect(newRevisionState.stdout).toContain('"new_status": "PENDING_UPLOAD"');

    const oldRevisionRepublish = execute(`
      UPDATE documents SET current_version_id='version-a',version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agency_id='agency-a' AND id='document-a'
    `);
    expect(oldRevisionRepublish.status).not.toBe(0);
    expect(`${oldRevisionRepublish.stdout}\\n${oldRevisionRepublish.stderr}`).toContain(
      'DOCUMENT_CURRENT_VERSION_INVALID',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-unavailable','agency-a','DOCUMENT_SCAN','version-b','${'b'.repeat(64)}',1);
        UPDATE document_versions SET status='QUARANTINED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-b';
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'4'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-unavailable';
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('scan-run-unavailable','agency-a','scan-job-unavailable',1,'${'4'.repeat(64)}');
        UPDATE document_versions SET status='SCANNING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-b';
        UPDATE background_job_runs SET status='PERMANENT_ERROR',reason_code='SCANNER_UNAVAILABLE',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-run-unavailable';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-unavailable';
        INSERT INTO document_scan_evidence
          (id,agency_id,document_version_id,job_run_id,sha256,outcome,reason_code,scanned_at)
        VALUES('scan-evidence-unavailable','agency-a','version-b','scan-run-unavailable','${'b'.repeat(64)}',
          'ERROR','SCANNER_UNAVAILABLE',
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-unavailable'));
      `),
    );
    const unavailableVersion = execute(
      "SELECT status FROM document_versions WHERE agency_id='agency-a' AND id='version-b'",
    );
    expectSuccess(unavailableVersion);
    expect(unavailableVersion.stdout).toContain('SCAN_FAILED');
    const failedRevisionRepublish = execute(`
      UPDATE documents SET current_version_id='version-a',version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agency_id='agency-a' AND id='document-a'
    `);
    expect(failedRevisionRepublish.status).not.toBe(0);
    expect(`${failedRevisionRepublish.stdout}\\n${failedRevisionRepublish.stderr}`).toContain(
      'DOCUMENT_CURRENT_VERSION_INVALID',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('backup-job-recopy-a','agency-a','DOCUMENT_BACKUP','version-a','${'a'.repeat(64)}',2)
      `),
    );
    const recopyUnpublishesCurrent = execute(`
      SELECT document.current_version_id,version.status
      FROM documents document JOIN document_versions version
        ON version.agency_id=document.agency_id AND version.document_id=document.id
      WHERE document.agency_id='agency-a' AND document.id='document-a' AND version.id='version-a'
    `);
    expectSuccess(recopyUnpublishesCurrent);
    expect(recopyUnpublishesCurrent.stdout).toContain('"current_version_id": null');
    expect(recopyUnpublishesCurrent.stdout).toContain('BACKUP_PENDING');
    const oldBackupCopyReuse = execute(`
      UPDATE document_versions SET status='AVAILABLE',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-a'
    `);
    expect(oldBackupCopyReuse.status).not.toBe(0);
    expect(`${oldBackupCopyReuse.stdout}\\n${oldBackupCopyReuse.stderr}`).toContain(
      'DOCUMENT_VERSION_STATE_TRANSITION_INVALID',
    );

    const secondLeaseHash = 'e'.repeat(64);
    expectSuccess(
      execute(`INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-infected','agency-a','DOCUMENT_SCAN','version-a','${'a'.repeat(64)}',2)`),
    );
    const rescanQuarantine = execute(`
      SELECT version.status,document.current_version_id
      FROM document_versions version
      JOIN documents document ON document.agency_id=version.agency_id
        AND document.id=version.document_id
      WHERE version.agency_id='agency-a' AND version.id='version-a'
    `);
    expectSuccess(rescanQuarantine);
    expect(rescanQuarantine.stdout).toContain('QUARANTINED');
    expect(rescanQuarantine.stdout).toContain('"current_version_id": null');

    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${secondLeaseHash}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-infected';
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('scan-run-infected','agency-a','scan-job-infected',1,'${secondLeaseHash}');
        UPDATE document_versions SET status='SCANNING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='version-a' AND status='QUARANTINED';
        UPDATE background_job_runs SET status='INFECTED',reason_code='SAFE_EICAR',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-run-infected';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-infected';
        INSERT INTO document_scan_evidence
          (id,agency_id,document_version_id,job_run_id,sha256,outcome,reason_code,
           scanner_engine_version,signature_version,signature_updated_at,scanned_at)
        VALUES('scan-evidence-infected','agency-a','version-a','scan-run-infected','${'a'.repeat(64)}',
          'INFECTED','SAFE_EICAR','test-engine','test-signature',
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-infected'),
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-infected'));
      `),
    );
    const latestEvidence = execute(`
      SELECT outcome,generation,attempt_number,job_status,run_status
      FROM document_latest_scan_evidence WHERE agency_id='agency-a' AND document_version_id='version-a'
    `);
    expectSuccess(latestEvidence);
    expect(latestEvidence.stdout).toContain('INFECTED');
    expect(latestEvidence.stdout).toContain('"generation": 2');
    const infectedVersion = execute(
      "SELECT status FROM document_versions WHERE agency_id='agency-a' AND id='version-a'",
    );
    expectSuccess(infectedVersion);
    expect(infectedVersion.stdout).toContain('REJECTED');

    const staleCleanReuse = execute(`
      UPDATE document_versions SET status='AVAILABLE',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id='version-a' AND status='REJECTED'
    `);
    expect(staleCleanReuse.status).not.toBe(0);
    expect(`${staleCleanReuse.stdout}\\n${staleCleanReuse.stderr}`).toContain(
      'DOCUMENT_VERSION_STATE_TRANSITION_INVALID',
    );

    expectSuccess(
      execute(`
        INSERT INTO document_versions
          (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
           detected_content_type,created_by_user_id,created_by_membership_id)
        VALUES('version-c','agency-a','document-a',3,'quarantine/00000000-0000-4000-8000-000000000103',
          '${'c'.repeat(64)}',256,'third.pdf','application/pdf','user-a','membership-a');
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-clean-third','agency-a','DOCUMENT_SCAN','version-c','${'c'.repeat(64)}',1);
        UPDATE document_versions SET status='QUARANTINED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c';
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'5'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-clean-third';
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('scan-run-clean-third','agency-a','scan-job-clean-third',1,'${'5'.repeat(64)}');
        UPDATE document_versions SET status='SCANNING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c';
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-run-clean-third';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-clean-third';
        INSERT INTO document_scan_evidence
          (id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,
           signature_version,signature_updated_at,scanned_at)
        VALUES('scan-evidence-clean-third','agency-a','version-c','scan-run-clean-third','${'c'.repeat(64)}',
          'CLEAN','test-engine','test-signature',
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean-third'),
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean-third'));
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('backup-job-clean-third','agency-a','DOCUMENT_BACKUP','version-c','${'c'.repeat(64)}',1);
        UPDATE document_versions SET status='BACKUP_PENDING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c';
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'6'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-clean-third';
      `),
    );
    expectSuccess(
      execute(`
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('backup-run-clean-third','agency-a','backup-job-clean-third',1,'${'6'.repeat(64)}');
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-run-clean-third';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-clean-third';
      `),
    );
    const unparseableBackupCreatedAt = execute(`
      INSERT INTO document_backup_copies
        (id,agency_id,document_version_id,job_run_id,source_sha256,object_key,backup_sha256,created_at)
      VALUES('backup-copy-invalid-time','agency-a','version-c','backup-run-clean-third','${'c'.repeat(64)}',
        'backup/00000000-0000-4000-8000-000000000202','${'c'.repeat(64)}',printf('%024s','x'))
    `);
    expect(unparseableBackupCreatedAt.status).not.toBe(0);
    expect(`${unparseableBackupCreatedAt.stdout}\\n${unparseableBackupCreatedAt.stderr}`).toContain(
      'document_backup_copies_timestamps_valid',
    );
    expectSuccess(
      execute(`
        INSERT INTO document_backup_copies
          (id,agency_id,document_version_id,job_run_id,source_sha256,object_key,backup_sha256)
        VALUES('backup-copy-clean-third','agency-a','version-c','backup-run-clean-third','${'c'.repeat(64)}',
          'backup/00000000-0000-4000-8000-000000000201','${'c'.repeat(64)}');
        UPDATE document_versions SET status='AVAILABLE',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c';
        UPDATE documents SET current_version_id='version-c',version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='document-a';
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation,max_attempts)
        VALUES('backup-job-dead-third','agency-a','DOCUMENT_BACKUP','version-c','${'c'.repeat(64)}',2,1);
      `),
    );

    const thirdBackupUnpublishesCurrent = execute(`
      SELECT document.current_version_id,version.status
      FROM documents document JOIN document_versions version
        ON version.agency_id=document.agency_id AND version.document_id=document.id
      WHERE document.agency_id='agency-a' AND document.id='document-a' AND version.id='version-c'
    `);
    expectSuccess(thirdBackupUnpublishesCurrent);
    expect(thirdBackupUnpublishesCurrent.stdout).toContain('"current_version_id": null');
    expect(thirdBackupUnpublishesCurrent.stdout).toContain('BACKUP_PENDING');
    const staleBackupBeforeRescan = execute(`
      UPDATE document_versions SET status='AVAILABLE',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c'
    `);
    expect(staleBackupBeforeRescan.status).not.toBe(0);
    expect(`${staleBackupBeforeRescan.stdout}\\n${staleBackupBeforeRescan.stderr}`).toContain(
      'DOCUMENT_VERSION_STATE_TRANSITION_INVALID',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-clean-fourth','agency-a','DOCUMENT_SCAN','version-c','${'c'.repeat(64)}',2);
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'7'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-clean-fourth';
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('scan-run-clean-fourth','agency-a','scan-job-clean-fourth',1,'${'7'.repeat(64)}');
        UPDATE document_versions SET status='SCANNING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c';
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-run-clean-fourth';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-clean-fourth';
        INSERT INTO document_scan_evidence
          (id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,
           signature_version,signature_updated_at,scanned_at)
        VALUES('scan-evidence-clean-fourth','agency-a','version-c','scan-run-clean-fourth','${'c'.repeat(64)}',
          'CLEAN','test-engine','test-signature',
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean-fourth'),
          (SELECT completed_at FROM background_job_runs WHERE id='scan-run-clean-fourth'));
        UPDATE document_versions SET status='BACKUP_PENDING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c';
      `),
    );
    const staleBackupReuse = execute(`
      UPDATE document_versions SET status='AVAILABLE',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-c'
    `);
    expect(staleBackupReuse.status).not.toBe(0);
    expect(`${staleBackupReuse.stdout}\\n${staleBackupReuse.stderr}`).toContain(
      'DOCUMENT_VERSION_STATE_TRANSITION_INVALID',
    );
    const prematureBackupDead = execute(`
      UPDATE background_jobs SET status='DEAD',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-dead-third'
    `);
    expect(prematureBackupDead.status).not.toBe(0);
    expect(`${prematureBackupDead.stdout}\\n${prematureBackupDead.stderr}`).toContain(
      'BACKGROUND_JOB_DEAD_ATTEMPT_REQUIRED',
    );
    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'8'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-dead-third';
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('backup-run-dead-third','agency-a','backup-job-dead-third',1,'${'8'.repeat(64)}');
        UPDATE background_job_runs SET status='PERMANENT_ERROR',reason_code='BACKUP_UNAVAILABLE',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-run-dead-third';
      `),
    );
    const retryAfterMaxAttempts = execute(`
      UPDATE background_jobs SET status='RETRY_WAIT',lease_token_hash=NULL,lease_expires_at=NULL,
        available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-dead-third'
    `);
    expect(retryAfterMaxAttempts.status).not.toBe(0);
    expect(`${retryAfterMaxAttempts.stdout}\\n${retryAfterMaxAttempts.stderr}`).toContain(
      'BACKGROUND_JOB_ATTEMPTS_EXHAUSTED',
    );
    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='DEAD',lease_token_hash=NULL,lease_expires_at=NULL,
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='backup-job-dead-third';
      `),
    );
    const deadBackupVersion = execute(
      "SELECT status FROM document_versions WHERE agency_id='agency-a' AND id='version-c'",
    );
    expectSuccess(deadBackupVersion);
    expect(deadBackupVersion.stdout).toContain('SCAN_FAILED');

    expectSuccess(
      execute(`
        INSERT INTO document_versions
          (id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,
           detected_content_type,created_by_user_id,created_by_membership_id)
        VALUES('version-d','agency-a','document-a',4,'quarantine/00000000-0000-4000-8000-000000000104',
          '${'d'.repeat(64)}',256,'fourth.pdf','application/pdf','user-a','membership-a');
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-old-generation','agency-a','DOCUMENT_SCAN','version-d','${'d'.repeat(64)}',1);
        UPDATE document_versions SET status='QUARANTINED',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-d';
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'9'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-old-generation';
        INSERT INTO background_job_runs
          (id,agency_id,job_id,attempt_number,lease_token_hash)
        VALUES('scan-run-old-generation','agency-a','scan-job-old-generation',1,'${'9'.repeat(64)}');
        UPDATE document_versions SET status='SCANNING',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='version-d';
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-run-old-generation';
      `),
    );
    const overlappingScanGeneration = execute(`
      INSERT INTO background_jobs
        (id,agency_id,job_type,document_version_id,input_sha256,generation)
      VALUES('scan-job-overlap-generation','agency-a','DOCUMENT_SCAN','version-d','${'d'.repeat(64)}',2)
    `);
    expect(overlappingScanGeneration.status).not.toBe(0);
    expect(`${overlappingScanGeneration.stdout}\\n${overlappingScanGeneration.stderr}`).toContain(
      'BACKGROUND_JOB_INSERT_INVALID',
    );
    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='scan-job-old-generation';
        INSERT INTO background_jobs
          (id,agency_id,job_type,document_version_id,input_sha256,generation)
        VALUES('scan-job-new-generation','agency-a','DOCUMENT_SCAN','version-d','${'d'.repeat(64)}',2);
      `),
    );
    const staleScanEvidence = execute(`
      INSERT INTO document_scan_evidence
        (id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,
         signature_version,signature_updated_at,scanned_at)
      VALUES('scan-evidence-old-generation','agency-a','version-d','scan-run-old-generation',
        '${'d'.repeat(64)}','CLEAN','test-engine','test-signature',
        (SELECT completed_at FROM background_job_runs WHERE id='scan-run-old-generation'),
        (SELECT completed_at FROM background_job_runs WHERE id='scan-run-old-generation'))
    `);
    expect(staleScanEvidence.status).not.toBe(0);
    expect(`${staleScanEvidence.stdout}\\n${staleScanEvidence.stderr}`).toContain(
      'DOCUMENT_SCAN_EVIDENCE_INVALID',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type)
          VALUES('reconcile-expired-run','agency-a','DOCUMENT_RECONCILE');
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'a'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
          WHERE id='reconcile-expired-run';
        UPDATE background_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-expired-run';
      `),
    );
    const lateRunInsert = execute(`
      INSERT INTO background_job_runs
        (id,agency_id,job_id,attempt_number,lease_token_hash,started_at)
      SELECT 'reconcile-expired-run-attempt','agency-a',job.id,job.attempt_count,
        job.lease_token_hash,job.created_at
      FROM background_jobs job WHERE job.agency_id='agency-a' AND job.id='reconcile-expired-run'
    `);
    expect(lateRunInsert.status).not.toBe(0);
    expect(`${lateRunInsert.stdout}\\n${lateRunInsert.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_INVALID',
    );
    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type)
          VALUES('reconcile-backdated-start','agency-a','DOCUMENT_RECONCILE');
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'b'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
          WHERE id='reconcile-backdated-start';
      `),
    );
    const backdatedRunStart = execute(`
      INSERT INTO background_job_runs
        (id,agency_id,job_id,attempt_number,lease_token_hash,started_at)
      VALUES('reconcile-backdated-start-run','agency-a','reconcile-backdated-start',1,
        '${'b'.repeat(64)}','2000-01-01T00:00:00.000Z')
    `);
    expect(backdatedRunStart.status).not.toBe(0);
    expect(`${backdatedRunStart.stdout}\\n${backdatedRunStart.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_INVALID',
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type)
          VALUES('reconcile-job-stale','agency-a','DOCUMENT_RECONCILE');
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'1'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
          WHERE id='reconcile-job-stale';
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('reconcile-run-old','agency-a','reconcile-job-stale',1,'${'1'.repeat(64)}');
      `),
    );
    const inPlaceAttemptAdvance = execute(`
      UPDATE background_jobs SET attempt_count=2
        WHERE id='reconcile-job-stale' AND status='RUNNING'
    `);
    expect(inPlaceAttemptAdvance.status).not.toBe(0);
    expect(`${inPlaceAttemptAdvance.stdout}\\n${inPlaceAttemptAdvance.stderr}`).toContain(
      'BACKGROUND_JOB_ATTEMPT_TRANSITION_INVALID',
    );
    expectSuccess(
      execute(`
        UPDATE background_jobs SET lease_expires_at=(
            SELECT strftime('%Y-%m-%dT%H:%M:%fZ',run.started_at,'+1 second')
            FROM background_job_runs run WHERE run.id='reconcile-run-old'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale';
      `),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    const expiredSameTokenExtension = execute(`
      UPDATE background_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale'
    `);
    expect(expiredSameTokenExtension.status).not.toBe(0);
    expect(`${expiredSameTokenExtension.stdout}\\n${expiredSameTokenExtension.stderr}`).toContain(
      'BACKGROUND_JOB_LEASE_RENEWAL_INVALID',
    );
    const expiredLeaseRenewal = execute(`
      UPDATE background_jobs SET lease_token_hash='${'3'.repeat(64)}',
        lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id='reconcile-job-stale' AND status='RUNNING'
    `);
    expect(expiredLeaseRenewal.status).not.toBe(0);
    expect(`${expiredLeaseRenewal.stdout}\\n${expiredLeaseRenewal.stderr}`).toContain(
      'BACKGROUND_JOB_LEASE_RENEWAL_INVALID',
    );
    const backdatedLateRun = execute(`
      UPDATE background_job_runs SET status='SUCCEEDED',
        completed_at=(SELECT started_at FROM background_job_runs WHERE id='reconcile-run-old')
      WHERE id='reconcile-run-old'
    `);
    expect(backdatedLateRun.status).not.toBe(0);
    expect(`${backdatedLateRun.stdout}\\n${backdatedLateRun.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_IMMUTABLE',
    );
    const retryWithoutRunResult = execute(`
      UPDATE background_jobs SET status='RETRY_WAIT',lease_token_hash=NULL,
        lease_expires_at=NULL,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale'
    `);
    expect(retryWithoutRunResult.status).not.toBe(0);
    expect(`${retryWithoutRunResult.stdout}\\n${retryWithoutRunResult.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_COMPLETION_REQUIRED',
    );
    expectSuccess(
      execute(`UPDATE background_job_runs SET status='STALE',reason_code='LEASE_EXPIRED',
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-run-old'`),
    );
    const retryWithoutBackoff = execute(`
      UPDATE background_jobs SET status='RETRY_WAIT',lease_token_hash=NULL,
        lease_expires_at=NULL,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale'
    `);
    expect(retryWithoutBackoff.status).not.toBe(0);
    expect(`${retryWithoutBackoff.stdout}\\n${retryWithoutBackoff.stderr}`).toContain(
      'BACKGROUND_JOB_RETRY_SCHEDULE_INVALID',
    );
    expectSuccess(
      execute(`UPDATE background_jobs SET status='RETRY_WAIT',lease_token_hash=NULL,
        lease_expires_at=NULL,available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 seconds'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale'`),
    );

    expectSuccess(
      execute(`
        INSERT INTO background_jobs(id,agency_id,job_type)
          VALUES('reconcile-completion-clock','agency-a','DOCUMENT_RECONCILE');
        UPDATE background_jobs SET status='RUNNING',attempt_count=1,
          lease_token_hash='${'c'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes')
          WHERE id='reconcile-completion-clock';
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('reconcile-completion-clock-run','agency-a','reconcile-completion-clock',1,
            '${'c'.repeat(64)}');
      `),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_100));
    const backdatedRunCompletion = execute(`
      UPDATE background_job_runs SET status='SUCCEEDED',
        completed_at=(SELECT started_at FROM background_job_runs
          WHERE id='reconcile-completion-clock-run')
      WHERE id='reconcile-completion-clock-run'
    `);
    expect(backdatedRunCompletion.status).not.toBe(0);
    expect(`${backdatedRunCompletion.stdout}\\n${backdatedRunCompletion.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_IMMUTABLE',
    );
    expectSuccess(
      execute(`
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='reconcile-completion-clock-run';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id='reconcile-completion-clock';
      `),
    );
    expectSuccess(
      execute(`
        UPDATE background_jobs SET status='RUNNING',attempt_count=2,
          lease_token_hash='${'2'.repeat(64)}',
          lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale';
        INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
          VALUES('reconcile-run-new','agency-a','reconcile-job-stale',2,'${'2'.repeat(64)}');
      `),
    );
    const staleRunCompletion = execute(`
      UPDATE background_job_runs SET status='SUCCEEDED',
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-run-old'
    `);
    expect(staleRunCompletion.status).not.toBe(0);
    expect(`${staleRunCompletion.stdout}\n${staleRunCompletion.stderr}`).toContain(
      'BACKGROUND_JOB_RUN_IMMUTABLE',
    );
    expectSuccess(
      execute(`
        UPDATE background_job_runs SET status='SUCCEEDED',
          completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-run-new';
        UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,
          lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='reconcile-job-stale';
      `),
    );
  }, 180_000);

  it('0014 tabanından 0015 upgrade kayıtları korur, tenant FK/trigger envanterini kurar ve no-op olur', () => {
    const upgradeDir = mkdtempSync(join(tmpdir(), 'mayi-documents-m4-upgrade-'));
    const upgradeMigrations = join(upgradeDir, 'migrations');
    const priorConfigPath = configPath;
    const priorStateDir = stateDir;
    stateDir = join(upgradeDir, 'state');
    configPath = join(upgradeDir, 'wrangler.jsonc');
    mkdirSync(upgradeMigrations);
    mkdirSync(stateDir);
    const priorMigrations = migrations.filter((file) => Number(file.slice(0, 4)) <= 14);
    for (const migration of priorMigrations) {
      copyFileSync(resolve(root, 'db/migrations', migration), join(upgradeMigrations, migration));
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'mayi-documents-m4-upgrade-local',
        compatibility_date: '2026-09-01',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'mayi-documents-m4-upgrade-local',
            database_id: '00000000-0000-0000-0000-000000000016',
            migrations_dir: upgradeMigrations,
          },
        ],
      }),
    );

    try {
      const baseApply = run([
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--persist-to',
        stateDir,
      ]);
      expectSuccess(baseApply);
      expectSuccess(
        execute(`
          INSERT INTO agencies(id,status) VALUES('upgrade-agency','PROVISIONING');
          INSERT INTO users(id,status) VALUES('upgrade-user','INACTIVE');
          INSERT INTO agency_memberships
            (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
          VALUES('upgrade-membership','upgrade-agency','upgrade-user','OWNER','INVITED',
            'upgrade@example.test','2099-01-01T00:00:00.000Z');
          INSERT INTO customers
            (id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
          VALUES('upgrade-customer','upgrade-agency','INDIVIDUAL','Preserved Customer',
            'Preserved','Customer','upgrade-membership');
        `),
      );
      const before = execute(`
        SELECT agency.id AS agency_id, customer.id AS customer_id,
          customer.display_name, membership.id AS membership_id
        FROM agencies agency
        JOIN agency_memberships membership ON membership.agency_id=agency.id
        JOIN customers customer ON customer.agency_id=agency.id
        WHERE agency.id='upgrade-agency'
      `);
      expectSuccess(before);

      copyFileSync(
        resolve(root, 'db/migrations', '0015_living_frog_thor.sql'),
        join(upgradeMigrations, '0015_living_frog_thor.sql'),
      );
      const upgraded = run([
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--persist-to',
        stateDir,
      ]);
      expectSuccess(upgraded);
      const after = execute(`
        SELECT agency.id AS agency_id, customer.id AS customer_id,
          customer.display_name, membership.id AS membership_id
        FROM agencies agency
        JOIN agency_memberships membership ON membership.agency_id=agency.id
        JOIN customers customer ON customer.agency_id=agency.id
        WHERE agency.id='upgrade-agency'
      `);
      expectSuccess(after);
      const rows = (result: CommandResult) =>
        (JSON.parse(result.stdout) as Array<{ results: unknown[] }>).flatMap(
          (entry) => entry.results,
        );
      expect(rows(after)).toEqual(rows(before));

      const foreignKeys = execute("PRAGMA foreign_key_list('documents')");
      expectSuccess(foreignKeys);
      for (const table of ['customers', 'policies', 'renewal_quotes'])
        expect(foreignKeys.stdout).toContain(table);
      const versionKeys = execute("PRAGMA foreign_key_list('document_versions')");
      expectSuccess(versionKeys);
      expect(versionKeys.stdout).toContain('documents');
      expect(versionKeys.stdout).toContain('agency_memberships');
      const foreignKeyCheck = execute('PRAGMA foreign_key_check');
      expectSuccess(foreignKeyCheck);
      expect(rows(foreignKeyCheck)).toEqual([]);

      const triggerInventory = execute(`
        SELECT name FROM sqlite_master WHERE type='trigger'
          AND (name LIKE 'documents_%' OR name LIKE 'document_%' OR name LIKE 'background_job%')
        ORDER BY name
      `);
      expectSuccess(triggerInventory);
      for (const name of [
        'documents_current_version_guard',
        'documents_update_version_guard',
        'documents_version_transition_guard',
        'documents_creator_membership_guard',
        'documents_identity_immutable',
        'documents_no_delete',
        'document_versions_insert_guard',
        'document_versions_creator_membership_guard',
        'document_versions_new_revision_unpublishes_current',
        'document_versions_current_pointer_clear_guard',
        'document_versions_no_delete',
        'document_version_state_transition_guard',
        'background_jobs_insert_guard',
        'background_jobs_rescan_quarantine_guard',
        'background_jobs_backup_unpublish_guard',
        'background_jobs_schedule_retry_guard',
        'background_jobs_retry_attempt_guard',
        'background_jobs_retry_eligibility_guard',
        'background_jobs_lease_claim_guard',
        'background_jobs_lease_renewal_guard',
        'background_jobs_dead_attempt_guard',
        'background_jobs_dead_fail_closed',
        'background_jobs_available_at_guard',
        'background_jobs_attempt_transition_guard',
        'background_jobs_retry_run_guard',
        'background_jobs_completion_evidence_guard',
        'background_jobs_no_delete',
        'background_job_runs_insert_guard',
        'background_job_runs_update_guard',
        'document_scan_evidence_insert_guard',
        'document_scan_evidence_finalize_failure',
        'document_scan_evidence_immutable_delete',
        'document_backup_copies_insert_guard',
        'document_backup_copies_immutable_delete',
      ]) {
        expect(triggerInventory.stdout).toContain(name);
      }

      const rerun = run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', stateDir]);
      expectSuccess(rerun);
      expect(`${rerun.stdout}\n${rerun.stderr}`).toContain('No migrations to apply');
    } finally {
      configPath = priorConfigPath;
      stateDir = priorStateDir;
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  }, 180_000);
});

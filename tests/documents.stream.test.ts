// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { VerifiedAccessPrincipal } from '../src/server/auth/types';
import { createApp, type Env } from '../src/server';
import { generateIdentityBoundCsrfToken } from '../src/server/security/csrf';
import { processDocumentBackupMessage } from '../src/server/documents/backup';
import { createR2DocumentBackupAdapter } from '../src/server/documents/backup-storage';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';
import { createSyntheticPdf } from './fixtures/documents';
import {
  downloadDocument,
  issueDocumentDownloadGrant,
  documentDownloadConfirmation,
} from '../src/server/documents/stream';
import { listRenewalQuotes } from '../src/server/renewals/engagement';
import { createDocumentUpload } from '../src/server/documents/service';
import {
  enqueueDocumentReconcile,
  processDocumentReconcileMessage,
} from '../src/server/documents/reconcile';
import { createR2DocumentReconcileStorage } from '../src/server/documents/reconcile-storage';
const timestamp = '2026-09-28T12:00:00.000Z';
const agencyId = 'upload-agency-a';
const userId = 'upload-owner-a';
const membershipId = 'upload-membership-a';
const identityId = 'upload-identity-a';
const customerId = 'upload-customer-a';
const memberUserId = 'upload-member-user-a';
const memberId = 'upload-member-a';
const memberIdentityId = 'upload-member-identity-a';
const otherAgencyId = 'upload-agency-b';
const otherMembershipId = 'upload-membership-b';
const otherCustomerId = 'upload-customer-b';
const policyId = 'upload-policy-a';
const renewalId = 'upload-renewal-a';
const quoteId = 'upload-quote-a';
const healthPolicyId = 'upload-health-policy-a';
const healthRenewalId = 'upload-health-renewal-a';
const healthQuoteId = 'upload-health-quote-a';
const teamDomain = 'upload-test.cloudflareaccess.com';
const csrfSecret = 'synthetic-upload-csrf-secret-with-at-least-32-bytes';

const ownerContext: AuthenticatedUserContext = {
  userId,
  identityId,
  assurance: 'NORMAL',
  memberships: [
    {
      id: membershipId,
      agencyId,
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};

const memberContext: AuthenticatedUserContext = {
  userId: memberUserId,
  identityId: memberIdentityId,
  assurance: 'NORMAL',
  memberships: [
    {
      id: memberId,
      agencyId,
      type: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 1,
    },
  ],
};

const principal: VerifiedAccessPrincipal = {
  issuer: `https://${teamDomain}`,
  subject: 'upload-owner-subject',
  assurance: 'NORMAL',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

let db: D1Database;
let source: R2Bucket;
let destination: R2Bucket;
let dispose: () => Promise<void>;
const bytes = createSyntheticPdf();
let checksum: string;
let directory: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mayi-stream-'));
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'mayi-stream-local',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'stream-local',
          database_id: '00000000-0000-0000-0000-000000000019',
        },
      ],
      r2_buckets: [
        { binding: 'DOCS_QUARANTINE', bucket_name: 'stream-primary' },
        { binding: 'BACKUP', bucket_name: 'stream-backup' },
      ],
    }),
  );
  const platform = await getPlatformProxy<{
    DB: D1Database;
    DOCS_QUARANTINE: R2Bucket;
    BACKUP: R2Bucket;
  }>({
    configPath,
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  db = platform.env.DB;
  source = platform.env.DOCS_QUARANTINE;
  destination = platform.env.BACKUP;
  dispose = platform.dispose;
  for (const name of readdirSync('db/migrations')
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
    .sort()) {
    for (const sql of readFileSync(resolve('db/migrations', name), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  }
  checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  await db
    .prepare(`INSERT INTO agencies(id,status,version) VALUES(?, 'PROVISIONING', 1)`)
    .bind(agencyId)
    .run();
  await db
    .prepare("INSERT INTO users(id,status,version) VALUES(?, 'INACTIVE', 1)")
    .bind(userId)
    .run();
  await db
    .prepare(
      `INSERT INTO agency_memberships
        (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,
         activated_at,version,permission_version)
       VALUES(?,?,?,'OWNER','INVITED',?, ?,NULL,1,1)`,
    )
    .bind(membershipId, agencyId, userId, 'upload@example.test', '2099-01-01T00:00:00.000Z')
    .run();
  await db
    .prepare(
      `INSERT INTO auth_identities
        (id,user_id,issuer,subject,verified_email,status)
       VALUES(?,?,?,?,?,'ACTIVE')`,
    )
    .bind(identityId, userId, principal.issuer, principal.subject, 'upload@example.test')
    .run();
  await db
    .prepare("UPDATE users SET status='ACTIVE',version=version+1 WHERE id=?")
    .bind(userId)
    .run();
  await db
    .prepare(
      `UPDATE agency_memberships SET status='ACTIVE',activated_at=?,
         version=version+1,permission_version=permission_version+1 WHERE id=?`,
    )
    .bind(timestamp, membershipId)
    .run();
  await db
    .prepare(
      `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at=?,activated_at=?,version=version+1
       WHERE id=?`,
    )
    .bind(timestamp, timestamp, agencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO customers
        (id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
       VALUES(?,?,'INDIVIDUAL','Synthetic Upload Customer','Synthetic','Upload',?)`,
    )
    .bind(customerId, agencyId, membershipId)
    .run();

  await db
    .prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('upload-insurer',?,'UP','Upload')",
    )
    .bind(agencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
       VALUES('upload-branch',?,'UP','Upload Branch','GENERAL')`,
    )
    .bind(agencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
       VALUES('upload-product',?,'upload-insurer','upload-branch','UP','Upload Product')`,
    )
    .bind(agencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
       VALUES('upload-health-branch',?,'UH','Health Branch','HEALTH')`,
    )
    .bind(agencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
       VALUES('upload-health-product',?,'upload-insurer','upload-health-branch','UH','Health Product')`,
    )
    .bind(agencyId)
    .run();
  await db
    .prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('upload-payment',?,'UP','Upload')",
    )
    .bind(agencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO policies
        (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
         assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
         gross_premium_minor,currency)
       VALUES(?,?,?,'upload-insurer','upload-product','upload-branch','upload-payment',?,
         'UPLOAD-POLICY','UPLOADPOLICY','2026-01-01','2026-12-31',10000,'TRY')`,
    )
    .bind(policyId, agencyId, customerId, membershipId)
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_opportunities
        (id,agency_id,expiring_policy_id,assignee_membership_id,state,version)
       VALUES(?,?,?,?,'CONTACT_PENDING',1)`,
    )
    .bind(renewalId, agencyId, policyId, membershipId)
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_state_history
        (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
       VALUES('upload-renewal-history',?, ?,NULL,'CONTACT_PENDING','SYSTEM','GENERATED',?)`,
    )
    .bind(agencyId, renewalId, timestamp)
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_quotes
        (id,agency_id,renewal_id,status,version,created_by_user_id,created_by_membership_id)
       VALUES(?,?,?,'DRAFT',1,?,?)`,
    )
    .bind(quoteId, agencyId, renewalId, userId, membershipId)
    .run();

  await db
    .prepare(
      `INSERT INTO policies
        (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
         assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
         gross_premium_minor,currency)
       VALUES(?,?,?,'upload-insurer','upload-health-product','upload-health-branch','upload-payment',?,
         'UPLOAD-HEALTH-POLICY','UPLOADHEALTHPOLICY','2026-01-01','2026-12-31',10000,'TRY')`,
    )
    .bind(healthPolicyId, agencyId, customerId, membershipId)
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_opportunities
        (id,agency_id,expiring_policy_id,assignee_membership_id,state,version)
       VALUES(?,?,?,?,'CONTACT_PENDING',1)`,
    )
    .bind(healthRenewalId, agencyId, healthPolicyId, membershipId)
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_state_history
        (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
       VALUES('upload-health-renewal-history',?, ?,NULL,'CONTACT_PENDING','SYSTEM','GENERATED',?)`,
    )
    .bind(agencyId, healthRenewalId, timestamp)
    .run();
  await db
    .prepare(
      `INSERT INTO renewal_quotes
        (id,agency_id,renewal_id,status,version,created_by_user_id,created_by_membership_id)
       VALUES(?,?,?,'DRAFT',1,?,?)`,
    )
    .bind(healthQuoteId, agencyId, healthRenewalId, userId, membershipId)
    .run();

  await db
    .prepare("INSERT INTO users(id,status,version) VALUES(?, 'ACTIVE', 1)")
    .bind(memberUserId)
    .run();
  await db
    .prepare(
      `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
       VALUES(?,?,?,?,?,'ACTIVE')`,
    )
    .bind(
      memberIdentityId,
      memberUserId,
      principal.issuer,
      'upload-member-subject',
      'member@example.test',
    )
    .run();
  await db
    .prepare(
      `INSERT INTO agency_memberships
        (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,activated_at,
         version,permission_version)
       VALUES(?,?,?,'MEMBER','ACTIVE',?,?,?,1,1)`,
    )
    .bind(
      memberId,
      agencyId,
      memberUserId,
      'member@example.test',
      '2099-01-01T00:00:00.000Z',
      timestamp,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
       VALUES('upload-member-customer-read',?,'customer.read','AGENCY')`,
    )
    .bind(memberId)
    .run();

  await db
    .prepare(`INSERT INTO agencies(id,status,version) VALUES(?, 'PROVISIONING', 1)`)
    .bind(otherAgencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO agency_memberships
        (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,
         activated_at,version,permission_version)
       VALUES(?,?,?,'OWNER','INVITED',?,?,NULL,1,1)`,
    )
    .bind(
      otherMembershipId,
      otherAgencyId,
      userId,
      'upload@example.test',
      '2099-01-01T00:00:00.000Z',
    )
    .run();
  await db
    .prepare(
      `UPDATE agency_memberships SET status='ACTIVE',activated_at=?,
         version=version+1,permission_version=permission_version+1 WHERE id=?`,
    )
    .bind(timestamp, otherMembershipId)
    .run();
  await db
    .prepare(
      `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at=?,activated_at=?,version=version+1
       WHERE id=?`,
    )
    .bind(timestamp, timestamp, otherAgencyId)
    .run();
  await db
    .prepare(
      `INSERT INTO customers
        (id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
       VALUES(?,?,'INDIVIDUAL','Synthetic Other Customer','Other','Customer',?)`,
    )
    .bind(otherCustomerId, otherAgencyId, otherMembershipId)
    .run();
}, 180000);
afterAll(async () => {
  await dispose?.();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function pendingFixture(
  ownerType: 'CUSTOMER' | 'POLICY' | 'QUOTE' = 'CUSTOMER',
  ownerId = customerId,
) {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const scanId = crypto.randomUUID();
  const scanRunId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const key = `quarantine/${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO documents(id,agency_id,owner_type,customer_id,policy_id,quote_id,created_by_user_id,created_by_membership_id)
    VALUES(?,'upload-agency-a',?,?,?,?,'upload-owner-a','upload-membership-a')`,
    )
    .bind(
      documentId,
      ownerType,
      ownerType === 'CUSTOMER' ? ownerId : null,
      ownerType === 'POLICY' ? ownerId : null,
      ownerType === 'QUOTE' ? ownerId : null,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id)
    VALUES(?,'upload-agency-a',?,1,?,?,?,'synthetic.pdf','application/pdf','upload-owner-a','upload-membership-a')`,
    )
    .bind(versionId, documentId, key, checksum, bytes.byteLength)
    .run();
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
    VALUES(?,'upload-agency-a','DOCUMENT_SCAN',?,?)`,
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
    VALUES(?,'upload-agency-a',?,1,?)`,
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
    SELECT ?,'upload-agency-a',?,?,?,'CLEAN','synthetic-engine','synthetic-signature',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),completed_at,'m4-content-inspection-v1','{"format":"PDF","pageCount":1,"valid":true}' FROM background_job_runs WHERE id=?`,
    )
    .bind(crypto.randomUUID(), versionId, scanRunId, checksum, scanRunId)
    .run();
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
    VALUES(?,'upload-agency-a','DOCUMENT_BACKUP',?,?)`,
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

async function availableFixture(
  ownerType: 'CUSTOMER' | 'POLICY' | 'QUOTE' = 'CUSTOMER',
  ownerId = customerId,
) {
  const f = await pendingFixture(ownerType, ownerId);
  expect(
    await processDocumentBackupMessage(
      db,
      source,
      createR2DocumentBackupAdapter(destination),
      f.message,
    ),
  ).toBe('COMPLETED');
  return f;
}
async function appFor(context = ownerContext, bucket: Pick<R2Bucket, 'get'> = source) {
  const p = { ...principal, assurance: context.assurance };
  const app = createApp({
    createVerifier: (config) => ({
      config,
      verify: async (_request, expected) => {
        if (expected && expected !== p.assurance) throw new Error('WRONG_AUDIENCE');
        return p;
      },
    }),
    createResolver: () => ({ resolve: async () => context }),
  });
  const env: Env = {
    DB: db,
    DOCS_QUARANTINE: bucket as R2Bucket,
    DOCUMENTS_ENABLED: 'true',
    PANEL_ORIGIN: 'https://panel.example.test',
    APP_ENV: 'test',
    CF_ACCESS_TEAM_DOMAIN: teamDomain,
    CF_ACCESS_AUDIENCE: 'normal',
    CF_ACCESS_SECURE_AUDIENCE: 'secure',
    CSRF_SECRET: csrfSecret,
  };
  const csrf = await generateIdentityBoundCsrfToken({ subject: p.subject }, csrfSecret);
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    app.request(
      'https://panel.example.test' + path,
      {
        method: 'POST',
        headers: {
          Origin: env.PANEL_ORIGIN as string,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          ...headers,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  return { app, env, post };
}
// Corruption fixtures disable only this isolated synthetic DB's table triggers, then
// restore their exact SQL. Historical migration files and production guards are untouched.
async function corruptTable(table: string, statement: D1PreparedStatement) {
  const triggers = await db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
    .bind(table)
    .all<{ name: string; sql: string }>();
  try {
    for (const trigger of triggers.results)
      await db.prepare(`DROP TRIGGER "${trigger.name}"`).run();
    await statement.run();
  } finally {
    for (const trigger of triggers.results) await db.prepare(trigger.sql).run();
  }
}
describe('authorized validated primary document stream (including historical scans)', () => {
  it('uploads, backs up, downloads and reconciles valid staff bytes with no scanner or CLEAN row', async () => {
    const uploaded = await createDocumentUpload(
      db,
      source,
      ownerContext,
      {
        ownerType: 'CUSTOMER',
        ownerId: customerId,
        classification: 'GENERAL',
        fileName: '../../unsafe.pdf',
        declaredContentType: 'application/pdf',
        file: new Blob([bytes], { type: 'application/pdf' }),
      },
      { correlationId: 'internal-flow', idempotencyKey: 'internal-flow' },
    );
    const row = await db
      .prepare(
        `SELECT id,generation,input_sha256 FROM background_jobs WHERE document_version_id=? AND job_type='DOCUMENT_BACKUP'`,
      )
      .bind(uploaded.body.versionId)
      .first<{ id: string; generation: number; input_sha256: string }>();
    const message: DocumentJobQueueMessage = {
      jobId: row!.id,
      jobType: 'DOCUMENT_BACKUP',
      generation: row!.generation,
      documentVersionId: uploaded.body.versionId,
      inputSha256: row!.input_sha256,
    };
    await expect(
      downloadDocument(db, source, ownerContext, uploaded.body.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        message,
      ),
    ).toBe('COMPLETED');
    const response = await downloadDocument(db, source, ownerContext, uploaded.body.documentId, {});
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="document.pdf"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
    await expect(
      downloadDocument(db, source, memberContext, uploaded.body.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
        .bind(uploaded.body.versionId)
        .first('count'),
    ).toBe(0);
    const job = await enqueueDocumentReconcile(
      db,
      agencyId,
      { versionId: uploaded.body.versionId },
      crypto.randomUUID(),
    );
    expect(
      await processDocumentReconcileMessage(
        db,
        createR2DocumentReconcileStorage(source, destination),
        job,
      ),
    ).toBe('SAFE_NOOP');
  });
  it.each(['renewal.read', 'policy.read', 'customer.read'] as const)(
    'retains Quote parent %s authority across confirmation, issuance and download',
    async (revoked) => {
      const f = await availableFixture('QUOTE', quoteId);
      const additions = new Map<string, string>();
      for (const code of [
        'document.read',
        'policy.read',
        'renewal.read',
        'quote.read',
        'sensitive.identity.read',
      ]) {
        const grantId = crypto.randomUUID();
        additions.set(code, grantId);
        await db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(grantId, memberId, code, code.startsWith('sensitive.') ? 'UNSCOPED' : 'AGENCY')
          .run();
      }
      const revokedId =
        revoked === 'customer.read' ? 'upload-member-customer-read' : additions.get(revoked)!;
      try {
        expect((await downloadDocument(db, source, memberContext, f.documentId, {})).status).toBe(
          200,
        );
        await db
          .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
          .bind(f.documentId)
          .run();
        const context = { ...memberContext, assurance: 'SECURE' as const };
        const confirmation = await documentDownloadConfirmation(db, context, f.documentId);
        const body = {
          expectedVersion: confirmation.expectedVersion,
          versionId: confirmation.versionId,
          checksum: confirmation.checksum,
          confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
        };
        const grant = await issueDocumentDownloadGrant(
          db,
          context,
          f.documentId,
          body,
          crypto.randomUUID(),
        );
        await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(revokedId).run();
        await expect(listRenewalQuotes(memberContext, db, renewalId)).rejects.toMatchObject({
          status: 403,
        });
        await expect(documentDownloadConfirmation(db, context, f.documentId)).rejects.toMatchObject(
          { status: 404 },
        );
        await expect(
          issueDocumentDownloadGrant(db, context, f.documentId, body, crypto.randomUUID()),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          downloadDocument(
            db,
            {
              get() {
                throw new Error('lost parent authority cannot reach storage');
              },
            },
            context,
            f.documentId,
            { ...body, grantEvidenceToken: grant.grantEvidenceToken },
          ),
        ).rejects.toMatchObject({ status: 404 });
      } finally {
        if (revoked === 'customer.read')
          await db
            .prepare(
              "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('upload-member-customer-read',?,'customer.read','AGENCY')",
            )
            .bind(memberId)
            .run();
        for (const grantId of additions.values())
          await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grantId).run();
      }
    },
  );
  it('records a safe security denial for sensitive access without implicit OWNER permission', async () => {
    const f = await availableFixture();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(f.documentId)
      .run();
    const { post } = await appFor({ ...ownerContext, assurance: 'SECURE' });
    expect((await post('/secure/api/documents/' + f.documentId + '/download')).status).toBe(404);
    const audit = await db
      .prepare(
        "SELECT outcome,metadata_json FROM audit_events WHERE action='sensitive_action.denied' AND target_id=?",
      )
      .bind(f.documentId)
      .all<{ outcome: string; metadata_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.outcome).toBe('FAILURE');
    expect(JSON.parse(audit.results[0]!.metadata_json)).toEqual({
      reasonCode: 'SENSITIVE_ACCESS_DENIED',
      requestSource: 'DOCUMENT_STREAM',
    });
    expect(audit.results[0]?.metadata_json).not.toContain('synthetic.pdf');
    const secretName = 'confidential-customer-file.pdf';
    expect((await post('/secure/api/documents/' + secretName + '/download')).status).toBe(404);
    const attempts = await db
      .prepare(
        "SELECT target_id,metadata_json FROM audit_events WHERE action='sensitive_action.denied' AND target_type='document_access_attempts'",
      )
      .all<{ target_id: string; metadata_json: string }>();
    expect(attempts.results).toHaveLength(1);
    expect(JSON.stringify(attempts.results)).not.toContain(secretName);
  });
  it('requires explicit HEALTH permission and a secure exact grant for a HEALTH-backed Quote', async () => {
    const f = await availableFixture('QUOTE', healthQuoteId);
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.health.read','UNSCOPED')",
      )
      .bind(permissionId, membershipId)
      .run();
    try {
      const context = { ...ownerContext, assurance: 'SECURE' as const };
      const confirmation = await documentDownloadConfirmation(db, context, f.documentId);
      const body = {
        expectedVersion: confirmation.expectedVersion,
        versionId: confirmation.versionId,
        checksum: confirmation.checksum,
        confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
      };
      const grant = await issueDocumentDownloadGrant(
        db,
        context,
        f.documentId,
        body,
        crypto.randomUUID(),
      );
      const command = { ...body, grantEvidenceToken: grant.grantEvidenceToken };
      await expect(
        downloadDocument(db, source, context, f.documentId, {
          ...command,
          versionId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 404 });
      const response = await downloadDocument(db, source, context, f.documentId, command);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      const second = await issueDocumentDownloadGrant(
        db,
        context,
        f.documentId,
        body,
        crypto.randomUUID(),
      );
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
      await expect(
        downloadDocument(db, source, context, f.documentId, {
          ...body,
          grantEvidenceToken: second.grantEvidenceToken,
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it('rolls back grant consumption on audit failure and keeps the exact grant retryable', async () => {
    const f = await availableFixture();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(f.documentId)
      .run();
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.identity.read','UNSCOPED')",
      )
      .bind(permissionId, membershipId)
      .run();
    try {
      const context = { ...ownerContext, assurance: 'SECURE' as const };
      const confirmation = await documentDownloadConfirmation(db, context, f.documentId);
      const body = {
        expectedVersion: confirmation.expectedVersion,
        versionId: confirmation.versionId,
        checksum: confirmation.checksum,
        confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
      };
      const grant = await issueDocumentDownloadGrant(
        db,
        context,
        f.documentId,
        body,
        crypto.randomUUID(),
      );
      const command = { ...body, grantEvidenceToken: grant.grantEvidenceToken };
      await db
        .prepare(
          `CREATE TRIGGER synthetic_stream_audit_failure BEFORE INSERT ON audit_events
        WHEN NEW.action='document.download.authorized' AND NEW.target_id='${f.documentId}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_STREAM_AUDIT_FAILURE'); END`,
        )
        .run();
      try {
        await expect(
          downloadDocument(db, source, context, f.documentId, command),
        ).rejects.toMatchObject({ status: 503 });
        expect(
          await db
            .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
            .bind(grant.grantId)
            .first('status'),
        ).toBe('ISSUED');
        expect(
          await db
            .prepare(
              "SELECT count(*) AS n FROM audit_events WHERE action='document.download.authorized' AND target_id=?",
            )
            .bind(f.documentId)
            .first('n'),
        ).toBe(0);
      } finally {
        await db.prepare('DROP TRIGGER synthetic_stream_audit_failure').run();
      }
      expect((await downloadDocument(db, source, context, f.documentId, command)).status).toBe(200);
    } finally {
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it('cancels incomplete primary streams and rejects expiry before any disclosure', async () => {
    const f = await availableFixture();
    let cancelled = false;
    const stalled = {
      async get(key: string) {
        const object = await source.get(key);
        await object!.body.cancel();
        return {
          size: object!.size,
          customMetadata: object!.customMetadata,
          body: new ReadableStream<Uint8Array>({
            pull() {
              return new Promise(() => undefined);
            },
            cancel() {
              cancelled = true;
            },
          }),
        } as R2ObjectBody;
      },
    };
    await expect(
      downloadDocument(db, stalled, ownerContext, f.documentId, {}, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(cancelled).toBe(true);
    const permissionId = crypto.randomUUID();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(f.documentId)
      .run();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.identity.read','UNSCOPED')",
      )
      .bind(permissionId, membershipId)
      .run();
    try {
      const context = { ...ownerContext, assurance: 'SECURE' as const };
      const confirmation = await documentDownloadConfirmation(db, context, f.documentId);
      const body = {
        expectedVersion: confirmation.expectedVersion,
        versionId: confirmation.versionId,
        checksum: confirmation.checksum,
        confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
      };
      const grant = await issueDocumentDownloadGrant(
        db,
        context,
        f.documentId,
        body,
        crypto.randomUUID(),
      );
      await corruptTable(
        'sensitive_action_grants',
        db
          .prepare(
            "UPDATE sensitive_action_grants SET issued_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-181 seconds'),expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?",
          )
          .bind(grant.grantId),
      );
      await expect(
        downloadDocument(
          db,
          {
            get() {
              throw new Error('expired grant cannot reach source');
            },
          },
          context,
          f.documentId,
          { ...body, grantEvidenceToken: grant.grantEvidenceToken },
        ),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it.each([
    'PENDING_UPLOAD',
    'QUARANTINED',
    'SCANNING',
    'BACKUP_PENDING',
    'REJECTED',
    'SCAN_FAILED',
    'RETIRED',
  ] as const)('denies %s even with a forged current pointer', async (state) => {
    const f = await availableFixture();
    await corruptTable(
      'document_versions',
      db.prepare('UPDATE document_versions SET status=? WHERE id=?').bind(state, f.versionId),
    );
    await expect(
      downloadDocument(
        db,
        {
          get() {
            throw new Error('non-AVAILABLE must not reach storage');
          },
        },
        ownerContext,
        f.documentId,
        {},
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('denies cross-agency access and does not accept possession of an object key', async () => {
    const f = await availableFixture();
    const other = {
      ...ownerContext,
      memberships: [
        { ...ownerContext.memberships[0]!, id: otherMembershipId, agencyId: otherAgencyId },
      ],
    };
    await expect(
      downloadDocument(
        db,
        {
          get() {
            throw new Error('tenant mismatch must not reach storage');
          },
        },
        other,
        f.documentId,
        {},
      ),
    ).rejects.toMatchObject({ status: 404 });
    const { post } = await appFor();
    const byKey = await post('/api/documents/' + encodeURIComponent(f.key) + '/download');
    expect(byKey.status).toBe(404);
    expect(await byKey.text()).not.toContain(f.key);
    expect(
      (await post('/api/documents/' + f.documentId + '/download', { objectKey: f.key })).status,
    ).toBe(404);
  });
  it('requires both current parent scope and normal document.read scope for a Member', async () => {
    const f = await availableFixture();
    const { post } = await appFor(memberContext);
    const path = '/api/documents/' + f.documentId + '/download';
    expect((await post(path)).status).toBe(404);
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'document.read','AGENCY')",
      )
      .bind(permissionId, memberId)
      .run();
    try {
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='ASSIGNED' WHERE id='upload-member-customer-read'",
        )
        .run();
      expect((await post(path)).status).toBe(404);
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE id='upload-member-customer-read'",
        )
        .run();
      await db
        .prepare("UPDATE membership_permissions SET scope='ASSIGNED' WHERE id=?")
        .bind(permissionId)
        .run();
      expect((await post(path)).status).toBe(404);
      await db
        .prepare('UPDATE customers SET assignee_membership_id=?,version=version+1 WHERE id=?')
        .bind(memberId, customerId)
        .run();
      expect((await post(path)).status).toBe(200);
      await db
        .prepare('UPDATE customers SET assignee_membership_id=?,version=version+1 WHERE id=?')
        .bind(membershipId, customerId)
        .run();
      expect((await post(path)).status).toBe(404);
    } finally {
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='AGENCY' WHERE id='upload-member-customer-read'",
        )
        .run();
      await db
        .prepare('UPDATE customers SET assignee_membership_id=?,version=version+1 WHERE id=?')
        .bind(membershipId, customerId)
        .run();
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it.each(['POLICY', 'QUOTE'] as const)(
    'serves an authorized AVAILABLE %s parent without borrowing sibling scope',
    async (type) => {
      const f = await availableFixture(type, type === 'POLICY' ? policyId : quoteId);
      const response = await downloadDocument(db, source, ownerContext, f.documentId, {});
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );
  it('does not grant OWNER implicit sensitive access or allow HEALTH parents to masquerade as GENERAL', async () => {
    const identity = await availableFixture();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(identity.documentId)
      .run();
    await expect(
      documentDownloadConfirmation(
        db,
        { ...ownerContext, assurance: 'SECURE' },
        identity.documentId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const health = await availableFixture('POLICY', healthPolicyId);
    const quote = await availableFixture('QUOTE', healthQuoteId);
    for (const f of [health, quote])
      await expect(
        downloadDocument(db, source, { ...ownerContext, assurance: 'SECURE' }, f.documentId, {}),
      ).rejects.toMatchObject({ status: 404 });
  });
  it('fails closed when permission or parent assignment changes across the source read await', async () => {
    const f = await availableFixture();
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'document.read','AGENCY')",
      )
      .bind(permissionId, memberId)
      .run();
    try {
      const revoke = {
        async get(key: string) {
          const object = await source.get(key);
          await db
            .prepare('DELETE FROM membership_permissions WHERE id=?')
            .bind(permissionId)
            .run();
          return object;
        },
      };
      await expect(
        downloadDocument(db, revoke, memberContext, f.documentId, {}),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE target_id=? AND action='document.download.authorized'",
          )
          .bind(f.documentId)
          .first('n'),
      ).toBe(0);
      await db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'document.read','ASSIGNED')",
        )
        .bind(permissionId, memberId)
        .run();
      await db
        .prepare('UPDATE customers SET assignee_membership_id=?,version=version+1 WHERE id=?')
        .bind(memberId, customerId)
        .run();
      const reassign = {
        async get(key: string) {
          const object = await source.get(key);
          await db
            .prepare('UPDATE customers SET assignee_membership_id=?,version=version+1 WHERE id=?')
            .bind(membershipId, customerId)
            .run();
          return object;
        },
      };
      await expect(
        downloadDocument(db, reassign, memberContext, f.documentId, {}),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await db
        .prepare('UPDATE customers SET assignee_membership_id=?,version=version+1 WHERE id=?')
        .bind(membershipId, customerId)
        .run();
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it('denies a previous AVAILABLE version after a newer revision is inserted during storage access', async () => {
    const f = await availableFixture();
    const changed = {
      async get(key: string) {
        const object = await source.get(key);
        await db
          .prepare(
            `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES(?,?,?,2,?,?,?,'synthetic.pdf','application/pdf',?,?)`,
          )
          .bind(
            crypto.randomUUID(),
            agencyId,
            f.documentId,
            `quarantine/${crypto.randomUUID()}`,
            checksum,
            bytes.byteLength,
            userId,
            membershipId,
          )
          .run();
        return object;
      },
    };
    await expect(
      downloadDocument(db, changed, ownerContext, f.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      downloadDocument(db, source, ownerContext, f.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('denies missing and changed serving objects without treating metadata checksum as byte proof', async () => {
    const f = await availableFixture();
    await source.delete(f.key);
    await expect(
      downloadDocument(db, source, ownerContext, f.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
    await source.put(f.key, new Uint8Array(bytes.byteLength), {
      customMetadata: { sha256: checksum },
    });
    await expect(
      downloadDocument(db, source, ownerContext, f.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('denies missing CLEAN or backup evidence even if AVAILABLE remains persisted', async () => {
    const scan = await availableFixture();
    await corruptTable(
      'document_scan_evidence',
      db
        .prepare('DELETE FROM document_scan_evidence WHERE document_version_id=?')
        .bind(scan.versionId),
    );
    await expect(
      downloadDocument(db, source, ownerContext, scan.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
    const backup = await availableFixture();
    await corruptTable(
      'document_backup_copies',
      db
        .prepare('DELETE FROM document_backup_copies WHERE document_version_id=?')
        .bind(backup.versionId),
    );
    await expect(
      downloadDocument(db, source, ownerContext, backup.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('ignores unsupported Range only after authorization and never trusts storage filename headers', async () => {
    const f = await availableFixture();
    await expect(
      corruptTable(
        'document_versions',
        db
          .prepare('UPDATE document_versions SET file_name=? WHERE id=?')
          .bind('bad"\r\nLocation: https://bad.invalid.pdf', f.versionId),
      ),
    ).rejects.toThrow('document_versions_file_name_shape');
    await corruptTable(
      'document_versions',
      db
        .prepare('UPDATE document_versions SET file_name=? WHERE id=?')
        .bind('özel %0D%0A gizli.pdf', f.versionId),
    );
    const hostile = {
      async get(key: string) {
        const object = await source.get(key);
        return object
          ? ({
              body: object.body,
              size: object.size,
              customMetadata: object.customMetadata,
              httpMetadata: {
                contentType: 'text/html',
                contentDisposition: 'inline; filename="bad"\r\nLocation: https://bad.invalid',
              },
            } as R2ObjectBody)
          : null;
      },
    };
    const authorized = await appFor(ownerContext, hostile);
    const response = await authorized.post(
      '/api/documents/' + f.documentId + '/download',
      {},
      { Range: 'bytes=0-1' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('none');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="document.pdf"');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('location')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const denied = await appFor(memberContext, {
      get() {
        throw new Error('Range cannot reach storage without auth');
      },
    });
    // POST downloads deliberately do not implement HTTP GET Range semantics.
    for (const range of ['bytes=oops', 'bytes=0-1,4-5', 'bytes=-999999999999999999']) {
      const full = await authorized.post(
        '/api/documents/' + f.documentId + '/download',
        {},
        { Range: range },
      );
      expect(full.status).toBe(200);
      expect(full.headers.get('content-range')).toBeNull();
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
      expect(
        (await denied.post('/api/documents/' + f.documentId + '/download', {}, { Range: range }))
          .status,
      ).toBe(404);
    }
    expect(
      (
        await denied.post(
          '/api/documents/' + f.documentId + '/download',
          {},
          { Range: 'bytes=0-1' },
        )
      ).status,
    ).toBe(404);
  });
  it('gates the module off and requires authentication and CSRF before disclosure', async () => {
    const f = await availableFixture();
    const { app, env, post } = await appFor();
    const request = () =>
      new Request('https://panel.example.test/api/documents/' + f.documentId + '/download', {
        method: 'POST',
        headers: { Origin: 'https://panel.example.test', 'Content-Type': 'application/json' },
        body: '{}',
      });
    expect(
      (await app.request(request(), undefined, { ...env, DOCUMENTS_ENABLED: 'false' })).status,
    ).toBe(404);
    expect((await app.request(request(), undefined, env)).status).toBe(403);
    const denied = createApp({
      createVerifier: (config) => ({
        config,
        verify: async () => {
          throw new Error('UNAUTHORIZED');
        },
      }),
    });
    expect((await denied.request(request(), undefined, env)).status).toBe(401);
    expect(
      (
        await post(
          '/api/documents/' + f.documentId + '/download?objectKey=' + encodeURIComponent(f.key),
        )
      ).status,
    ).toBe(404);
  });
  it('uses the established unavailable API envelope for missing Access configuration', async () => {
    const { app, env } = await appFor();
    const response = await app.request(
      'https://panel.example.test/api/documents/unknown/download',
      {
        method: 'POST',
        headers: { Origin: 'https://panel.example.test', 'Content-Type': 'application/json' },
        body: '{}',
      },
      { ...env, CF_ACCESS_TEAM_DOMAIN: undefined },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
      timestamp: expect.any(String),
    });
  });
  it('exposes current secure confirmation only after current sensitive authorization', async () => {
    const f = await availableFixture();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(f.documentId)
      .run();
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.identity.read','UNSCOPED')",
      )
      .bind(permissionId, membershipId)
      .run();
    try {
      const secure = await appFor({ ...ownerContext, assurance: 'SECURE' });
      const response = await secure.post(
        '/secure/api/documents/' + f.documentId + '/download-confirmation',
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        data: { confirmationText: string; versionId: string };
      };
      expect(result.data.confirmationText).toContain('onaylıyorum');
      expect(result.data.versionId).toBe(f.versionId);
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
      expect(
        (await secure.post('/secure/api/documents/' + f.documentId + '/download-confirmation'))
          .status,
      ).toBe(404);
    } finally {
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it('returns secure explanatory confirmation and idempotently audits one grant issuance', async () => {
    const f = await availableFixture();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(f.documentId)
      .run();
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.identity.read','UNSCOPED')",
      )
      .bind(permissionId, membershipId)
      .run();
    try {
      const context = { ...ownerContext, assurance: 'SECURE' as const };
      const confirmation = await documentDownloadConfirmation(db, context, f.documentId);
      expect(confirmation).toHaveProperty('confirmationText');
      const body = {
        expectedVersion: confirmation.expectedVersion,
        versionId: confirmation.versionId,
        checksum: confirmation.checksum,
        confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
      };
      const key = crypto.randomUUID();
      const first = await issueDocumentDownloadGrant(db, context, f.documentId, body, key);
      const replay = await issueDocumentDownloadGrant(db, context, f.documentId, body, key);
      expect(replay).toEqual(first);
      expect(
        await db
          .prepare(
            "SELECT count(*) AS n FROM audit_events WHERE action='sensitive_action_grant.issued' AND target_id=?",
          )
          .bind(first.grantId)
          .first('n'),
      ).toBe(1);
    } finally {
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it('rechecks a Member document.read permission after a previously successful stream', async () => {
    const f = await availableFixture();
    const permissionId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'document.read','AGENCY')",
      )
      .bind(permissionId, memberId)
      .run();
    try {
      const { post } = await appFor(memberContext);
      expect((await post('/api/documents/' + f.documentId + '/download')).status).toBe(200);
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
      expect((await post('/api/documents/' + f.documentId + '/download')).status).toBe(404);
    } finally {
      await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
    }
  });
  it('rejects a corrupted non-null inspection result instead of trusting AVAILABLE metadata', async () => {
    const f = await availableFixture();
    await corruptTable(
      'document_scan_evidence',
      db
        .prepare(
          'UPDATE document_scan_evidence SET content_inspection_result=\'{"valid":true}\' WHERE document_version_id=?',
        )
        .bind(f.versionId),
    );
    await expect(
      downloadDocument(db, source, ownerContext, f.documentId, {}),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('requires secure audience and explanatory confirmation, then consumes an exact sensitive grant once', async () => {
    const f = await availableFixture();
    await db
      .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
      .bind(f.documentId)
      .run();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.identity.read','UNSCOPED')",
      )
      .bind(crypto.randomUUID(), membershipId)
      .run();
    const normal = await appFor();
    expect((await normal.post('/api/documents/' + f.documentId + '/download')).status).toBe(404);
    const secure = await appFor({ ...ownerContext, assurance: 'SECURE' });
    const row = await db
      .prepare('SELECT version FROM documents WHERE id=?')
      .bind(f.documentId)
      .first<{ version: number }>();
    const body = {
      expectedVersion: row!.version,
      versionId: f.versionId,
      checksum,
      confirmation: 'DOWNLOAD_SENSITIVE_DOCUMENT',
    };
    const grantResponse = await secure.post(
      '/secure/api/documents/' + f.documentId + '/download-grants',
      body,
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { data: { grantEvidenceToken: string } };
    const command = { ...body, grantEvidenceToken: grant.data.grantEvidenceToken };
    const response = await secure.post(
      '/secure/api/documents/' + f.documentId + '/download',
      command,
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(
      (await secure.post('/secure/api/documents/' + f.documentId + '/download', command)).status,
    ).toBe(404);
    await db
      .prepare(
        "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='sensitive.identity.read'",
      )
      .bind(membershipId)
      .run();
  });
  it('serves exact AVAILABLE bytes as a private attachment, never a backup key or public link', async () => {
    const f = await availableFixture();
    const { post } = await appFor();
    const response = await post('/api/documents/' + f.documentId + '/download');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/u);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('location')).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  it.each(['auth_identities', 'users', 'agency_memberships'] as const)(
    'rechecks current %s liveness after a successful stream',
    async (table) => {
      const f = await availableFixture();
      const { post } = await appFor(memberContext);
      const permissionId = crypto.randomUUID();
      const targetId =
        table === 'auth_identities'
          ? memberIdentityId
          : table === 'users'
            ? memberUserId
            : memberId;
      const inactive =
        table === 'auth_identities'
          ? "status='REVOKED',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
          : table === 'agency_memberships'
            ? "status='INACTIVE',inactivated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
            : "status='INACTIVE'";
      const active =
        table === 'auth_identities'
          ? "status='ACTIVE',revoked_at=NULL"
          : table === 'agency_memberships'
            ? "status='ACTIVE',inactivated_at=NULL"
            : "status='ACTIVE'";
      await db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'document.read','AGENCY')",
        )
        .bind(permissionId, memberId)
        .run();
      try {
        expect((await post('/api/documents/' + f.documentId + '/download')).status).toBe(200);
        await db
          .prepare(
            `UPDATE ${table} SET ${inactive},version=version+1${table === 'agency_memberships' ? ',permission_version=permission_version+1' : ''} WHERE id=?`,
          )
          .bind(targetId)
          .run();
        const denied = await post('/api/documents/' + f.documentId + '/download');
        expect(denied.status).toBe(404);
        for (const header of ['content-disposition', 'etag', 'content-length', 'content-range'])
          expect(denied.headers.get(header)).toBeNull();
        expect(await denied.text()).not.toContain(f.versionId);
      } finally {
        await corruptTable(
          table,
          db
            .prepare(
              `UPDATE ${table} SET ${active}${table === 'agency_memberships' ? ',permission_version=1' : ''} WHERE id=?`,
            )
            .bind(targetId),
        );
        await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
      }
    },
  );
  it.each(['document_scan_evidence', 'document_backup_copies'] as const)(
    'rejects wrong-checksum %s before reaching storage',
    async (table) => {
      const f = await availableFixture();
      const update =
        table === 'document_scan_evidence' ? 'sha256=?' : 'source_sha256=?,backup_sha256=?';
      await corruptTable(
        table,
        db
          .prepare(`UPDATE ${table} SET ${update} WHERE document_version_id=?`)
          .bind(
            ...(table === 'document_scan_evidence'
              ? ['f'.repeat(64)]
              : ['f'.repeat(64), 'f'.repeat(64)]),
            f.versionId,
          ),
      );
      await expect(
        downloadDocument(
          db,
          {
            get() {
              throw new Error('wrong evidence must not reach storage');
            },
          },
          ownerContext,
          f.documentId,
          {},
        ),
      ).rejects.toMatchObject({ status: 404 });
    },
  );
  it('does not expose document metadata through GET or HEAD', async () => {
    const f = await availableFixture();
    const { app, env } = await appFor();
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request(
        'https://panel.example.test/api/documents/' + f.documentId + '/download',
        { method },
        env,
      );
      expect(response.status).toBe(404);
      for (const header of ['content-disposition', 'etag', 'content-length', 'accept-ranges'])
        expect(response.headers.get(header)).toBeNull();
    }
  });
});

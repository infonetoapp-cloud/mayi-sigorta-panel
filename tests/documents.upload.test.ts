import { controlledSessionCookie } from './support/controlled-session';
// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { AuthenticatedPrincipal } from '../src/server/auth/types';
import { createApp } from '../src/server';
import { generateIdentityBoundCsrfToken } from '../src/server/security/csrf';
import { createDocumentUpload } from '../src/server/documents/service';
import {
  REQUIRED_CONTENT_INSPECTION_VERSION,
  type DocumentContentInspectionResult,
} from '../src/server/documents/content-inspection';
import {
  dispatchDueDocumentJobs,
  documentScanRetryDelaySeconds,
  type DocumentJobQueueMessage,
} from '../src/server/documents/queue';
import {
  consumeDocumentQueueBatch,
  DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
  processDocumentScanMessage,
  unavailableDocumentScanner,
  type DocumentScannerAdapter,
  type DocumentScannerContentInspectionEvidence,
  type DocumentScannerResult,
} from '../src/server/documents/scan';
import { MAX_DOCUMENT_UPLOAD_BYTES } from '../src/server/documents/validation';
import {
  prepareQuarantinedDocumentObject,
  createQuarantineObjectKey,
  writePreparedQuarantinedDocumentObject,
} from '../src/server/documents/quarantine';
import { createSyntheticJpeg, createSyntheticPdf, createSyntheticPng } from './fixtures/documents';
import { unsupportedXlsxBase64, unsupportedMacroOoxmlBase64 } from './fixtures/unsupported-office';

interface LocalDocumentBindings {
  readonly DB: D1Database;
  readonly DOCS_QUARANTINE: R2Bucket;
  readonly DOCUMENT_JOB_QUEUE: Queue<DocumentJobQueueMessage>;
}

const root = process.cwd();
const migrationFiles = readdirSync(resolve(root, 'db/migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
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

let db: D1Database;
let quarantine: R2Bucket;
let localQueue: Queue<DocumentJobQueueMessage>;
let disposePlatform: (() => Promise<void>) | undefined;

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

const principal: AuthenticatedPrincipal = {
  issuer: `https://${teamDomain}`,
  subject: 'upload-owner-subject',
  assurance: 'NORMAL',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

const validPdfFixture = createSyntheticPdf();
const alternatePdfFixture = createSyntheticPdf({ comment: 'synthetic upload payload variant' });

function pdfBlob(extraByte?: number): Blob {
  return new Blob([extraByte === undefined ? validPdfFixture : alternatePdfFixture], {
    type: 'application/pdf',
  });
}

type ValidDocumentInspection = Extract<DocumentContentInspectionResult, { valid: true }>;

function syntheticContentInspectionEvidence(
  sha256: string,
  result: ValidDocumentInspection = { valid: true, format: 'PDF', pageCount: 1 },
): DocumentScannerContentInspectionEvidence {
  return {
    version: REQUIRED_CONTENT_INSPECTION_VERSION,
    sha256,
    format: result.format,
    complete: true,
    result,
  };
}

function syntheticCleanScannerResponse(
  sha256: string,
  overrides: Partial<
    Pick<
      Extract<DocumentScannerResult, { outcome: 'CLEAN' }>,
      'scannerEngineVersion' | 'signatureVersion' | 'signatureUpdatedAt'
    >
  > = {},
  inspectionResult?: ValidDocumentInspection,
): Extract<DocumentScannerResult, { outcome: 'CLEAN' }> {
  return {
    outcome: 'CLEAN',
    sha256,
    scannerEngineVersion: 'test-engine',
    signatureVersion: 'synthetic-test-signature',
    signatureUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
    contentInspection: syntheticContentInspectionEvidence(sha256, inspectionResult),
  };
}

async function digestDocumentStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await new Response(body).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pdfFile(fileName: string): File {
  return new File([pdfBlob()], fileName, { type: 'application/pdf' });
}

function mutateDatabaseAfterStoredResultRead(
  database: D1Database,
  afterRead: () => Promise<void>,
): D1Database {
  let mutated = false;

  const wrapStatement = (statement: D1PreparedStatement, revokeAfterRead: boolean) =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: Parameters<D1PreparedStatement['bind']>) =>
            wrapStatement(target.bind(...values), revokeAfterRead);
        }
        if (property === 'first' && revokeAfterRead) {
          return async (...values: Parameters<D1PreparedStatement['first']>) => {
            const result = await target.first(...values);
            if (!mutated) {
              await afterRead();
              mutated = true;
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) =>
          wrapStatement(
            target.prepare(sql),
            sql.includes('FROM documents d JOIN document_versions v'),
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function synchronizeConcurrentScanJobReads(
  database: D1Database,
  expectedReads: number,
): D1Database {
  let reads = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const wrapStatement = (statement: D1PreparedStatement, waitForRead: boolean) =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: Parameters<D1PreparedStatement['bind']>) =>
            wrapStatement(target.bind(...values), waitForRead);
        }
        if (property === 'first' && waitForRead) {
          return async (...values: Parameters<D1PreparedStatement['first']>) => {
            const result = await target.first(...values);
            reads += 1;
            if (reads === expectedReads) releaseBarrier();
            await barrier;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) =>
          wrapStatement(
            target.prepare(sql),
            sql.includes('FROM background_jobs job') &&
              sql.includes('JOIN document_versions version') &&
              sql.includes('WHERE job.id=?'),
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function mutateAfterFirstQuarantinePut(bucket: R2Bucket, afterPut: () => Promise<void>): R2Bucket {
  let mutated = false;
  return new Proxy(bucket, {
    get(target, property) {
      if (property === 'put') {
        return async (...args: Parameters<R2Bucket['put']>) => {
          const result = await target.put(...args);
          if (!mutated) {
            await afterPut();
            mutated = true;
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createUploadForm(
  extra: Readonly<Record<string, string>> = {},
  fileName = 'api-policy.pdf',
) {
  const form = new FormData();
  form.append('ownerType', 'CUSTOMER');
  form.append('ownerId', customerId);
  form.append('classification', 'GENERAL');
  for (const [name, value] of Object.entries(extra)) form.append(name, value);
  form.append('file', pdfFile(fileName));
  return form;
}

async function createQueuedCustomerDocument(
  idempotencyKey: string,
  file: Blob = pdfBlob(),
  fileName = `${idempotencyKey}.pdf`,
  declaredContentType = 'application/pdf',
) {
  // Historical scanner contract fixture, NOT the active production upload path.
  const documentId = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    jobId = crypto.randomUUID();
  const prepared = await prepareQuarantinedDocumentObject(file, { fileName, declaredContentType });
  const key = createQuarantineObjectKey();
  await db
    .prepare(
      `INSERT INTO documents(id,agency_id,owner_type,customer_id,classification,created_by_user_id,created_by_membership_id) VALUES(?,?,'CUSTOMER',?,'GENERAL',?,?)`,
    )
    .bind(documentId, agencyId, customerId, userId, membershipId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,declared_content_type,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,?,?,1,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      versionId,
      agencyId,
      documentId,
      key,
      prepared.sha256,
      prepared.sizeBytes,
      prepared.fileName,
      declaredContentType,
      prepared.contentType,
      userId,
      membershipId,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256) VALUES(?,?,'DOCUMENT_SCAN',?,?)`,
    )
    .bind(jobId, agencyId, versionId, prepared.sha256)
    .run();
  await db
    .prepare(`UPDATE document_versions SET status='QUARANTINED' WHERE id=?`)
    .bind(versionId)
    .run();
  await writePreparedQuarantinedDocumentObject(quarantine, key, prepared);
  const upload = {
    status: 202,
    body: {
      documentId,
      versionId,
      state: 'QUARANTINED',
      classification: 'GENERAL',
      versionNumber: 1,
    },
    replayed: false,
  };
  const row = await db
    .prepare(
      `SELECT id,job_type,generation,document_version_id,input_sha256
       FROM background_jobs WHERE document_version_id=? AND job_type='DOCUMENT_SCAN'`,
    )
    .bind(upload.body.versionId)
    .first<{
      id: string;
      job_type: string;
      generation: number;
      document_version_id: string | null;
      input_sha256: string | null;
    }>();
  if (!row || row.job_type !== 'DOCUMENT_SCAN' || !row.document_version_id || !row.input_sha256) {
    throw new Error('Expected durable scan job fixture missing');
  }
  const message: DocumentJobQueueMessage = {
    jobId: row.id,
    jobType: 'DOCUMENT_SCAN',
    generation: row.generation,
    documentVersionId: row.document_version_id,
    inputSha256: row.input_sha256,
  };
  return { upload, message };
}

async function postUpload(
  form: FormData,
  idempotencyKey: string,
  csrf = true,
  documentsEnabled?: boolean,
  authenticated = true,
) {
  const app = authenticated
    ? createApp({
        createSessionVerifier: (config) => ({ config, verify: async () => principal }),
        createResolver: () => ({ resolve: async () => ownerContext }),
      })
    : createApp({ createResolver: () => ({ resolve: async () => ownerContext }) });
  const csrfToken = await generateIdentityBoundCsrfToken(
    { subject: principal.subject },
    csrfSecret,
  );
  const headers: Record<string, string> = {
    Origin: 'https://panel.mayisigorta.com',
    cookie: controlledSessionCookie('synthetic-test-assertion'),
    'Idempotency-Key': idempotencyKey,
  };
  if (csrf) headers['X-CSRF-Token'] = csrfToken;
  if (!authenticated) delete headers['Cf-Access-Jwt-Assertion'];
  const env = {
    DB: db,
    DOCS_QUARANTINE: quarantine,
    APP_ENV: 'test',
    CSRF_SECRET: csrfSecret,
    ...(documentsEnabled === undefined
      ? {}
      : { DOCUMENTS_ENABLED: documentsEnabled ? 'true' : 'false' }),
  };
  return await app.request(
    'https://panel.mayisigorta.com/api/documents',
    { method: 'POST', headers, body: form },
    env,
  );
}

beforeAll(async () => {
  const platform = await getPlatformProxy<LocalDocumentBindings>({
    configPath: 'wrangler.jsonc',
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  db = platform.env.DB;
  quarantine = platform.env.DOCS_QUARANTINE;
  localQueue = platform.env.DOCUMENT_JOB_QUEUE;
  disposePlatform = platform.dispose;

  for (const migrationName of migrationFiles) {
    const migration = readFileSync(resolve(root, 'db/migrations', migrationName), 'utf8');
    const statements = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }

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
});

afterAll(async () => {
  const objects = await db
    .prepare('SELECT object_key FROM document_versions')
    .all<{ object_key: string }>();
  for (const object of objects.results ?? []) await quarantine.delete(object.object_key);
  await disposePlatform?.();
});

describe('document upload transaction', () => {
  it('denies anonymous/public upload before writing any metadata', async () => {
    const before = await db.prepare('SELECT count(*) AS count FROM documents').first('count');
    const response = await postUpload(createUploadForm(), 'anonymous-upload', true, true, false);
    expect(response.status).toBe(401);
    expect(await db.prepare('SELECT count(*) AS count FROM documents').first('count')).toBe(before);
  });
  it.each([
    ['PDF', 'valid.pdf', 'application/pdf', createSyntheticPdf()],
    ['JPEG', 'valid.jpg', 'image/jpeg', createSyntheticJpeg(2, 2)],
    ['PNG', 'valid.png', 'image/png', createSyntheticPng(2, 2)],
  ] as const)(
    'accepts structurally valid %s without creating any scanner job or verdict',
    async (_format, fileName, declaredContentType, bytes) => {
      const key = crypto.randomUUID();
      const result = await createDocumentUpload(
        db,
        quarantine,
        ownerContext,
        {
          ownerType: 'CUSTOMER',
          ownerId: customerId,
          classification: 'GENERAL',
          fileName,
          declaredContentType,
          file: new Blob([bytes], { type: declaredContentType }),
        },
        { correlationId: key, idempotencyKey: key },
      );
      expect(result.body.state).toBe('BACKUP_PENDING');
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM background_jobs WHERE document_version_id=? AND job_type='DOCUMENT_SCAN'",
          )
          .bind(result.body.versionId)
          .first('count'),
      ).toBe(0);
      expect(
        await db
          .prepare(
            'SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?',
          )
          .bind(result.body.versionId)
          .first('count'),
      ).toBe(0);
    },
  );
  it.each([
    ['script', 'payload.js', 'application/pdf', createSyntheticPdf()],
    ['executable', 'payload.exe', 'application/pdf', createSyntheticPdf()],
    ['HTML', 'payload.html', 'text/html', new TextEncoder().encode('<script>alert(1)</script>')],
    ['SVG', 'payload.svg', 'image/svg+xml', new TextEncoder().encode('<svg onload="alert(1)"/>')],
    ['image/PDF mismatch', 'mismatch.pdf', 'application/pdf', createSyntheticPng(2, 2)],
    [
      'malformed PDF',
      'malformed.pdf',
      'application/pdf',
      new TextEncoder().encode('%PDF-1.7\nnot-a-pdf\n%%EOF'),
    ],
    [
      'unsupported real XLSX',
      'workbook.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from(unsupportedXlsxBase64, 'base64'),
    ],
    [
      'ZIP renamed XLSX',
      'arbitrary.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0]),
    ],
    [
      'macro OOXML renamed XLSX',
      'macro.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from(unsupportedMacroOoxmlBase64, 'base64'),
    ],
    [
      'macro-enabled Office',
      'macro.xlsm',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
      Buffer.from(unsupportedMacroOoxmlBase64, 'base64'),
    ],
    [
      'binary Office',
      'macro.xlsb',
      'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
      Buffer.from(unsupportedMacroOoxmlBase64, 'base64'),
    ],
  ] as const)(
    'rejects %s before reserving metadata or writing R2',
    async (_kind, fileName, declaredContentType, bytes) => {
      const before = await db.prepare('SELECT count(*) AS count FROM documents').first('count');
      const key = crypto.randomUUID();
      await expect(
        createDocumentUpload(
          db,
          quarantine,
          ownerContext,
          {
            ownerType: 'CUSTOMER',
            ownerId: customerId,
            classification: 'GENERAL',
            fileName,
            declaredContentType,
            file: new Blob([bytes], { type: declaredContentType }),
          },
          { correlationId: key, idempotencyKey: key },
        ),
      ).rejects.toMatchObject({ status: 415 });
      expect(await db.prepare('SELECT count(*) AS count FROM documents').first('count')).toBe(
        before,
      );
    },
  );
  it('accepts validated staff content without a scanner and atomically queues backup and audit', async () => {
    const result = await createDocumentUpload(
      db,
      quarantine,
      ownerContext,
      {
        ownerType: 'CUSTOMER',
        ownerId: customerId,
        classification: 'GENERAL',
        fileName: 'synthetic-policy.pdf',
        declaredContentType: 'application/pdf',
        file: pdfBlob(),
      },
      { correlationId: 'upload-correlation-a', idempotencyKey: 'upload-idempotency-a' },
    );
    expect(result).toMatchObject({
      status: 202,
      body: {
        documentId: expect.any(String),
        versionId: expect.any(String),
        classification: 'GENERAL',
        versionNumber: 1,
        state: 'BACKUP_PENDING',
      },
    });
    expect(JSON.stringify(result)).not.toContain('objectKey');
    expect(JSON.stringify(result)).not.toContain('quarantine/');

    const document = await db
      .prepare(
        'SELECT id,agency_id,owner_type,customer_id,classification,current_version_id FROM documents WHERE id=?',
      )
      .bind(result.body.documentId)
      .first<Record<string, unknown>>();
    expect(document).toMatchObject({
      id: result.body.documentId,
      agency_id: agencyId,
      owner_type: 'CUSTOMER',
      customer_id: customerId,
      classification: 'GENERAL',
      current_version_id: null,
    });

    const version = await db
      .prepare(
        `SELECT id,document_id,object_key,sha256,size_bytes,file_name,status,detected_content_type
         FROM document_versions WHERE id=?`,
      )
      .bind(result.body.versionId)
      .first<Record<string, unknown>>();
    expect(version).toMatchObject({
      id: result.body.versionId,
      document_id: result.body.documentId,
      status: 'BACKUP_PENDING',
      file_name: 'synthetic-policy.pdf',
      detected_content_type: 'application/pdf',
    });
    expect(version?.object_key).toMatch(/^quarantine\/[0-9a-f-]{36}$/u);

    const stored = await quarantine.get(String(version?.object_key));
    expect(stored).not.toBeNull();
    expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([...validPdfFixture]);

    const job = await db
      .prepare(
        `SELECT job_type,document_version_id,input_sha256,generation,status
         FROM background_jobs WHERE document_version_id=?`,
      )
      .bind(result.body.versionId)
      .first<Record<string, unknown>>();
    expect(job).toMatchObject({
      job_type: 'DOCUMENT_BACKUP',
      document_version_id: result.body.versionId,
      input_sha256: version?.sha256,
      generation: 1,
      status: 'QUEUED',
    });

    const receipt = await db
      .prepare(
        `SELECT status,response_status,response_body FROM operation_receipts
         WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
      )
      .bind(agencyId, userId, membershipId, 'upload-idempotency-a')
      .first<Record<string, unknown>>();
    expect(receipt?.status).toBe('COMPLETED');
    expect(receipt?.response_status).toBe(202);

    const audit = await db
      .prepare(
        `SELECT action,target_type,target_id,outcome,metadata_json FROM audit_events
         WHERE agency_id=? AND actor_user_id=? AND actor_membership_id=? AND idempotency_key=?`,
      )
      .bind(agencyId, userId, membershipId, 'upload-idempotency-a')
      .first<Record<string, unknown>>();
    expect(audit).toMatchObject({
      action: 'document.upload',
      target_type: 'documents',
      target_id: result.body.documentId,
      outcome: 'SUCCESS',
    });
    expect(String(audit?.metadata_json)).not.toContain('synthetic-policy.pdf');
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
        .bind(result.body.versionId)
        .first('count'),
    ).toBe(0);
  });

  it('resolves Policy and Renewal-backed Quote parents from the real local D1 graph', async () => {
    const targets = [
      { ownerType: 'POLICY' as const, ownerId: policyId, fileName: 'policy-parent.pdf' },
      { ownerType: 'QUOTE' as const, ownerId: quoteId, fileName: 'quote-parent.pdf' },
    ];
    for (const [index, target] of targets.entries()) {
      const result = await createDocumentUpload(
        db,
        quarantine,
        ownerContext,
        {
          ...target,
          classification: 'GENERAL',
          declaredContentType: 'application/pdf',
          file: pdfBlob(),
        },
        {
          correlationId: `upload-parent-correlation-${index}`,
          idempotencyKey: `upload-parent-idempotency-${index}`,
        },
      );
      const document = await db
        .prepare('SELECT owner_type,policy_id,quote_id FROM documents WHERE id=?')
        .bind(result.body.documentId)
        .first<{ owner_type: string; policy_id: string | null; quote_id: string | null }>();
      expect(document?.owner_type).toBe(target.ownerType);
      expect(document?.policy_id).toBe(target.ownerType === 'POLICY' ? target.ownerId : null);
      expect(document?.quote_id).toBe(target.ownerType === 'QUOTE' ? target.ownerId : null);
    }
  });

  it('requires OWNER explicit sensitive permission and MEMBER document permission', async () => {
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    await expect(
      createDocumentUpload(
        db,
        quarantine,
        ownerContext,
        {
          ownerType: 'CUSTOMER',
          ownerId: customerId,
          classification: 'IDENTITY',
          fileName: 'synthetic-identity.pdf',
          declaredContentType: 'application/pdf',
          file: pdfBlob(),
        },
        { correlationId: 'upload-sensitive-deny', idempotencyKey: 'upload-sensitive-deny' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    await expect(
      createDocumentUpload(
        db,
        quarantine,
        memberContext,
        {
          ownerType: 'CUSTOMER',
          ownerId: customerId,
          classification: 'GENERAL',
          fileName: 'member-without-document-grant.pdf',
          declaredContentType: 'application/pdf',
          file: pdfBlob(),
        },
        { correlationId: 'upload-member-deny', idempotencyKey: 'upload-member-deny' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const after = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it('allows Member uploads for each parent type and rechecks authority at completed replay return', async () => {
    await db.batch([
      db
        .prepare('DELETE FROM membership_permissions WHERE membership_id=? AND permission_code=?')
        .bind(memberId, 'customer.read'),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'document.read','AGENCY')`,
        )
        .bind('upload-member-document-read', memberId),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'document.upload','AGENCY')`,
        )
        .bind('upload-member-document-upload', memberId),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'policy.read','AGENCY')`,
        )
        .bind('upload-member-policy-read', memberId),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'quote.read','AGENCY')`,
        )
        .bind('upload-member-quote-read', memberId),
      db
        .prepare(
          'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
        )
        .bind(memberId),
    ]);
    const memberWithoutCustomerRead: AuthenticatedUserContext = {
      ...memberContext,
      memberships: [{ ...memberContext.memberships[0]!, permissionVersion: 2 }],
    };
    const policyInput = {
      ownerType: 'POLICY' as const,
      ownerId: policyId,
      classification: 'GENERAL' as const,
      fileName: 'member-policy-replay.pdf',
      declaredContentType: 'application/pdf',
      file: pdfBlob(),
    };
    const policyOptions = {
      correlationId: 'member-policy-upload-correlation',
      idempotencyKey: 'member-policy-upload-replay-key',
    };
    const policyUpload = await createDocumentUpload(
      db,
      quarantine,
      memberWithoutCustomerRead,
      policyInput,
      policyOptions,
    );
    const quoteUpload = await createDocumentUpload(
      db,
      quarantine,
      memberWithoutCustomerRead,
      {
        ownerType: 'QUOTE',
        ownerId: quoteId,
        classification: 'GENERAL',
        fileName: 'member-quote.pdf',
        declaredContentType: 'application/pdf',
        file: pdfBlob(),
      },
      {
        correlationId: 'member-quote-upload-correlation',
        idempotencyKey: 'member-quote-upload-key',
      },
    );

    await db.batch([
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'customer.read','AGENCY')`,
        )
        .bind('upload-member-customer-read-restored', memberId),
      db
        .prepare(
          'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
        )
        .bind(memberId),
    ]);
    const memberWithAllParents: AuthenticatedUserContext = {
      ...memberContext,
      memberships: [{ ...memberContext.memberships[0]!, permissionVersion: 3 }],
    };
    const customerInput = {
      ownerType: 'CUSTOMER' as const,
      ownerId: customerId,
      classification: 'GENERAL' as const,
      fileName: 'member-customer.pdf',
      declaredContentType: 'application/pdf',
      file: pdfBlob(),
    };
    const customerOptions = {
      correlationId: 'member-customer-upload-correlation',
      idempotencyKey: 'member-customer-upload-key',
    };
    const customerUpload = await createDocumentUpload(
      db,
      quarantine,
      memberWithAllParents,
      customerInput,
      customerOptions,
    );

    const racingDb = mutateDatabaseAfterStoredResultRead(db, async () => {
      await db.batch([
        db
          .prepare('DELETE FROM membership_permissions WHERE membership_id=? AND permission_code=?')
          .bind(memberId, 'document.upload'),
        db
          .prepare(
            'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
          )
          .bind(memberId),
      ]);
    });
    await expect(
      createDocumentUpload(racingDb, quarantine, memberWithAllParents, policyInput, policyOptions),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const memberAfterRevocation: AuthenticatedUserContext = {
      ...memberContext,
      memberships: [{ ...memberContext.memberships[0]!, permissionVersion: 4 }],
    };
    await expect(
      createDocumentUpload(db, quarantine, memberAfterRevocation, policyInput, policyOptions),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    expect(policyUpload.body.state).toBe('BACKUP_PENDING');
    expect(quoteUpload.body.state).toBe('BACKUP_PENDING');
    expect(customerUpload.body.state).toBe('BACKUP_PENDING');
    const receipt = await db
      .prepare(
        `SELECT status,response_body FROM operation_receipts
         WHERE actor_membership_id=? AND idempotency_key=?`,
      )
      .bind(memberId, policyOptions.idempotencyKey)
      .first<{ status: string; response_body: string }>();
    expect(receipt?.status).toBe('COMPLETED');
    expect(JSON.parse(receipt!.response_body)).toMatchObject({
      documentId: policyUpload.body.documentId,
    });

    const customerReceipt = await db
      .prepare(
        `SELECT status,response_body FROM operation_receipts
         WHERE actor_membership_id=? AND idempotency_key=?`,
      )
      .bind(memberId, customerOptions.idempotencyKey)
      .first<{ status: string; response_body: string }>();
    expect(customerReceipt?.status).toBe('COMPLETED');
    expect(JSON.parse(customerReceipt!.response_body)).toMatchObject({
      documentId: customerUpload.body.documentId,
    });
  });

  it('rejects a parent id that belongs to another agency before creating any metadata', async () => {
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    await expect(
      createDocumentUpload(
        db,
        quarantine,
        ownerContext,
        {
          ownerType: 'CUSTOMER',
          ownerId: otherCustomerId,
          classification: 'GENERAL',
          fileName: 'cross-agency.pdf',
          declaredContentType: 'application/pdf',
          file: pdfBlob(),
        },
        { correlationId: 'upload-cross-agency', idempotencyKey: 'upload-cross-agency' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const after = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it('replays one upload without another effect and conflicts when the same key changes content', async () => {
    const input = {
      ownerType: 'CUSTOMER' as const,
      ownerId: customerId,
      classification: 'GENERAL' as const,
      fileName: 'synthetic-replay.pdf',
      declaredContentType: 'application/pdf',
      file: pdfBlob(),
    };
    const options = {
      correlationId: 'upload-correlation-replay',
      idempotencyKey: 'upload-idempotency-replay',
    };
    const first = await createDocumentUpload(db, quarantine, ownerContext, input, options);
    const replay = await createDocumentUpload(db, quarantine, ownerContext, input, options);
    expect(replay).toEqual({ ...first, replayed: true });

    const counts = await db
      .prepare(
        `SELECT
           (SELECT count(*) FROM documents WHERE id=?) AS documents,
           (SELECT count(*) FROM document_versions WHERE document_id=?) AS versions,
           (SELECT count(*) FROM background_jobs WHERE document_version_id=?) AS jobs,
           (SELECT count(*) FROM audit_events WHERE idempotency_key=?) AS audits`,
      )
      .bind(
        first.body.documentId,
        first.body.documentId,
        first.body.versionId,
        options.idempotencyKey,
      )
      .first<Record<string, number>>();
    expect(counts).toEqual({ documents: 1, versions: 1, jobs: 1, audits: 1 });

    await expect(
      createDocumentUpload(
        db,
        quarantine,
        ownerContext,
        { ...input, file: pdfBlob(0x78) },
        options,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
  });

  it('recovers an R2 object after D1 finalization fails by retrying the same durable reservation', async () => {
    await db
      .prepare(
        `CREATE TRIGGER test_fail_document_scan_job
         BEFORE INSERT ON background_jobs
         WHEN NEW.job_type='DOCUMENT_BACKUP' AND EXISTS (
           SELECT 1 FROM document_versions version
           WHERE version.id=NEW.document_version_id AND version.file_name='synthetic-retry.pdf'
         )
         BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FINALIZATION_FAILURE'); END`,
      )
      .run();

    const input = {
      ownerType: 'CUSTOMER' as const,
      ownerId: customerId,
      classification: 'GENERAL' as const,
      fileName: 'synthetic-retry.pdf',
      declaredContentType: 'application/pdf',
      file: pdfBlob(),
    };
    const options = {
      correlationId: 'upload-correlation-retry',
      idempotencyKey: 'upload-idempotency-retry',
    };
    await expect(
      createDocumentUpload(db, quarantine, ownerContext, input, options),
    ).rejects.toMatchObject({
      code: 'UPLOAD_RETRYABLE',
      status: 503,
    });

    const pending = await db
      .prepare(
        `SELECT d.id AS document_id,v.id AS version_id,v.object_key,v.status
         FROM documents d JOIN document_versions v
           ON v.agency_id=d.agency_id AND v.document_id=d.id
         WHERE d.agency_id=? AND v.file_name=?`,
      )
      .bind(agencyId, input.fileName)
      .first<{ document_id: string; version_id: string; object_key: string; status: string }>();
    expect(pending?.status).toBe('PENDING_UPLOAD');
    expect(await quarantine.get(pending!.object_key)).not.toBeNull();

    await db.prepare('DROP TRIGGER test_fail_document_scan_job').run();
    const resumed = await createDocumentUpload(db, quarantine, ownerContext, input, options);
    expect(resumed).toMatchObject({
      status: 202,
      body: {
        documentId: pending?.document_id,
        versionId: pending?.version_id,
        state: 'BACKUP_PENDING',
      },
      replayed: false,
    });
  });

  it('keeps the document module closed unless an explicit environment opt-in exists', async () => {
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    const response = await postUpload(createUploadForm({}, 'disabled.pdf'), 'upload-disabled-a');
    expect(response.status).toBe(404);
    const after = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it('accepts a CSRF-bound multipart API request without returning an R2 key', async () => {
    const response = await postUpload(
      createUploadForm({}, 'api-policy.pdf'),
      'upload-http-route-a',
      true,
      true,
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = (await response.json()) as {
      success: boolean;
      data: { documentId: string; classification: string; status: 'PROCESSING' };
      replayed: boolean;
    };
    expect(body).toMatchObject({
      success: true,
      replayed: false,
      data: { status: 'PROCESSING' },
    });
    expect(JSON.stringify(body)).not.toContain('objectKey');
    expect(JSON.stringify(body)).not.toContain('quarantine/');
  });

  it('rejects a multipart mutation without CSRF before processing its form fields', async () => {
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    const response = await postUpload(
      createUploadForm({ agencyId: 'untrusted' }, 'csrf-missing.pdf'),
      'upload-http-no-csrf',
      false,
      true,
    );
    expect(response.status).toBe(403);
    const after = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it('rejects an oversized streaming multipart body before parsing it', async () => {
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    const form = new FormData();
    form.append('ownerType', 'CUSTOMER');
    form.append('ownerId', customerId);
    form.append('classification', 'GENERAL');
    form.append(
      'file',
      new File([new Uint8Array(MAX_DOCUMENT_UPLOAD_BYTES + 65_537)], 'oversized.pdf', {
        type: 'application/pdf',
      }),
    );
    const response = await postUpload(form, 'upload-http-oversize-a', true, true);
    expect(response.status).toBe(413);
    const after = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it('rejects client-selected agency, version, checksum, and object-key fields', async () => {
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    const response = await postUpload(
      createUploadForm(
        {
          agencyId: 'attacker-selected-agency',
          versionId: 'attacker-selected-version',
          sha256: '0'.repeat(64),
          objectKey: 'quarantine/00000000-0000-4000-8000-000000000001',
        },
        'forged-policy.pdf',
      ),
      'upload-http-forged-a',
      true,
      true,
    );
    expect(response.status).toBe(400);
    const after = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it('derives HEALTH as the minimum class for health-backed Policy and Quote parents', async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'sensitive.health.read','UNSCOPED')`,
        )
        .bind('upload-owner-health-read', membershipId),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'sensitive.health.write','UNSCOPED')`,
        )
        .bind('upload-owner-health-write', membershipId),
      db
        .prepare(
          'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
        )
        .bind(membershipId),
    ]);
    const healthAuthorizedOwner: AuthenticatedUserContext = {
      ...ownerContext,
      memberships: [{ ...ownerContext.memberships[0]!, permissionVersion: 3 }],
    };
    const before = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    const healthParents = [
      { ownerType: 'POLICY' as const, ownerId: healthPolicyId },
      { ownerType: 'QUOTE' as const, ownerId: healthQuoteId },
    ];
    for (const [index, parent] of healthParents.entries()) {
      for (const classification of ['GENERAL', 'IDENTITY'] as const) {
        await expect(
          createDocumentUpload(
            db,
            quarantine,
            healthAuthorizedOwner,
            {
              ...parent,
              classification,
              fileName: `health-parent-${index}-${classification}.pdf`,
              declaredContentType: 'application/pdf',
              file: pdfBlob(),
            },
            {
              correlationId: `health-parent-correlation-${index}-${classification}`,
              idempotencyKey: `health-parent-idempotency-${index}-${classification}`,
            },
          ),
        ).rejects.toMatchObject({ code: 'CLASSIFICATION_PARENT_MISMATCH', status: 400 });
      }
    }
    const afterRejectedDowngrades = await db
      .prepare('SELECT count(*) AS count FROM documents')
      .first<{ count: number }>();
    expect(afterRejectedDowngrades?.count).toBe(before?.count);

    const accepted = await createDocumentUpload(
      db,
      quarantine,
      healthAuthorizedOwner,
      {
        ownerType: 'POLICY',
        ownerId: healthPolicyId,
        classification: 'HEALTH',
        fileName: 'health-policy.pdf',
        declaredContentType: 'application/pdf',
        file: pdfBlob(),
      },
      { correlationId: 'health-policy-upload', idempotencyKey: 'health-policy-upload' },
    );
    const stored = await db
      .prepare('SELECT classification FROM documents WHERE id=?')
      .bind(accepted.body.documentId)
      .first<{ classification: string }>();
    expect(stored?.classification).toBe('HEALTH');
    expect(accepted.body.state).toBe('BACKUP_PENDING');
  });

  it('rechecks assigned source Policy authority independently for a HEALTH Quote', async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'document.upload','AGENCY')`,
        )
        .bind('upload-member-health-document-upload', memberId),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'sensitive.health.read','UNSCOPED')`,
        )
        .bind('upload-member-health-read', memberId),
      db
        .prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES(?,?,'sensitive.health.write','UNSCOPED')`,
        )
        .bind('upload-member-health-write', memberId),
      db
        .prepare(
          `UPDATE membership_permissions SET scope='ASSIGNED'
           WHERE membership_id=? AND permission_code='policy.read'`,
        )
        .bind(memberId),
      db
        .prepare(
          `UPDATE policies SET assignee_membership_id=?,version=version+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(memberId, healthPolicyId),
      db
        .prepare(
          `UPDATE renewal_opportunities SET assignee_membership_id=?,version=version+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(memberId, healthRenewalId),
      db
        .prepare(
          'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
        )
        .bind(memberId),
    ]);
    const healthMemberContext: AuthenticatedUserContext = {
      ...memberContext,
      memberships: [{ ...memberContext.memberships[0]!, permissionVersion: 5 }],
    };
    const input = {
      ownerType: 'QUOTE' as const,
      ownerId: healthQuoteId,
      classification: 'HEALTH' as const,
      fileName: 'health-quote-assigned.pdf',
      declaredContentType: 'application/pdf',
      file: pdfBlob(),
    };
    const options = {
      correlationId: 'health-quote-assigned-correlation',
      idempotencyKey: 'health-quote-assigned-key',
    };
    const bucketWithPolicyReassignment = mutateAfterFirstQuarantinePut(quarantine, async () => {
      await db
        .prepare(
          `UPDATE policies SET assignee_membership_id=?,version=version+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(membershipId, healthPolicyId)
        .run();
    });

    await expect(
      createDocumentUpload(db, bucketWithPolicyReassignment, healthMemberContext, input, options),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const reserved = await db
      .prepare(
        `SELECT v.status,
                (SELECT count(*) FROM background_jobs j WHERE j.document_version_id=v.id) AS job_count
         FROM operation_receipts receipt
         JOIN documents d ON d.id=json_extract(receipt.response_body,'$.documentId')
         JOIN document_versions v ON v.document_id=d.id
         WHERE receipt.idempotency_key=?`,
      )
      .bind(options.idempotencyKey)
      .first<{ status: string; job_count: number }>();
    expect(reserved).toMatchObject({ status: 'PENDING_UPLOAD', job_count: 0 });

    await db
      .prepare(
        `UPDATE policies SET assignee_membership_id=?,version=version+1,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      )
      .bind(memberId, healthPolicyId)
      .run();
    const completed = await createDocumentUpload(
      db,
      quarantine,
      healthMemberContext,
      input,
      options,
    );
    expect(completed.body.state).toBe('BACKUP_PENDING');

    const databaseWithPolicyReassignment = mutateDatabaseAfterStoredResultRead(db, async () => {
      await db
        .prepare(
          `UPDATE policies SET assignee_membership_id=?,version=version+1,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        )
        .bind(membershipId, healthPolicyId)
        .run();
    });
    await expect(
      createDocumentUpload(
        databaseWithPolicyReassignment,
        quarantine,
        healthMemberContext,
        input,
        options,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const completedAgain = await db
      .prepare(`SELECT status,response_body FROM operation_receipts WHERE idempotency_key=?`)
      .bind(options.idempotencyKey)
      .first<{ status: string; response_body: string }>();
    expect(completedAgain?.status).toBe('COMPLETED');
    expect(JSON.parse(completedAgain!.response_body)).toMatchObject({
      documentId: completed.body.documentId,
    });
    const jobs = await db
      .prepare('SELECT count(*) AS count FROM background_jobs WHERE document_version_id=?')
      .bind(completed.body.versionId)
      .first<{ count: number }>();
    expect(jobs?.count).toBe(1);
  });

  it('keeps UNKNOWN scans fail-closed and schedules a durable retry', async () => {
    const { upload, message } = await createQueuedCustomerDocument('scan-unknown-idempotency');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        await body.cancel();
        return { outcome: 'UNKNOWN', reasonCode: 'SCANNER_UNAVAILABLE' };
      },
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'RETRY_SCHEDULED',
    );
    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,job.available_at,version.status AS version_status,
                run.status AS run_status,run.reason_code,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.id=job.document_version_id
         JOIN background_job_runs run ON run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        available_at: string;
        version_status: string;
        run_status: string;
        reason_code: string;
        evidence_count: number;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'RETRY_WAIT',
      attempt_count: 1,
      version_status: 'SCANNING',
      run_status: 'RETRYABLE_ERROR',
      reason_code: 'SCANNER_UNAVAILABLE',
      evidence_count: 0,
      backup_count: 0,
    });
    expect(Date.parse(state!.available_at)).toBeGreaterThan(Date.now());
    const duplicate = await processDocumentScanMessage(db, quarantine, message, scanner);
    expect(duplicate).toBe('ACKED');
    expect(upload.body.state).toBe('QUARANTINED');
    const attempts = await db
      .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
      .bind(message.jobId)
      .first<{ attempt_count: number }>();
    expect(attempts?.attempt_count).toBe(1);
    expect([1, 2, 3, 4].map(documentScanRetryDelaySeconds)).toEqual([60, 120, 240, 480]);
  });

  it('rejects an R2 object that changes between preflight and direct scanner streaming', async () => {
    const { upload, message } = await createQueuedCustomerDocument('scan-r2-etag-change');
    let gets = 0;
    let scannerCalls = 0;
    const changedBucket = {
      get: async (key: string) => {
        gets += 1;
        const object = await quarantine.get(key);
        if (gets !== 2 || object === null) return object;
        return new Proxy(object, {
          get(target, property) {
            if (property === 'etag') return `${target.etag}-changed`;
            return Reflect.get(target, property, target);
          },
        });
      },
    } as unknown as R2Bucket;
    const scanner: DocumentScannerAdapter = {
      scan: async () => {
        scannerCalls += 1;
        return { outcome: 'UNKNOWN', reasonCode: 'SHOULD_NOT_SCAN_CHANGED_OBJECT' };
      },
    };

    await expect(processDocumentScanMessage(db, changedBucket, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    expect(gets).toBe(2);
    expect(scannerCalls).toBe(0);
    const evidence = await db
      .prepare('SELECT outcome,reason_code FROM document_scan_evidence WHERE document_version_id=?')
      .bind(message.documentVersionId)
      .first<{ outcome: string; reason_code: string | null }>();
    expect(evidence).toEqual({ outcome: 'ERROR', reason_code: 'R2_OBJECT_CHANGED_DURING_SCAN' });
    expect(upload.body.state).toBe('QUARANTINED');
  });

  it('hashes the second R2 stream itself before accepting a scanner CLEAN claim', async () => {
    const { upload, message } = await createQueuedCustomerDocument('scan-r2-body-change-same-etag');
    let gets = 0;
    let scannerCalls = 0;
    const changedBodyBucket = {
      get: async (key: string) => {
        gets += 1;
        const object = await quarantine.get(key);
        if (gets !== 2 || object === null || object.body === null) return object;
        const source = object.body.getReader();
        let mutated = false;
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              const { done, value } = await source.read();
              if (done) {
                controller.close();
                source.releaseLock();
                return;
              }
              if (!mutated && value.byteLength > 0) {
                const changed = Uint8Array.from(value);
                changed[0] = changed[0]! ^ 1;
                mutated = true;
                controller.enqueue(changed);
              } else {
                controller.enqueue(value);
              }
            },
            async cancel(reason) {
              await source.cancel(reason);
              try {
                source.releaseLock();
              } catch {
                // The source may already have completed.
              }
            },
          },
          { highWaterMark: 0 },
        );
        return new Proxy(object, {
          get(target, property) {
            if (property === 'body') return body;
            return Reflect.get(target, property, target);
          },
        });
      },
    } as unknown as R2Bucket;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body, sha256 }) => {
        scannerCalls += 1;
        await digestDocumentStream(body);
        return syntheticCleanScannerResponse(sha256);
      },
    };

    await expect(processDocumentScanMessage(db, changedBodyBucket, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    expect(gets).toBe(2);
    expect(scannerCalls).toBe(1);
    const evidence = await db
      .prepare('SELECT outcome,reason_code FROM document_scan_evidence WHERE document_version_id=?')
      .bind(message.documentVersionId)
      .first<{ outcome: string; reason_code: string | null }>();
    expect(evidence).toEqual({ outcome: 'ERROR', reason_code: 'R2_CHANGED_DURING_SCAN' });
    expect(upload.body.state).toBe('QUARANTINED');
  });

  it('preserves historical unavailable-scanner retry semantics outside the active Worker', async () => {
    const { message } = await createQueuedCustomerDocument('scan-worker-no-adapter');
    let acknowledged = 0;
    let retried = 0;
    const queueMessage = {
      id: 'message-worker-no-adapter',
      timestamp: new Date(),
      body: message,
      ack: () => {
        acknowledged += 1;
      },
      retry: () => {
        retried += 1;
      },
    };

    await consumeDocumentQueueBatch(
      {
        queue: 'mayisigorta-document-scan',
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      db,
      quarantine,
      true,
      unavailableDocumentScanner,
    );

    expect(acknowledged).toBe(1);
    expect(retried).toBe(0);
    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,version.status AS version_status,
                run.status AS run_status,run.reason_code,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        version_status: string;
        run_status: string;
        reason_code: string;
        evidence_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'RETRY_WAIT',
      attempt_count: 1,
      version_status: 'SCANNING',
      run_status: 'RETRYABLE_ERROR',
      reason_code: 'SCANNER_UNAVAILABLE',
      evidence_count: 0,
    });
  });

  it('preserves the durable dead-letter marker through a later scan retry', async () => {
    const { message } = await createQueuedCustomerDocument('scan-dead-letter-marker');
    const dlqMessage = {
      id: 'message-dead-letter-marker',
      timestamp: new Date(),
      body: message,
      ack: () => undefined,
      retry: () => undefined,
    };
    await consumeDocumentQueueBatch(
      {
        queue: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
        messages: [dlqMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      db,
      quarantine,
      false,
    );
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => syntheticCleanScannerResponse(await digestDocumentStream(body)),
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    const state = await db
      .prepare('SELECT status,last_error_code FROM background_jobs WHERE id=?')
      .bind(message.jobId)
      .first<{ status: string; last_error_code: string | null }>();
    expect(state).toEqual({
      status: 'COMPLETED',
      last_error_code: 'QUEUE_DELIVERY_EXHAUSTED',
    });
    const event = await db
      .prepare(
        'SELECT reason_code,job_id FROM document_queue_dead_letter_events WHERE message_id=?',
      )
      .bind(dlqMessage.id)
      .first();
    expect(event).toEqual({ reason_code: 'QUEUE_DELIVERY_EXHAUSTED', job_id: message.jobId });
  });

  it('records a dead-letter event that arrives after the scan job completed', async () => {
    const { message } = await createQueuedCustomerDocument('scan-late-dead-letter');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => syntheticCleanScannerResponse(await digestDocumentStream(body)),
    };
    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    const lateDeadLetter = {
      id: 'message-late-dead-letter',
      timestamp: new Date(),
      body: message,
      ack: () => undefined,
      retry: () => undefined,
    };
    await consumeDocumentQueueBatch(
      {
        queue: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
        messages: [lateDeadLetter],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      db,
      quarantine,
      false,
    );

    const job = await db
      .prepare('SELECT status,last_error_code FROM background_jobs WHERE id=?')
      .bind(message.jobId)
      .first<{ status: string; last_error_code: string | null }>();
    expect(job).toEqual({
      status: 'COMPLETED',
      last_error_code: 'QUEUE_DELIVERY_EXHAUSTED',
    });
    const event = await db
      .prepare(
        'SELECT reason_code,job_id FROM document_queue_dead_letter_events WHERE message_id=?',
      )
      .bind(lateDeadLetter.id)
      .first();
    expect(event).toEqual({ reason_code: 'QUEUE_DELIVERY_EXHAUSTED', job_id: message.jobId });
  });

  it('retries Queue delivery when the durable D1 claim fails', async () => {
    const { message } = await createQueuedCustomerDocument('scan-d1-claim-failure');
    let acknowledged = 0;
    let retried = 0;
    const queueMessage = {
      id: 'message-d1-claim-failure',
      timestamp: new Date(),
      body: message,
      ack: () => {
        acknowledged += 1;
      },
      retry: () => {
        retried += 1;
      },
    };
    const failingDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return async () => Promise.reject(new Error('synthetic D1 outage'));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await consumeDocumentQueueBatch(
      {
        queue: 'mayisigorta-document-scan',
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      failingDatabase,
      quarantine,
      true,
    );

    expect(acknowledged).toBe(0);
    expect(retried).toBe(1);
    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,version.status AS version_status,
                (SELECT count(*) FROM background_job_runs run WHERE run.job_id=job.id) AS run_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        version_status: string;
        run_count: number;
      }>();
    expect(state).toEqual({
      status: 'QUEUED',
      attempt_count: 0,
      version_status: 'QUARANTINED',
      run_count: 0,
    });
  });

  it('retries Queue delivery when D1 finalization fails after the scanner returns', async () => {
    const { message } = await createQueuedCustomerDocument('scan-d1-finalize-failure');
    let acknowledged = 0;
    let retried = 0;
    let batchCalls = 0;
    const queueMessage = {
      id: 'message-d1-finalize-failure',
      timestamp: new Date(),
      body: message,
      ack: () => {
        acknowledged += 1;
      },
      retry: () => {
        retried += 1;
      },
    };
    const failingDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (...statements: Parameters<D1Database['batch']>) => {
            batchCalls += 1;
            if (batchCalls === 2) throw new Error('synthetic finalization D1 outage');
            return await target.batch(...statements);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => syntheticCleanScannerResponse(await digestDocumentStream(body)),
    };

    await consumeDocumentQueueBatch(
      {
        queue: 'mayisigorta-document-scan',
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      failingDatabase,
      quarantine,
      true,
      scanner,
    );

    expect(batchCalls).toBe(2);
    expect(acknowledged).toBe(0);
    expect(retried).toBe(1);
    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,version.status AS version_status,
                run.status AS run_status,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        version_status: string;
        run_status: string;
        evidence_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'RUNNING',
      attempt_count: 1,
      version_status: 'SCANNING',
      run_status: 'RUNNING',
      evidence_count: 0,
    });
  });

  it('uses the D1 lease CAS so concurrent duplicate deliveries scan once', async () => {
    const { message } = await createQueuedCustomerDocument('scan-claim-concurrency');
    const concurrentDatabase = synchronizeConcurrentScanJobReads(db, 2);
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        scanCalls += 1;
        return syntheticCleanScannerResponse(await digestDocumentStream(body));
      },
    };

    const results = await Promise.all([
      processDocumentScanMessage(concurrentDatabase, quarantine, message, scanner),
      processDocumentScanMessage(concurrentDatabase, quarantine, message, scanner),
    ]);
    expect(results.sort()).toEqual(['ACKED', 'COMPLETED']);

    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,
                (SELECT count(*) FROM background_job_runs run WHERE run.job_id=job.id) AS run_count,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=job.document_version_id) AS evidence_count,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=job.document_version_id
                   AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        run_count: number;
        evidence_count: number;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      attempt_count: 1,
      run_count: 1,
      evidence_count: 1,
      backup_count: 1,
    });
    expect(scanCalls).toBe(1);
  });

  it('marks the latest scan attempt DEAD instead of accepting UNKNOWN after five tries', async () => {
    const { message } = await createQueuedCustomerDocument('scan-unknown-exhausted');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        await body.cancel();
        return { outcome: 'UNKNOWN', reasonCode: 'SCANNER_UNAVAILABLE' };
      },
    };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await processDocumentScanMessage(db, quarantine, message, scanner, {
        retryDelaySeconds: () => 1,
      });
      expect(result).toBe(attempt < 5 ? 'RETRY_SCHEDULED' : 'FAILED_CLOSED');
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1_100));
    }

    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,version.status AS version_status,
                run.status AS run_status,run.reason_code,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        version_status: string;
        run_status: string;
        reason_code: string;
        evidence_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'DEAD',
      attempt_count: 5,
      version_status: 'SCAN_FAILED',
      run_status: 'PERMANENT_ERROR',
      reason_code: 'SCANNER_UNAVAILABLE',
      evidence_count: 0,
    });
  });

  it('marks an expired fifth scan lease DEAD and rejects its late CLEAN result', async () => {
    const { message } = await createQueuedCustomerDocument('scan-fifth-expired-lease');
    const unavailable: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        await body.cancel();
        return { outcome: 'UNKNOWN', reasonCode: 'SCANNER_UNAVAILABLE' };
      },
    };
    const fastRetry = { retryDelaySeconds: () => 1 };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        processDocumentScanMessage(db, quarantine, message, unavailable, fastRetry),
      ).resolves.toBe('RETRY_SCHEDULED');
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }

    let scannerStarted!: () => void;
    const scannerReady = new Promise<void>((resolve) => {
      scannerStarted = resolve;
    });
    let resolveScan!: (result: DocumentScannerResult) => void;
    const pendingScan = new Promise<DocumentScannerResult>((resolve) => {
      resolveScan = resolve;
    });
    const lateScanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        const observedSha = await digestDocumentStream(body);
        scannerStarted();
        return await pendingScan.then((result) => ({ ...result, sha256: observedSha }));
      },
    };
    const running = processDocumentScanMessage(db, quarantine, message, lateScanner, fastRetry);
    await scannerReady;
    await db
      .prepare(
        `UPDATE background_jobs
         SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds')
         WHERE id=? AND status='RUNNING'`,
      )
      .bind(message.jobId)
      .run();
    if (!localQueue) throw new Error('Local document Queue binding was not initialized');
    const dispatch = await dispatchDueDocumentJobs(db, localQueue, ['DOCUMENT_SCAN']);
    expect(dispatch.failed).toBe(0);
    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,run.status AS run_status,run.reason_code,
                version.status AS version_status,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first();
    expect(state).toMatchObject({
      status: 'DEAD',
      attempt_count: 5,
      run_status: 'STALE',
      reason_code: 'LEASE_EXPIRED',
      version_status: 'SCAN_FAILED',
      evidence_count: 0,
    });

    resolveScan(syntheticCleanScannerResponse(message.inputSha256!));
    await expect(running).resolves.toBe('ACKED');
  });

  it('binds CLEAN evidence and backup work to the exact version and checksum once', async () => {
    const { upload, message } = await createQueuedCustomerDocument('scan-clean-idempotency');
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        scanCalls += 1;
        const observedSha = await digestDocumentStream(body);
        const result: DocumentScannerResult = syntheticCleanScannerResponse(observedSha);
        return result;
      },
    };
    const mismatchedSha = message.inputSha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);

    await expect(
      processDocumentScanMessage(
        db,
        quarantine,
        { ...message, documentVersionId: 'another-version-id' },
        scanner,
      ),
    ).resolves.toBe('ACKED');
    await expect(
      processDocumentScanMessage(
        db,
        quarantine,
        { ...message, inputSha256: mismatchedSha },
        scanner,
      ),
    ).resolves.toBe('ACKED');
    await expect(
      processDocumentScanMessage(
        db,
        quarantine,
        { ...message, generation: message.generation + 1 },
        scanner,
      ),
    ).resolves.toBe('ACKED');
    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'ACKED',
    );

    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,version.status AS version_status,
                document.current_version_id,run.status AS run_status,
                evidence.outcome,evidence.sha256,evidence.content_inspection_version,
                evidence.content_inspection_result,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP'
                   AND backup.status='QUEUED') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN documents document ON document.agency_id=version.agency_id
           AND document.id=version.document_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         JOIN document_scan_evidence evidence ON evidence.agency_id=run.agency_id
           AND evidence.job_run_id=run.id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        version_status: string;
        current_version_id: string | null;
        run_status: string;
        outcome: string;
        sha256: string;
        content_inspection_version: string | null;
        content_inspection_result: string | null;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      attempt_count: 1,
      version_status: 'BACKUP_PENDING',
      current_version_id: null,
      run_status: 'SUCCEEDED',
      outcome: 'CLEAN',
      sha256: message.inputSha256,
      backup_count: 1,
    });
    expect(scanCalls).toBe(1);
    expect(upload.body.versionId).toBe(message.documentVersionId);
    expect(state?.content_inspection_version).toBe(REQUIRED_CONTENT_INSPECTION_VERSION);
    expect(JSON.parse(state?.content_inspection_result ?? '{}')).toEqual({
      valid: true,
      format: 'PDF',
      pageCount: 1,
    });
  });

  it('persists bounded JPEG and PNG inspection evidence for the exact scanned version', async () => {
    for (const fixture of [
      { bytes: createSyntheticJpeg(2, 1), name: 'fixture.jpg', mime: 'image/jpeg', format: 'JPEG' },
      { bytes: createSyntheticPng(2, 1), name: 'fixture.png', mime: 'image/png', format: 'PNG' },
    ]) {
      const { message } = await createQueuedCustomerDocument(
        `scan-real-${fixture.format.toLowerCase()}`,
        new Blob([fixture.bytes], { type: fixture.mime }),
        fixture.name,
        fixture.mime,
      );
      const scanner: DocumentScannerAdapter = {
        scan: async ({ body, preflightInspection }) =>
          syntheticCleanScannerResponse(await digestDocumentStream(body), {}, preflightInspection),
      };
      await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
        'COMPLETED',
      );
      const evidence = await db
        .prepare(
          `
        SELECT evidence.sha256,evidence.content_inspection_version,evidence.content_inspection_result,
          version.status
        FROM document_scan_evidence evidence
        JOIN document_versions version ON version.agency_id=evidence.agency_id
          AND version.id=evidence.document_version_id
        WHERE evidence.document_version_id=?
      `,
        )
        .bind(message.documentVersionId)
        .first<{
          sha256: string;
          content_inspection_version: string;
          content_inspection_result: string;
          status: string;
        }>();
      expect(evidence).toMatchObject({
        sha256: message.inputSha256,
        content_inspection_version: REQUIRED_CONTENT_INSPECTION_VERSION,
        status: 'BACKUP_PENDING',
      });
      expect(JSON.parse(evidence!.content_inspection_result)).toMatchObject({
        valid: true,
        format: fixture.format,
        width: 2,
        height: 1,
        pixelCount: 2,
      });
      if (fixture.format === 'JPEG') {
        for (const inspection of [
          { valid: true, format: 'JPEG', width: 2_500, height: 2_000, pixelCount: 5_000_000 },
          { valid: true, format: 'JPEG', width: 8_193, height: 1, pixelCount: 8_193 },
        ]) {
          await expect(
            db
              .prepare(
                `
            INSERT INTO document_scan_evidence
              (id,agency_id,document_version_id,job_run_id,sha256,outcome,reason_code,
               scanner_engine_version,signature_version,signature_updated_at,
               content_inspection_version,content_inspection_result,scanned_at)
            SELECT ?,agency_id,document_version_id,job_run_id,sha256,outcome,reason_code,
              scanner_engine_version,signature_version,signature_updated_at,
              content_inspection_version,?,scanned_at
            FROM document_scan_evidence WHERE document_version_id=?
          `,
              )
              .bind(crypto.randomUUID(), JSON.stringify(inspection), message.documentVersionId)
              .run(),
          ).rejects.toThrow('DOCUMENT_SCAN_INSPECTION_EVIDENCE_INVALID');
        }
      }
    }
  });

  it('rejects missing, stale, and mismatched CLEAN content-inspection evidence', async () => {
    const { message } = await createQueuedCustomerDocument('scan-inspection-result-mismatch');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) =>
        syntheticCleanScannerResponse(
          await digestDocumentStream(body),
          {},
          { valid: true, format: 'PDF', pageCount: 2 },
        ),
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'RETRY_SCHEDULED',
    );
    const mismatchEvidence = await db
      .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
      .bind(message.documentVersionId)
      .first<{ count: number }>();
    expect(mismatchEvidence?.count).toBe(0);

    const invalidEvidenceCases = [
      {
        key: 'missing',
        response: (sha256: string) => {
          const { contentInspection: _inspection, ...withoutInspection } =
            syntheticCleanScannerResponse(sha256);
          return withoutInspection;
        },
      },
      {
        key: 'stale-checksum',
        response: (sha256: string) => ({
          ...syntheticCleanScannerResponse(sha256),
          contentInspection: {
            ...syntheticContentInspectionEvidence(sha256),
            sha256: '0'.repeat(64),
          },
        }),
      },
      {
        key: 'stale-parser-version',
        response: (sha256: string) => ({
          ...syntheticCleanScannerResponse(sha256),
          contentInspection: {
            ...syntheticContentInspectionEvidence(sha256),
            version: 'obsolete-content-parser-v0',
          },
        }),
      },
      {
        key: 'unexpected-clean-field',
        response: (sha256: string) => ({
          ...syntheticCleanScannerResponse(sha256),
          completenessNote: 'unvalidated metadata must not be accepted',
        }),
      },
    ];

    for (const testCase of invalidEvidenceCases) {
      const { message: invalidMessage } = await createQueuedCustomerDocument(
        `scan-inspection-${testCase.key}`,
      );
      const invalidScanner: DocumentScannerAdapter = {
        scan: async ({ body }) => testCase.response(await digestDocumentStream(body)),
      };
      await expect(
        processDocumentScanMessage(db, quarantine, invalidMessage, invalidScanner),
      ).resolves.toBe('RETRY_SCHEDULED');
      const evidence = await db
        .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
        .bind(invalidMessage.documentVersionId)
        .first<{ count: number }>();
      expect(evidence?.count).toBe(0);
    }
  });

  it('allows only one claim when duplicate deliveries share a queued snapshot', async () => {
    const { message } = await createQueuedCustomerDocument('scan-concurrent-duplicate');
    const barrierDb = synchronizeConcurrentScanJobReads(db, 2);
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        scanCalls += 1;
        const observedSha = await digestDocumentStream(body);
        return syntheticCleanScannerResponse(observedSha);
      },
    };

    const results = await Promise.all([
      processDocumentScanMessage(barrierDb, quarantine, message, scanner),
      processDocumentScanMessage(barrierDb, quarantine, message, scanner),
    ]);
    expect(results.sort()).toEqual(['ACKED', 'COMPLETED']);

    const state = await db
      .prepare(
        `SELECT job.status,job.attempt_count,
                (SELECT count(*) FROM background_job_runs run WHERE run.job_id=job.id) AS run_count,
                (SELECT count(*) FROM document_scan_evidence evidence WHERE evidence.document_version_id=job.document_version_id) AS evidence_count,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=job.document_version_id
                   AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        attempt_count: number;
        run_count: number;
        evidence_count: number;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      attempt_count: 1,
      run_count: 1,
      evidence_count: 1,
      backup_count: 1,
    });
    expect(scanCalls).toBe(1);
  });

  it('rejects CLEAN evidence whose signature database is older than 48 hours', async () => {
    const { message } = await createQueuedCustomerDocument('scan-stale-signature');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        const observedSha = await digestDocumentStream(body);
        return syntheticCleanScannerResponse(observedSha, {
          signatureVersion: 'synthetic-old-signature',
          signatureUpdatedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
        });
      },
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,run.reason_code,
                version.status AS version_status,evidence.outcome,
                evidence.reason_code AS evidence_reason_code,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         JOIN document_scan_evidence evidence ON evidence.agency_id=run.agency_id
           AND evidence.job_run_id=run.id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        run_status: string;
        reason_code: string;
        version_status: string;
        outcome: string;
        evidence_reason_code: string;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      run_status: 'PERMANENT_ERROR',
      reason_code: 'SIGNATURE_STALE_OR_INVALID',
      version_status: 'SCAN_FAILED',
      outcome: 'ERROR',
      evidence_reason_code: 'SIGNATURE_STALE_OR_INVALID',
      backup_count: 0,
    });
  });

  it('records INFECTED evidence and rejects the exact quarantined version', async () => {
    const { message } = await createQueuedCustomerDocument('scan-infected-version');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        const observedSha = await digestDocumentStream(body);
        return {
          outcome: 'INFECTED',
          sha256: observedSha,
          scannerEngineVersion: 'test-engine',
          signatureVersion: 'synthetic-test-signature',
          signatureUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
        };
      },
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,version.status AS version_status,
                evidence.outcome,evidence.sha256,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         JOIN document_scan_evidence evidence ON evidence.agency_id=run.agency_id
           AND evidence.job_run_id=run.id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        run_status: string;
        version_status: string;
        outcome: string;
        sha256: string;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      run_status: 'INFECTED',
      version_status: 'REJECTED',
      outcome: 'INFECTED',
      sha256: message.inputSha256,
      backup_count: 0,
    });
  });

  it('fails a malformed PDF closed before the malware scanner can return CLEAN', async () => {
    const malformedPdf = new Blob(['%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'], {
      type: 'application/pdf',
    });
    const { message } = await createQueuedCustomerDocument('scan-malformed-pdf', malformedPdf);
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        scanCalls += 1;
        return syntheticCleanScannerResponse(await digestDocumentStream(body));
      },
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    expect(scanCalls).toBe(0);
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,version.status AS version_status,
                evidence.outcome,evidence.reason_code AS evidence_reason_code,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         JOIN document_scan_evidence evidence ON evidence.agency_id=run.agency_id
           AND evidence.job_run_id=run.id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      run_status: 'PERMANENT_ERROR',
      version_status: 'SCAN_FAILED',
      outcome: 'ERROR',
      evidence_reason_code: 'MALFORMED_PDF',
      backup_count: 0,
    });
  });

  it('records INVALID evidence and rejects the exact quarantined version', async () => {
    const { message } = await createQueuedCustomerDocument('scan-invalid-version');
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => ({
        outcome: 'INVALID',
        sha256: await digestDocumentStream(body),
        reasonCode: 'MALFORMED_PDF',
      }),
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,version.status AS version_status,
                evidence.outcome,evidence.reason_code,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         JOIN document_scan_evidence evidence ON evidence.agency_id=run.agency_id
           AND evidence.job_run_id=run.id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      run_status: 'PERMANENT_ERROR',
      version_status: 'REJECTED',
      outcome: 'INVALID',
      reason_code: 'MALFORMED_PDF',
      backup_count: 0,
    });
  });

  it('fails closed when private R2 bytes no longer match the persisted checksum', async () => {
    const { message } = await createQueuedCustomerDocument('scan-r2-checksum-mismatch');
    const version = await db
      .prepare('SELECT object_key FROM document_versions WHERE id=?')
      .bind(message.documentVersionId)
      .first<{ object_key: string }>();
    if (!version) throw new Error('Document version fixture missing');
    const modifiedBytes = new Uint8Array(await pdfBlob().arrayBuffer());
    const commentByteIndex = modifiedBytes.findIndex((value, index) => index > 8 && value === 0x73);
    if (commentByteIndex < 0) throw new Error('Synthetic PDF comment fixture missing');
    modifiedBytes[commentByteIndex] = modifiedBytes[commentByteIndex]! ^ 1;
    const expectedSha = message.inputSha256;
    if (!expectedSha) throw new Error('Scan message checksum fixture missing');
    await quarantine.put(version.object_key, modifiedBytes, {
      customMetadata: { sha256: expectedSha },
    });
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        scanCalls += 1;
        const observedSha = await digestDocumentStream(body);
        return syntheticCleanScannerResponse(observedSha);
      },
    };

    await expect(processDocumentScanMessage(db, quarantine, message, scanner)).resolves.toBe(
      'COMPLETED',
    );
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,run.reason_code,version.status AS version_status,
                evidence.outcome,evidence.reason_code AS evidence_reason_code,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         JOIN document_scan_evidence evidence ON evidence.agency_id=run.agency_id
           AND evidence.job_run_id=run.id
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        run_status: string;
        reason_code: string;
        version_status: string;
        outcome: string;
        evidence_reason_code: string;
        backup_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'COMPLETED',
      run_status: 'PERMANENT_ERROR',
      reason_code: 'CONTENT_SHA256_MISMATCH',
      version_status: 'SCAN_FAILED',
      outcome: 'ERROR',
      evidence_reason_code: 'CONTENT_SHA256_MISMATCH',
      backup_count: 0,
    });
    expect(scanCalls).toBe(0);
  });

  it('turns a stalled private R2 object lookup into a bounded delivery retry', async () => {
    const { message } = await createQueuedCustomerDocument('scan-r2-read-timeout');
    const hangingBucket = new Proxy(quarantine, {
      get(target, property) {
        if (property === 'get') return () => new Promise<R2ObjectBody | null>(() => undefined);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scanner: DocumentScannerAdapter = {
      scan: async () => {
        throw new Error('The scanner must not be called when R2 lookup stalls');
      },
    };

    await expect(
      processDocumentScanMessage(db, hangingBucket, message, scanner, { scanTimeoutMs: 1_000 }),
    ).resolves.toBe('RETRY_DELIVERY');
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,run.reason_code,
                version.status AS version_status,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        run_status: string;
        reason_code: string | null;
        version_status: string;
        evidence_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'RUNNING',
      run_status: 'RUNNING',
      reason_code: null,
      version_status: 'SCANNING',
      evidence_count: 0,
    });
  });

  it('bounds a stalled R2 body read and never lets it reach CLEAN', async () => {
    const { message } = await createQueuedCustomerDocument('scan-r2-stream-timeout');
    const version = await db
      .prepare('SELECT object_key FROM document_versions WHERE id=?')
      .bind(message.documentVersionId)
      .first<{ object_key: string }>();
    if (!version) throw new Error('Document version fixture missing');
    const object = await quarantine.get(version.object_key);
    if (!object) throw new Error('Quarantine object fixture missing');
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const stalledObject = new Proxy(object, {
      get(target, property) {
        if (property === 'body') return stalledBody;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stalledBucket = new Proxy(quarantine, {
      get(target, property) {
        if (property === 'get') return async () => stalledObject;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        void body.cancel().catch(() => undefined);
        return { outcome: 'UNKNOWN', reasonCode: 'SCANNER_UNAVAILABLE' };
      },
    };

    await expect(
      processDocumentScanMessage(db, stalledBucket, message, scanner, { scanTimeoutMs: 1_000 }),
    ).resolves.toBe('RETRY_DELIVERY');
    const versionState = await db
      .prepare('SELECT status FROM document_versions WHERE id=?')
      .bind(message.documentVersionId)
      .first<{ status: string }>();
    expect(versionState?.status).toBe('SCANNING');
    const evidence = await db
      .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
      .bind(message.documentVersionId)
      .first<{ count: number }>();
    expect(evidence?.count).toBe(0);
  });

  it('bounds the final checksum digest before accepting a CLEAN scanner result', async () => {
    const { message } = await createQueuedCustomerDocument('scan-digest-timeout');
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body, sha256 }) => {
        scanCalls += 1;
        void body.cancel().catch(() => undefined);
        return syntheticCleanScannerResponse(sha256);
      },
    };

    await expect(
      processDocumentScanMessage(db, quarantine, message, scanner, {
        scanTimeoutMs: 1_000,
        digestBytes: () => new Promise<ArrayBuffer>(() => undefined),
      }),
    ).resolves.toBe('RETRY_DELIVERY');
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,run.reason_code,
                version.status AS version_status,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        run_status: string;
        reason_code: string | null;
        version_status: string;
        evidence_count: number;
      }>();
    expect(state).toMatchObject({
      status: 'RUNNING',
      run_status: 'RUNNING',
      reason_code: null,
      version_status: 'SCANNING',
      evidence_count: 0,
    });
    expect(scanCalls).toBe(0);
  });

  it('rejects a CLEAN D1 finalization that begins after the scan deadline', async () => {
    const { message } = await createQueuedCustomerDocument('scan-finalization-after-deadline');
    let batchCalls = 0;
    const delayedFinalizationDb = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (...statements: Parameters<D1Database['batch']>) => {
            batchCalls += 1;
            if (batchCalls === 2) await new Promise((resolve) => setTimeout(resolve, 1_200));
            return await target.batch(...statements);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => syntheticCleanScannerResponse(await digestDocumentStream(body)),
    };

    await expect(
      processDocumentScanMessage(delayedFinalizationDb, quarantine, message, scanner, {
        scanTimeoutMs: 1_000,
      }),
    ).resolves.toBe('RETRY_DELIVERY');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = await db
      .prepare(
        `SELECT job.status,run.status AS run_status,run.reason_code,
                version.status AS version_status,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.document_version_id=version.id) AS evidence_count,
                (SELECT count(*) FROM background_jobs backup
                 WHERE backup.document_version_id=version.id AND backup.job_type='DOCUMENT_BACKUP') AS backup_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first();
    expect(state).toMatchObject({
      status: 'RUNNING',
      run_status: 'RUNNING',
      reason_code: null,
      version_status: 'SCANNING',
      evidence_count: 0,
      backup_count: 0,
    });
  });

  it('bounds D1 job loading before any scanner claim can start', async () => {
    const { message } = await createQueuedCustomerDocument('scan-d1-load-timeout');
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(statementTarget, statementProperty) {
          if (statementProperty === 'bind') {
            const bind = Reflect.get(statementTarget, 'bind', statementTarget) as (
              ...values: unknown[]
            ) => D1PreparedStatement;
            return (...values: unknown[]) => wrapStatement(bind.apply(statementTarget, values));
          }
          if (statementProperty === 'first') {
            const first = Reflect.get(statementTarget, 'first', statementTarget) as (
              ...args: unknown[]
            ) => Promise<unknown>;
            return async (...args: unknown[]) => {
              await new Promise((resolve) => setTimeout(resolve, 700));
              return await first.apply(statementTarget, args);
            };
          }
          const value: unknown = Reflect.get(statementTarget, statementProperty, statementTarget);
          return typeof value === 'function' ? value.bind(statementTarget) : value;
        },
      });
    const delayedReadDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (...args: Parameters<D1Database['prepare']>) => {
            return wrapStatement(target.prepare(...args));
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let scanCalls = 0;
    const scanner: DocumentScannerAdapter = {
      scan: async () => {
        scanCalls += 1;
        return { outcome: 'UNKNOWN', reasonCode: 'SHOULD_NOT_RUN' };
      },
    };
    const startedAt = Date.now();

    await expect(
      processDocumentScanMessage(delayedReadDb, quarantine, message, scanner, {
        scanTimeoutMs: 500,
      }),
    ).resolves.toBe('RETRY_DELIVERY');
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(scanCalls).toBe(0);
    const job = await db
      .prepare('SELECT status,attempt_count FROM background_jobs WHERE id=?')
      .bind(message.jobId)
      .first();
    expect(job).toEqual({ status: 'QUEUED', attempt_count: 0 });
  });

  it('reclaims an expired scan lease and rejects its late CLEAN result', async () => {
    const { message } = await createQueuedCustomerDocument('scan-expired-lease');
    const expectedSha = message.inputSha256;
    if (!expectedSha) throw new Error('Scan message checksum fixture missing');
    let scannerStarted!: () => void;
    let resolveScanner!: (result: DocumentScannerResult) => void;
    const started = new Promise<void>((resolve) => {
      scannerStarted = resolve;
    });
    const pendingResult = new Promise<DocumentScannerResult>((resolve) => {
      resolveScanner = resolve;
    });
    const scanner: DocumentScannerAdapter = {
      scan: async ({ body }) => {
        const observedSha = await digestDocumentStream(body);
        scannerStarted();
        return await pendingResult.then((result) => ({ ...result, sha256: observedSha }));
      },
    };

    const processing = processDocumentScanMessage(db, quarantine, message, scanner);
    await started;
    await db
      .prepare(
        `UPDATE background_jobs
         SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')
         WHERE id=? AND status='RUNNING'`,
      )
      .bind(message.jobId)
      .run();
    const dispatch = await dispatchDueDocumentJobs(db, localQueue, ['DOCUMENT_SCAN']);
    expect(dispatch.failed).toBe(0);

    const reclaimed = await db
      .prepare(
        `SELECT job.status,job.available_at,job.queue_dispatched_at,version.status AS version_status,
                run.status AS run_status,run.reason_code,
                (SELECT count(*) FROM document_scan_evidence evidence
                 WHERE evidence.job_run_id=run.id) AS evidence_count
         FROM background_jobs job
         JOIN document_versions version ON version.agency_id=job.agency_id
           AND version.id=job.document_version_id
         JOIN background_job_runs run ON run.agency_id=job.agency_id
           AND run.job_id=job.id AND run.attempt_number=job.attempt_count
         WHERE job.id=?`,
      )
      .bind(message.jobId)
      .first<{
        status: string;
        available_at: string;
        queue_dispatched_at: string | null;
        version_status: string;
        run_status: string;
        reason_code: string;
        evidence_count: number;
      }>();
    expect(reclaimed).toMatchObject({
      status: 'RETRY_WAIT',
      queue_dispatched_at: null,
      version_status: 'SCANNING',
      run_status: 'STALE',
      reason_code: 'LEASE_EXPIRED',
      evidence_count: 0,
    });
    expect(Date.parse(reclaimed!.available_at)).toBeGreaterThan(Date.now());

    resolveScanner(syntheticCleanScannerResponse(expectedSha));
    await expect(processing).resolves.toBe('ACKED');
    const evidence = await db
      .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
      .bind(message.documentVersionId)
      .first<{ count: number }>();
    expect(evidence?.count).toBe(0);
  });
});

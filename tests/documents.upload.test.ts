// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { VerifiedAccessPrincipal } from '../src/server/auth/types';
import { createApp } from '../src/server';
import { generateIdentityBoundCsrfToken } from '../src/server/security/csrf';
import { createDocumentUpload, type DocumentUploadResult } from '../src/server/documents/service';
import { MAX_DOCUMENT_UPLOAD_BYTES } from '../src/server/documents/validation';

interface LocalDocumentBindings {
  readonly DB: D1Database;
  readonly DOCS_QUARANTINE: R2Bucket;
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

const principal: VerifiedAccessPrincipal = {
  issuer: `https://${teamDomain}`,
  subject: 'upload-owner-subject',
  assurance: 'NORMAL',
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};

function pdfBlob(extraByte?: number): Blob {
  return new Blob(
    [
      Uint8Array.of(
        0x25,
        0x50,
        0x44,
        0x46,
        0x2d,
        0x31,
        0x2e,
        0x37,
        0x0a,
        ...(extraByte === undefined ? [] : [extraByte]),
        0x25,
        0x25,
        0x45,
        0x4f,
        0x46,
      ),
    ],
    { type: 'application/pdf' },
  );
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

async function postUpload(
  form: FormData,
  idempotencyKey: string,
  csrf = true,
  documentsEnabled?: boolean,
) {
  const app = createApp({
    createVerifier: (config) => ({ config, verify: async () => principal }),
    createResolver: () => ({ resolve: async () => ownerContext }),
  });
  const csrfToken = await generateIdentityBoundCsrfToken(
    { subject: principal.subject },
    csrfSecret,
  );
  const headers: Record<string, string> = {
    Origin: 'https://panel.mayisigorta.com',
    'Cf-Access-Jwt-Assertion': 'synthetic-test-assertion',
    'Idempotency-Key': idempotencyKey,
  };
  if (csrf) headers['X-CSRF-Token'] = csrfToken;
  const env = {
    DB: db,
    DOCS_QUARANTINE: quarantine,
    APP_ENV: 'test',
    CF_ACCESS_TEAM_DOMAIN: teamDomain,
    CF_ACCESS_AUDIENCE: 'synthetic-normal-audience-upload-123456',
    CF_ACCESS_SECURE_AUDIENCE: 'synthetic-secure-audience-upload-abcdef',
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
  it('stores only quarantined content and atomically records its durable scan job and audit', async () => {
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
        state: 'QUARANTINED',
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
      status: 'QUARANTINED',
      file_name: 'synthetic-policy.pdf',
      detected_content_type: 'application/pdf',
    });
    expect(version?.object_key).toMatch(/^quarantine\/[0-9a-f-]{36}$/u);

    const stored = await quarantine.get(String(version?.object_key));
    expect(stored).not.toBeNull();
    expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46,
    ]);

    const job = await db
      .prepare(
        `SELECT job_type,document_version_id,input_sha256,generation,status
         FROM background_jobs WHERE document_version_id=?`,
      )
      .bind(result.body.versionId)
      .first<Record<string, unknown>>();
    expect(job).toMatchObject({
      job_type: 'DOCUMENT_SCAN',
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

    expect(policyUpload.body.state).toBe('QUARANTINED');
    expect(quoteUpload.body.state).toBe('QUARANTINED');
    expect(customerUpload.body.state).toBe('QUARANTINED');
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
         WHEN NEW.job_type='DOCUMENT_SCAN' AND EXISTS (
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
        state: 'QUARANTINED',
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
      data: DocumentUploadResult['body'];
      replayed: boolean;
    };
    expect(body).toMatchObject({ success: true, replayed: false, data: { state: 'QUARANTINED' } });
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
    expect(accepted.body.state).toBe('QUARANTINED');
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
    expect(completed.body.state).toBe('QUARANTINED');

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
});

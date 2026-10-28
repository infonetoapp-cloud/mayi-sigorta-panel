// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { localAuthFixture } from './support/local-auth-fixture';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from '../src/server/worker';
import { createUploadRuntime } from '../src/server/documents/upload-runtime';
import { createSyntheticPdf } from './fixtures/documents';
import { createDocumentUpload } from '../src/server/documents/service';
import { createR2DocumentBackupAdapter } from '../src/server/documents/backup-storage';
import { processDocumentBackupMessage } from '../src/server/documents/backup';
import { documentDownloadConfirmation, downloadDocument } from '../src/server/documents/stream';
import { sessionBoundDatabase } from '../src/server/auth/session-database';
import { loadLocalSession } from '../src/server/auth/session';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import { listEmployeeDocuments } from '../src/server/documents/query';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  storage: Miniflare,
  primary: R2Bucket,
  backup: R2Bucket;
let actor: Awaited<ReturnType<typeof f.seed>>;
beforeAll(async () => {
  f = await localAuthFixture();
  actor = await f.seed('document-launch-owner', 'OWNER');
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('launch-customer',?,'INDIVIDUAL','Synthetic','Synthetic','Only',?)",
    )
    .bind(actor.agencyId, actor.membershipId)
    .run();
  storage = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response(null)}}',
      r2Buckets: ['primary', 'backup'],
    }),
  );
  primary = (await storage.getR2Bucket('primary')) as unknown as R2Bucket;
  backup = (await storage.getR2Bucket('backup')) as unknown as R2Bucket;
  f.env.DOCS_QUARANTINE = primary;
  f.env.DOCUMENTS_ENABLED = 'true';
  const runtime = createUploadRuntime((request, env) => Promise.resolve(f.app.fetch(request, env)));
  // Node/native-D1 composition seam. Real private SQLite DO dispatch is exercised
  // separately in documents.upload-do.workerd.test.ts; no production fallback.
  f.env.DOCUMENT_UPLOAD_RUNTIME = {
    getByName: (name: string) => {
      expect(name).toBe('mayi-document-upload-v1');
      return { fetch: (request: Request) => runtime.fetch(request, f.env) };
    },
  } as unknown as NonNullable<typeof f.env.DOCUMENT_UPLOAD_RUNTIME>;
});
afterAll(async () => {
  await f?.mf.dispose();
  await storage?.dispose();
});
async function context() {
  const m = await f.db
    .prepare('SELECT permission_version FROM agency_memberships WHERE id=?')
    .bind(actor.membershipId)
    .first<{ permission_version: number }>();
  return {
    userId: actor.id,
    identityId: actor.identityId,
    assurance: 'NORMAL',
    memberships: [
      {
        id: actor.membershipId,
        agencyId: actor.agencyId,
        status: 'ACTIVE',
        type: 'OWNER',
        permissionVersion: m!.permission_version,
      },
    ],
  } as AuthenticatedUserContext;
}
function input(classification: 'GENERAL' | 'IDENTITY' = 'GENERAL') {
  return {
    ownerType: 'CUSTOMER' as const,
    ownerId: 'launch-customer',
    classification,
    fileName: 'synthetic.pdf',
    declaredContentType: 'application/pdf',
    file: new Blob([createSyntheticPdf()], { type: 'application/pdf' }),
  };
}
it('default exported HTTP upload accepts a real opaque session and creates a canonical job', async () => {
  const s = await f.session(actor.id),
    csrf = await f.csrf(s.cookie),
    body = new FormData();
  body.set('ownerType', 'CUSTOMER');
  body.set('ownerId', 'launch-customer');
  body.set('classification', 'GENERAL');
  body.set('file', new File([createSyntheticPdf()], 'synthetic.pdf', { type: 'application/pdf' }));
  const r = await worker.fetch(
    new Request('https://panel.mayisigorta.com/api/documents', {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: 'https://panel.mayisigorta.com',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
      },
      body,
    }),
    f.env,
    {} as ExecutionContext,
  );
  expect(r.status).toBe(202);
  const response = (await r.json()) as { data: Record<string, unknown> };
  expect(Object.keys(response.data).sort()).toEqual(['classification', 'documentId', 'status']);
  expect(response.data.status).toBe('PROCESSING');
  const listing = await worker.fetch(
    new Request(
      'https://panel.mayisigorta.com/api/documents?ownerType=CUSTOMER&ownerId=launch-customer',
      { headers: { cookie: s.cookie } },
    ),
    f.env,
    {} as ExecutionContext,
  );
  expect(listing.status).toBe(200);
  expect(await listing.json()).toMatchObject({
    success: true,
    data: {
      documents: [
        { documentId: response.data.documentId, status: 'PROCESSING', fileName: 'synthetic.pdf' },
      ],
    },
  });
  const documentId = String(response.data.documentId);
  const job = await f.db
    .prepare(
      "SELECT j.id,j.generation,j.input_sha256,j.document_version_id FROM background_jobs j JOIN document_versions v ON v.id=j.document_version_id WHERE v.document_id=? AND j.job_type='DOCUMENT_BACKUP'",
    )
    .bind(documentId)
    .first<{ id: string; generation: number; input_sha256: string; document_version_id: string }>();
  const message = {
    jobId: job!.id,
    jobType: 'DOCUMENT_BACKUP' as const,
    generation: job!.generation,
    documentVersionId: job!.document_version_id,
    inputSha256: job!.input_sha256,
  };
  expect(
    await processDocumentBackupMessage(
      f.db,
      primary,
      createR2DocumentBackupAdapter(backup),
      message,
    ),
  ).toBe('COMPLETED');
  expect(
    await processDocumentBackupMessage(
      f.db,
      primary,
      createR2DocumentBackupAdapter(backup),
      message,
    ),
  ).toBe('ACKED');
  const download = await worker.fetch(
    new Request(`https://panel.mayisigorta.com/api/documents/${documentId}/download`, {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: 'https://panel.mayisigorta.com',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      body: '{}',
    }),
    f.env,
    {} as ExecutionContext,
  );
  expect(download.status).toBe(200);
  const ready = await worker.fetch(
    new Request(
      'https://panel.mayisigorta.com/api/documents?ownerType=CUSTOMER&ownerId=launch-customer',
      { headers: { cookie: s.cookie } },
    ),
    f.env,
    {} as ExecutionContext,
  );
  expect(await ready.json()).toMatchObject({
    success: true,
    data: { documents: [{ documentId, status: 'READY' }] },
  });
  expect(download.headers.get('content-disposition')).toContain('attachment');
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(createSyntheticPdf());
  const stranger = await f.seed('document-other-owner', 'OWNER', false, 'document-other-agency'),
    other = await f.session(stranger.id),
    otherCsrf = await f.csrf(other.cookie);
  const denied = await worker.fetch(
    new Request(`https://panel.mayisigorta.com/api/documents/${documentId}/download`, {
      method: 'POST',
      headers: {
        cookie: other.cookie,
        origin: 'https://panel.mayisigorta.com',
        'content-type': 'application/json',
        'x-csrf-token': otherCsrf,
      },
      body: '{}',
    }),
    f.env,
    {} as ExecutionContext,
  );
  expect(denied.status).toBe(404);
});
it.each(['session', 'classification', 'archive'] as const)(
  'completed replay rejects changed %s after persisted result read',
  async (change) => {
    const key = crypto.randomUUID(),
      ctx = await context(),
      payload = input(),
      s = await f.session(actor.id);
    await createDocumentUpload(f.db, primary, ctx, payload, {
      idempotencyKey: key,
      correlationId: key,
    });
    const row = await loadLocalSession(
      f.db,
      new Request('https://panel.mayisigorta.com/api/documents', { headers: { cookie: s.cookie } }),
    );
    let reached = false;
    const base = {
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        if (sql.includes('d.created_by_user_id') && sql.includes('FROM documents'))
          return {
            bind(...args: unknown[]) {
              const bound = statement.bind(...args);
              return {
                async first() {
                  const result = await bound.first();
                  reached = true;
                  if (change === 'session')
                    await f.db
                      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
                      .bind(Date.now(), s.hash)
                      .run();
                  if (change === 'classification')
                    await f.db
                      .prepare(
                        "UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?",
                      )
                      .bind((result as { document_id: string }).document_id)
                      .run();
                  if (change === 'archive')
                    await f.db
                      .prepare(
                        "UPDATE documents SET status='ARCHIVED',version=version+1 WHERE id=?",
                      )
                      .bind((result as { document_id: string }).document_id)
                      .run();
                  return result;
                },
              };
            },
          } as unknown as D1PreparedStatement;
        return statement;
      },
      batch: f.db.batch.bind(f.db),
    } as D1Database;
    await expect(
      createDocumentUpload(sessionBoundDatabase(base, row), primary, ctx, payload, {
        idempotencyKey: key,
        correlationId: key,
      }),
    ).rejects.toThrow();
    expect(reached).toBe(true);
  },
);
it('completed replay rejects a corrupted receipt classification', async () => {
  const key = crypto.randomUUID(),
    ctx = await context(),
    payload = input();
  await createDocumentUpload(f.db, primary, ctx, payload, {
    idempotencyKey: key,
    correlationId: key,
  });
  await f.db
    .prepare(
      "UPDATE operation_receipts SET response_body=json_set(response_body,'$.classification','IDENTITY') WHERE idempotency_key=?",
    )
    .bind(key)
    .run();
  await expect(
    createDocumentUpload(f.db, primary, ctx, payload, { idempotencyKey: key, correlationId: key }),
  ).rejects.toThrow();
});
it('even an empty metadata page rejects final-session revocation', async () => {
  const ctx = await context(),
    s = await f.session(actor.id),
    row = await loadLocalSession(
      f.db,
      new Request('https://panel.mayisigorta.com/api/documents', { headers: { cookie: s.cookie } }),
    );
  const input = {
    ownerType: 'CUSTOMER',
    ownerId: 'launch-customer',
    cursor: encodeURIComponent(
      JSON.stringify({ ownerType: 'CUSTOMER', ownerId: 'launch-customer', after: 'zzzzzz' }),
    ),
  };
  expect(
    (await listEmployeeDocuments(sessionBoundDatabase(f.db, row), ctx, input)).documents,
  ).toEqual([]);
  let reached = false;
  const base = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: D1PreparedStatement[]) {
      reached = true;
      await f.db
        .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
        .bind(Date.now(), s.hash)
        .run();
      return f.db.batch(statements);
    },
  } as D1Database;
  await expect(
    listEmployeeDocuments(sessionBoundDatabase(base, row), ctx, input),
  ).rejects.toThrow();
  expect(reached).toBe(true);
});
it('parent-scoped metadata pages fail closed at session and classification disclosure races', async () => {
  const ctx = await context(),
    s = await f.session(actor.id),
    row = await loadLocalSession(
      f.db,
      new Request('https://panel.mayisigorta.com/api/documents', { headers: { cookie: s.cookie } }),
    );
  const before = await listEmployeeDocuments(sessionBoundDatabase(f.db, row), ctx, {
    ownerType: 'CUSTOMER',
    ownerId: 'launch-customer',
  });
  expect(before.documents.length).toBeGreaterThan(0);
  expect(JSON.stringify(before)).not.toMatch(/objectKey|checksum|jobId|versionId/);
  const base = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: D1PreparedStatement[]) {
      await f.db
        .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
        .bind(Date.now(), s.hash)
        .run();
      return f.db.batch(statements);
    },
  } as D1Database;
  await expect(
    listEmployeeDocuments(sessionBoundDatabase(base, row), ctx, {
      ownerType: 'CUSTOMER',
      ownerId: 'launch-customer',
    }),
  ).rejects.toThrow();
  await expect(
    listEmployeeDocuments(f.db, ctx, { ownerType: 'CUSTOMER', ownerId: 'other-parent' }),
  ).rejects.toThrow();
  const second = await f.session(actor.id),
    row2 = await loadLocalSession(
      f.db,
      new Request('https://panel.mayisigorta.com/api/documents', {
        headers: { cookie: second.cookie },
      }),
    );
  const base2 = {
    prepare: f.db.prepare.bind(f.db),
    async batch(statements: D1PreparedStatement[]) {
      await f.db
        .prepare("UPDATE documents SET classification='IDENTITY',version=version+1 WHERE id=?")
        .bind(before.documents[0]!.documentId)
        .run();
      return f.db.batch(statements);
    },
  } as D1Database;
  await expect(
    listEmployeeDocuments(sessionBoundDatabase(base2, row2), ctx, {
      ownerType: 'CUSTOMER',
      ownerId: 'launch-customer',
    }),
  ).rejects.toThrow();
});
it.each(['confirmation', 'download'] as const)(
  '%s rechecks a revocation at final disclosure',
  async (kind) => {
    const ctx = await context();
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) SELECT ?,?,'sensitive.identity.read','UNSCOPED' WHERE NOT EXISTS(SELECT 1 FROM membership_permissions WHERE membership_id=? AND permission_code='sensitive.identity.read')",
      )
      .bind(crypto.randomUUID(), actor.membershipId, actor.membershipId)
      .run();
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) SELECT ?,?,'sensitive.identity.write','UNSCOPED' WHERE NOT EXISTS(SELECT 1 FROM membership_permissions WHERE membership_id=? AND permission_code='sensitive.identity.write')",
      )
      .bind(crypto.randomUUID(), actor.membershipId, actor.membershipId)
      .run();
    const current = await context(),
      key = crypto.randomUUID(),
      p = input(kind === 'confirmation' ? 'IDENTITY' : 'GENERAL');
    const uploaded = await createDocumentUpload(f.db, primary, current, p, {
      idempotencyKey: key,
      correlationId: key,
    });
    const job = await f.db
      .prepare('SELECT id,generation,input_sha256 FROM background_jobs WHERE document_version_id=?')
      .bind(uploaded.body.versionId)
      .first<{ id: string; generation: number; input_sha256: string }>();
    expect(
      await processDocumentBackupMessage(f.db, primary, createR2DocumentBackupAdapter(backup), {
        jobId: job!.id,
        jobType: 'DOCUMENT_BACKUP',
        generation: job!.generation,
        documentVersionId: uploaded.body.versionId,
        inputSha256: job!.input_sha256,
      }),
    ).toBe('COMPLETED');
    const s = await f.session(actor.id, true),
      row = await loadLocalSession(
        f.db,
        new Request('https://panel.mayisigorta.com/api/documents', {
          headers: { cookie: s.cookie },
        }),
      );
    let snapshots = 0;
    const base = {
      prepare(sql: string) {
        const stmt = f.db.prepare(sql);
        if (sql.startsWith('SELECT json_object('))
          return {
            bind(...args: unknown[]) {
              const bound = stmt.bind(...args);
              return {
                async all() {
                  const result = await bound.all();
                  if (++snapshots === 2)
                    await f.db
                      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
                      .bind(Date.now(), s.hash)
                      .run();
                  return result;
                },
              };
            },
          } as unknown as D1PreparedStatement;
        return stmt;
      },
      batch: f.db.batch.bind(f.db),
    } as D1Database;
    const scoped = sessionBoundDatabase(base, row, kind === 'confirmation');
    await expect(
      kind === 'confirmation'
        ? documentDownloadConfirmation(
            scoped,
            { ...current, assurance: 'SECURE' },
            uploaded.body.documentId,
          )
        : downloadDocument(scoped, primary, current, uploaded.body.documentId, {}),
    ).rejects.toThrow();
    expect(snapshots).toBe(2);
    expect(ctx.userId).toBe(current.userId);
  },
);

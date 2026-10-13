// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { localAuthFixture } from './support/local-auth-fixture';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from '../src/server/worker';
import { createSyntheticPdf } from './fixtures/documents';
import { createDocumentUpload } from '../src/server/documents/service';
import { createR2DocumentBackupAdapter } from '../src/server/documents/backup-storage';
import { processDocumentBackupMessage } from '../src/server/documents/backup';
import { documentDownloadConfirmation, downloadDocument } from '../src/server/documents/stream';
import { sessionBoundDatabase } from '../src/server/auth/session-database';
import { loadLocalSession } from '../src/server/auth/session';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
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

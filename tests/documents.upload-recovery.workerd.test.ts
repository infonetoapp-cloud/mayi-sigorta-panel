// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { localAuthFixture } from './support/local-auth-fixture';
import { createSyntheticJpeg } from './fixtures/documents';

const origin = 'https://panel.mayisigorta.com';
const bytes = createSyntheticJpeg(64, 64);
let runtime: InstanceType<typeof miniflare.Miniflare>;
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents:
        "import worker from './src/server/worker';export {DocumentUploadDurableObject} from './src/server/worker';export default {fetch(request,env,ctx){const local=new Request(request);local.headers.delete('host');return worker.fetch(local,env,ctx)}}",
      resolveDir: process.cwd(),
      sourcefile: 'local-recovery-loopback.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['node:*', 'cloudflare:workers'],
    write: false,
  });
  runtime = new miniflare.Miniflare(
    miniflare.convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: {
        DOCUMENT_UPLOAD_RUNTIME: { className: 'DocumentUploadDurableObject', useSQLite: true },
      },
      d1Databases: { DB: '00000000-0000-0000-0000-000000000039' },
      r2Buckets: ['DOCS_QUARANTINE'],
      bindings: {
        APP_ENV: 'test',
        PANEL_ORIGIN: origin,
        DOCUMENTS_ENABLED: 'true',
        CSRF_SECRET: crypto.randomUUID(),
      },
      ratelimits: {
        AUTH_SOURCE_RATE_LIMITER: { namespace_id: '2702', simple: { limit: 1000, period: 60 } },
        DOCUMENT_UPLOAD_RATE_LIMITER: { namespace_id: '2703', simple: { limit: 10, period: 60 } },
      },
    }),
  );
  f = await localAuthFixture(runtime);
}, 90000);
afterAll(async () => {
  await runtime?.dispose();
});

async function fixture() {
  const actor = await f.seed(crypto.randomUUID(), 'OWNER', false, crypto.randomUUID());
  const customer = crypto.randomUUID(),
    key = crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,?,'INDIVIDUAL','Synthetic','Synthetic','Only',?)",
    )
    .bind(customer, actor.agencyId, actor.membershipId)
    .run();
  const session = await f.session(actor.id);
  const res = await runtime.dispatchFetch(origin + '/api/auth/csrf-token', {
    headers: { Cookie: session.cookie, Origin: origin },
  });
  expect(res.status).toBe(200);
  const csrf = ((await res.json()) as { data: { token: string } }).data.token;
  async function upload(token: string | null = csrf, content = bytes) {
    const body = new FormData();
    body.set('ownerType', 'CUSTOMER');
    body.set('ownerId', customer);
    body.set('classification', 'GENERAL');
    body.set('file', new File([content], 'synthetic.jpeg', { type: 'image/jpeg' }));
    const req = new Request(origin + '/api/documents', {
      method: 'POST',
      body,
      headers: {
        Origin: origin,
        Cookie: session.cookie,
        'Idempotency-Key': key,
        ...(token ? { 'X-CSRF-Token': token } : {}),
      },
    });
    return runtime.dispatchFetch(req.url, {
      method: 'POST',
      headers: Object.fromEntries(req.headers),
      body: await req.arrayBuffer(),
    });
  }
  async function counts() {
    const result: Record<string, number> = {};
    for (const table of [
      'documents',
      'document_versions',
      'operation_receipts',
      'background_jobs',
      'audit_events',
    ])
      result[table] = (await f.db
        .prepare('SELECT count(*) n FROM ' + table + ' WHERE agency_id=?')
        .bind(actor.agencyId)
        .first<number>('n'))!;
    return result;
  }
  // Test-only SQLite trigger: abort INSIDE the real atomic finalization batch.
  // No production source/config switch or failpoint exists.
  async function failFinalization() {
    await f.db
      .prepare(
        "CREATE TRIGGER recovery_test_failure BEFORE UPDATE OF status ON document_versions WHEN NEW.status='BACKUP_PENDING' BEGIN SELECT RAISE(ABORT,'CONTROLLED_RECOVERY_TEST_FAILURE'); END",
      )
      .run();
  }
  return { actor, session, key, upload, counts, failFinalization };
}

it('rolls back controlled finalization then recovers the same key and replays exactly one logical effect', async () => {
  const x = await fixture();
  await x.failFinalization();
  try {
    expect((await x.upload()).status).toBe(503);
    expect(await x.counts()).toEqual({
      documents: 1,
      document_versions: 1,
      operation_receipts: 1,
      background_jobs: 0,
      audit_events: 0,
    });
    expect(
      await f.db
        .prepare('SELECT status,validation_version FROM document_versions WHERE agency_id=?')
        .bind(x.actor.agencyId)
        .first(),
    ).toEqual({ status: 'PENDING_UPLOAD', validation_version: null });
    expect(
      await f.db
        .prepare('SELECT status,response_status FROM operation_receipts WHERE idempotency_key=?')
        .bind(x.key)
        .first(),
    ).toEqual({ status: 'IN_PROGRESS', response_status: null });
  } finally {
    await f.db.prepare('DROP TRIGGER IF EXISTS recovery_test_failure').run();
  }
  const recovered = await x.upload();
  expect(recovered.status).toBe(202);
  const completed = (await recovered.json()) as { data: { documentId: string }; replayed: boolean };
  expect(completed.replayed).toBe(false);
  const replay = await x.upload();
  expect(replay.status).toBe(202);
  expect(await replay.json()).toMatchObject({ data: completed.data, replayed: true });
  expect(await x.counts()).toEqual({
    documents: 1,
    document_versions: 1,
    operation_receipts: 1,
    background_jobs: 1,
    audit_events: 1,
  });
  expect(
    await f.db
      .prepare('SELECT status,response_status FROM operation_receipts WHERE idempotency_key=?')
      .bind(x.key)
      .first(),
  ).toEqual({ status: 'COMPLETED', response_status: 202 });
  const row = await f.db
    .prepare(
      'SELECT status,validation_version,object_key,sha256,size_bytes FROM document_versions WHERE agency_id=?',
    )
    .bind(x.actor.agencyId)
    .first<{
      status: string;
      validation_version: string;
      object_key: string;
      sha256: string;
      size_bytes: number;
    }>();
  expect(row).toMatchObject({
    status: 'BACKUP_PENDING',
    validation_version: 'm4-content-inspection-v1',
    size_bytes: bytes.byteLength,
  });
  const bucket = await runtime.getR2Bucket('DOCS_QUARANTINE');
  const object = await bucket.get(row!.object_key);
  expect(object).not.toBeNull();
  const actual = new Uint8Array(await object!.arrayBuffer());
  expect(actual).toEqual(bytes);
  const sha = Buffer.from(await crypto.subtle.digest('SHA-256', actual)).toString('hex');
  expect(row!.sha256).toBe(sha);
  expect((await bucket.list()).objects.filter((o) => o.key === row!.object_key)).toHaveLength(1);
  expect((await x.upload(null)).status).toBe(403);
  expect((await x.upload(undefined, createSyntheticJpeg(32, 32))).status).toBe(409);
}, 60000);

it('denies same-key recovery after session revocation and leaves no finalized effect', async () => {
  const x = await fixture();
  await x.failFinalization();
  try {
    expect((await x.upload()).status).toBe(503);
  } finally {
    await f.db.prepare('DROP TRIGGER IF EXISTS recovery_test_failure').run();
  }
  await f.db
    .prepare(
      "UPDATE local_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash=?",
    )
    .bind(x.session.hash)
    .run();
  expect((await x.upload()).status).toBe(401);
  expect(await x.counts()).toEqual({
    documents: 1,
    document_versions: 1,
    operation_receipts: 1,
    background_jobs: 0,
    audit_events: 0,
  });
  expect(
    await f.db
      .prepare('SELECT status,validation_version FROM document_versions WHERE agency_id=?')
      .bind(x.actor.agencyId)
      .first(),
  ).toEqual({ status: 'PENDING_UPLOAD', validation_version: null });
}, 60000);

// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { localAuthFixture } from './support/local-auth-fixture';
import { createSyntheticPng } from './fixtures/documents';
let runtime: InstanceType<typeof miniflare.Miniflare>;
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let cookie: string, csrf: string, customer: string;
const origin = 'https://panel.mayisigorta.com';
beforeAll(async () => {
  // Miniflare's loopback proxy rewrites Host but preserves the canonical URL.
  // Remove only that local transport header; production Host denial is tested separately.
  const bundle = await build({
    stdin: {
      contents:
        "import worker from './src/server/worker';export {DocumentUploadDurableObject,PasswordKdfDurableObject} from './src/server/worker';export default {fetch(request,env,ctx){const local=new Request(request);local.headers.delete('host');return worker.fetch(local,env,ctx)}}",
      resolveDir: process.cwd(),
      sourcefile: 'native-upload-loopback.ts',
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
      d1Databases: { DB: '00000000-0000-0000-0000-000000000027' },
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
  const actor = await f.seed(crypto.randomUUID(), 'OWNER');
  customer = crypto.randomUUID();
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES(?,?,'INDIVIDUAL','Synthetic','Synthetic','Only',?)",
    )
    .bind(customer, actor.agencyId, actor.membershipId)
    .run();
  cookie = (await f.session(actor.id)).cookie;
  const response = await runtime.dispatchFetch(origin + '/api/auth/csrf-token', {
    headers: { Cookie: cookie, Host: 'panel.mayisigorta.com', Origin: origin },
  });
  expect(response.status).toBe(200);
  csrf = ((await response.json()) as { data: { token: string } }).data.token;
}, 90000);
afterAll(async () => {
  await runtime?.dispose();
});
function body() {
  const form = new FormData();
  form.set('ownerType', 'CUSTOMER');
  form.set('ownerId', customer);
  form.set('classification', 'GENERAL');
  form.set('file', new File([createSyntheticPng(1, 1)], 'synthetic.png', { type: 'image/png' }));
  return form;
}
async function upload(key: string, token: string | null = csrf) {
  const encoded = new Request(origin + '/api/documents', {
    method: 'POST',
    headers: {
      Origin: origin,
      Host: 'panel.mayisigorta.com',
      Cookie: cookie,
      'Idempotency-Key': key,
      ...(token ? { 'X-CSRF-Token': token } : {}),
    },
    body: body(),
  });
  return runtime.dispatchFetch(encoded.url, {
    method: 'POST',
    headers: Object.fromEntries(encoded.headers),
    body: await encoded.arrayBuffer(),
  });
}
it('runs actual exported HTTP -> SQLite DO -> canonical parser/receipt with exact replay', async () => {
  const key = crypto.randomUUID();
  const response = await upload(key);
  expect(response.status).toBe(202);
  const first = (await response.json()) as { data: { documentId: string }; replayed: boolean };
  expect(first.replayed).toBe(false);
  const retry = await upload(key);
  expect(retry.status).toBe(202);
  const replay = (await retry.json()) as typeof first;
  expect(replay.replayed).toBe(true);
  expect(replay.data).toEqual(first.data);
  const row = await f.db
    .prepare(
      'SELECT v.status,v.validation_version,v.size_bytes FROM document_versions v WHERE v.document_id=?',
    )
    .bind(first.data.documentId)
    .first<{ status: string; validation_version: string; size_bytes: number }>();
  expect(row?.status).toBe('BACKUP_PENDING');
  expect(row?.validation_version).toBe('m4-content-inspection-v1');
  expect(row?.size_bytes).toBe(createSyntheticPng(1, 1).byteLength);
  for (const table of [
    'documents',
    'document_versions',
    'background_jobs',
    'operation_receipts',
    'audit_events',
  ])
    expect((await f.db.prepare('SELECT count(*) n FROM ' + table).first<{ n: number }>())?.n).toBe(
      1,
    );
}, 60000);
it('retains real CSRF and live-session denial inside the object', async () => {
  expect((await upload(crypto.randomUUID(), null)).status).toBe(403);
  await f.db
    .prepare(
      "UPDATE local_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE revoked_at IS NULL",
    )
    .run();
  expect((await upload(crypto.randomUUID())).status).toBe(401);
  expect((await f.db.prepare('SELECT count(*) n FROM documents').first<{ n: number }>())?.n).toBe(
    1,
  );
}, 60000);

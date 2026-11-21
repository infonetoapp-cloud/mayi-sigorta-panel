// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
// Only the unused Node DO-base re-export is stubbed. Native bundles below are
// built from disk by esbuild, never from this Vite mock graph.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import exportedWorker from '../src/server/worker';
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createSyntheticPdf } from './fixtures/documents';
import { documentBackupObjectKey } from '../src/server/documents/backup-storage';
import { documentByteStream } from '../src/server/documents/copy-resources';
const wire = (value: Uint8Array<ArrayBuffer>) =>
  documentByteStream(value, new AbortController().signal);
const gateMatrix = [
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [false, false, true],
  [false, true, true],
  [true, false, true],
  [true, true, false],
  [true, true, true],
] as const;
const matrixName = (i: number) => 'closed-gate-matrix-' + i;
import type { DocumentBackupCapability } from '../src/server/documents/backup-capability-contract';
import { enqueueDocumentReconcile } from '../src/server/documents/reconcile';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';
const bytes = createSyntheticPdf(),
  sha = createHash('sha256').update(bytes).digest('hex');
const options = {
  bundle: true,
  format: 'esm' as const,
  platform: 'neutral' as const,
  target: 'es2022',
  external: ['node:*', 'cloudflare:workers'],
  write: false,
};
let runtime: InstanceType<typeof miniflare.Miniflare>,
  db: D1Database,
  primary: R2Bucket,
  backup: R2Bucket;
let worker: Awaited<ReturnType<typeof runtime.getWorker>>;
beforeAll(async () => {
  const crm = await build({ ...options, entryPoints: ['src/server/worker.ts'] });
  const path = 'src/server/documents/private-backup-worker.ts';
  const peer = await build({ ...options, entryPoints: [path] });
  const exceptionPeer = await build({
    ...options,
    stdin: {
      contents:
        "import {WorkerEntrypoint} from 'cloudflare:workers';export class DocumentBackupCapability extends WorkerEntrypoint {createAndVerify(){throw new Error('SYNTHETIC_RPC_IO_FAILURE')}observeBackup(){throw new Error('SYNTHETIC_RPC_IO_FAILURE')}fetch(){return new Response(null,{status:404})}}export default {fetch(){return new Response(null,{status:404})}}",
      resolveDir: process.cwd(),
      loader: 'ts',
    },
  });
  const gateProbe = await build({
    ...options,
    stdin: {
      contents: `import {WorkerEntrypoint} from 'cloudflare:workers';import worker from './src/server/worker';export class DocumentGateProbe extends WorkerEntrypoint {async check(path){const r=await worker.fetch(new Request('https://panel.mayisigorta.com'+path,{method:'POST',headers:{Origin:'https://panel.mayisigorta.com',Host:'panel.mayisigorta.com','content-type':'application/json'},body:'{}'}),this.env,this.ctx);const b=await r.json();return {status:r.status,code:b.error?.code}}}export default {...worker,fetch(){return new Response(null,{status:404})}}`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
  });
  // Test-only lost-result fault AFTER real conditional write+readback. No successful
  // response is fabricated, no fault flag is added to production source.
  const ambiguous = await build({
    ...options,
    stdin: {
      contents: `import {DocumentBackupCapability as Base} from './${path}';export class DocumentBackupCapability extends Base {async createAndVerify(identity,bytes){const result=await super.createAndVerify(identity,bytes);return result.ok?{ok:false,kind:'IO'}:result}}export default {fetch(){return new Response(null,{status:404})}}`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
  });
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const common = {
    modules: true,
    compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'],
  };
  const main = {
    ...common,
    script: crm.outputFiles![0]!.text,
    d1Databases: { DB: '00000000-0000-4000-8000-000000000030' },
    r2Buckets: { DOCS_QUARANTINE: 'synthetic-private-primary' },
  };
  const bindings = (pub: string, jobs: string, cron: string) => ({
    APP_ENV: 'test',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    DOCUMENTS_ENABLED: pub,
    DOCUMENT_JOBS_ENABLED: jobs,
    DOCUMENT_CRON_ENABLED: cron,
  });
  const capability = (name: string) => ({
    DOCUMENT_BACKUP_CAPABILITY: { name, entrypoint: 'DocumentBackupCapability' },
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        ...gateMatrix.map(([pub, jobs, cron], i) => ({
          name: matrixName(i),
          ...main,
          script: gateProbe.outputFiles![0]!.text,
          bindings: bindings(String(pub), String(jobs), String(cron)),
          serviceBindings: capability('document-recovery'),
          queueProducers: { DOCUMENT_JOB_QUEUE: 'synthetic-document-jobs' },
        })),
        {
          name: 'crm',
          ...main,
          bindings: bindings('true', 'true', 'true'),
          serviceBindings: capability('document-recovery'),
          queueProducers: { DOCUMENT_JOB_QUEUE: 'synthetic-document-jobs' },
        },
        {
          name: 'crm-disabled',
          ...main,
          bindings: bindings('false', 'false', 'false'),
          serviceBindings: {
            ...capability('document-recovery'),
            LOCAL_GATE_PROBE: { name: 'document-gate-probe', entrypoint: 'DocumentGateProbe' },
            ...Object.fromEntries(
              gateMatrix.map((_, i) => [
                matrixName(i),
                { name: matrixName(i), entrypoint: 'DocumentGateProbe' },
              ]),
            ),
          },
          queueProducers: { DOCUMENT_JOB_QUEUE: 'synthetic-document-jobs' },
        },
        {
          name: 'document-gate-probe',
          ...main,
          script: gateProbe.outputFiles![0]!.text,
          bindings: bindings('false', 'false', 'false'),
          serviceBindings: capability('document-recovery'),
        },
        {
          name: 'native-deadline-producer',
          ...common,
          serviceBindings: capability('document-recovery'),
          script: `export default {async fetch(request,env){const identity=await request.json();let cancelled=0,finishPull,owner;const body=new ReadableStream({start(c){owner=c},pull(){return new Promise(r=>{finishPull=r})},cancel(){cancelled++;finishPull?.()}});const start=Date.now();const first=await env.DOCUMENT_BACKUP_CAPABILITY.createAndVerify(identity,body);let producerClosed=false;try{owner.error(new Error('SYNTHETIC_PRODUCER_CLOSED'));producerClosed=true}catch{}finishPull?.();await new Promise(r=>setTimeout(r,20));const resumed=await env.DOCUMENT_BACKUP_CAPABILITY.createAndVerify({...identity,documentVersionId:identity.documentVersionId+'-resumed'},new ReadableStream({start(c){c.enqueue(new Uint8Array([7]));c.close()}}));return Response.json({firstOK:first.ok,resumedOK:resumed.ok,cancelled,producerClosed,wallMs:Date.now()-start})}}`,
        },
        { name: 'crm-unbound', ...main, bindings: bindings('true', 'true', 'true') },
        {
          name: 'crm-ambiguous',
          ...main,
          bindings: bindings('true', 'true', 'true'),
          serviceBindings: capability('ambiguous-recovery'),
        },
        {
          name: 'crm-io',
          ...main,
          bindings: bindings('true', 'true', 'true'),
          serviceBindings: capability('unavailable-recovery'),
        },
        {
          name: 'crm-exception',
          ...main,
          bindings: bindings('true', 'true', 'true'),
          serviceBindings: capability('exception-recovery'),
        },
        { name: 'exception-recovery', ...common, script: exceptionPeer.outputFiles![0]!.text },
        {
          name: 'document-recovery',
          ...common,
          script: peer.outputFiles![0]!.text,
          r2Buckets: { DOCUMENT_BACKUP_STORAGE: 'synthetic-private-backup' },
        },
        {
          name: 'ambiguous-recovery',
          ...common,
          script: ambiguous.outputFiles![0]!.text,
          r2Buckets: { DOCUMENT_BACKUP_STORAGE: 'synthetic-private-backup' },
        },
        { name: 'unavailable-recovery', ...common, script: peer.outputFiles![0]!.text },
        // Native producer sink isolates scheduled dispatch from our manual Queue event
        // matrix. It adds no HTTP/business adapter and never runs document executors.
        {
          name: 'queue-hold',
          ...common,
          script:
            'export default {queue(batch){batch.ackAll()},fetch(){return new Response(null,{status:404})}}',
          queueConsumers: ['synthetic-document-jobs'],
        },
      ],
    }),
  );
  db = await runtime.getD1Database('DB', 'crm');
  primary = (await runtime.getR2Bucket('DOCS_QUARANTINE', 'crm')) as unknown as R2Bucket;
  backup = (await runtime.getR2Bucket(
    'DOCUMENT_BACKUP_STORAGE',
    'document-recovery',
  )) as unknown as R2Bucket;
  worker = await runtime.getWorker('crm');
  for (const name of readdirSync('db/migrations')
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
    .sort())
    for (const sql of readFileSync(resolve('db/migrations', name), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  await db.prepare("INSERT INTO agencies(id,status) VALUES('private-agency','PROVISIONING')").run();
  await db.prepare("INSERT INTO users(id,status) VALUES('private-user','INACTIVE')").run();
  await db
    .prepare(
      "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('private-member','private-agency','private-user','OWNER','INVITED','synthetic@example.invalid','2099-01-01T00:00:00.000Z')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('private-customer','private-agency','INDIVIDUAL','Synthetic','Synthetic','Customer','private-member')",
    )
    .run();
}, 180000);
afterAll(async () => {
  await runtime?.dispose();
});
async function fixture(maxAttempts = 5, content: Uint8Array<ArrayBuffer> = bytes) {
  const checksum = createHash('sha256').update(content).digest('hex');
  const document = crypto.randomUUID(),
    version = crypto.randomUUID(),
    job = crypto.randomUUID(),
    key = 'quarantine/' + crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id) VALUES(?,'private-agency','CUSTOMER','private-customer','private-user','private-member')",
    )
    .bind(document)
    .run();
  await db
    .prepare(
      "INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,'private-agency',?,1,?,?,?,'synthetic.pdf','application/pdf','private-user','private-member')",
    )
    .bind(version, document, key, checksum, content.byteLength)
    .run();
  await primary.put(key, content, { customMetadata: { sha256: checksum } });
  await db
    .prepare(
      "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,max_attempts) VALUES(?,'private-agency','DOCUMENT_BACKUP',?,?,?)",
    )
    .bind(job, version, checksum, maxAttempts)
    .run();
  await db
    .prepare(
      "UPDATE document_versions SET status='BACKUP_PENDING',validation_version='m4-content-inspection-v1',validation_result=? WHERE id=?",
    )
    .bind(JSON.stringify({ format: 'PDF', pageCount: 1, valid: true }), version)
    .run();
  const identity = {
    agencyId: 'private-agency',
    documentVersionId: version,
    generation: 1,
    sha256: checksum,
    sizeBytes: content.byteLength,
  };
  return {
    document,
    version,
    job,
    key,
    backupKey: documentBackupObjectKey(identity),
    identity,
    message: {
      jobId: job,
      jobType: 'DOCUMENT_BACKUP',
      generation: 1,
      documentVersionId: version,
      inputSha256: checksum,
    } as DocumentJobQueueMessage,
  };
}
async function deliver(body: unknown, target = worker) {
  return target.queue('synthetic-document-jobs', [
    { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body },
  ]);
}
async function state(job: string) {
  return db
    .prepare(
      'SELECT status,attempt_count,last_error_code,available_at,queue_dispatched_at FROM background_jobs WHERE id=?',
    )
    .bind(job)
    .first<{
      status: string;
      attempt_count: number;
      last_error_code: string | null;
      available_at: string;
      queue_dispatched_at: string | null;
    }>();
}
async function versionState(f: Awaited<ReturnType<typeof fixture>>) {
  return db
    .prepare(
      'SELECT v.status,d.current_version_id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?',
    )
    .bind(f.version)
    .first<{ status: string; current_version_id: string | null }>();
}
async function evidence(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all([
    db
      .prepare('SELECT count(*) AS n FROM background_job_runs WHERE job_id=?')
      .bind(f.job)
      .first<number>('n'),
    db
      .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
      .bind(f.version)
      .first<number>('n'),
    db
      .prepare(
        "SELECT count(*) AS n FROM system_audit_events WHERE target_id=? AND action='document.backup.completed' AND outcome='SUCCESS' AND reason_code='BACKUP_VERIFIED'",
      )
      .bind(f.version)
      .first<number>('n'),
  ]);
}
async function peer() {
  return (
    await runtime.getBindings<{ DOCUMENT_BACKUP_CAPABILITY: DocumentBackupCapability }>('crm')
  ).DOCUMENT_BACKUP_CAPABILITY;
}
async function reconcile(f: Awaited<ReturnType<typeof fixture>>, operation = crypto.randomUUID()) {
  const m = await enqueueDocumentReconcile(
    db,
    'private-agency',
    { versionId: f.version },
    operation,
  );
  await deliver(m);
  return m;
}
const measurements: unknown[] = [];
it.each([1, 4096, 1048576, 20971519, 20971520])(
  'actual queue/stream-RPC copy admission at %s bytes',
  async (size) => {
    // Admission-layer deterministic bytes, NOT a format/parser or AV performance claim.
    const data = new Uint8Array(size);
    data.fill(23);
    const f = await fixture(5, data);
    const start = performance.now();
    let peak = process.memoryUsage();
    const sample = setInterval(() => {
      const m = process.memoryUsage();
      peak = {
        ...m,
        heapUsed: Math.max(peak.heapUsed, m.heapUsed),
        external: Math.max(peak.external, m.external),
        arrayBuffers: Math.max(peak.arrayBuffers, m.arrayBuffers),
      };
    }, 5);
    try {
      await deliver(f.message);
      expect((await state(f.job))?.status).toBe('COMPLETED');
      expect(await evidence(f)).toEqual([1, 1, 1]);
      const object = await backup.get(f.backupKey);
      expect(object !== null && object.size === size).toBe(true);
      const reader = object!.body.getReader(),
        hash = createHash('sha256');
      let read = 0;
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          read += r.value.byteLength;
          hash.update(r.value);
        }
      } finally {
        reader.releaseLock();
      }
      expect(read === size && hash.digest('hex') === f.identity.sha256).toBe(true);
      measurements.push({
        size,
        wallMs: Math.round(performance.now() - start),
        verifiedBytes: read,
        nodeDriverHeapUsedPeak: peak.heapUsed,
        nodeDriverExternalPeak: peak.external,
        nodeDriverArrayBuffersPeak: peak.arrayBuffers,
        scope: 'NODE TEST DRIVER ONLY; NOT WORKER ISOLATE OR PRODUCTION',
        explicitBuffersFromSourceTrace: 3,
        RPCFullBodySerialization: false,
      });
      writeFileSync(
        join(tmpdir(), 'mayi-document-copy-local-metrics.json'),
        JSON.stringify(measurements, null, 2),
      );
    } finally {
      clearInterval(sample);
    }
  },
  120000,
);
it('actual RPC rejects20MiB+1 before object write and rejects whole-buffer wire bodies', async () => {
  const p = await peer(),
    data = new Uint8Array(1),
    identity = {
      agencyId: 'private-agency',
      documentVersionId: crypto.randomUUID(),
      generation: 1,
      sizeBytes: 20971521,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  expect((await p.createAndVerify(identity, wire(data))).ok).toBe(false);
  const valid = { ...identity, sizeBytes: 1 };
  expect(
    (
      await (p.createAndVerify as unknown as (i: unknown, b: unknown) => Promise<{ ok: boolean }>)(
        valid,
        data,
      )
    ).ok,
  ).toBe(false);
  expect(await backup.head(documentBackupObjectKey(valid))).toBeNull();
});
it.each(['same', 'different'] as const)(
  'concurrent %s document events use one nonwaiting admission; no duplicate effects',
  async (kind) => {
    const first = await fixture(),
      second = kind === 'same' ? first : await fixture();
    const results = await Promise.all([deliver(first.message), deliver(second.message)]);
    // Native queue transport may serialize events before isolate execution.
    // Forced overlap and exact busy semantics are independently tested below.
    expect(results.reduce((n, r) => n + r.retryMessages.length, 0) <= 1).toBe(true);
    await deliver(first.message);
    await deliver(second.message);
    expect(await evidence(first)).toEqual([1, 1, 1]);
    expect(await evidence(second)).toEqual([1, 1, 1]);
  },
);
it('backup/reconcile race and health coexistence do not fabricate completion or corrupt state', async () => {
  const f = await fixture();
  const message = await enqueueDocumentReconcile(
    db,
    'private-agency',
    { versionId: f.version },
    crypto.randomUUID(),
  );
  const results = await Promise.all([
    deliver(f.message),
    deliver(message),
    worker.scheduled({ cron: '*/5 * * * *' }),
  ]);
  expect(results[2]!.outcome).toBe('ok');
  await deliver(f.message);
  await deliver(message);
  expect((await state(f.job))?.status).toBe('COMPLETED');
  expect((await state(message.jobId))?.status).toBe('COMPLETED');
  expect(await evidence(f)).toEqual([1, 1, 1]);
});
it('forced source barrier proves exported Queue admission across duplicate/different/reconcile events with native D1/RPC', async () => {
  const f = await fixture(),
    other = await fixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
      entered = r;
    }),
    blocked = new Promise<void>((r) => {
      release = r;
    });
  let gets = 0;
  const source = {
    get: async (key: string) => {
      gets++;
      entered();
      await blocked;
      return primary.get(key);
    },
  } as unknown as R2Bucket;
  const env = {
    DB: db,
    DOCS_QUARANTINE: source,
    DOCUMENT_BACKUP_CAPABILITY: await peer(),
    DOCUMENTS_ENABLED: 'true',
    DOCUMENT_JOBS_ENABLED: 'true',
  };
  const invoke = (body: DocumentJobQueueMessage) => {
    let ack = 0,
      retry = 0;
    const task = exportedWorker.queue(
      {
        messages: [
          {
            body,
            ack() {
              ack++;
            },
            retry() {
              retry++;
            },
          },
        ],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      env,
    );
    return { task, ack: () => ack, retry: () => retry };
  };
  const first = invoke(f.message);
  await ready;
  const duplicate = invoke(f.message),
    second = invoke(other.message),
    reconcileMessage = await enqueueDocumentReconcile(
      db,
      'private-agency',
      { versionId: f.version },
      crypto.randomUUID(),
    ),
    race = invoke(reconcileMessage);
  await Promise.all([duplicate.task, second.task, race.task]);
  expect(duplicate.retry() + second.retry() + race.retry()).toBe(3);
  expect(gets).toBe(1);
  expect((await state(f.job))?.attempt_count).toBe(1);
  expect((await state(other.job))?.attempt_count).toBe(0);
  expect((await state(reconcileMessage.jobId))?.attempt_count).toBe(0);
  const health: Promise<unknown>[] = [];
  exportedWorker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, env, {
    waitUntil: (p: Promise<unknown>) => health.push(p),
  } as unknown as ExecutionContext);
  await Promise.all(health);
  release();
  await first.task;
  expect(first.ack()).toBe(1);
  expect(await evidence(f)).toEqual([1, 1, 1]);
  await deliver(other.message);
  await deliver(reconcileMessage);
  expect(await evidence(other)).toEqual([1, 1, 1]);
  expect((await state(reconcileMessage.jobId))?.status).toBe('COMPLETED');
});
it('actual private admission rejects another incoming body while a stream is stalled, then recovers', async () => {
  const p = await peer(),
    body = new Uint8Array([7]),
    identity = {
      agencyId: 'private-agency',
      documentVersionId: crypto.randomUUID(),
      generation: 1,
      sizeBytes: 1,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  let send!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      entered();
      return new Promise<void>((r) => {
        send = () => {
          c.enqueue(body);
          c.close();
          r();
        };
      });
    },
  });
  const first = p.createAndVerify(identity, stream);
  await ready;
  const second = { ...identity, documentVersionId: crypto.randomUUID() };
  expect((await p.createAndVerify(second, wire(body))).ok).toBe(false);
  send();
  expect((await first).ok).toBe(true);
  expect((await p.createAndVerify(second, wire(body))).ok).toBe(true);
});
it('native Worker-to-Worker RPC120s deadline fails closed; producer-owned shutdown resumes bounded admission', async () => {
  const data = new Uint8Array([7]),
    identity = {
      agencyId: 'private-agency',
      documentVersionId: crypto.randomUUID(),
      generation: 1,
      sizeBytes: 1,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  const producer = await runtime.getWorker('native-deadline-producer');
  const response = await producer.fetch('https://local-deadline.test', {
    method: 'POST',
    body: JSON.stringify(identity),
  });
  const result = (await response.json()) as {
    firstOK: boolean;
    resumedOK: boolean;
    cancelled: number;
    producerClosed: boolean;
    wallMs: number;
  };
  expect(result.firstOK).toBe(false);
  expect(result.wallMs >= 119000).toBe(true);
  expect(result.producerClosed).toBe(true);
  expect(result.resumedOK).toBe(true);
  measurements.push({ ...result, scope: 'LOCAL NATIVE WORKER-TO-WORKER RPC; NOT PRODUCTION' });
  writeFileSync(
    join(tmpdir(), 'mayi-document-copy-local-metrics.json'),
    JSON.stringify(measurements, null, 2),
  );
  expect(await backup.head(documentBackupObjectKey(identity))).toBeNull();
}, 145000);
it('real private service RPC creates verified immutable backup and denies HTTP/destructive authority', async () => {
  const f = await fixture();
  const capability = await peer();
  expect((await capability.createAndVerify(f.identity, wire(bytes))).ok).toBe(true);
  const first = await backup.head(f.backupKey);
  expect((await capability.createAndVerify(f.identity, wire(bytes))).ok).toBe(true);
  expect((await backup.head(f.backupKey))?.etag === first?.etag).toBe(true);
  const backupObject = await backup.get(f.backupKey);
  expect(
    backupObject !== null &&
      backupObject.size === bytes.byteLength &&
      createHash('sha256')
        .update(new Uint8Array(await backupObject.arrayBuffer()))
        .digest('hex') === sha,
  ).toBe(true);
  await primary.delete(f.backupKey);
  expect((await backup.head(f.backupKey))?.etag === first?.etag).toBe(true);
  const http = await runtime.getWorker('document-recovery');
  expect(
    (await http.fetch('https://private.invalid/create', { method: 'POST', body: 'not-authority' }))
      .status,
  ).toBe(404);
  expect((await capability.observeBackup('d1/unauthorized/database.sql')).ok).toBe(false);
  expect((await state(f.job))?.status).toBe('QUEUED');
  expect(await evidence(f)).toEqual([0, 0, 0]);
});
it('private RPC rejects extra/path-selecting identity and oversized/hash-mismatched bytes', async () => {
  const f = await fixture(),
    capability = await peer();
  const bad = bytes.slice();
  bad[0] = bad[0]! ^ 1;
  for (const [identity, value] of [
    [{ ...f.identity, objectKey: 'd1/unrelated/database.sql' }, bytes],
    [{ ...f.identity, sizeBytes: 20971521 }, bytes],
    [f.identity, bad],
    [{ ...f.identity, sizeBytes: bytes.byteLength + 1 }, bytes],
  ] as Array<[typeof f.identity, Uint8Array<ArrayBuffer>]>)
    expect((await capability.createAndVerify(identity, wire(value))).ok).toBe(false);
  expect(await backup.head(f.backupKey)).toBeNull();
  expect(await evidence(f)).toEqual([0, 0, 0]);
  for (const method of ['delete', 'list', 'get', 'put', 'overwrite']) {
    const forbidden = capability as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    await expect(async () => await forbidden[method]!(f.backupKey)).rejects.toThrow();
  }
});
it('D1 finalize failure after object verification never completes; immutable object is reused by due retry', async () => {
  const f = await fixture();
  expect(/^[a-f0-9-]{36}$/.test(f.version)).toBe(true);
  await db
    .prepare(
      `CREATE TRIGGER synthetic_copy_finalize_stop BEFORE INSERT ON document_backup_copies WHEN NEW.document_version_id='${f.version}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FINALIZE_FAILURE'); END`,
    )
    .run();
  try {
    await deliver(f.message);
    expect((await state(f.job))?.status).toBe('RETRY_WAIT');
    expect(await evidence(f)).toEqual([1, 0, 0]);
    expect((await backup.head(f.backupKey)) !== null).toBe(true);
  } finally {
    await db.prepare('DROP TRIGGER synthetic_copy_finalize_stop').run();
  }
  const before = await backup.head(f.backupKey);
  const failed = await state(f.job);
  await new Promise((r) =>
    setTimeout(r, Math.max(0, Date.parse(failed!.available_at) - Date.now()) + 25),
  );
  await deliver(f.message);
  expect((await state(f.job))?.status).toBe('COMPLETED');
  expect(await evidence(f)).toEqual([2, 1, 1]);
  const after = await backup.head(f.backupKey);
  expect(
    before !== null &&
      after !== null &&
      before.etag === after.etag &&
      before.uploaded.getTime() === after.uploaded.getTime(),
  ).toBe(true);
}, 90000);
it('real exported workerd queue composes private RPC into verified backup and AVAILABLE', async () => {
  const f = await fixture();
  const result = await deliver(f.message);
  expect(result.outcome).toBe('ok');
  expect((await state(f.job))?.status).toBe('COMPLETED');
  expect((await versionState(f))?.status).toBe('AVAILABLE');
  expect((await versionState(f))?.current_version_id === f.version).toBe(true);
  expect(await evidence(f)).toEqual([1, 1, 1]);
  const copy = await db
    .prepare(
      'SELECT source_sha256,backup_sha256,object_key FROM document_backup_copies WHERE document_version_id=?',
    )
    .bind(f.version)
    .first<{ source_sha256: string; backup_sha256: string; object_key: string }>();
  expect(
    copy?.source_sha256 === sha && copy.backup_sha256 === sha && copy.object_key === f.backupKey,
  ).toBe(true);
});
it('duplicate/COMPLETED delivery causes no duplicate run/copy/audit or object replacement', async () => {
  const f = await fixture();
  await deliver(f.message);
  const old = await backup.head(f.backupKey);
  const before = await evidence(f);
  await deliver(f.message);
  await deliver(f.message);
  expect(await evidence(f)).toEqual(before);
  expect(before).toEqual([1, 1, 1]);
  expect((await state(f.job))?.attempt_count).toBe(1);
  expect((await backup.head(f.backupKey))?.etag === old?.etag).toBe(true);
});
it('stale generation/wrong version/missing job never synthesize trusted state or objects', async () => {
  const f = await fixture();
  const before = (await db
    .prepare('SELECT count(*) AS n FROM background_jobs')
    .first<number>('n'))!;
  for (const body of [
    { ...f.message, generation: 2 },
    { ...f.message, documentVersionId: crypto.randomUUID() },
    { ...f.message, jobId: crypto.randomUUID() },
  ])
    expect((await deliver(body)).retryMessages.length).toBe(0);
  expect((await state(f.job))?.status).toBe('QUEUED');
  expect((await state(f.job))?.attempt_count).toBe(0);
  expect(await evidence(f)).toEqual([0, 0, 0]);
  expect(await backup.head(f.backupKey)).toBeNull();
  expect(await db.prepare('SELECT count(*) AS n FROM background_jobs').first<number>('n')).toBe(
    before,
  );
});
it('live lease conflict is ACKed without a second claim or backup write', async () => {
  const f = await fixture();
  const lease = createHash('sha256').update(crypto.randomUUID()).digest('hex');
  await db.batch([
    db
      .prepare(
        "UPDATE background_jobs SET status='RUNNING',attempt_count=1,lease_token_hash=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+150 seconds') WHERE id=?",
      )
      .bind(lease, f.job),
    db
      .prepare(
        "INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash) VALUES(?,'private-agency',?,1,?)",
      )
      .bind(crypto.randomUUID(), f.job, lease),
  ]);
  expect((await deliver(f.message)).retryMessages.length).toBe(0);
  expect((await state(f.job))?.status).toBe('RUNNING');
  expect((await state(f.job))?.attempt_count).toBe(1);
  expect(await backup.head(f.backupKey)).toBeNull();
  expect(await evidence(f)).toEqual([1, 0, 0]);
});
it('malformed/unsupported body is safely ACKed without durable business effects', async () => {
  const before = await db.prepare('SELECT count(*) AS n FROM background_jobs').first<number>('n');
  for (const body of [
    null,
    'not-a-job',
    [],
    { jobType: 'DOCUMENT_RESTORE' },
    { jobType: 'DOCUMENT_BACKUP', generation: 0 },
    {
      jobType: 'DOCUMENT_RECONCILE',
      jobId: 'missing',
      generation: 1,
      documentVersionId: 'not-null',
      inputSha256: null,
    },
  ])
    expect((await deliver(body)).retryMessages.length).toBe(0);
  expect(await db.prepare('SELECT count(*) AS n FROM background_jobs').first<number>('n')).toBe(
    before,
  );
});
it('unbound private capability retries delivery without primary-bucket fallback or D1 attempt', async () => {
  const f = await fixture();
  const unbound = await runtime.getWorker('crm-unbound');
  expect((await deliver(f.message, unbound)).retryMessages.length).toBe(1);
  expect((await state(f.job))?.attempt_count).toBe(0);
  expect((await state(f.job))?.status).toBe('QUEUED');
  expect(await backup.head(f.backupKey)).toBeNull();
  expect(await primary.head(f.backupKey)).toBeNull();
});
it('handler IO failure exhausts the configured D1 budget; DEAD delivery cannot resurrect it', async () => {
  const f = await fixture(1),
    io = await runtime.getWorker('crm-io');
  await deliver(f.message, io);
  expect((await state(f.job))?.status).toBe('DEAD');
  expect((await state(f.job))?.last_error_code).toBe('BACKUP_IO_OR_FINALIZE_FAILED');
  expect(await evidence(f)).toEqual([1, 0, 0]);
  await deliver(f.message);
  expect((await state(f.job))?.status).toBe('DEAD');
  expect(await backup.head(f.backupKey)).toBeNull();
  expect(await evidence(f)).toEqual([1, 0, 0]);
});
it('actual private RPC exception is sanitized into durable retry, not completion', async () => {
  const f = await fixture(),
    exception = await runtime.getWorker('crm-exception');
  const result = await deliver(f.message, exception);
  expect(result.retryMessages.length).toBe(0);
  expect((await state(f.job))?.status).toBe('RETRY_WAIT');
  expect((await state(f.job))?.last_error_code).toBe('BACKUP_IO_OR_FINALIZE_FAILED');
  expect(await evidence(f)).toEqual([1, 0, 0]);
  expect((await versionState(f))?.status).toBe('BACKUP_PENDING');
  expect(await backup.head(f.backupKey)).toBeNull();
});
it('immutable conflicting object cannot be replaced or accepted as verified completion', async () => {
  const f = await fixture();
  const wrong = bytes.slice();
  wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 1;
  const wrongHash = createHash('sha256').update(wrong).digest('hex');
  await backup.put(f.backupKey, wrong, {
    customMetadata: {
      agencyId: f.identity.agencyId,
      documentVersionId: f.version,
      generation: '1',
      sha256: sha,
    },
  });
  const before = await backup.head(f.backupKey);
  await deliver(f.message);
  expect((await state(f.job))?.status).toBe('DEAD');
  expect(await evidence(f)).toEqual([1, 0, 0]);
  expect((await versionState(f))?.current_version_id).toBeNull();
  const object = await backup.get(f.backupKey);
  expect(
    object !== null &&
      createHash('sha256')
        .update(new Uint8Array(await object.arrayBuffer()))
        .digest('hex') === wrongHash,
  ).toBe(true);
  expect((await backup.head(f.backupKey))?.etag === before?.etag).toBe(true);
});
it('ambiguous committed R2 outcome stays RETRY_WAIT; due retry converges without replacing object', async () => {
  const f = await fixture(),
    ambiguous = await runtime.getWorker('crm-ambiguous');
  await deliver(f.message, ambiguous);
  const failed = await state(f.job);
  expect(failed?.status).toBe('RETRY_WAIT');
  expect(await evidence(f)).toEqual([1, 0, 0]);
  expect((await versionState(f))?.status).toBe('BACKUP_PENDING');
  const object = await backup.head(f.backupKey);
  expect(object !== null).toBe(true);
  await new Promise((r) =>
    setTimeout(r, Math.max(0, Date.parse(failed!.available_at) - Date.now()) + 25),
  );
  await deliver(f.message);
  expect((await state(f.job))?.status).toBe('COMPLETED');
  expect(await evidence(f)).toEqual([2, 1, 1]);
  expect((await backup.head(f.backupKey))?.etag === object?.etag).toBe(true);
}, 90000);
it('reconcile absent backup detects investigation while original backup work stays recoverable', async () => {
  const f = await fixture();
  const m = await reconcile(f);
  expect((await state(m.jobId))?.status).toBe('COMPLETED');
  expect((await state(m.jobId))?.last_error_code).toBe('RECONCILE_BACKUP_MISSING');
  expect((await state(f.job))?.status).toBe('QUEUED');
  expect((await versionState(f))?.status).toBe('BACKUP_PENDING');
  expect((await versionState(f))?.current_version_id).toBeNull();
  expect(await evidence(f)).toEqual([0, 0, 0]);
});
it('verified object without D1 evidence is finalized only through authoritative nested backup lease/CAS', async () => {
  const f = await fixture();
  expect((await (await peer()).createAndVerify(f.identity, wire(bytes))).ok).toBe(true);
  expect(await evidence(f)).toEqual([0, 0, 0]);
  expect((await versionState(f))?.status).toBe('BACKUP_PENDING');
  const m = await reconcile(f);
  expect((await state(m.jobId))?.last_error_code).toBeNull();
  expect((await state(f.job))?.status).toBe('COMPLETED');
  expect(await evidence(f)).toEqual([1, 1, 1]);
  expect((await versionState(f))?.status).toBe('AVAILABLE');
});
it('evidence with missing object is an inconsistency and removes publication, not evidence', async () => {
  const f = await fixture();
  await deliver(f.message);
  await backup.delete(f.backupKey);
  const m = await reconcile(f);
  expect((await state(m.jobId))?.last_error_code).toBe('RECONCILE_BACKUP_MISSING');
  expect((await versionState(f))?.current_version_id).toBeNull();
  expect(await evidence(f)).toEqual([1, 1, 1]);
});
it.each(['metadata', 'checksum'] as const)(
  'reconcile %s mismatch is detected and cannot retain publication',
  async (kind) => {
    const f = await fixture();
    await deliver(f.message);
    const value = bytes.slice();
    if (kind === 'checksum') value[value.length - 1] = value[value.length - 1]! ^ 1;
    await backup.put(f.backupKey, value, {
      customMetadata: {
        agencyId: kind === 'metadata' ? 'other-synthetic-agency' : f.identity.agencyId,
        documentVersionId: f.version,
        generation: '1',
        sha256: sha,
      },
    });
    const m = await reconcile(f);
    expect((await state(m.jobId))?.last_error_code).toBe(
      kind === 'metadata'
        ? 'RECONCILE_BACKUP_IDENTITY_MISMATCH'
        : 'RECONCILE_BACKUP_CHECKSUM_MISMATCH',
    );
    expect((await versionState(f))?.current_version_id).toBeNull();
    expect(await evidence(f)).toEqual([1, 1, 1]);
  },
);
it('coherent reconcile is a no-op; duplicate scheduling/delivery and stale generation are idempotent', async () => {
  const f = await fixture();
  await deliver(f.message);
  const op = crypto.randomUUID(),
    m = await reconcile(f, op),
    again = await enqueueDocumentReconcile(db, 'private-agency', { versionId: f.version }, op);
  expect(m.jobId === again.jobId).toBe(true);
  await deliver(m);
  await deliver({ ...m, generation: 2 });
  expect((await state(m.jobId))?.attempt_count).toBe(1);
  expect((await state(m.jobId))?.last_error_code).toBeNull();
  expect((await versionState(f))?.current_version_id === f.version).toBe(true);
  expect(await evidence(f)).toEqual([1, 1, 1]);
});
it('DOCUMENTS_ENABLED=false keeps upload/download/secure routes closed even with local Queue and private RPC', async () => {
  const f = await fixture(),
    disabled = await runtime.getWorker('crm-disabled');
  await deliver(f.message, disabled);
  expect((await state(f.job))?.status).toBe('QUEUED');
  expect((await state(f.job))?.attempt_count).toBe(0);
  expect(await evidence(f)).toEqual([0, 0, 0]);
  // Construct the canonical Request INSIDE workerd: the installed Node Fetcher
  // proxy returned transport403, not a document-route response. This fixture RPC
  // calls the actual imported exported fetch without auth/app injection.
  const probe = (
    await runtime.getBindings<{
      LOCAL_GATE_PROBE: { check(path: string): Promise<{ status: number; code: string }> };
    }>('crm-disabled')
  ).LOCAL_GATE_PROBE;
  for (const path of [
    '/api/documents',
    '/api/documents/' + f.document + '/download',
    '/secure/api/documents/' + f.document + '/download',
    '/secure/api/documents/' + f.document + '/download-grants',
    '/secure/api/documents/' + f.document + '/download-confirmation',
  ]) {
    const result = await probe.check(path);
    expect(result.status).toBe(404);
    expect(result.code).toBe('NOT_FOUND');
  }
  expect((await disabled.scheduled({ cron: '*/5 * * * *' })).outcome).toBe('ok');
  expect((await state(f.job))?.queue_dispatched_at).toBeNull();
  expect(await backup.head(f.backupKey)).toBeNull();
});
it('actual exported scheduled handler composes native producer and health without executing the test-held delivery', async () => {
  const f = await fixture();
  expect((await worker.scheduled({ cron: '*/5 * * * *' })).outcome).toBe('ok');
  expect((await state(f.job))?.queue_dispatched_at !== null).toBe(true);
  expect((await state(f.job))?.status).toBe('QUEUED');
  expect(await evidence(f)).toEqual([0, 0, 0]);
});
it.each(gateMatrix.map((flags, i) => [i, ...flags] as const))(
  'native gate matrix%s public%s/jobs%s/cron%s',
  async (i, pub, jobs, cron) => {
    const name = matrixName(i),
      target = await runtime.getWorker(name),
      caller =
        await runtime.getBindings<
          Record<string, { check(path: string): Promise<{ status: number; code: string }> }>
        >('crm-disabled'),
      probe = caller[name]!;
    for (const path of [
      '/api/documents',
      '/api/documents/synthetic-missing/download',
      '/secure/api/documents/synthetic-missing/download',
      '/secure/api/documents/synthetic-missing/download-grants',
      '/secure/api/documents/synthetic-missing/download-confirmation',
    ]) {
      const r = await probe.check(path);
      // The Queue fixture has no upload dispatch bindings, so that route fails closed at the edge.
      const expected = !pub
        ? { status: 404, code: 'NOT_FOUND' }
        : path === '/api/documents'
          ? { status: 503, code: 'SERVICE_UNAVAILABLE' }
          : { status: 401, code: 'UNAUTHORIZED' };
      expect(r).toEqual(expected);
    }
    const f = await fixture();
    const delivery = await deliver(f.message, target);
    expect(delivery.outcome).toBe('ok');
    expect((await state(f.job))?.status).toBe(jobs ? 'COMPLETED' : 'QUEUED');
    expect(await evidence(f)).toEqual(jobs ? [1, 1, 1] : [0, 0, 0]);
    const scheduled = await fixture();
    expect((await target.scheduled({ cron: '*/5 * * * *' })).outcome).toBe('ok');
    expect((await state(scheduled.job))?.queue_dispatched_at !== null).toBe(cron);
    expect((await state(scheduled.job))?.status).toBe('QUEUED');
    expect(await evidence(scheduled)).toEqual([0, 0, 0]);
  },
);

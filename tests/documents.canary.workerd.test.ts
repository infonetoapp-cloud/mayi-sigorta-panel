// @vitest-environment node
import { it, expect } from 'vitest';
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let runtime: InstanceType<typeof miniflare.Miniflare>,
  control: {
    prepare(size: number): Promise<unknown>;
    snapshot(): Promise<Record<string, unknown>>;
    closedRoutes(): Promise<number[]>;
  },
  db: D1Database;
const options = {
  bundle: true,
  format: 'esm' as const,
  platform: 'neutral' as const,
  target: 'es2022',
  external: ['node:*', 'cloudflare:workers'],
  write: false,
};
async function setup(size = 1048576) {
  const app = await build({ ...options, entryPoints: ['scripts/canary/document-worker.ts'] }),
    leaf = await build({ ...options, entryPoints: ['scripts/canary/document-leaf.ts'] });
  const common = {
    modules: true,
    compatibilityDate: '2026-09-01',
    compatibilityFlags: ['nodejs_compat'],
  };
  runtime = new miniflare.Miniflare(
    miniflare.convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'p0',
          ...common,
          script: app.outputFiles![0]!.text,
          bindings: {
            APP_ENV: 'test',
            PANEL_ORIGIN: 'https://panel.mayisigorta.com',
            DOCUMENTS_ENABLED: 'false',
            CANARY_QUEUE_COMMISSIONED: 'true',
            CANARY_DATABASE_ID: '00000000-0000-4000-8000-000000000081',
            CANARY_PRIMARY_BUCKET: 'mayisigorta-m4-canary-local-primary',
            CANARY_RECOVERY_BUCKET: 'mayisigorta-m4-canary-local-recovery',
            CANARY_RUN_ID: '00000000-0000-4000-8000-000000000082',
            CANARY_EXPECTED_SIZE: String(size),
          },
          d1Databases: { DB: '00000000-0000-4000-8000-000000000081' },
          r2Buckets: { DOCS_QUARANTINE: 'mayisigorta-m4-canary-local-primary' },
          serviceBindings: {
            CANARY_LEAF: { name: 'p0-leaf', entrypoint: 'MeasuredDocumentBackupCapability' },
          },
          queueProducers: { DOCUMENT_JOB_QUEUE: 'synthetic-p0-jobs' },
          queueConsumers: {
            'synthetic-p0-jobs': { maxBatchSize: 1, maxRetries: 0 },
          },
        },
        {
          name: 'p0-leaf',
          ...common,
          script: leaf.outputFiles![0]!.text,
          r2Buckets: { DOCUMENT_BACKUP_STORAGE: 'mayisigorta-m4-canary-local-recovery' },
        },
        {
          name: 'control',
          ...common,
          script: 'export default {fetch(){return new Response(null,{status:404})}}',
          serviceBindings: { CANARY_CONTROL: { name: 'p0', entrypoint: 'DocumentCanaryControl' } },
        },
      ],
    }),
  );
  db = await runtime.getD1Database('DB', 'p0');
  for (const name of readdirSync('db/migrations')
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
    .sort())
    for (const sql of readFileSync('db/migrations/' + name, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
  control = (await runtime.getBindings<{ CANARY_CONTROL: typeof control }>('control'))
    .CANARY_CONTROL;
}
it('strict sequential1/10/20MiB closed real broker exported-runtime canary; first failure stops progression', async () => {
  const results: Record<string, unknown>[] = [];
  for (const size of [1048576, 10485760, 20971520]) {
    await setup(size);
    let peak = process.memoryUsage();
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      peak = {
        ...m,
        heapUsed: Math.max(peak.heapUsed, m.heapUsed),
        external: Math.max(peak.external, m.external),
        arrayBuffers: Math.max(peak.arrayBuffers, m.arrayBuffers),
      };
    }, 5);
    try {
      await expect(async () => await control.prepare(20971521)).rejects.toThrow(
        'CANARY_SIZE_DENIED',
      );
      expect(await db.prepare('SELECT count(*) AS n FROM background_jobs').first<number>('n')).toBe(
        0,
      );
      const producer = (await runtime.getBindings<{ DOCUMENT_JOB_QUEUE: Queue<unknown> }>('p0'))
        .DOCUMENT_JOB_QUEUE;
      await producer.send({
        kind: 'P0_SYNTHETIC_START',
        runId: '00000000-0000-4000-8000-000000000082',
        sizeBytes: size,
      });
      let result: Record<string, unknown> = {};
      for (let n = 0; n < 300; n++) {
        try {
          result = JSON.parse(JSON.stringify(await control.snapshot())) as Record<string, unknown>;
        } catch {
          /* kickoff may not have committed scope yet */
        }
        if (result.finished) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const bucket = await runtime.getR2Bucket('DOCUMENT_BACKUP_STORAGE', 'p0-leaf');
      const count = (await bucket.list()).objects.length;
      result.destinationObjectCount = count;
      result.localMemory = {
        scope: 'NODE_DRIVER_ONLY_NOT_PROVIDER',
        heapUsed: peak.heapUsed,
        external: peak.external,
        arrayBuffers: peak.arrayBuffers,
      };
      results.push(result);
      writeFileSync(
        join(tmpdir(), 'mayi-p0-canary-results.json'),
        JSON.stringify(results, null, 2),
      );
      expect(result.finished).toBe(true);
      expect(result.pass).toBe(true);
      expect(result.documentsEnabled).toBe('false');
      expect((result.jobs as { max_attempts?: number }[]).every((j) => j.max_attempts === 1)).toBe(
        true,
      );
      const reconcileDelivery = (
        result.deliveries as {
          job_type: string;
          metrics: { health?: { counts: Record<string, number> } };
        }[]
      ).find((d) => d.job_type === 'DOCUMENT_RECONCILE');
      expect(reconcileDelivery?.metrics.health?.counts).toEqual({
        dead: 0,
        due: 0,
        stalledDue: 0,
        expiredLeases: 0,
        completedInvestigations: 0,
        overdueBackups: 0,
      });
      expect(count).toBe(1);
      expect(await control.closedRoutes()).toEqual([404, 404, 404, 404, 404]);
      await expect(
        (await runtime.getWorker('p0'))
          .fetch('https://canary.invalid/upload')
          .then((r) => r.status),
      ).resolves.toBe(404);
    } finally {
      clearInterval(sampler);
      await runtime.dispose();
    }
  }
  expect(results.map((r) => r.sizeBytes)).toEqual([1048576, 10485760, 20971520]);
}, 180000);
it('actual SAFE_REPAIR is not accepted as the required coherent no-op', async () => {
  await setup();
  try {
    await db
      .prepare(
        "CREATE TRIGGER synthetic_unpublish_canary AFTER INSERT ON system_audit_events WHEN NEW.action='document.backup.completed' BEGIN UPDATE documents SET current_version_id=NULL,version=version+1 WHERE id=(SELECT document_id FROM document_versions WHERE id=NEW.target_id); END",
      )
      .run();
    await control.prepare(1048576);
    let result: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      result = JSON.parse(JSON.stringify(await control.snapshot())) as Record<string, unknown>;
      if (result.finished) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(result.finished).toBe(true);
    expect(result.pass).toBe(false);
  } finally {
    await runtime.dispose();
  }
}, 60000);
it('unexpected delivery STOP is durable, cannot add jobs or duplicate completion evidence', async () => {
  await setup();
  try {
    await control.prepare(1048576);
    let result: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      result = JSON.parse(JSON.stringify(await control.snapshot())) as Record<string, unknown>;
      if (result.finished) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(result.pass).toBe(true);
    const row = await db
      .prepare('SELECT backup_job_id,version_id,checksum FROM p0_document_canary_scope')
      .first<{ backup_job_id: string; version_id: string; checksum: string }>();
    const body = {
      jobId: row!.backup_job_id,
      jobType: 'DOCUMENT_BACKUP',
      generation: 1,
      documentVersionId: row!.version_id,
      inputSha256: row!.checksum,
    };
    const delivered = await (
      await runtime.getWorker('p0')
    ).queue('synthetic-p0-jobs', [
      { id: crypto.randomUUID(), timestamp: new Date(), attempts: 2, body },
    ]);
    expect(delivered.outcome).toBe('exception');
    const after = JSON.parse(JSON.stringify(await control.snapshot())) as Record<string, unknown>;
    expect(after.failed).toBe(true);
    expect(after.pass).toBe(false);
    expect(after.failureCode).toBe('CANARY_REDELIVERY_STOP');
    expect(after.completionAudit).toBe(1);
    expect(await db.prepare('SELECT count(*) AS n FROM background_jobs').first<number>('n')).toBe(
      2,
    );
  } finally {
    await runtime.dispose();
  }
}, 60000);

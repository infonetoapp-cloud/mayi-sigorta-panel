// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
async function read() {
  try {
    return (await import('../scripts/canary/provider-inventory')).readProviderInventory;
  } catch {
    return undefined;
  }
}
it('provider inventory requires explicit SDK completeness and bounded canonical metadata', async () => {
  const inventory = await read();
  expect(typeof inventory).toBe('function');
  if (!inventory) return;
  const bucket = (truncated: unknown, objects: unknown[] = []) =>
    ({ list: async () => ({ objects, truncated }) }) as unknown as R2Bucket;
  expect(await inventory(bucket(false), 'recovery')).toEqual({ complete: true, objects: [] });
  for (const flag of [undefined, null, true])
    await expect(inventory(bucket(flag), 'recovery')).rejects.toThrow(
      'CANARY_INVENTORY_INCOMPLETE',
    );
  const object = {
    key: 'backup/44444444-1111-4000-8000-000000000001',
    size: 1048576,
    etag: 'synthetic-metadata-only',
    uploaded: new Date('2026-10-12T00:00:00.000Z'),
  };
  expect((await inventory(bucket(false, [object]), 'recovery')).objects).toHaveLength(1);
  await expect(inventory(bucket(false, [object, object]), 'recovery')).rejects.toThrow(
    'CANARY_INVENTORY_SHAPE',
  );
  await expect(
    inventory(bucket(false, [{ ...object, key: 'outside/synthetic' }]), 'recovery'),
  ).rejects.toThrow('CANARY_INVENTORY_SHAPE');
});

it('native inventory delegates P0 copy at all sizes without changing the copy gate', async () => {
  const options = {
    bundle: true,
    format: 'esm' as const,
    platform: 'neutral' as const,
    target: 'es2022',
    external: ['node:*', 'cloudflare:workers'],
    write: false,
  };
  const app = await build({ ...options, entryPoints: ['scripts/canary/provider-worker.ts'] });
  const leaf = await build({ ...options, entryPoints: ['scripts/canary/provider-leaf.ts'] });
  for (const size of [1048576, 10485760, 20971520]) {
    const common = {
      modules: true,
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
    };
    const runtime = new miniflare.Miniflare(
      miniflare.convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: 'provider',
            ...common,
            script: app.outputFiles![0]!.text,
            bindings: {
              APP_ENV: 'test',
              PANEL_ORIGIN: 'https://panel.mayisigorta.com',
              DOCUMENTS_ENABLED: 'false',
              DOCUMENT_JOBS_ENABLED: 'false',
              DOCUMENT_CRON_ENABLED: 'false',
              CANARY_QUEUE_COMMISSIONED: 'true',
              CANARY_DATABASE_ID: '00000000-0000-4000-8000-000000000084',
              CANARY_PRIMARY_BUCKET: 'mayisigorta-m4-canary-local-primary',
              CANARY_RECOVERY_BUCKET: 'mayisigorta-m4-canary-local-recovery',
              CANARY_RUN_ID: '44444444-1111-4000-8000-000000000001',
              CANARY_EXPECTED_SIZE: String(size),
            },
            d1Databases: { DB: '00000000-0000-4000-8000-000000000084' },
            r2Buckets: { DOCS_QUARANTINE: 'mayisigorta-m4-canary-local-primary' },
            serviceBindings: {
              CANARY_LEAF: { name: 'provider-leaf', entrypoint: 'ProviderCanaryLeaf' },
            },
            queueProducers: { DOCUMENT_JOB_QUEUE: 'provider-jobs' },
            queueConsumers: { 'provider-jobs': { maxBatchSize: 1, maxRetries: 0 } },
          },
          {
            name: 'provider-leaf',
            ...common,
            script: leaf.outputFiles![0]!.text,
            bindings: { CANARY_RECOVERY_BUCKET: 'mayisigorta-m4-canary-local-recovery' },
            r2Buckets: { DOCUMENT_BACKUP_STORAGE: 'mayisigorta-m4-canary-local-recovery' },
          },
          {
            name: 'control',
            ...common,
            script: 'export default {fetch(){return new Response(null,{status:404})}}',
            serviceBindings: { CONTROL: { name: 'provider', entrypoint: 'DocumentCanaryControl' } },
          },
        ],
      }),
    );
    try {
      const db = await runtime.getD1Database('DB', 'provider');
      for (const name of readdirSync('db/migrations')
        .filter((n) => /^\d{4}_.+\.sql$/u.test(n))
        .sort())
        for (const sql of readFileSync('db/migrations/' + name, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean))
          await db.prepare(sql).run();
      const producer = (
        await runtime.getBindings<{ DOCUMENT_JOB_QUEUE: Queue<unknown> }>('provider')
      ).DOCUMENT_JOB_QUEUE;
      const control = (
        await runtime.getBindings<{
          CONTROL: {
            prepare(n: number): Promise<unknown>;
            snapshot(): Promise<{ finished: boolean; pass: boolean }>;
          };
        }>('control')
      ).CONTROL;
      async function inventory() {
        const nonce = crypto.randomUUID();
        await producer.send({
          kind: 'P4_PROVIDER_INVENTORY',
          runId: '44444444-1111-4000-8000-000000000001',
          nonce,
        });
        for (let i = 0; i < 100; i++) {
          try {
            const text = await db
              .prepare('SELECT result_json FROM p4_provider_inventory WHERE nonce=?')
              .bind(nonce)
              .first<string>('result_json');
            const result = JSON.parse(text ?? '{}');
            if (result.primary && result.recovery)
              return result as {
                primary: { complete: boolean; objects: unknown[] };
                recovery: { complete: boolean; objects: unknown[] };
              };
          } catch {
            /* initial broker creates the table */
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('LOCAL_INVENTORY_NOT_COMPLETED');
      }
      expect(await inventory()).toEqual({
        primary: { complete: true, objects: [] },
        recovery: { complete: true, objects: [] },
      });
      await expect(async () => await control.prepare(20971521)).rejects.toThrow(
        'CANARY_SIZE_DENIED',
      );
      expect(await db.prepare('SELECT count(*) n FROM background_jobs').first('n')).toBe(0);
      await producer.send({
        kind: 'P0_SYNTHETIC_START',
        runId: '44444444-1111-4000-8000-000000000001',
        sizeBytes: size,
      });
      let snapshot = { finished: false, pass: false };
      for (let i = 0; i < 200; i++) {
        try {
          snapshot = JSON.parse(JSON.stringify(await control.snapshot()));
        } catch {
          /* startup */
        }
        if (snapshot.finished) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(snapshot.pass).toBe(true);
      const after = await inventory();
      expect(after.primary.complete && after.recovery.complete).toBe(true);
      expect(after.primary.objects).toHaveLength(1);
      expect(after.recovery.objects).toHaveLength(1);
      expect(
        (await (await runtime.getWorker('provider')).fetch('https://private.invalid')).status,
      ).toBe(404);
      const source = await runtime.getR2Bucket('DOCS_QUARANTINE', 'provider');
      for (let i = 0; i < 3; i++)
        await source.put('quarantine/' + crypto.randomUUID(), new Uint8Array([1]));
      const nonce = crypto.randomUUID();
      const rejected = await (
        await runtime.getWorker('provider')
      ).queue('provider-jobs', [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          attempts: 1,
          body: {
            kind: 'P4_PROVIDER_INVENTORY',
            runId: '44444444-1111-4000-8000-000000000001',
            nonce,
          },
        },
      ]);
      expect(rejected.outcome).toBe('exception');
      expect(
        await db
          .prepare('SELECT result_json FROM p4_provider_inventory WHERE nonce=?')
          .bind(nonce)
          .first('result_json'),
      ).toBe('{}');
      expect(await db.prepare('SELECT count(*) n FROM background_jobs').first('n')).toBe(2);
    } finally {
      await runtime.dispose();
    }
  }
}, 180000);

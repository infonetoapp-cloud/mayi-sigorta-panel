import { z } from 'zod';
const resourcesSchema = z.strictObject({
  databaseId: z
    .string()
    .uuid()
    .refine((v) => v !== '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d'),
  databaseName: z.string().regex(/^mayisigorta-m4-canary-[a-z0-9-]+-db$/u),
  primaryBucket: z.string().regex(/^mayisigorta-m4-canary-[a-z0-9-]+-primary$/u),
  recoveryBucket: z.string().regex(/^mayisigorta-m4-canary-[a-z0-9-]+-recovery$/u),
  queueName: z.string().regex(/^mayisigorta-m4-canary-[a-z0-9-]+-jobs$/u),
  runId: z.string().uuid(),
  sizeBytes: z
    .union([z.literal(1048576), z.literal(10485760), z.literal(20971520)])
    .default(1048576),
});
/** Pure LOCAL preparation. Declared identity is not live provider binding proof.
 * Templates must pass actual provider exact-binding preflight before any publish. */
export function buildCanaryConfig(input: unknown, commissionQueue = false) {
  const r = resourcesSchema.parse(input);
  const common = {
    account_id: 'af9fc98cb8d5f5508d58057bc794d863',
    compatibility_date: '2026-09-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    routes: [],
    triggers: { crons: [] },
  };
  return {
    crm: {
      ...common,
      name: 'mayisigorta-m4-canary-crm',
      main: 'scripts/canary/document-worker.ts',
      vars: {
        APP_ENV: 'test',
        PANEL_ORIGIN: 'https://panel.mayisigorta.com',
        DOCUMENTS_ENABLED: 'false',
        DOCUMENT_JOBS_ENABLED: 'false',
        DOCUMENT_CRON_ENABLED: 'false',
        CANARY_QUEUE_COMMISSIONED: commissionQueue ? 'true' : 'false',
        CANARY_DATABASE_ID: r.databaseId,
        CANARY_PRIMARY_BUCKET: r.primaryBucket,
        CANARY_RECOVERY_BUCKET: r.recoveryBucket,
        CANARY_RUN_ID: r.runId,
        CANARY_EXPECTED_SIZE: String(r.sizeBytes),
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: r.databaseName,
          database_id: r.databaseId,
          migrations_dir: 'db/migrations',
        },
      ],
      r2_buckets: [
        { binding: 'DOCS_QUARANTINE', bucket_name: r.primaryBucket, jurisdiction: 'eu' },
      ],
      services: [
        {
          binding: 'CANARY_LEAF',
          service: 'mayisigorta-m4-canary-leaf',
          entrypoint: 'MeasuredDocumentBackupCapability',
        },
      ],
      queues: {
        producers: [{ binding: 'DOCUMENT_JOB_QUEUE', queue: r.queueName }],
        consumers: commissionQueue
          ? [
              {
                queue: r.queueName,
                max_batch_size: 1,
                max_batch_timeout: 1,
                max_retries: 0,
                max_concurrency: 1,
              },
            ]
          : [],
      },
    },
    leaf: {
      ...common,
      name: 'mayisigorta-m4-canary-leaf',
      main: 'scripts/canary/document-leaf.ts',
      r2_buckets: [
        { binding: 'DOCUMENT_BACKUP_STORAGE', bucket_name: r.recoveryBucket, jurisdiction: 'eu' },
      ],
    },
  };
}

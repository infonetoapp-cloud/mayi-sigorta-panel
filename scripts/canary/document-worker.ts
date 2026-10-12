import { WorkerEntrypoint } from 'cloudflare:workers';
import { parseCanaryStart } from './contract';
import { createHash } from 'node:crypto';
import worker from '../../src/server/worker';
import {
  assertClosedCanaryEnvironment,
  issueClosedCanaryPermit,
  type ClosedCanaryEnv,
} from '../../src/server/documents/closed-canary';
import { parseDocumentQueueControl } from '../../src/server/documents/queue-message';
import { enqueueDocumentReconcile } from '../../src/server/documents/reconcile';
import { evaluateDocumentHealth } from '../../src/server/documents/health';
import {
  documentBackupObjectKey,
  type DocumentBackupIdentity,
} from '../../src/server/documents/backup-storage';
import type { DocumentBackupCapability } from '../../src/server/documents/backup-capability-contract';
import type { DocumentJobQueueMessage } from '../../src/server/documents/queue';
import { metrics, countBucket, countDatabase, countedStream, type CanaryMetrics } from './metrics';
import { emitCanaryMarker } from './attribution';
interface Leaf {
  measuredCopy(
    id: DocumentBackupIdentity,
    b: ReadableStream<Uint8Array>,
    correlation?: { runId: string; size: number; jobId: string },
  ): Promise<{
    reply: Awaited<ReturnType<DocumentBackupCapability['createAndVerify']>>;
    metrics: CanaryMetrics;
    wallMs: number;
  }>;
  measuredObservation(
    k: string,
    correlation?: { runId: string; size: number; jobId: string },
  ): Promise<{
    reply: Awaited<ReturnType<DocumentBackupCapability['observeBackup']>>;
    metrics: CanaryMetrics;
    wallMs: number;
  }>;
}
interface CanaryEnv extends ClosedCanaryEnv {
  CANARY_LOGS_ENABLED?: string;
  DOCS_QUARANTINE: R2Bucket;
  CANARY_LEAF: Leaf;
  DOCUMENT_JOB_QUEUE: Queue<DocumentJobQueueMessage>;
  PANEL_ORIGIN: string;
}
const scopeDDL = `CREATE TABLE IF NOT EXISTS p0_document_canary_scope(run_id TEXT PRIMARY KEY,backup_job_id TEXT,reconcile_job_id TEXT,version_id TEXT,document_id TEXT,checksum TEXT,size_bytes INTEGER,start_ms INTEGER,destination_key TEXT,failure_code TEXT)`;
const metricsDDL = `CREATE TABLE IF NOT EXISTS p0_document_canary_metrics(run_id TEXT,delivery_id TEXT PRIMARY KEY,job_type TEXT,ack_count INTEGER,retry_count INTEGER,wall_ms INTEGER,metrics_json TEXT,UNIQUE(run_id,job_type))`;
let preparationActive = false;
/** Private-only synthetic controller. This file is never a production CRM entrypoint.
 * Fixture begins AFTER format validation; COPY canary, not PDF/parser/employee commissioning. */
export class DocumentCanaryControl extends WorkerEntrypoint<CanaryEnv> {
  async prepare(size: number) {
    assertClosedCanaryEnvironment(this.env);
    if (preparationActive) throw new Error('CANARY_PREPARATION_BUSY');
    preparationActive = true;
    try {
      return await this.#prepare(size);
    } finally {
      preparationActive = false;
    }
  }
  async #prepare(size: number) {
    assertClosedCanaryEnvironment(this.env);
    if (![1048576, 10485760, 20971520].includes(size)) throw new Error('CANARY_SIZE_DENIED');
    if (size !== Number(this.env.CANARY_EXPECTED_SIZE)) throw new Error('CANARY_STAGE_DENIED');
    const db = this.env.DB;

    // Isolated empty schema is required; never seed into an existing business graph.
    for (const table of ['agencies', 'users', 'customers', 'documents', 'background_jobs']) {
      const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n');
      if (row !== 0) throw new Error('CANARY_NOT_EMPTY');
    }
    await db.prepare(scopeDDL).run();
    await db.prepare(metricsDDL).run();
    if (await db.prepare('SELECT run_id FROM p0_document_canary_scope LIMIT 1').first())
      throw new Error('CANARY_NOT_EMPTY');
    const body = new Uint8Array(size);
    body.fill(73);
    const sha = createHash('sha256').update(body).digest('hex'),
      document = crypto.randomUUID(),
      version = crypto.randomUUID(),
      job = crypto.randomUUID(),
      key = 'quarantine/' + crypto.randomUUID();
    const id = {
      agencyId: 'synthetic-canary-agency',
      documentVersionId: version,
      generation: 1,
      sha256: sha,
      sizeBytes: size,
    };
    await db
      .prepare(
        'INSERT INTO p0_document_canary_scope(run_id,backup_job_id,version_id,document_id,checksum,size_bytes,start_ms,destination_key) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        this.env.CANARY_RUN_ID,
        job,
        version,
        document,
        sha,
        size,
        Date.now(),
        documentBackupObjectKey(id),
      )
      .run();
    await db
      .prepare("INSERT INTO agencies(id,status) VALUES('synthetic-canary-agency','PROVISIONING')")
      .run();
    await db
      .prepare("INSERT INTO users(id,status) VALUES('synthetic-canary-user','INACTIVE')")
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('synthetic-canary-member','synthetic-canary-agency','synthetic-canary-user','OWNER','INVITED','synthetic@example.invalid','2099-01-01T00:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('synthetic-canary-customer','synthetic-canary-agency','INDIVIDUAL','SYNTHETIC COPY ONLY','Synthetic','Canary','synthetic-canary-member')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id) VALUES(?,'synthetic-canary-agency','CUSTOMER','synthetic-canary-customer','synthetic-canary-user','synthetic-canary-member')",
      )
      .bind(document)
      .run();
    await db
      .prepare(
        "INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,'synthetic-canary-agency',?,1,?,?,?,'synthetic-copy-only.pdf','application/pdf','synthetic-canary-user','synthetic-canary-member')",
      )
      .bind(version, document, key, sha, size)
      .run();
    await this.env.DOCS_QUARANTINE.put(key, body, { customMetadata: { sha256: sha } });
    await db
      .prepare(
        "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,max_attempts) VALUES(?,'synthetic-canary-agency','DOCUMENT_BACKUP',?,?,1)",
      )
      .bind(job, version, sha)
      .run();
    await db
      .prepare(
        "UPDATE document_versions SET status='BACKUP_PENDING',validation_version='m4-content-inspection-v1',validation_result=? WHERE id=?",
      )
      .bind(JSON.stringify({ format: 'PDF', pageCount: 1, valid: true }), version)
      .run();
    await this.env.DOCUMENT_JOB_QUEUE.send({
      jobId: job,
      jobType: 'DOCUMENT_BACKUP',
      generation: 1,
      documentVersionId: version,
      inputSha256: sha,
    });
    return { runId: this.env.CANARY_RUN_ID, size, scope: 'SYNTHETIC_PREVALIDATED_COPY_ONLY' };
  }
  async snapshot() {
    assertClosedCanaryEnvironment(this.env);
    const db = this.env.DB,
      scope = await db
        .prepare('SELECT * FROM p0_document_canary_scope WHERE run_id=?')
        .bind(this.env.CANARY_RUN_ID)
        .first<{
          backup_job_id: string;
          reconcile_job_id: string | null;
          version_id: string;
          document_id: string;
          checksum: string;
          size_bytes: number;
          start_ms: number;
          failure_code: string | null;
        }>();
    if (!scope) throw new Error('CANARY_SCOPE_DENIED');
    const jobs = (
      await db
        .prepare(
          'SELECT job_type,status,attempt_count,max_attempts,last_error_code FROM background_jobs ORDER BY job_type',
        )
        .all()
    ).results;
    const delivery = (
      await db
        .prepare(
          'SELECT job_type,ack_count,retry_count,wall_ms,metrics_json FROM p0_document_canary_metrics WHERE run_id=?',
        )
        .bind(this.env.CANARY_RUN_ID)
        .all()
    ).results;
    const version = await db
      .prepare(
        'SELECT v.status,d.current_version_id FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?',
      )
      .bind(scope.version_id)
      .first<{ status: string; current_version_id: string | null }>();
    const audit = await db
      .prepare(
        "SELECT count(*) AS n FROM system_audit_events WHERE target_id=? AND action='document.backup.completed' AND outcome='SUCCESS' AND reason_code='BACKUP_VERIFIED'",
      )
      .bind(scope.version_id)
      .first<number>('n');
    const copies = await db
      .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
      .bind(scope.version_id)
      .first<number>('n');
    const runs = (
      await db.prepare('SELECT job_id,status,reason_code FROM background_job_runs').all()
    ).results;
    const reconcileRun = runs.find((r) => r.job_id === scope.reconcile_job_id);
    const repairEffects = await db
      .prepare(
        "SELECT count(*) AS n FROM system_audit_events WHERE action IN ('document.reconcile.repaired','document.reconcile.discrepancy')",
      )
      .first<number>('n');
    const failed =
      scope.failure_code !== null ||
      jobs.some(
        (j) =>
          j.status === 'DEAD' ||
          j.status === 'RETRY_WAIT' ||
          Number(j.attempt_count) > 1 ||
          j.last_error_code !== null,
      ) ||
      delivery.some((d) => Number(d.retry_count) > 0);
    const finished =
      failed ||
      (jobs.length === 2 && jobs.every((j) => j.status === 'COMPLETED') && delivery.length === 2);
    const health = await evaluateDocumentHealth(db);
    const object = finished
      ? await this.env.CANARY_LEAF.measuredObservation(
          (await db
            .prepare('SELECT destination_key FROM p0_document_canary_scope WHERE run_id=?')
            .bind(this.env.CANARY_RUN_ID)
            .first<string>('destination_key'))!,
        )
      : null;
    return {
      runId: this.env.CANARY_RUN_ID,
      sizeBytes: scope.size_bytes,
      expectedHash: scope.checksum,
      totalWallMs: Date.now() - scope.start_ms,
      jobs,
      runs,
      reconcileNoop:
        reconcileRun?.status === 'SUCCEEDED' &&
        reconcileRun.reason_code === 'SAFE_NOOP' &&
        repairEffects === 0,
      repairEffects,
      version,
      completionAudit: audit,
      immutableCopies: copies,
      deliveries: delivery.map((d) => ({
        ...d,
        metrics: JSON.parse(String(d.metrics_json)),
        metrics_json: undefined,
      })),
      health,
      verifiedObject: object?.reply.ok ? object.reply.value : null,
      finished,
      failed,
      failureCode: scope.failure_code,
      documentsEnabled: this.env.DOCUMENTS_ENABLED,
      pass:
        finished &&
        !failed &&
        jobs.every(
          (j) => j.attempt_count === 1 && j.max_attempts === 1 && j.last_error_code === null,
        ) &&
        runs.length === 2 &&
        runs.every((r) => r.status === 'SUCCEEDED') &&
        reconcileRun?.reason_code === 'SAFE_NOOP' &&
        repairEffects === 0 &&
        audit === 1 &&
        copies === 1 &&
        version?.status === 'AVAILABLE' &&
        version.current_version_id === scope.version_id &&
        delivery.every((d) => d.ack_count === 1 && d.retry_count === 0) &&
        object?.reply.ok === true &&
        object.reply.value?.sizeBytes === scope.size_bytes &&
        object.reply.value.sha256 === scope.checksum &&
        !health.truncated &&
        Object.values(health.counts).every((n) => n === 0),
    };
  }
  async closedRoutes() {
    const results = [];
    const doc = await this.env.DB.prepare(
      'SELECT document_id FROM p0_document_canary_scope WHERE run_id=?',
    )
      .bind(this.env.CANARY_RUN_ID)
      .first<string>('document_id');
    for (const path of [
      '/api/documents',
      `/api/documents/${doc}/download`,
      `/secure/api/documents/${doc}/download`,
      `/secure/api/documents/${doc}/download-grants`,
      `/secure/api/documents/${doc}/download-confirmation`,
    ]) {
      const r = await worker.fetch(
        new Request('https://panel.mayisigorta.com/' + path.replace(/^\//u, ''), {
          method: 'POST',
          headers: {
            Origin: 'https://panel.mayisigorta.com',
            Host: 'panel.mayisigorta.com',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
        this.env as never,
        this.ctx,
      );
      results.push(r.status);
    }
    return results;
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
  async queue(batch: MessageBatch<DocumentJobQueueMessage>, env: CanaryEnv, ctx: ExecutionContext) {
    assertClosedCanaryEnvironment(env);
    if (batch.messages.length !== 1) throw new Error('CANARY_BATCH_DENIED');
    if (batch.messages[0]?.attempts !== 1) {
      await env.DB.prepare(
        "UPDATE p0_document_canary_scope SET failure_code='CANARY_REDELIVERY_STOP' WHERE run_id=?",
      )
        .bind(env.CANARY_RUN_ID)
        .run();
      throw new Error('CANARY_REDELIVERY_STOP');
    }
    const raw = batch.messages[0]?.body as unknown;
    if (raw && typeof raw === 'object' && 'kind' in raw) {
      const start = parseCanaryStart(raw, env.CANARY_RUN_ID!);
      emitCanaryMarker(env, 'queue_start', null, 'start');
      emitCanaryMarker(env, 'producer_start', null, 'start');
      await new DocumentCanaryControl(ctx, env).prepare(start.sizeBytes);
      batch.messages[0]!.ack();
      emitCanaryMarker(env, 'queue_complete', null, 'ok');
      return;
    }
    const message = parseDocumentQueueControl(batch.messages[0]?.body);
    if (!message) throw new Error('CANARY_MESSAGE_DENIED');
    emitCanaryMarker(env, 'queue_start', message.jobId, 'start');
    const m = metrics(),
      start = Date.now();
    let acks = 0,
      retries = 0;
    const leafMetrics: unknown[] = [];
    const measuredPeer: DocumentBackupCapability = {
      async createAndVerify(id, b) {
        emitCanaryMarker(env, 'rpc_client_start', message.jobId, 'start');
        const s = Date.now();
        const reply = await env.CANARY_LEAF.measuredCopy(
          id,
          countedStream(b, (n) => {
            m.rpcChunks++;
            m.rpcBytes += n;
          }),
          {
            runId: env.CANARY_RUN_ID!,
            size: Number(env.CANARY_EXPECTED_SIZE),
            jobId: message.jobId,
          },
        );
        m.stageMs.rpc = Date.now() - s;
        leafMetrics.push(reply.metrics);
        return reply.reply;
      },
      async observeBackup(k) {
        emitCanaryMarker(env, 'rpc_client_start', message.jobId, 'start');
        const s = Date.now(),
          r = await env.CANARY_LEAF.measuredObservation(k, {
            runId: env.CANARY_RUN_ID!,
            size: Number(env.CANARY_EXPECTED_SIZE),
            jobId: message.jobId,
          });
        m.stageMs.rpc = (m.stageMs.rpc ?? 0) + Date.now() - s;
        leafMetrics.push(r.metrics);
        return r.reply;
      },
    };
    let meteringEnabled = false;
    const scoped = {
      ...env,
      DB: countDatabase(env.DB, m, () => meteringEnabled),
      DOCS_QUARANTINE: countBucket(env.DOCS_QUARANTINE, m),
      DOCUMENT_BACKUP_CAPABILITY: measuredPeer,
    };
    const permit = await issueClosedCanaryPermit(scoped, message);
    meteringEnabled = true;
    // Reserve before business execution. A duplicate cannot manufacture another
    // reconcile operation or overwrite the first delivery receipt.
    const deliveryId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO p0_document_canary_metrics(run_id,delivery_id,job_type,ack_count,retry_count,wall_ms,metrics_json) VALUES(?,?,?,0,0,0,?)',
      )
        .bind(env.CANARY_RUN_ID, deliveryId, message.jobType, '{}')
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE p0_document_canary_scope SET failure_code='CANARY_DUPLICATE_DELIVERY_STOP' WHERE run_id=?",
      )
        .bind(env.CANARY_RUN_ID)
        .run();
      throw new Error('CANARY_DUPLICATE_DELIVERY_STOP');
    }
    const original = batch.messages[0]!;
    const delivery = {
      ...batch,
      messages: [
        {
          ...original,
          body: message,
          ack() {
            acks++;
            original.ack();
          },
          retry(options?: { delaySeconds?: number }) {
            retries++;
            original.retry(options);
          },
        },
      ],
    } as MessageBatch<DocumentJobQueueMessage>;
    await worker.queue(delivery, scoped as never, ctx, permit);
    const finalStatus = await env.DB.prepare('SELECT status FROM background_jobs WHERE id=?')
      .bind(message.jobId)
      .first<string>('status');
    emitCanaryMarker(
      env,
      message.jobType === 'DOCUMENT_BACKUP' ? 'd1_finalization' : 'reconcile_complete',
      message.jobId,
      finalStatus === 'COMPLETED' && acks === 1 && retries === 0 ? 'ok' : 'fail',
    );
    if (finalStatus !== 'COMPLETED' || acks !== 1 || retries !== 0)
      await env.DB.prepare(
        "UPDATE p0_document_canary_scope SET failure_code='CANARY_JOB_NOT_COMPLETED' WHERE run_id=?",
      )
        .bind(env.CANARY_RUN_ID)
        .run();
    if (message.jobType === 'DOCUMENT_RECONCILE' && finalStatus === 'COMPLETED') {
      const startHealth = Date.now();
      const health = await evaluateDocumentHealth(scoped.DB);
      m.stageMs.health = Date.now() - startHealth;
      Object.assign(m, { health });
      if (health.truncated || Object.values(health.counts).some((n) => n !== 0))
        await env.DB.prepare(
          "UPDATE p0_document_canary_scope SET failure_code='CANARY_HEALTH_FAILED' WHERE run_id=?",
        )
          .bind(env.CANARY_RUN_ID)
          .run();
    }
    await env.DB.prepare(
      'UPDATE p0_document_canary_metrics SET ack_count=?,retry_count=?,wall_ms=?,metrics_json=? WHERE run_id=? AND delivery_id=?',
    )
      .bind(
        acks,
        retries,
        Date.now() - start,
        JSON.stringify({ ...m, leaf: leafMetrics, queueAttempts: original.attempts }),
        env.CANARY_RUN_ID,
        deliveryId,
      )
      .run();
    if (message.jobType === 'DOCUMENT_BACKUP') {
      const status = await env.DB.prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first<string>('status');
      if (status === 'COMPLETED') {
        const next = await enqueueDocumentReconcile(
          env.DB,
          'synthetic-canary-agency',
          { versionId: message.documentVersionId! },
          crypto.randomUUID(),
          1,
        );
        await env.DB.prepare(
          'UPDATE p0_document_canary_scope SET reconcile_job_id=? WHERE run_id=?',
        )
          .bind(next.jobId, env.CANARY_RUN_ID)
          .run();
        await env.DOCUMENT_JOB_QUEUE.send(next);
      }
    }
    emitCanaryMarker(
      env,
      'queue_complete',
      message.jobId,
      acks === 1 && retries === 0 ? 'ok' : 'fail',
    );
  },
};

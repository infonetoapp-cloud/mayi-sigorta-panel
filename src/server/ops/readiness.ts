import type { Hono } from 'hono';
import journal from '../../../db/migrations/meta/_journal.json';
import type { AppDependencies, Env } from '../index';
import { createAuthorizationEvaluator } from '../auth/authorization';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import { SessionVerificationError } from '../auth/errors';
import { createLocalSessionVerifier, parseLocalSessionConfig } from '../auth/session';
import { monitorStatus, OPERATIONAL_FRESHNESS_MS, type Decision } from '../backup-monitor/evidence';
import { readPublishedBackupObservation } from '../backup-monitor/status-reader';

const expectedMigrations = journal.entries.map(({ tag }) => `${tag}.sql`);
export const OPS_READINESS_PATH = '/api/ops/readiness';

async function probe<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('READINESS_DEADLINE'));
          controller.abort();
        }, 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function registerOpsReadiness(app: Hono<{ Bindings: Env }>, deps: AppDependencies) {
  app.get(OPS_READINESS_PATH, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const db = c.env.DB;
    const fail = (status: 401 | 403 | 503, code: string) =>
      c.json({ success: false, error: { code } }, status);
    if (!db) return fail(503, 'SERVICE_UNAVAILABLE');
    let actor;
    try {
      const config = parseLocalSessionConfig(c.env);
      const principal = await (
        deps.createSessionVerifier?.(config) ?? createLocalSessionVerifier({ config })
      ).verify(c.req.raw);
      actor = await (deps.createResolver?.(db) ?? createApplicationIdentityResolver(db)).resolve(
        principal,
      );
    } catch (error) {
      if (error instanceof SessionVerificationError && error.code !== 'CONFIGURATION_ERROR')
        return fail(401, 'UNAUTHORIZED');
      if (
        error instanceof IdentityResolutionError &&
        !['DATABASE_ERROR', 'CORRUPT_IDENTITY_DATA', 'CORRUPT_MEMBERSHIP_DATA'].includes(error.code)
      )
        return fail(403, 'FORBIDDEN');
      return fail(503, 'SERVICE_UNAVAILABLE');
    }
    const owners = actor.memberships.filter((m) => m.type === 'OWNER');
    if (owners.length !== 1) return fail(403, 'FORBIDDEN');
    const agencyId = owners[0]!.agencyId;
    try {
      const access = await createAuthorizationEvaluator({ db }).authorize({
        context: actor,
        permissionCode: 'audit.read',
        agencyId,
      });
      if (access.code === 'DATABASE_ERROR') return fail(503, 'SERVICE_UNAVAILABLE');
      if (access.decision !== 'ALLOW') return fail(403, 'FORBIDDEN');
    } catch {
      return fail(503, 'SERVICE_UNAVAILABLE');
    }

    const documentAccessEnabled = c.env.DOCUMENTS_ENABLED === 'true';
    const documentWorkerEnabled = c.env.DOCUMENT_JOBS_ENABLED === 'true';
    const documentScheduleEnabled = c.env.DOCUMENT_CRON_ENABLED === 'true';
    const reads = await Promise.allSettled([
      probe(() => db.prepare('SELECT 1 AS ready').first<number>('ready')),
      probe(() =>
        db
          .prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT ?')
          .bind(expectedMigrations.length + 1)
          .all<{ name: string }>(),
      ),
      probe(() =>
        db
          .prepare(
            'SELECT 1 AS pending FROM renewal_generation_cursors WHERE agency_id=? AND continuation_json IS NOT NULL',
          )
          .bind(agencyId)
          .first<number>('pending'),
      ),
      probe((signal) =>
        deps.readBackupObservation
          ? deps.readBackupObservation(signal)
          : readPublishedBackupObservation(c.env.OPS_BACKUP_STATUS, signal),
      ),
      probe(async () =>
        documentWorkerEnabled || documentScheduleEnabled
          ? db
              .prepare(
                `SELECT MAX(r.completed_at) AS latest
               FROM background_job_runs r
               JOIN background_jobs j ON j.agency_id=r.agency_id AND j.id=r.job_id
               WHERE r.agency_id=? AND r.status='SUCCEEDED'
                 AND j.job_type IN ('DOCUMENT_BACKUP','DOCUMENT_RECONCILE')`,
              )
              .bind(agencyId)
              .first<string>('latest')
          : null,
      ),
    ] as const);
    const now = Date.now();
    const [dbRead, schemaRead, renewalRead, backupRead, documentRead] = reads;
    const database = dbRead.status === 'fulfilled' && dbRead.value === 1 ? 'OK' : 'UNKNOWN';
    const schema =
      schemaRead.status === 'rejected'
        ? 'UNKNOWN'
        : schemaRead.value.results.length === expectedMigrations.length &&
            schemaRead.value.results.every((row, index) => row.name === expectedMigrations[index])
          ? 'OK'
          : 'MISMATCH';
    const renewals =
      renewalRead.status === 'rejected' ? 'UNKNOWN' : renewalRead.value === 1 ? 'PENDING' : 'IDLE';
    const evidence: Decision | null = backupRead.status === 'fulfilled' ? backupRead.value : null;
    const observed = monitorStatus(evidence, now, OPERATIONAL_FRESHNESS_MS);
    const backup =
      observed === 'HEALTHY' ? 'OK' : observed === 'BACKUP_STALE' ? 'STALE' : 'UNKNOWN';
    const exportAt = evidence?.exportAt;
    const backupAgeMinutes =
      backup !== 'UNKNOWN' &&
      exportAt !== undefined &&
      Number.isSafeInteger(exportAt) &&
      exportAt >= 0 &&
      exportAt <= now
        ? Math.floor((now - exportAt) / 60_000)
        : null;
    const documentJobs = documentWorkerEnabled || documentScheduleEnabled ? 'UNKNOWN' : 'INACTIVE';
    const ready =
      database === 'OK' &&
      schema === 'OK' &&
      renewals !== 'UNKNOWN' &&
      backup === 'OK' &&
      documentJobs !== 'UNKNOWN';
    return c.json(
      {
        success: ready,
        data: {
          database,
          schema,
          renewals,
          backup,
          backupAgeMinutes,
          documentJobs,
          documentAccessEnabled,
          documentWorkerEnabled,
          documentScheduleEnabled,
          documentLastSuccessAt: documentRead.status === 'fulfilled' ? documentRead.value : null,
          checkedAt: new Date(now).toISOString(),
        },
      },
      ready ? 200 : 503,
    );
  });
}

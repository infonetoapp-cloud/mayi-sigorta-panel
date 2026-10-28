import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import { requireRecentPassword } from '../auth/session-database';
import type { AuthenticatedUserContext } from '../auth/identity';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import { REQUIRED_CONTENT_INSPECTION_VERSION } from './content-inspection';
import { computePayloadHash } from '../mutations/canonical';
import { canonicalizeTargetIds, computeEvidenceHash } from '../mutations/grants';
import { buildSafeAuditRecord } from '../mutations/audit';

export class DocumentStreamError extends Error {
  constructor(readonly status: 404 | 503 = 404) {
    super(status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE');
  }
}

const id = z.string().min(1).max(128);
const permissionSchema = z
  .object({ id, membership_id: id, permission_code: id, scope: id })
  .strict();
const snapshotSchema = z
  .object({
    documentId: id,
    documentVersion: z.number().int().positive(),
    versionId: id,
    versionNumber: z.number().int().positive(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
    objectKey: z
      .string()
      .regex(/^quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
    size: z.number().int().min(1).max(MAX_DOCUMENT_UPLOAD_BYTES),
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    classification: z.enum(['GENERAL', 'IDENTITY', 'HEALTH']),
    ownerType: z.enum(['CUSTOMER', 'POLICY', 'QUOTE']),
    ownerId: id,
    customerId: id,
    customerAssignee: id,
    policyId: id.nullable(),
    policyAssignee: id.nullable(),
    renewalId: id.nullable(),
    renewalAssignee: id.nullable(),
    parentHealth: z.number().int().min(0).max(1),
    validationId: id,
    validationGeneration: z.number().int().positive(),
    inspectionResult: z.string().min(1).max(256),
    backupId: id,
    backupGeneration: z.number().int().positive(),
    permissions: z.array(permissionSchema).max(128),
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Actor = AuthenticatedUserContext & {
  memberships: [AuthenticatedUserContext['memberships'][number]];
};

const confirmationSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    versionId: id,
    checksum: z.string().regex(/^[0-9a-f]{64}$/u),
    confirmation: z.literal('DOWNLOAD_SENSITIVE_DOCUMENT'),
  })
  .strict();
const commandSchema = confirmationSchema.extend({
  grantEvidenceToken: z.string().regex(/^[0-9a-f]{64}$/u),
});
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function recordStreamDenial(
  db: D1Database,
  context: AuthenticatedUserContext,
  documentId: string,
): Promise<void> {
  const correlationId = crypto.randomUUID();
  try {
    const actor = actorSnapshot(context);
    const member = actor.memberships[0];
    id.parse(actor.userId);
    id.parse(member.id);
    id.parse(member.agencyId);
    // Persist only a server-resolved ID, never arbitrary paths, filenames or tokens.
    const target = id.safeParse(documentId).success
      ? await db
          .prepare('SELECT id FROM documents WHERE id=? AND agency_id=?')
          .bind(documentId, member.agencyId)
          .first<{ id: string }>()
      : null;
    const audit = buildSafeAuditRecord({
      agencyId: member.agencyId,
      actorUserId: actor.userId,
      actorMembershipId: member.id,
      action: 'sensitive_action.denied',
      targetType: target ? 'documents' : 'document_access_attempts',
      targetId: target?.id ?? correlationId,
      correlationId,
      outcome: 'FAILURE',
      metadata: { reasonCode: 'SENSITIVE_ACCESS_DENIED', requestSource: 'DOCUMENT_STREAM' },
    });
    const result = await db
      .prepare(
        `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,outcome,metadata_json)
      SELECT ?,membership.agency_id,membership.user_id,membership.id,?,?,?,?,?,?
      FROM agency_memberships membership
      WHERE membership.id=? AND membership.agency_id=? AND membership.user_id=?`,
      )
      .bind(
        audit.id,
        audit.action,
        audit.targetType,
        audit.targetId,
        audit.correlationId,
        audit.outcome,
        audit.metadataJson,
        member.id,
        member.agencyId,
        actor.userId,
      )
      .run();
    if (result.meta.changes !== 1) throw new Error('DENIAL_AUDIT_UNAVAILABLE');
  } catch {
    // Logging failure never changes DENY. Input and exception text are not logged.
    console.warn('DOCUMENT_STREAM_DENIAL_AUDIT_UNAVAILABLE', {
      correlationId,
      reasonCode: 'AUDIT_UNAVAILABLE',
    });
  }
}

function sensitiveAction(s: Snapshot) {
  if (s.classification === 'IDENTITY')
    return s.parentHealth ? 'document.identity_health.download' : 'document.identity.download';
  if (s.classification === 'HEALTH' || s.parentHealth) return 'document.health.download';
  throw new DocumentStreamError();
}
function grantPayload(actor: Actor, s: Snapshot, confirmation: z.infer<typeof confirmationSchema>) {
  if (
    actor.assurance !== 'SECURE' ||
    confirmation.expectedVersion !== s.documentVersion ||
    confirmation.versionId !== s.versionId ||
    confirmation.checksum !== s.checksum
  )
    throw new DocumentStreamError();
  return {
    ...confirmation,
    agencyId: actor.memberships[0].agencyId,
    documentId: s.documentId,
    actorIdentityId: actor.identityId,
    classification: s.classification,
    parentHealth: s.parentHealth,
    validationId: s.validationId,
    validationGeneration: s.validationGeneration,
    backupId: s.backupId,
    backupGeneration: s.backupGeneration,
  };
}
function documentResource(actor: Actor, s: Snapshot) {
  return {
    agencyId: actor.memberships[0].agencyId,
    id: s.documentId,
    ownerType: s.ownerType,
    customerId: s.ownerType === 'CUSTOMER' ? s.ownerId : null,
    policyId: s.ownerType === 'POLICY' ? s.ownerId : null,
    quoteId: s.ownerType === 'QUOTE' ? s.ownerId : null,
    assigneeMembershipId:
      s.ownerType === 'CUSTOMER'
        ? s.customerAssignee
        : s.ownerType === 'POLICY'
          ? s.policyAssignee
          : undefined,
    customerAssigneeMembershipId: s.customerAssignee,
    renewalAssigneeMembershipId: s.renewalAssignee,
    parentReadAuthorized: true,
  };
}

export async function documentDownloadConfirmation(
  db: D1Database,
  context: AuthenticatedUserContext,
  documentId: string,
) {
  try {
    const actor = actorSnapshot(context);
    if (actor.assurance !== 'SECURE') throw new DocumentStreamError();
    requireRecentPassword(db);
    const s = await loadSnapshot(db, actor, id.parse(documentId));
    await authorize(db, actor, s.data);
    sensitiveAction(s.data);
    await unchanged(db, actor, s);
    return {
      documentId: s.data.documentId,
      expectedVersion: s.data.documentVersion,
      versionId: s.data.versionId,
      checksum: s.data.checksum,
      classification: s.data.classification,
      parentHealth: !!s.data.parentHealth,
      confirmationText:
        'Bu kimlik/sağlık belgesini yalnız yetkili iş amacı için indirdiğimi onaylıyorum.',
    };
  } catch (error) {
    await recordStreamDenial(db, context, documentId);
    throw streamError(error);
  }
}

export async function issueDocumentDownloadGrant(
  db: D1Database,
  context: AuthenticatedUserContext,
  documentId: string,
  raw: unknown,
  idempotencyKey: string,
) {
  try {
    const actor = actorSnapshot(context);
    const confirmation = confirmationSchema.parse(raw);
    z.string().uuid().parse(idempotencyKey);
    const s = await loadSnapshot(db, actor, id.parse(documentId));
    await authorize(db, actor, s.data);
    const action = sensitiveAction(s.data);
    requireRecentPassword(db);
    const payload = grantPayload(actor, s.data, confirmation);
    const payloadHash = await computePayloadHash(payload);
    const token = await computePayloadHash({
      purpose: 'document.download.grant',
      agencyId: actor.memberships[0].agencyId,
      userId: actor.userId,
      membershipId: actor.memberships[0].id,
      identityId: actor.identityId,
      documentId,
      idempotencyKey,
    });
    const evidenceHash = await computeEvidenceHash(token);
    const targetIds = canonicalizeTargetIds([documentId, s.data.versionId]);
    const bindings = [
      evidenceHash,
      actor.memberships[0].agencyId,
      actor.userId,
      actor.memberships[0].id,
      action,
      payloadHash,
      targetIds,
      s.data.documentVersion,
      actor.memberships[0].permissionVersion,
    ];
    const grantPredicate = `evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND payload_hash=?
      AND target_ids_json=? AND expected_target_version=? AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
      AND issued_at<=${NOW} AND expires_at>${NOW} AND julianday(expires_at)-julianday(issued_at)<=180.001/86400
      AND consumed_at IS NULL AND revoked_at IS NULL AND consumed_operation_id IS NULL`;
    await db.batch([
      authorityAssertion(db, actor, s),
      db
        .prepare(
          `INSERT INTO sensitive_action_grants(id,evidence_hash,agency_id,actor_user_id,actor_membership_id,action,payload_hash,target_ids_json,expected_target_version,permission_version,assurance,status,issued_at,expires_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,'SECURE_GRANT','ISSUED',${NOW},strftime('%Y-%m-%dT%H:%M:%fZ','now','+180 seconds')
        WHERE NOT EXISTS(SELECT 1 FROM sensitive_action_grants WHERE evidence_hash=?)`,
        )
        .bind(crypto.randomUUID(), ...bindings, evidenceHash),
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN EXISTS(SELECT 1 FROM sensitive_action_grants WHERE ${grantPredicate}) THEN 1 ELSE 0 END,'DOCUMENT_STREAM_GRANT_CONFLICT'`,
        )
        .bind(crypto.randomUUID(), ...bindings),
      db
        .prepare(
          `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,idempotency_key,outcome,metadata_json)
        SELECT ?,agency_id,actor_user_id,actor_membership_id,'sensitive_action_grant.issued','sensitive_action_grants',id,?,?,'SUCCESS',?
        FROM sensitive_action_grants WHERE ${grantPredicate}
          AND NOT EXISTS(SELECT 1 FROM audit_events audit
            WHERE audit.agency_id=sensitive_action_grants.agency_id
              AND audit.action='sensitive_action_grant.issued' AND audit.target_type='sensitive_action_grants'
              AND audit.target_id=sensitive_action_grants.id)`,
        )
        .bind(
          crypto.randomUUID(),
          crypto.randomUUID(),
          `document.download.grant:${idempotencyKey}`,
          JSON.stringify({
            action,
            documentId,
            versionId: s.data.versionId,
            reasonCode: 'SENSITIVE_DOCUMENT_CONFIRMATION',
          }),
          ...bindings,
        ),
    ]);
    const grant = await db
      .prepare(`SELECT id,expires_at FROM sensitive_action_grants WHERE ${grantPredicate}`)
      .bind(...bindings)
      .first<{ id: string; expires_at: string }>();
    if (!grant) throw new DocumentStreamError();
    await unchanged(db, actor, s);
    return { grantEvidenceToken: token, grantId: grant.id, expiresAt: grant.expires_at };
  } catch (error) {
    await recordStreamDenial(db, context, documentId);
    throw streamError(error);
  }
}
function streamError(error: unknown) {
  if (error instanceof DocumentStreamError) return error;
  return new DocumentStreamError(
    error instanceof z.ZodError || String(error).includes('OPTIMISTIC_CONCURRENCY_CONFLICT')
      ? 404
      : 503,
  );
}

// One joined, durable read is the authority/evidence snapshot, not request or Queue identity.
// Comparing this same server-owned read in the final batch pins the entire permission graph,
// all typed parent links/assignments/classifications, and exact current evidence generations.
const SNAPSHOT_SQL = `SELECT json_object(
  'documentId',d.id,'documentVersion',d.version,'versionId',v.id,'versionNumber',v.version_number,
  'checksum',v.sha256,'objectKey',v.object_key,'size',v.size_bytes,'contentType',v.detected_content_type,
  'classification',d.classification,'ownerType',d.owner_type,
  'ownerId',coalesce(d.customer_id,d.policy_id,d.quote_id),
  'customerId',c.id,'customerAssignee',c.assignee_membership_id,
  'policyId',p.id,'policyAssignee',p.assignee_membership_id,
  'renewalId',r.id,'renewalAssignee',r.assignee_membership_id,
  'parentHealth',CASE WHEN branch.data_classification='HEALTH' THEN 1 ELSE 0 END,
  'validationId',inspection.id,'validationGeneration',inspection.generation,'inspectionResult',inspection.content_inspection_result,
  'backupId',copy.id,'backupGeneration',backup.generation,
  'permissions',(SELECT json_group_array(json_object('id',id,'membership_id',membership_id,
    'permission_code',permission_code,'scope',scope)) FROM
    (SELECT id,membership_id,permission_code,scope FROM membership_permissions WHERE membership_id=m.id ORDER BY id))
) AS snapshot_json
FROM documents d
JOIN document_versions v ON v.agency_id=d.agency_id AND v.document_id=d.id AND v.id=d.current_version_id
JOIN agencies a ON a.id=d.agency_id AND a.status='ACTIVE'
JOIN agency_memberships m ON m.agency_id=a.id AND m.id=? AND m.user_id=? AND m.type=?
  AND m.status='ACTIVE' AND m.permission_version=?
JOIN users u ON u.id=m.user_id AND u.status='ACTIVE'
JOIN auth_identities ai ON ai.id=? AND ai.user_id=u.id AND ai.status='ACTIVE'
LEFT JOIN renewal_quotes q ON d.owner_type='QUOTE' AND q.agency_id=d.agency_id AND q.id=d.quote_id
LEFT JOIN renewal_opportunities r ON r.agency_id=q.agency_id AND r.id=q.renewal_id
LEFT JOIN policies p ON p.agency_id=d.agency_id AND p.id=CASE WHEN d.owner_type='POLICY' THEN d.policy_id WHEN d.owner_type='QUOTE' THEN r.expiring_policy_id END
JOIN customers c ON c.agency_id=d.agency_id AND c.id=CASE WHEN d.owner_type='CUSTOMER' THEN d.customer_id ELSE p.customer_id END
LEFT JOIN insurance_branches branch ON branch.agency_id=p.agency_id AND branch.id=p.branch_id
JOIN document_accepted_validation inspection ON inspection.agency_id=v.agency_id AND inspection.document_version_id=v.id
  AND inspection.sha256=v.sha256
  AND inspection.content_inspection_version=? AND inspection.content_inspection_result IS NOT NULL
  AND length(inspection.content_inspection_result)<=256
  AND CASE WHEN json_valid(inspection.content_inspection_result)=1 THEN
    json_type(inspection.content_inspection_result)='object'
    AND json_type(inspection.content_inspection_result,'$.valid')='true'
    AND (
      (v.detected_content_type='application/pdf'
        AND json_extract(inspection.content_inspection_result,'$.format')='PDF'
        AND (SELECT count(*) FROM json_each(inspection.content_inspection_result))=3
        AND json_type(inspection.content_inspection_result,'$.pageCount')='integer'
        AND json_extract(inspection.content_inspection_result,'$.pageCount') BETWEEN 1 AND 200)
      OR (v.detected_content_type='image/jpeg'
        AND json_extract(inspection.content_inspection_result,'$.format')='JPEG'
        AND (SELECT count(*) FROM json_each(inspection.content_inspection_result))=5
        AND json_type(inspection.content_inspection_result,'$.width')='integer'
        AND json_type(inspection.content_inspection_result,'$.height')='integer'
        AND json_type(inspection.content_inspection_result,'$.pixelCount')='integer'
        AND json_extract(inspection.content_inspection_result,'$.width') BETWEEN 1 AND 8192
        AND json_extract(inspection.content_inspection_result,'$.height') BETWEEN 1 AND 8192
        AND json_extract(inspection.content_inspection_result,'$.pixelCount')=
          json_extract(inspection.content_inspection_result,'$.width')*json_extract(inspection.content_inspection_result,'$.height')
        AND json_extract(inspection.content_inspection_result,'$.pixelCount')<=4000000)
      OR (v.detected_content_type='image/png'
        AND json_extract(inspection.content_inspection_result,'$.format')='PNG'
        AND (SELECT count(*) FROM json_each(inspection.content_inspection_result))=6
        AND json_type(inspection.content_inspection_result,'$.width')='integer'
        AND json_type(inspection.content_inspection_result,'$.height')='integer'
        AND json_type(inspection.content_inspection_result,'$.pixelCount')='integer'
        AND json_type(inspection.content_inspection_result,'$.decompressedBytes')='integer'
        AND json_extract(inspection.content_inspection_result,'$.width')>0
        AND json_extract(inspection.content_inspection_result,'$.height')>0
        AND json_extract(inspection.content_inspection_result,'$.pixelCount')=
          json_extract(inspection.content_inspection_result,'$.width')*json_extract(inspection.content_inspection_result,'$.height')
        AND json_extract(inspection.content_inspection_result,'$.pixelCount')<=16000000
        AND json_extract(inspection.content_inspection_result,'$.decompressedBytes') BETWEEN 1 AND 33554432)
    ) ELSE 0 END=1
JOIN document_backup_copies copy ON copy.agency_id=v.agency_id AND copy.document_version_id=v.id
  AND copy.source_sha256=v.sha256 AND copy.backup_sha256=v.sha256
JOIN background_job_runs backup_run ON backup_run.agency_id=copy.agency_id AND backup_run.id=copy.job_run_id
  AND backup_run.status='SUCCEEDED'
JOIN background_jobs backup ON backup.agency_id=backup_run.agency_id AND backup.id=backup_run.job_id
  AND backup.job_type='DOCUMENT_BACKUP' AND backup.document_version_id=v.id AND backup.input_sha256=v.sha256
  AND backup.status='COMPLETED' AND backup.attempt_count=backup_run.attempt_number
  AND backup.generation=(SELECT max(j.generation) FROM background_jobs j WHERE j.agency_id=v.agency_id
    AND j.document_version_id=v.id AND j.input_sha256=v.sha256 AND j.job_type='DOCUMENT_BACKUP')
WHERE d.id=? AND d.agency_id=? AND d.status='ACTIVE' AND v.status='AVAILABLE'
  AND v.version_number=(SELECT max(newer.version_number) FROM document_versions newer WHERE newer.agency_id=d.agency_id AND newer.document_id=d.id)
  AND c.archived_at IS NULL
  AND (d.owner_type='CUSTOMER' OR (p.id IS NOT NULL AND p.archived_at IS NULL
    AND branch.data_classification IN ('GENERAL','HEALTH') AND (d.owner_type='POLICY' OR (q.id IS NOT NULL AND r.id IS NOT NULL))))`;

function actorSnapshot(context: AuthenticatedUserContext): Actor {
  const actor = structuredClone(context);
  if (actor.memberships.length !== 1) throw new DocumentStreamError();
  return actor as Actor;
}
function values(actor: Actor, documentId: string) {
  const m = actor.memberships[0];
  return [
    m.id,
    actor.userId,
    m.type,
    m.permissionVersion,
    actor.identityId,
    REQUIRED_CONTENT_INSPECTION_VERSION,
    documentId,
    m.agencyId,
  ];
}
/** Server-owned evidence predicate for an authorized metadata page, not a
 * caller-selected SQL/action or a substitute for byte verification on download. */
export function documentPageReadiness(context: AuthenticatedUserContext) {
  const actor = actorSnapshot(context);
  return {
    sql: `EXISTS(${SNAPSHOT_SQL.replace('WHERE d.id=? AND d.agency_id=?', 'WHERE d.id=listed.id AND d.agency_id=?')})`,
    params: values(actor, 'unused').filter((_, index) => index !== 6),
  };
}
async function loadSnapshot(db: D1Database, actor: Actor, documentId: string) {
  const rows = await db
    .prepare(SNAPSHOT_SQL)
    .bind(...values(actor, documentId))
    .all<{ snapshot_json: string }>();

  if (rows.results.length !== 1) throw new DocumentStreamError();
  const json = rows.results[0]!.snapshot_json;
  const parsed = snapshotSchema.safeParse(JSON.parse(json));

  if (!parsed.success) throw new DocumentStreamError();
  return { json, data: parsed.data };
}

// Only the evaluator's exact permission query is supplied the detached graph from the
// joined read. Other queries use live D1. Final snapshot equality prevents snapshot authority
// from surviving any intervening graph mutation, including without a permission_version bump.
function permissionSnapshotDb(db: D1Database, s: Snapshot): D1Database {
  const permissions = s.permissions;
  return {
    prepare(sql: string) {
      if (
        /SELECT id, membership_id, permission_code, scope\s+FROM membership_permissions\s+WHERE membership_id = \?/u.test(
          sql.trim(),
        )
      ) {
        return {
          bind: () => ({
            all: async () => ({ success: true, results: structuredClone(permissions) }),
          }),
        } as unknown as D1PreparedStatement;
      }
      return db.prepare(sql);
    },
  } as D1Database;
}
async function authorize(db: D1Database, actor: Actor, s: Snapshot) {
  const agencyId = actor.memberships[0].agencyId;
  const stableDb = permissionSnapshotDb(db, s);
  const check = async (action: string, resource: Record<string, unknown>) => {
    const result = await evaluateAuthorization(stableDb, {
      context: actor,
      action,
      resource: { agencyId, ...resource },
    });
    if (result.decision !== 'ALLOW')
      throw new DocumentStreamError(result.code === 'DATABASE_ERROR' ? 503 : 404);
  };
  if (s.ownerType === 'CUSTOMER') {
    await check('customer.read', { id: s.customerId, assigneeMembershipId: s.customerAssignee });
  } else if (s.ownerType === 'POLICY') {
    await check(s.parentHealth ? 'policy.health.read' : 'policy.read', {
      id: s.policyId,
      assigneeMembershipId: s.policyAssignee,
      customerAssigneeMembershipId: s.customerAssignee,
    });
  }
  if (s.ownerType === 'QUOTE') {
    await check('renewal.read', {
      id: s.renewalId,
      renewalAssigneeMembershipId: s.renewalAssignee,
      customerAssigneeMembershipId: s.customerAssignee,
    });
    await check(s.parentHealth ? 'policy.health.read' : 'policy.read', {
      id: s.policyId,
      assigneeMembershipId: s.policyAssignee,
      customerAssigneeMembershipId: s.customerAssignee,
    });
    await check('customer.read', { id: s.customerId, assigneeMembershipId: s.customerAssignee });
    await check('quote.read', {
      id: s.ownerId,
      renewalAssigneeMembershipId: s.renewalAssignee,
      customerAssigneeMembershipId: s.customerAssignee,
    });
  }
  await check(
    s.classification === 'IDENTITY'
      ? 'document.identity.read'
      : s.classification === 'HEALTH' || s.parentHealth
        ? 'document.health.read'
        : 'document.read',
    {
      id: s.documentId,
      ownerType: s.ownerType,
      customerId: s.ownerType === 'CUSTOMER' ? s.ownerId : null,
      policyId: s.ownerType === 'POLICY' ? s.ownerId : null,
      quoteId: s.ownerType === 'QUOTE' ? s.ownerId : null,
      assigneeMembershipId:
        s.ownerType === 'CUSTOMER'
          ? s.customerAssignee
          : s.ownerType === 'POLICY'
            ? s.policyAssignee
            : undefined,
      customerAssigneeMembershipId: s.customerAssignee,
      renewalAssigneeMembershipId: s.renewalAssignee,
      parentReadAuthorized: true,
    },
  );
}
async function unchanged(db: D1Database, actor: Actor, s: { json: string; data: Snapshot }) {
  if ((await loadSnapshot(db, actor, s.data.documentId)).json !== s.json)
    throw new DocumentStreamError();
  await db.batch([authorityAssertion(db, actor, s)]);
}
function authorityAssertion(db: D1Database, actor: Actor, s: { json: string; data: Snapshot }) {
  return db
    .prepare(
      `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
    SELECT ?,1,CASE WHEN (SELECT snapshot_json FROM (${SNAPSHOT_SQL}))=? THEN 1 ELSE 0 END,'DOCUMENT_STREAM_AUTHORITY_CHANGED'`,
    )
    .bind(crypto.randomUUID(), ...values(actor, s.data.documentId), s.json);
}

async function readPrimary(
  db: D1Database,
  source: Pick<R2Bucket, 'get'>,
  actor: Actor,
  s: { json: string; data: Snapshot },
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortable = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = () => reject(new DocumentStreamError(503));
      if (controller.signal.aborted) {
        abort();
        return;
      }
      controller.signal.addEventListener('abort', abort, { once: true });
      operation
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort))
        .catch(() => undefined);
    });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => undefined);
  };
  controller.signal.addEventListener('abort', cancel, { once: true });
  try {
    const pending = source.get(s.data.objectKey);
    let object;
    try {
      object = await abortable(pending);
    } catch (error) {
      void pending.then((o) => o?.body.cancel()).catch(() => undefined);
      throw error;
    }
    if (!object) throw new DocumentStreamError();
    reader = object.body.getReader();
    if (object.size !== s.data.size || object.customMetadata?.sha256 !== s.data.checksum)
      throw new DocumentStreamError();
    await abortable(unchanged(db, actor, s));
    const bytes = new Uint8Array(s.data.size);
    const hash = createHash('sha256');
    let length = 0;
    while (true) {
      const { done, value } = await abortable(reader.read());
      if (done) break;
      length += value.byteLength;
      if (length > bytes.byteLength) throw new DocumentStreamError();
      bytes.set(value, length - value.byteLength);
      hash.update(value);
    }
    if (length !== bytes.byteLength || hash.digest('hex') !== s.data.checksum)
      throw new DocumentStreamError();
    return bytes;
  } finally {
    clearTimeout(timer);
    cancel();
    reader?.releaseLock();
  }
}

export async function downloadDocument(
  db: D1Database,
  source: Pick<R2Bucket, 'get'>,
  context: AuthenticatedUserContext,
  documentId: string,
  raw: unknown,
  options: { readonly timeoutMs?: number } = {},
): Promise<Response> {
  try {
    id.parse(documentId);
    const actor = actorSnapshot(context);
    const s = await loadSnapshot(db, actor, documentId);
    await authorize(db, actor, s.data);
    const sensitive = s.data.classification !== 'GENERAL' || !!s.data.parentHealth;
    let grantBindings: (string | number)[] | undefined;
    if (sensitive) {
      // Classification is loaded by the server, not selected by the download URL/body.
      requireRecentPassword(db);
      const command = commandSchema.parse(raw);
      const { grantEvidenceToken, ...confirmation } = command;
      const action = sensitiveAction(s.data);
      const payload = grantPayload(actor, s.data, confirmation);
      const result = await evaluateAuthorization(permissionSnapshotDb(db, s.data), {
        context: actor,
        action,
        resource: documentResource(actor, s.data),
        secureGrantBinding: {
          evidence: grantEvidenceToken,
          payload,
          targetIds: [documentId, s.data.versionId],
          expectedTargetVersion: s.data.documentVersion,
        },
      });
      if (result.decision !== 'ALLOW')
        throw new DocumentStreamError(result.code === 'DATABASE_ERROR' ? 503 : 404);
      grantBindings = [
        await computeEvidenceHash(grantEvidenceToken),
        actor.memberships[0].agencyId,
        actor.userId,
        actor.memberships[0].id,
        action,
        await computePayloadHash(payload),
        canonicalizeTargetIds([documentId, s.data.versionId]),
        s.data.documentVersion,
        actor.memberships[0].permissionVersion,
      ];
    } else z.object({}).strict().parse(raw);
    await unchanged(db, actor, s);
    const bytes = await readPrimary(
      db,
      source,
      actor,
      s,
      Math.min(30000, Math.max(1, options.timeoutMs ?? 30000)),
    );
    const operationId = crypto.randomUUID();
    await db.batch([
      authorityAssertion(db, actor, s),
      ...(grantBindings
        ? [
            db
              .prepare(
                `UPDATE sensitive_action_grants SET status='CONSUMED',consumed_at=${NOW},consumed_operation_id=?,updated_at=${NOW}
          WHERE evidence_hash=? AND agency_id=? AND actor_user_id=? AND actor_membership_id=? AND action=? AND payload_hash=?
            AND target_ids_json=? AND expected_target_version=? AND permission_version=? AND assurance='SECURE_GRANT' AND status='ISSUED'
            AND issued_at<=${NOW} AND expires_at>${NOW} AND julianday(expires_at)-julianday(issued_at)<=180.001/86400
            AND revoked_at IS NULL AND consumed_at IS NULL AND consumed_operation_id IS NULL`,
              )
              .bind(operationId, ...grantBindings),
            db
              .prepare(
                `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,changes(),'DOCUMENT_STREAM_GRANT_RACE'`,
              )
              .bind(crypto.randomUUID()),
          ]
        : []),
      db
        .prepare(
          `INSERT INTO audit_events(id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,correlation_id,outcome,metadata_json)
        VALUES(?,?,?,?,'document.download.authorized','documents',?,?,'SUCCESS',?)`,
        )
        .bind(
          operationId,
          actor.memberships[0].agencyId,
          actor.userId,
          actor.memberships[0].id,
          documentId,
          operationId,
          JSON.stringify({
            resultCode: 'PRIMARY_BYTES_VERIFIED',
            targetVersion: s.data.documentVersion,
          }),
        ),
    ]);
    // D1 and HTTP/R2 are not one transaction. This final live read precedes disclosure;
    // audit means release authorized, not network delivery/receipt of the file.
    await unchanged(db, actor, s);
    const extension =
      s.data.contentType === 'application/pdf'
        ? 'pdf'
        : s.data.contentType === 'image/jpeg'
          ? 'jpg'
          : 'png';
    return new Response(bytes, {
      headers: {
        'Content-Type': s.data.contentType,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `attachment; filename="document.${extension}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'Accept-Ranges': 'none',
      },
    });
  } catch (error) {
    await recordStreamDenial(db, context, documentId);
    throw streamError(error);
  }
}

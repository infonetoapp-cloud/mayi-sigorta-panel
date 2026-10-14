import { z } from 'zod';
import { evaluateAuthorization } from '../auth/authorization';
import { inheritSessionPolicy } from '../auth/session-database';
import type { AuthenticatedUserContext } from '../auth/identity';
import type { EmployeeDocumentPage, EmployeeDocumentDto } from '../../shared/document-types';
import { documentPageReadiness, DocumentStreamError } from './stream';
const identifier = z.string().min(1).max(128);
const inputSchema = z
  .object({
    ownerType: z.enum(['CUSTOMER', 'POLICY', 'QUOTE']),
    ownerId: identifier,
    limit: z.coerce.number().int().min(1).max(20).default(10),
    cursor: z.string().max(1024).optional(),
  })
  .strict();
const graphSchema = z
  .object({
    customerId: identifier,
    customerAssignee: identifier,
    policyId: identifier.nullable(),
    policyAssignee: identifier.nullable(),
    renewalId: identifier.nullable(),
    renewalAssignee: identifier.nullable(),
    parentHealth: z.number().int().min(0).max(1),
    permissions: z
      .array(
        z
          .object({
            id: identifier,
            membership_id: identifier,
            permission_code: identifier,
            scope: identifier,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
// The entire graph is re-read in the final batch, even for empty pages.
const GRAPH = `SELECT json_object('customerId',c.id,'customerAssignee',c.assignee_membership_id,'policyId',p.id,'policyAssignee',p.assignee_membership_id,'renewalId',r.id,'renewalAssignee',r.assignee_membership_id,'parentHealth',CASE WHEN b.data_classification='HEALTH' THEN 1 ELSE 0 END,
'permissions',(SELECT json_group_array(json_object('id',id,'membership_id',membership_id,'permission_code',permission_code,'scope',scope)) FROM (SELECT id,membership_id,permission_code,scope FROM membership_permissions WHERE membership_id=m.id ORDER BY id))) AS value
FROM agencies a JOIN agency_memberships m ON m.agency_id=a.id JOIN users u ON u.id=m.user_id JOIN auth_identities ai ON ai.user_id=u.id
LEFT JOIN renewal_quotes q ON ?='QUOTE' AND q.agency_id=a.id AND q.id=?
LEFT JOIN renewal_opportunities r ON r.agency_id=a.id AND r.id=q.renewal_id
LEFT JOIN policies p ON p.agency_id=a.id AND p.id=CASE WHEN ?='POLICY' THEN ? ELSE r.expiring_policy_id END
JOIN customers c ON c.agency_id=a.id AND c.id=CASE WHEN ?='CUSTOMER' THEN ? ELSE p.customer_id END
LEFT JOIN insurance_branches b ON b.agency_id=a.id AND b.id=p.branch_id
WHERE m.id=? AND m.user_id=? AND m.type=? AND m.permission_version=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND ai.id=? AND ai.status='ACTIVE' AND a.id=? AND a.status='ACTIVE' AND c.archived_at IS NULL
AND (?='CUSTOMER' OR (p.id IS NOT NULL AND p.archived_at IS NULL AND b.data_classification IN ('GENERAL','HEALTH') AND (?='POLICY' OR (q.id IS NOT NULL AND r.id IS NOT NULL))))`;
export async function listEmployeeDocuments(
  db: D1Database,
  context: AuthenticatedUserContext,
  raw: unknown,
): Promise<EmployeeDocumentPage> {
  try {
    const input = inputSchema.parse(raw),
      actor = structuredClone(context);
    if (actor.memberships.length !== 1) throw new DocumentStreamError();
    const m = actor.memberships[0]!;
    const gp = [
      input.ownerType,
      input.ownerId,
      input.ownerType,
      input.ownerId,
      input.ownerType,
      input.ownerId,
      m.id,
      actor.userId,
      m.type,
      m.permissionVersion,
      actor.identityId,
      m.agencyId,
      input.ownerType,
      input.ownerType,
    ];
    const initial = await db
      .prepare(GRAPH)
      .bind(...gp)
      .first<{ value: string }>();
    if (!initial) throw new DocumentStreamError();
    const g = graphSchema.parse(JSON.parse(initial.value));
    const stable = inheritSessionPolicy(db, {
      prepare(sql: string) {
        if (
          /SELECT id, membership_id, permission_code, scope\s+FROM membership_permissions\s+WHERE membership_id = \?/u.test(
            sql.trim(),
          )
        )
          return {
            bind: () => ({
              all: async () => ({ success: true, results: structuredClone(g.permissions) }),
            }),
          } as unknown as D1PreparedStatement;
        return db.prepare(sql);
      },
    } as D1Database);
    const check = async (action: string, resource: Record<string, unknown>) => {
      const result = await evaluateAuthorization(stable, {
        context: actor,
        action,
        resource: { agencyId: m.agencyId, ...resource },
      });
      if (result.code === 'DATABASE_ERROR') throw new DocumentStreamError(503);
      return result.decision === 'ALLOW';
    };
    const parentResource = {
      id: input.ownerId,
      assigneeMembershipId: input.ownerType === 'CUSTOMER' ? g.customerAssignee : g.policyAssignee,
      customerAssigneeMembershipId: g.customerAssignee,
      renewalAssigneeMembershipId: g.renewalAssignee,
    };
    if (input.ownerType === 'CUSTOMER' && !(await check('customer.read', parentResource)))
      throw new DocumentStreamError();
    if (
      input.ownerType === 'POLICY' &&
      !(await check(g.parentHealth ? 'policy.health.read' : 'policy.read', parentResource))
    )
      throw new DocumentStreamError();
    if (input.ownerType === 'QUOTE')
      for (const [action, resource] of [
        [
          'renewal.read',
          {
            id: g.renewalId,
            renewalAssigneeMembershipId: g.renewalAssignee,
            customerAssigneeMembershipId: g.customerAssignee,
          },
        ],
        [
          g.parentHealth ? 'policy.health.read' : 'policy.read',
          {
            id: g.policyId,
            assigneeMembershipId: g.policyAssignee,
            customerAssigneeMembershipId: g.customerAssignee,
          },
        ],
        ['customer.read', { id: g.customerId, assigneeMembershipId: g.customerAssignee }],
        ['quote.read', parentResource],
      ] as const)
        if (!(await check(action, resource))) throw new DocumentStreamError();
    const resource = {
      id: input.ownerId,
      ownerType: input.ownerType,
      customerId: input.ownerType === 'CUSTOMER' ? input.ownerId : null,
      policyId: input.ownerType === 'POLICY' ? input.ownerId : null,
      quoteId: input.ownerType === 'QUOTE' ? input.ownerId : null,
      assigneeMembershipId:
        input.ownerType === 'CUSTOMER'
          ? g.customerAssignee
          : input.ownerType === 'POLICY'
            ? g.policyAssignee
            : undefined,
      customerAssigneeMembershipId: g.customerAssignee,
      renewalAssigneeMembershipId: g.renewalAssignee,
      parentReadAuthorized: true,
    };
    const allowed: string[] = [];
    for (const classification of ['GENERAL', 'IDENTITY', 'HEALTH'] as const)
      if (
        await check(
          classification === 'IDENTITY'
            ? 'document.identity.read'
            : classification === 'HEALTH' || g.parentHealth
              ? 'document.health.read'
              : 'document.read',
          resource,
        )
      )
        allowed.push(classification);
    if (!allowed.length) throw new DocumentStreamError();
    let after = '';
    if (input.cursor) {
      const cursor = z
        .object({
          ownerType: z.literal(input.ownerType),
          ownerId: z.literal(input.ownerId),
          after: identifier,
        })
        .strict()
        .parse(JSON.parse(decodeURIComponent(input.cursor)));
      after = cursor.after;
    }
    const ready = documentPageReadiness(actor);
    const ownerColumn = { CUSTOMER: 'customer_id', POLICY: 'policy_id', QUOTE: 'quote_id' }[
      input.ownerType
    ];
    const query = `SELECT json_group_array(json_object('documentId',id,'fileName',file_name,'classification',classification,'status',status,'createdAt',created_at,'sizeBytes',size_bytes,'downloadMode',downloadMode)) AS value FROM (
 SELECT listed.id,v.file_name,listed.classification,listed.created_at,v.size_bytes,CASE WHEN listed.classification!='GENERAL' OR ?=1 THEN 'SENSITIVE' ELSE 'NORMAL' END AS downloadMode,
 CASE WHEN v.status='AVAILABLE' AND ${ready.sql} THEN 'READY' WHEN v.status IN ('REJECTED','SCAN_FAILED','RETIRED','AVAILABLE') OR EXISTS(SELECT 1 FROM background_jobs j WHERE j.agency_id=listed.agency_id AND j.document_version_id=v.id AND j.job_type='DOCUMENT_BACKUP' AND j.status='DEAD') THEN 'FAILED' ELSE 'PROCESSING' END AS status
 FROM documents listed JOIN document_versions v ON v.agency_id=listed.agency_id AND v.document_id=listed.id AND v.id=coalesce(listed.current_version_id,(SELECT latest.id FROM document_versions latest WHERE latest.agency_id=listed.agency_id AND latest.document_id=listed.id ORDER BY latest.version_number DESC LIMIT 1))
 WHERE listed.agency_id=? AND listed.owner_type=? AND listed.${ownerColumn}=? AND listed.status='ACTIVE' AND listed.id>? AND listed.classification IN (${allowed.map(() => '?').join(',')})
 AND v.version_number=(SELECT max(version_number) FROM document_versions last WHERE last.agency_id=listed.agency_id AND last.document_id=listed.id)
 ORDER BY listed.id LIMIT ?)`;
    const qp = [
      g.parentHealth,
      ...ready.params,
      m.agencyId,
      input.ownerType,
      input.ownerId,
      after,
      ...allowed,
      input.limit + 1,
    ];
    const page = await db
      .prepare(query)
      .bind(...qp)
      .first<{ value: string }>();
    if (!page) throw new DocumentStreamError(503);
    await db.batch([
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code) SELECT ?,1,CASE WHEN (SELECT value FROM (${GRAPH}))=? AND (SELECT value FROM (${query}))=? THEN 1 ELSE 0 END,'DOCUMENT_STREAM_AUTHORITY_CHANGED'`,
        )
        .bind(crypto.randomUUID(), ...gp, initial.value, ...qp, page.value),
    ]);
    const rowSchema = z
      .object({
        documentId: identifier,
        fileName: z.string().min(1).max(1024),
        classification: z.enum(['GENERAL', 'IDENTITY', 'HEALTH']),
        status: z.enum(['PROCESSING', 'READY', 'FAILED']),
        createdAt: z.string().min(1).max(40),
        sizeBytes: z.number().int().min(1).max(20971520),
        downloadMode: z.enum(['NORMAL', 'SENSITIVE']),
      })
      .strict();
    const rows = z.array(rowSchema).max(21).parse(JSON.parse(page.value));
    const documents: EmployeeDocumentDto[] = rows.slice(0, input.limit);
    return {
      documents,
      nextCursor:
        rows.length > input.limit
          ? encodeURIComponent(
              JSON.stringify({
                ownerType: input.ownerType,
                ownerId: input.ownerId,
                after: documents.at(-1)!.documentId,
              }),
            )
          : null,
    };
  } catch (error) {
    if (error instanceof DocumentStreamError) throw error;
    throw new DocumentStreamError(503);
  }
}

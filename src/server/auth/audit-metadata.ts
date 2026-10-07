import { z } from 'zod';
import { getPermissionDefinition } from '../../shared/permissions';
import { sanitizeAuditMetadata } from '../mutations/audit';

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const version = z.number().int().min(1).max(1_000_000_000);
const scope = z.enum(['UNSCOPED', 'ASSIGNED', 'AGENCY']).nullable();
const status = z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE']).nullable();
const type = z.enum(['OWNER', 'MEMBER']).nullable();
const delta = z
  .object({
    permissionCode: z.string().refine((code) => !!getPermissionDefinition(code)),
    classification: z.enum(['NORMAL', 'SENSITIVE']),
    beforeScope: scope,
    afterScope: scope,
  })
  .strict()
  .refine((d) => getPermissionDefinition(d.permissionCode)?.classification === d.classification);
// Do not copy arbitrary reason text into durable audit. Reject likely PII/secret material,
// control characters and opaque strings; preserve only the explicit, bounded human justification.
export function safeJustification(value: string): string {
  const text = value.normalize('NFC').trim();
  if (
    text.length < 3 ||
    text.length > 500 ||
    /[\p{Cc}\p{Cf}]|@|https?:|\d{7}|[A-Za-z0-9_+/=-]{20,}|password|parola|şifre|cookie|csrf|bearer|token|verifier|secret|api.?key/iu.test(
      text,
    )
  )
    throw new Error('UNSAFE_JUSTIFICATION');
  return text;
}
export const personnelAuditMetadataSchema = z
  .object({
    actorKind: z.literal('USER'),
    reasonCode: z.string().regex(/^[A-Z_]{1,64}$/),
    actorPermissionVersion: version,
    grantId: id,
    effectAuditId: id,
    grantTargets: z.array(id).min(1).max(2),
    expectedTargetVersion: version.nullable(),
    action: z
      .string()
      .regex(
        /^personnel\.(create|reset|suspend|inactivate|reactivate|permissions|promote|demote|transfer)$/,
      ),
    targetMembershipId: id,
    targetUserId: id,
    beforeVersion: version.nullable(),
    afterVersion: version,
    beforePermissionVersion: version.nullable(),
    afterPermissionVersion: version,
    beforeStatus: status,
    afterStatus: status,
    beforeType: type,
    afterType: type,
    changedFields: z
      .array(z.enum(['membership', 'permissions', 'credential', 'sessions', 'ownership']))
      .max(5),
    justification: z.string().refine((value) => {
      if (value === 'OWNER_PROVISIONED_EMPLOYEE') return true;
      try {
        return safeJustification(value) === value;
      } catch {
        return false;
      }
    }),
    permissionDeltas: z.array(delta).max(200),
    secondary: z
      .object({
        membershipId: id,
        userId: id,
        beforeVersion: version,
        afterVersion: version,
        beforePermissionVersion: version,
        afterPermissionVersion: version,
        beforeType: type,
        afterType: type,
        beforeStatus: status,
        afterStatus: status,
        permissionDeltas: z.array(delta).max(200),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PersonnelAuditMetadata = z.infer<typeof personnelAuditMetadataSchema>;
export function serializeAuthAuditMetadata(
  metadata?: PersonnelAuditMetadata,
  security?: { action: string; permissionVersion?: number; credentialVersion?: number },
): string {
  if (metadata) return JSON.stringify(personnelAuditMetadataSchema.parse(metadata));
  const credentialChanged =
    security?.action === 'auth.password.changed' || security?.action === 'auth.password.activated';
  return JSON.stringify({
    actorKind: 'USER',
    ...sanitizeAuditMetadata({
      reasonCode: 'AUTH_SECURITY_EVENT',
      changedFields: credentialChanged
        ? ['credentialVersion', 'mustChangePassword', 'sessions']
        : ['sessions'],
    }),
    ...(security?.permissionVersion === undefined
      ? {}
      : { actorPermissionVersion: version.parse(security.permissionVersion) }),
    ...(security?.credentialVersion === undefined
      ? {}
      : {
          beforeCredentialVersion: version.parse(security.credentialVersion),
          afterCredentialVersion: version.parse(
            security.credentialVersion + (credentialChanged ? 1 : 0),
          ),
        }),
  });
}
export function permissionDeltas(
  before: { permission_code: string; scope: string }[],
  after: { permission_code: string; scope: string }[],
): PersonnelAuditMetadata['permissionDeltas'] {
  const old = new Map(before.map((g) => [g.permission_code, g.scope]));
  const next = new Map(after.map((g) => [g.permission_code, g.scope]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort()
    .filter((code) => old.get(code) !== next.get(code))
    .map((code) => ({
      permissionCode: code,
      classification: getPermissionDefinition(code)!.classification,
      beforeScope: (old.get(code) ?? null) as z.infer<typeof scope>,
      afterScope: (next.get(code) ?? null) as z.infer<typeof scope>,
    }));
}

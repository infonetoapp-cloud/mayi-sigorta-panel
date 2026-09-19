import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const agencies = sqliteTable(
  'agencies',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: ['PROVISIONING', 'ACTIVE'] }).notNull(),
    bootstrapCompletedAt: text('bootstrap_completed_at'),
    activatedAt: text('activated_at'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('agencies_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('agencies_status_valid', sql`${table.status} IN ('PROVISIONING', 'ACTIVE')`),
    check('agencies_version_positive', sql`${table.version} >= 1`),
    check('agencies_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'agencies_lifecycle_consistent',
      sql`(${table.status} = 'PROVISIONING' AND ${table.bootstrapCompletedAt} IS NULL AND ${table.activatedAt} IS NULL)
          OR (${table.status} = 'ACTIVE' AND ${table.bootstrapCompletedAt} IS NOT NULL AND ${table.activatedAt} IS NOT NULL)`,
    ),
  ],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('INACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('users_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('users_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('users_version_positive', sql`${table.version} >= 1`),
    check('users_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    index('users_status_idx').on(table.status),
  ],
);

export const authIdentities = sqliteTable(
  'auth_identities',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    verifiedEmail: text('verified_email').notNull(),
    status: text('status', { enum: ['ACTIVE', 'REVOKED'] })
      .notNull()
      .default('ACTIVE'),
    boundAt: text('bound_at').notNull().default(utcNow),
    revokedAt: text('revoked_at'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('auth_identities_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('auth_identities_issuer_nonempty', sql`length(trim(${table.issuer})) > 0`),
    check('auth_identities_subject_nonempty', sql`length(trim(${table.subject})) > 0`),
    check(
      'auth_identities_verified_email_shape',
      sql`length(trim(${table.verifiedEmail})) > 3 AND instr(${table.verifiedEmail}, '@') > 1`,
    ),
    check('auth_identities_status_valid', sql`${table.status} IN ('ACTIVE', 'REVOKED')`),
    check('auth_identities_version_positive', sql`${table.version} >= 1`),
    check('auth_identities_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'auth_identities_lifecycle_consistent',
      sql`(${table.status} = 'ACTIVE' AND ${table.revokedAt} IS NULL)
          OR (${table.status} = 'REVOKED' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    uniqueIndex('auth_identities_issuer_subject_uq').on(table.issuer, table.subject),
    index('auth_identities_user_status_idx').on(table.userId, table.status),
  ],
);

export const agencyMemberships = sqliteTable(
  'agency_memberships',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    type: text('type', { enum: ['OWNER', 'MEMBER'] }).notNull(),
    status: text('status', { enum: ['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'] }).notNull(),
    permissionVersion: integer('permission_version').notNull().default(1),
    version: integer('version').notNull().default(1),
    invitationEmail: text('invitation_email').notNull(),
    invitationExpiresAt: text('invitation_expires_at').notNull(),
    invitationRenewedAt: text('invitation_renewed_at'),
    activatedAt: text('activated_at'),
    suspendedAt: text('suspended_at'),
    inactivatedAt: text('inactivated_at'),
    lastOperationId: text('last_operation_id'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('agency_memberships_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('agency_memberships_type_valid', sql`${table.type} IN ('OWNER', 'MEMBER')`),
    check(
      'agency_memberships_status_valid',
      sql`${table.status} IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE')`,
    ),
    check('agency_memberships_version_positive', sql`${table.version} >= 1`),
    check('agency_memberships_permission_version_positive', sql`${table.permissionVersion} >= 1`),
    check(
      'agency_memberships_invitation_email_shape',
      sql`length(trim(${table.invitationEmail})) > 3 AND instr(${table.invitationEmail}, '@') > 1`,
    ),
    check(
      'agency_memberships_invitation_expiry_ordered',
      sql`${table.invitationExpiresAt} > ${table.createdAt}`,
    ),
    check('agency_memberships_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'agency_memberships_lifecycle_consistent',
      sql`(${table.status} = 'INVITED')
          OR (${table.status} = 'ACTIVE' AND ${table.activatedAt} IS NOT NULL)
          OR (${table.status} = 'SUSPENDED' AND ${table.activatedAt} IS NOT NULL AND ${table.suspendedAt} IS NOT NULL)
          OR (${table.status} = 'INACTIVE' AND ${table.inactivatedAt} IS NOT NULL)`,
    ),
    uniqueIndex('agency_memberships_agency_user_uq').on(table.agencyId, table.userId),
    index('agency_memberships_owner_lookup_idx').on(table.agencyId, table.type, table.status),
    index('agency_memberships_user_status_idx').on(table.userId, table.status),
  ],
);

export const membershipPermissions = sqliteTable(
  'membership_permissions',
  {
    id: text('id').primaryKey(),
    membershipId: text('membership_id')
      .notNull()
      .references(() => agencyMemberships.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    permissionCode: text('permission_code').notNull(),
    scope: text('scope', { enum: ['UNSCOPED', 'ASSIGNED', 'AGENCY'] }).notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('membership_permissions_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('membership_permissions_code_nonempty', sql`length(trim(${table.permissionCode})) > 0`),
    check(
      'membership_permissions_scope_valid',
      sql`${table.scope} IN ('UNSCOPED', 'ASSIGNED', 'AGENCY')`,
    ),
    check(
      'membership_permissions_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    uniqueIndex('membership_permissions_membership_code_uq').on(
      table.membershipId,
      table.permissionCode,
    ),
    index('membership_permissions_membership_idx').on(table.membershipId),
  ],
);

export const d1CasAssertions = sqliteTable(
  'd1_cas_assertions',
  {
    id: text('id').primaryKey(),
    expected: integer('expected').notNull(),
    actual: integer('actual').notNull(),
    failureCode: text('failure_code').notNull().default('OPTIMISTIC_CONCURRENCY_CONFLICT'),
  },
  (table) => [
    check('d1_cas_assertions_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('d1_cas_assertions_failure_code_nonempty', sql`length(trim(${table.failureCode})) > 0`),
  ],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actorMembershipId: text('actor_membership_id')
      .notNull()
      .references(() => agencyMemberships.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    outcome: text('outcome', { enum: ['SUCCESS', 'FAILURE'] }).notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    check('audit_events_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('audit_events_action_nonempty', sql`length(trim(${table.action})) > 0`),
    check('audit_events_target_type_nonempty', sql`length(trim(${table.targetType})) > 0`),
    check('audit_events_target_id_nonempty', sql`length(trim(${table.targetId})) > 0`),
    check('audit_events_correlation_id_nonempty', sql`length(trim(${table.correlationId})) > 0`),
    check('audit_events_outcome_valid', sql`${table.outcome} IN ('SUCCESS', 'FAILURE')`),
    index('audit_events_agency_created_idx').on(table.agencyId, table.createdAt),
    index('audit_events_actor_created_idx').on(table.actorMembershipId, table.createdAt),
    index('audit_events_target_idx').on(table.targetType, table.targetId),
    index('audit_events_correlation_idx').on(table.correlationId),
  ],
);

export const operationReceipts = sqliteTable(
  'operation_receipts',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actorMembershipId: text('actor_membership_id')
      .notNull()
      .references(() => agencyMemberships.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    action: text('action').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadFingerprint: text('payload_fingerprint').notNull(),
    status: text('status', { enum: ['IN_PROGRESS', 'COMPLETED', 'FAILED'] }).notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('operation_receipts_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('operation_receipts_action_nonempty', sql`length(trim(${table.action})) > 0`),
    check('operation_receipts_key_nonempty', sql`length(trim(${table.idempotencyKey})) > 0`),
    check(
      'operation_receipts_fingerprint_nonempty',
      sql`length(trim(${table.payloadFingerprint})) > 0`,
    ),
    check(
      'operation_receipts_status_valid',
      sql`${table.status} IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')`,
    ),
    check('operation_receipts_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    uniqueIndex('operation_receipts_idem_uq').on(
      table.agencyId,
      table.actorUserId,
      table.actorMembershipId,
      table.idempotencyKey,
    ),
    index('operation_receipts_agency_idx').on(table.agencyId),
  ],
);

export const sensitiveActionGrants = sqliteTable(
  'sensitive_action_grants',
  {
    id: text('id').primaryKey(),
    evidenceHash: text('evidence_hash').notNull(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    actorMembershipId: text('actor_membership_id')
      .notNull()
      .references(() => agencyMemberships.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    action: text('action').notNull(),
    payloadHash: text('payload_hash').notNull(),
    targetIdsJson: text('target_ids_json').notNull(),
    expectedTargetVersion: integer('expected_target_version'),
    permissionVersion: integer('permission_version').notNull(),
    assurance: text('assurance', { enum: ['SECURE_GRANT'] })
      .notNull()
      .default('SECURE_GRANT'),
    status: text('status', { enum: ['ISSUED', 'CONSUMED', 'REVOKED'] })
      .notNull()
      .default('ISSUED'),
    issuedAt: text('issued_at').notNull().default(utcNow),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
    revokedAt: text('revoked_at'),
    consumedOperationId: text('consumed_operation_id'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('sensitive_action_grants_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('sensitive_action_grants_evidence_shape', sql`length(${table.evidenceHash}) = 64`),
    check('sensitive_action_grants_action_nonempty', sql`length(trim(${table.action})) > 0`),
    check('sensitive_action_grants_payload_shape', sql`length(${table.payloadHash}) = 64`),
    check(
      'sensitive_action_grants_permission_version_positive',
      sql`${table.permissionVersion} > 0`,
    ),
    check('sensitive_action_grants_assurance_valid', sql`${table.assurance} = 'SECURE_GRANT'`),
    check(
      'sensitive_action_grants_status_valid',
      sql`${table.status} IN ('ISSUED', 'CONSUMED', 'REVOKED')`,
    ),
    check('sensitive_action_grants_expiry_ordered', sql`${table.expiresAt} > ${table.issuedAt}`),
    check(
      'sensitive_action_grants_ttl_valid',
      sql`(strftime('%s', ${table.expiresAt}) - strftime('%s', ${table.issuedAt})) <= 180 AND (strftime('%s', ${table.expiresAt}) - strftime('%s', ${table.issuedAt})) >= 1`,
    ),
    check(
      'sensitive_action_grants_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      'sensitive_action_grants_lifecycle_consistent',
      sql`(${table.status} = 'ISSUED' AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL AND ${table.consumedOperationId} IS NULL)
          OR (${table.status} = 'CONSUMED' AND ${table.consumedAt} IS NOT NULL AND ${table.revokedAt} IS NULL)
          OR (${table.status} = 'REVOKED' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    uniqueIndex('sensitive_action_grants_evidence_uq').on(table.evidenceHash),
    index('sensitive_action_grants_lookup_idx').on(
      table.agencyId,
      table.actorMembershipId,
      table.action,
      table.status,
    ),
  ],
);

export type Agency = typeof agencies.$inferSelect;
export type User = typeof users.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type AgencyMembership = typeof agencyMemberships.$inferSelect;
export type MembershipPermission = typeof membershipPermissions.$inferSelect;
export type D1CasAssertion = typeof d1CasAssertions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type OperationReceipt = typeof operationReceipts.$inferSelect;
export type SensitiveActionGrant = typeof sensitiveActionGrants.$inferSelect;

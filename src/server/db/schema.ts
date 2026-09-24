import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    uniqueIndex('agency_memberships_agency_id_id_uq').on(table.agencyId, table.id),
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

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    type: text('type', { enum: ['INDIVIDUAL', 'COMPANY'] }).notNull(),
    displayName: text('display_name').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    companyTitle: text('company_title'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    assigneeMembershipId: text('assignee_membership_id').notNull(),
    archivedAt: text('archived_at'),
    archivedByMembershipId: text('archived_by_membership_id'),
    archiveReasonCode: text('archive_reason_code'),
    identityType: text('identity_type', { enum: ['TCKN', 'VKN'] }),
    identityCiphertext: text('identity_ciphertext'),
    identityIv: text('identity_iv'),
    identityTag: text('identity_tag'),
    identitySearchHash: text('identity_search_hash'),
    identityKeyVersion: integer('identity_key_version'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('customers_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('customers_type_valid', sql`${table.type} IN ('INDIVIDUAL', 'COMPANY')`),
    check('customers_display_name_nonempty', sql`length(trim(${table.displayName})) > 0`),
    check('customers_version_positive', sql`${table.version} >= 1`),
    check('customers_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'customers_type_fields_valid',
      sql`(${table.type} = 'INDIVIDUAL' AND ${table.companyTitle} IS NULL)
          OR (${table.type} = 'COMPANY' AND ${table.firstName} IS NULL AND ${table.lastName} IS NULL)`,
    ),
    check(
      'customers_email_shape',
      sql`${table.email} IS NULL OR (length(trim(${table.email})) > 3 AND instr(${table.email}, '@') > 1)`,
    ),
    check('customers_phone_shape', sql`${table.phone} IS NULL OR length(trim(${table.phone})) > 0`),
    foreignKey({
      columns: [table.agencyId, table.assigneeMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'customers_agency_assignee_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('customers_agency_id_id_uq').on(table.agencyId, table.id),
    index('customers_agency_type_idx').on(table.agencyId, table.type),
    index('customers_agency_assignee_idx').on(table.agencyId, table.assigneeMembershipId),
    index('customers_agency_created_idx').on(table.agencyId, table.createdAt),
    index('customers_agency_display_name_idx').on(table.agencyId, table.displayName),
    index('customers_agency_identity_search_hash_idx').on(table.agencyId, table.identitySearchHash),
  ],
);

export const companyContacts = sqliteTable(
  'company_contacts',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    customerId: text('customer_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    role: text('role'),
    email: text('email'),
    phone: text('phone'),
    isPrimary: integer('is_primary').notNull().default(0),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('company_contacts_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('company_contacts_first_name_nonempty', sql`length(trim(${table.firstName})) > 0`),
    check('company_contacts_last_name_nonempty', sql`length(trim(${table.lastName})) > 0`),
    check('company_contacts_is_primary_valid', sql`${table.isPrimary} IN (0, 1)`),
    check('company_contacts_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('company_contacts_version_positive', sql`${table.version} >= 1`),
    check('company_contacts_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'company_contacts_email_shape',
      sql`${table.email} IS NULL OR (length(trim(${table.email})) > 3 AND instr(${table.email}, '@') > 1)`,
    ),
    check(
      'company_contacts_phone_shape',
      sql`${table.phone} IS NULL OR length(trim(${table.phone})) > 0`,
    ),
    foreignKey({
      columns: [table.agencyId, table.customerId],
      foreignColumns: [customers.agencyId, customers.id],
      name: 'company_contacts_agency_customer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('company_contacts_active_primary_uq')
      .on(table.agencyId, table.customerId)
      .where(sql`${table.isPrimary} = 1 AND ${table.status} = 'ACTIVE'`),
    index('company_contacts_agency_customer_idx').on(table.agencyId, table.customerId),
    index('company_contacts_customer_status_idx').on(table.customerId, table.status),
  ],
);

export const externalCustomerReferences = sqliteTable(
  'external_customer_references',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    customerId: text('customer_id').notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    externalKey: text('external_key').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('ext_cust_refs_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check(
      'ext_cust_refs_source_namespace_nonempty',
      sql`length(trim(${table.sourceNamespace})) > 0`,
    ),
    check('ext_cust_refs_external_key_nonempty', sql`length(trim(${table.externalKey})) > 0`),
    check('ext_cust_refs_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    foreignKey({
      columns: [table.agencyId, table.customerId],
      foreignColumns: [customers.agencyId, customers.id],
      name: 'ext_cust_refs_agency_customer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('ext_cust_refs_agency_source_key_uq').on(
      table.agencyId,
      table.sourceNamespace,
      table.externalKey,
    ),
    index('ext_cust_refs_agency_customer_idx').on(table.agencyId, table.customerId),
    index('ext_cust_refs_agency_source_key_idx').on(
      table.agencyId,
      table.sourceNamespace,
      table.externalKey,
    ),
  ],
);

export const insurers = sqliteTable(
  'insurers',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('insurers_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('insurers_code_nonempty', sql`length(trim(${table.code})) > 0`),
    check('insurers_name_nonempty', sql`length(trim(${table.name})) > 0`),
    check('insurers_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('insurers_version_positive', sql`${table.version} >= 1`),
    check('insurers_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    uniqueIndex('insurers_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('insurers_agency_code_uq').on(table.agencyId, table.code),
    index('insurers_agency_status_idx').on(table.agencyId, table.status),
  ],
);

export const insuranceBranches = sqliteTable(
  'insurance_branches',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    dataClassification: text('data_classification', { enum: ['GENERAL', 'HEALTH'] })
      .notNull()
      .default('GENERAL'),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('insurance_branches_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('insurance_branches_code_nonempty', sql`length(trim(${table.code})) > 0`),
    check('insurance_branches_name_nonempty', sql`length(trim(${table.name})) > 0`),
    check(
      'insurance_branches_data_classification_valid',
      sql`${table.dataClassification} IN ('GENERAL', 'HEALTH')`,
    ),
    check('insurance_branches_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('insurance_branches_version_positive', sql`${table.version} >= 1`),
    check('insurance_branches_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    uniqueIndex('insurance_branches_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('insurance_branches_agency_code_uq').on(table.agencyId, table.code),
    index('insurance_branches_agency_status_idx').on(table.agencyId, table.status),
  ],
);

export const insuranceProducts = sqliteTable(
  'insurance_products',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    insurerId: text('insurer_id').notNull(),
    branchId: text('branch_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('insurance_products_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('insurance_products_code_nonempty', sql`length(trim(${table.code})) > 0`),
    check('insurance_products_name_nonempty', sql`length(trim(${table.name})) > 0`),
    check('insurance_products_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('insurance_products_version_positive', sql`${table.version} >= 1`),
    check('insurance_products_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    foreignKey({
      columns: [table.agencyId, table.insurerId],
      foreignColumns: [insurers.agencyId, insurers.id],
      name: 'insurance_products_agency_insurer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.branchId],
      foreignColumns: [insuranceBranches.agencyId, insuranceBranches.id],
      name: 'insurance_products_agency_branch_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('insurance_products_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('insurance_products_policy_relation_uq').on(
      table.agencyId,
      table.id,
      table.insurerId,
      table.branchId,
    ),
    uniqueIndex('insurance_products_agency_code_uq').on(table.agencyId, table.code),
    index('insurance_products_agency_insurer_idx').on(table.agencyId, table.insurerId),
    index('insurance_products_agency_branch_idx').on(table.agencyId, table.branchId),
    index('insurance_products_agency_status_idx').on(table.agencyId, table.status),
  ],
);

export const paymentMethods = sqliteTable(
  'payment_methods',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    supportsInstallments: integer('supports_installments').notNull().default(0),
    maxInstallments: integer('max_installments').notNull().default(12),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('payment_methods_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('payment_methods_code_nonempty', sql`length(trim(${table.code})) > 0`),
    check('payment_methods_name_nonempty', sql`length(trim(${table.name})) > 0`),
    check(
      'payment_methods_supports_installments_valid',
      sql`${table.supportsInstallments} IN (0, 1)`,
    ),
    check(
      'payment_methods_max_installments_range',
      sql`${table.maxInstallments} >= 2 AND ${table.maxInstallments} <= 36`,
    ),
    check('payment_methods_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('payment_methods_version_positive', sql`${table.version} >= 1`),
    check('payment_methods_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    uniqueIndex('payment_methods_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('payment_methods_agency_code_uq').on(table.agencyId, table.code),
    index('payment_methods_agency_status_idx').on(table.agencyId, table.status),
  ],
);

export const lossReasons = sqliteTable(
  'loss_reasons',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('loss_reasons_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('loss_reasons_code_nonempty', sql`length(trim(${table.code})) > 0`),
    check('loss_reasons_name_nonempty', sql`length(trim(${table.name})) > 0`),
    check('loss_reasons_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('loss_reasons_version_positive', sql`${table.version} >= 1`),
    check('loss_reasons_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    uniqueIndex('loss_reasons_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('loss_reasons_agency_code_uq').on(table.agencyId, table.code),
    index('loss_reasons_agency_status_idx').on(table.agencyId, table.status),
  ],
);

export const agencySettings = sqliteTable(
  'agency_settings',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    defaultInsurerId: text('default_insurer_id'),
    timezone: text('timezone').notNull().default('Europe/Istanbul'),
    renewalWindowDays: integer('renewal_window_days').notNull().default(30),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('agency_settings_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('agency_settings_timezone_nonempty', sql`length(trim(${table.timezone})) > 0`),
    check(
      'agency_settings_renewal_window_days_range',
      sql`${table.renewalWindowDays} >= 1 AND ${table.renewalWindowDays} <= 120`,
    ),
    check('agency_settings_version_positive', sql`${table.version} >= 1`),
    check('agency_settings_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    foreignKey({
      columns: [table.agencyId, table.defaultInsurerId],
      foreignColumns: [insurers.agencyId, insurers.id],
      name: 'agency_settings_agency_default_insurer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('agency_settings_agency_id_uq').on(table.agencyId),
    index('agency_settings_default_insurer_idx').on(table.agencyId, table.defaultInsurerId),
  ],
);

export const policies = sqliteTable(
  'policies',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    customerId: text('customer_id').notNull(),
    insurerId: text('insurer_id').notNull(),
    productId: text('product_id').notNull(),
    branchId: text('branch_id').notNull(),
    paymentMethodId: text('payment_method_id').notNull(),
    assigneeMembershipId: text('assignee_membership_id').notNull(),
    policyNumber: text('policy_number').notNull(),
    normalizedPolicyNumber: text('normalized_policy_number').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    grossPremiumMinor: integer('gross_premium_minor').notNull(),
    currency: text('currency').notNull(),
    installmentCount: integer('installment_count'),
    status: text('status', { enum: ['ACTIVE', 'CANCELLED', 'VOIDED'] })
      .notNull()
      .default('ACTIVE'),
    identityVariant: integer('identity_variant').notNull().default(0),
    identityVariantReason: text('identity_variant_reason'),
    archivedAt: text('archived_at'),
    archivedByMembershipId: text('archived_by_membership_id'),
    archiveReason: text('archive_reason'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('policies_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('policies_number_nonempty', sql`length(trim(${table.policyNumber})) > 0`),
    check('policies_normalized_number_nonempty', sql`length(${table.normalizedPolicyNumber}) > 0`),
    check(
      'policies_date_shape',
      sql`${table.startDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ${table.endDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check('policies_period_ordered', sql`${table.startDate} <= ${table.endDate}`),
    check(
      'policies_premium_safe',
      sql`${table.grossPremiumMinor} >= 0 AND ${table.grossPremiumMinor} <= 9007199254740991`,
    ),
    check(
      'policies_currency_shape',
      sql`length(${table.currency}) = 3 AND ${table.currency} = upper(${table.currency})`,
    ),
    check('policies_status_valid', sql`${table.status} IN ('ACTIVE', 'CANCELLED', 'VOIDED')`),
    check('policies_identity_variant_nonnegative', sql`${table.identityVariant} >= 0`),
    check(
      'policies_identity_variant_reason_consistent',
      sql`(${table.identityVariant} = 0 AND ${table.identityVariantReason} IS NULL) OR (${table.identityVariant} > 0 AND length(trim(${table.identityVariantReason})) >= 3)`,
    ),
    check(
      'policies_installment_range',
      sql`${table.installmentCount} IS NULL OR (${table.installmentCount} >= 2 AND ${table.installmentCount} <= 36)`,
    ),
    check(
      'policies_archive_consistent',
      sql`(${table.archivedAt} IS NULL AND ${table.archivedByMembershipId} IS NULL AND ${table.archiveReason} IS NULL) OR (${table.archivedAt} IS NOT NULL AND ${table.archivedByMembershipId} IS NOT NULL AND length(trim(${table.archiveReason})) > 0)`,
    ),
    check('policies_version_positive', sql`${table.version} >= 1`),
    foreignKey({
      columns: [table.agencyId, table.customerId],
      foreignColumns: [customers.agencyId, customers.id],
      name: 'policies_agency_customer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.insurerId],
      foreignColumns: [insurers.agencyId, insurers.id],
      name: 'policies_agency_insurer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.branchId],
      foreignColumns: [insuranceBranches.agencyId, insuranceBranches.id],
      name: 'policies_agency_branch_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.paymentMethodId],
      foreignColumns: [paymentMethods.agencyId, paymentMethods.id],
      name: 'policies_agency_payment_method_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.assigneeMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'policies_agency_assignee_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.archivedByMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'policies_agency_archived_by_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.productId, table.insurerId, table.branchId],
      foreignColumns: [
        insuranceProducts.agencyId,
        insuranceProducts.id,
        insuranceProducts.insurerId,
        insuranceProducts.branchId,
      ],
      name: 'policies_product_relation_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('policies_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('policies_candidate_uq').on(
      table.agencyId,
      table.insurerId,
      table.normalizedPolicyNumber,
      table.endDate,
      table.identityVariant,
    ),
    index('policies_agency_end_id_idx').on(table.agencyId, table.endDate, table.id),
    index('policies_agency_customer_end_idx').on(table.agencyId, table.customerId, table.endDate),
    index('policies_agency_assignee_idx').on(table.agencyId, table.assigneeMembershipId),
  ],
);

export const policyParties = sqliteTable(
  'policy_parties',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    policyId: text('policy_id').notNull(),
    customerId: text('customer_id').notNull(),
    role: text('role', { enum: ['INSURED', 'BENEFICIARY'] }).notNull(),
    status: text('status', { enum: ['ACTIVE', 'INACTIVE'] })
      .notNull()
      .default('ACTIVE'),
    version: integer('version').notNull().default(1),
    deactivatedAt: text('deactivated_at'),
    deactivatedByMembershipId: text('deactivated_by_membership_id'),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('policy_parties_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('policy_parties_role_valid', sql`${table.role} IN ('INSURED', 'BENEFICIARY')`),
    check('policy_parties_status_valid', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
    check('policy_parties_version_positive', sql`${table.version} >= 1`),
    check(
      'policy_parties_lifecycle_consistent',
      sql`(${table.status}='ACTIVE' AND ${table.deactivatedAt} IS NULL AND ${table.deactivatedByMembershipId} IS NULL) OR (${table.status}='INACTIVE' AND ${table.deactivatedAt} IS NOT NULL AND ${table.deactivatedByMembershipId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.agencyId, table.policyId],
      foreignColumns: [policies.agencyId, policies.id],
      name: 'policy_parties_agency_policy_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.customerId],
      foreignColumns: [customers.agencyId, customers.id],
      name: 'policy_parties_agency_customer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.deactivatedByMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'policy_parties_agency_deactivated_by_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('policy_parties_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('policy_parties_active_relation_uq')
      .on(table.agencyId, table.policyId, table.customerId, table.role)
      .where(sql`${table.status}='ACTIVE'`),
    index('policy_parties_policy_idx').on(table.agencyId, table.policyId, table.status),
  ],
);

export const policyAmendments = sqliteTable(
  'policy_amendments',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    policyId: text('policy_id').notNull(),
    externalReference: text('external_reference').notNull(),
    effectiveDate: text('effective_date').notNull(),
    description: text('description').notNull(),
    premiumDifferenceMinor: integer('premium_difference_minor'),
    currency: text('currency'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    check('policy_amendments_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check(
      'policy_amendments_external_reference_nonempty',
      sql`length(trim(${table.externalReference})) > 0`,
    ),
    check('policy_amendments_description_nonempty', sql`length(trim(${table.description})) > 0`),
    check(
      'policy_amendments_date_shape',
      sql`${table.effectiveDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check(
      'policy_amendments_premium_safe',
      sql`${table.premiumDifferenceMinor} IS NULL OR (${table.premiumDifferenceMinor} >= -9007199254740991 AND ${table.premiumDifferenceMinor} <= 9007199254740991)`,
    ),
    check(
      'policy_amendments_money_consistent',
      sql`(${table.premiumDifferenceMinor} IS NULL AND ${table.currency} IS NULL) OR (${table.premiumDifferenceMinor} IS NOT NULL AND length(${table.currency})=3 AND ${table.currency}=upper(${table.currency}))`,
    ),
    foreignKey({
      columns: [table.agencyId, table.policyId],
      foreignColumns: [policies.agencyId, policies.id],
      name: 'policy_amendments_agency_policy_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('policy_amendments_agency_id_id_uq').on(table.agencyId, table.id),
    index('policy_amendments_policy_date_idx').on(
      table.agencyId,
      table.policyId,
      table.effectiveDate,
    ),
  ],
);

export const policyExternalReferences = sqliteTable(
  'policy_external_references',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    policyId: text('policy_id').notNull(),
    sourceNamespace: text('source_namespace').notNull(),
    externalKey: text('external_key').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    check('policy_external_references_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check(
      'policy_external_references_namespace_nonempty',
      sql`length(trim(${table.sourceNamespace})) > 0`,
    ),
    check('policy_external_references_key_nonempty', sql`length(trim(${table.externalKey})) > 0`),
    foreignKey({
      columns: [table.agencyId, table.policyId],
      foreignColumns: [policies.agencyId, policies.id],
      name: 'policy_external_references_agency_policy_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('policy_external_references_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('policy_external_references_namespace_key_uq').on(
      table.agencyId,
      table.sourceNamespace,
      table.externalKey,
    ),
    index('policy_external_references_policy_idx').on(table.agencyId, table.policyId),
  ],
);

export const renewalOpportunities = sqliteTable(
  'renewal_opportunities',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    expiringPolicyId: text('expiring_policy_id').notNull(),
    assigneeMembershipId: text('assignee_membership_id'),
    state: text('state', {
      enum: [
        'CONTACT_PENDING',
        'CONTACTED',
        'QUOTE_PREPARING',
        'QUOTE_SENT',
        'AWAITING_RESPONSE',
        'WON',
        'LOST',
        'VOIDED',
      ],
    })
      .notNull()
      .default('CONTACT_PENDING'),
    lossReasonId: text('loss_reason_id'),
    lossReasonNotes: text('loss_reason_notes'),
    voidReasonCode: text('void_reason_code'),
    closedAt: text('closed_at'),
    closedByMembershipId: text('closed_by_membership_id'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('renewal_opportunities_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check(
      'renewal_opportunities_state_valid',
      sql`${table.state} IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE','WON','LOST','VOIDED')`,
    ),
    check('renewal_opportunities_version_positive', sql`${table.version} >= 1`),
    check(
      'renewal_opportunities_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      'renewal_opportunities_terminal_fields_consistent',
      sql`(${table.state} IN ('WON','LOST','VOIDED') AND ${table.closedAt} IS NOT NULL AND ${table.closedByMembershipId} IS NOT NULL) OR (${table.state} NOT IN ('WON','LOST','VOIDED') AND ${table.closedAt} IS NULL AND ${table.closedByMembershipId} IS NULL)`,
    ),
    check(
      'renewal_opportunities_loss_reason_consistent',
      sql`(${table.state}='LOST' AND ${table.lossReasonId} IS NOT NULL) OR (${table.state}<>'LOST' AND ${table.lossReasonId} IS NULL AND ${table.lossReasonNotes} IS NULL)`,
    ),
    check(
      'renewal_opportunities_void_reason_consistent',
      sql`(${table.state}='VOIDED' AND ${table.voidReasonCode} IS NOT NULL AND length(trim(${table.voidReasonCode}))>0) OR (${table.state}<>'VOIDED' AND ${table.voidReasonCode} IS NULL)`,
    ),
    foreignKey({
      columns: [table.agencyId, table.expiringPolicyId],
      foreignColumns: [policies.agencyId, policies.id],
      name: 'renewal_opportunities_agency_expiring_policy_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.assigneeMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'renewal_opportunities_agency_assignee_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.lossReasonId],
      foreignColumns: [lossReasons.agencyId, lossReasons.id],
      name: 'renewal_opportunities_agency_loss_reason_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.closedByMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'renewal_opportunities_agency_closed_by_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('renewal_opportunities_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('renewal_opportunities_expiring_policy_uq').on(
      table.agencyId,
      table.expiringPolicyId,
    ),
    index('renewal_opportunities_state_idx').on(table.agencyId, table.state, table.id),
    index('renewal_opportunities_assignee_state_idx').on(
      table.agencyId,
      table.assigneeMembershipId,
      table.state,
      table.id,
    ),
  ],
);

export const renewalStateHistory = sqliteTable(
  'renewal_state_history',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    renewalId: text('renewal_id').notNull(),
    fromState: text('from_state', {
      enum: [
        'CONTACT_PENDING',
        'CONTACTED',
        'QUOTE_PREPARING',
        'QUOTE_SENT',
        'AWAITING_RESPONSE',
        'WON',
        'LOST',
        'VOIDED',
      ],
    }),
    toState: text('to_state', {
      enum: [
        'CONTACT_PENDING',
        'CONTACTED',
        'QUOTE_PREPARING',
        'QUOTE_SENT',
        'AWAITING_RESPONSE',
        'WON',
        'LOST',
        'VOIDED',
      ],
    }).notNull(),
    actorKind: text('actor_kind', { enum: ['USER', 'SYSTEM'] }).notNull(),
    actorUserId: text('actor_user_id'),
    actorMembershipId: text('actor_membership_id'),
    reasonCode: text('reason_code').notNull(),
    createdAt: text('created_at').notNull().default(utcNow),
    lossReasonId: text('loss_reason_id'),
    lossReasonNotes: text('loss_reason_notes'),
    voidReasonCode: text('void_reason_code'),
  },
  (table) => [
    check('renewal_state_history_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check(
      'renewal_state_history_from_state_valid',
      sql`${table.fromState} IS NULL OR ${table.fromState} IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE','WON','LOST','VOIDED')`,
    ),
    check(
      'renewal_state_history_to_state_valid',
      sql`${table.toState} IN ('CONTACT_PENDING','CONTACTED','QUOTE_PREPARING','QUOTE_SENT','AWAITING_RESPONSE','WON','LOST','VOIDED')`,
    ),
    check(
      'renewal_state_history_actor_consistent',
      sql`(${table.actorKind}='USER' AND ${table.actorUserId} IS NOT NULL AND ${table.actorMembershipId} IS NOT NULL) OR (${table.actorKind}='SYSTEM' AND ${table.actorUserId} IS NULL AND ${table.actorMembershipId} IS NULL)`,
    ),
    check('renewal_state_history_reason_nonempty', sql`length(trim(${table.reasonCode})) > 0`),
    foreignKey({
      columns: [table.agencyId, table.renewalId],
      foreignColumns: [renewalOpportunities.agencyId, renewalOpportunities.id],
      name: 'renewal_state_history_agency_renewal_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.actorUserId],
      foreignColumns: [users.id],
      name: 'renewal_state_history_actor_user_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.actorMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'renewal_state_history_actor_membership_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('renewal_state_history_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('renewal_state_history_initial_uq')
      .on(table.agencyId, table.renewalId)
      .where(sql`${table.fromState} IS NULL`),
    index('renewal_state_history_renewal_created_idx').on(
      table.agencyId,
      table.renewalId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id').notNull(),
    customerId: text('customer_id').notNull(),
    policyId: text('policy_id'),
    renewalId: text('renewal_id'),
    kind: text('kind', { enum: ['GENERAL', 'RENEWAL_FOLLOWUP'] }).notNull(),
    title: text('title').notNull(),
    dueAt: text('due_at').notNull(),
    assigneeMembershipId: text('assignee_membership_id'),
    status: text('status', { enum: ['OPEN', 'COMPLETED'] })
      .notNull()
      .default('OPEN'),
    completedAt: text('completed_at'),
    completedByMembershipId: text('completed_by_membership_id'),
    actorKind: text('actor_kind', { enum: ['USER', 'SYSTEM'] }).notNull(),
    createdByUserId: text('created_by_user_id'),
    createdByMembershipId: text('created_by_membership_id'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(utcNow),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check('tasks_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check('tasks_title_nonempty', sql`length(trim(${table.title})) > 0`),
    check('tasks_kind_valid', sql`${table.kind} IN ('GENERAL','RENEWAL_FOLLOWUP')`),
    check('tasks_status_valid', sql`${table.status} IN ('OPEN','COMPLETED')`),
    check('tasks_version_positive', sql`${table.version} >= 1`),
    check('tasks_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'tasks_kind_parent_consistent',
      sql`(${table.kind}='RENEWAL_FOLLOWUP' AND ${table.renewalId} IS NOT NULL AND ${table.policyId} IS NULL) OR (${table.kind}='GENERAL' AND ${table.renewalId} IS NULL)`,
    ),
    check(
      'tasks_completion_consistent',
      sql`(${table.status}='OPEN' AND ${table.completedAt} IS NULL AND ${table.completedByMembershipId} IS NULL) OR (${table.status}='COMPLETED' AND ${table.completedAt} IS NOT NULL AND ${table.completedByMembershipId} IS NOT NULL)`,
    ),
    check(
      'tasks_creator_consistent',
      sql`(${table.actorKind}='USER' AND ${table.createdByUserId} IS NOT NULL AND ${table.createdByMembershipId} IS NOT NULL) OR (${table.actorKind}='SYSTEM' AND ${table.createdByUserId} IS NULL AND ${table.createdByMembershipId} IS NULL)`,
    ),
    foreignKey({
      columns: [table.agencyId, table.customerId],
      foreignColumns: [customers.agencyId, customers.id],
      name: 'tasks_agency_customer_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.policyId],
      foreignColumns: [policies.agencyId, policies.id],
      name: 'tasks_agency_policy_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.renewalId],
      foreignColumns: [renewalOpportunities.agencyId, renewalOpportunities.id],
      name: 'tasks_agency_renewal_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.assigneeMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'tasks_agency_assignee_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [users.id],
      name: 'tasks_created_by_user_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.createdByMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'tasks_created_by_membership_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.agencyId, table.completedByMembershipId],
      foreignColumns: [agencyMemberships.agencyId, agencyMemberships.id],
      name: 'tasks_completed_by_membership_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    uniqueIndex('tasks_agency_id_id_uq').on(table.agencyId, table.id),
    uniqueIndex('tasks_open_renewal_followup_uq')
      .on(table.agencyId, table.renewalId)
      .where(sql`${table.kind}='RENEWAL_FOLLOWUP' AND ${table.status}='OPEN'`),
    index('tasks_today_lookup_idx').on(table.agencyId, table.status, table.dueAt, table.id),
    index('tasks_assignee_status_due_idx').on(
      table.agencyId,
      table.assigneeMembershipId,
      table.status,
      table.dueAt,
      table.id,
    ),
    index('tasks_customer_due_idx').on(table.agencyId, table.customerId, table.dueAt),
  ],
);

export const renewalGenerationCursors = sqliteTable(
  'renewal_generation_cursors',
  {
    agencyId: text('agency_id')
      .primaryKey()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    lastSuccessfulLocalDate: text('last_successful_local_date'),
    version: integer('version').notNull().default(1),
    updatedAt: text('updated_at').notNull().default(utcNow),
  },
  (table) => [
    check(
      'renewal_generation_cursors_date_shape',
      sql`${table.lastSuccessfulLocalDate} IS NULL OR ${table.lastSuccessfulLocalDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check('renewal_generation_cursors_version_positive', sql`${table.version} >= 1`),
  ],
);

export const systemAuditEvents = sqliteTable(
  'system_audit_events',
  {
    id: text('id').primaryKey(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    systemActorCode: text('system_actor_code').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    outcome: text('outcome', { enum: ['SUCCESS', 'FAILURE'] }).notNull(),
    reasonCode: text('reason_code').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(utcNow),
  },
  (table) => [
    check('system_audit_events_id_nonempty', sql`length(trim(${table.id})) > 0`),
    check(
      'system_audit_events_actor_code_nonempty',
      sql`length(trim(${table.systemActorCode})) > 0`,
    ),
    check('system_audit_events_action_nonempty', sql`length(trim(${table.action})) > 0`),
    check('system_audit_events_target_type_nonempty', sql`length(trim(${table.targetType})) > 0`),
    check('system_audit_events_target_id_nonempty', sql`length(trim(${table.targetId})) > 0`),
    check(
      'system_audit_events_correlation_id_nonempty',
      sql`length(trim(${table.correlationId})) > 0`,
    ),
    check('system_audit_events_key_nonempty', sql`length(trim(${table.idempotencyKey})) > 0`),
    check('system_audit_events_reason_nonempty', sql`length(trim(${table.reasonCode})) > 0`),
    check('system_audit_events_outcome_valid', sql`${table.outcome} IN ('SUCCESS','FAILURE')`),
    uniqueIndex('system_audit_events_idempotency_uq').on(
      table.agencyId,
      table.systemActorCode,
      table.action,
      table.idempotencyKey,
    ),
    index('system_audit_events_target_idx').on(table.agencyId, table.targetType, table.targetId),
    index('system_audit_events_created_idx').on(table.agencyId, table.createdAt),
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
export type Customer = typeof customers.$inferSelect;
export type CompanyContact = typeof companyContacts.$inferSelect;
export type ExternalCustomerReference = typeof externalCustomerReferences.$inferSelect;
export type Insurer = typeof insurers.$inferSelect;
export type InsuranceBranch = typeof insuranceBranches.$inferSelect;
export type InsuranceProduct = typeof insuranceProducts.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type LossReason = typeof lossReasons.$inferSelect;
export type AgencySettings = typeof agencySettings.$inferSelect;
export type Policy = typeof policies.$inferSelect;
export type PolicyParty = typeof policyParties.$inferSelect;
export type PolicyAmendment = typeof policyAmendments.$inferSelect;
export type PolicyExternalReference = typeof policyExternalReferences.$inferSelect;
export type RenewalOpportunity = typeof renewalOpportunities.$inferSelect;
export type RenewalStateHistory = typeof renewalStateHistory.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type RenewalGenerationCursor = typeof renewalGenerationCursors.$inferSelect;
export type SystemAuditEvent = typeof systemAuditEvents.$inferSelect;

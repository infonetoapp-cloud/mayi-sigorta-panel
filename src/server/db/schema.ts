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

export type Agency = typeof agencies.$inferSelect;
export type User = typeof users.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type AgencyMembership = typeof agencyMemberships.$inferSelect;

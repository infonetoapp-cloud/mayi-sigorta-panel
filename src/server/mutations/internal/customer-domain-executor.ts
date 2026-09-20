/**
 * Mayı Sigorta CRM — Dahili Müşteri Domain Mutasyon Yürütücüsü (M2-T01 Sealed Internal Capability)
 *
 * MİMARİ VE GÜVENLİK SÖZLEŞMESİ (BLOCKER A & B DÜZELTMESİ):
 * 1. Kapalı Dahili Yetenek (Sealed Internal Capability):
 *    Bu modül YALNIZCA `src/server/customers/service.ts` tarafından içe aktarılabilir.
 *    Başka hiçbir production sunucu dosyası, route handler veya harici modül doğrudan erişemez.
 * 2. Caller-Selected Authority Girdisi Yasağı:
 *    Müşteri oluşturulurken (`customer.create`) assignee seçimi arayüzden veya çağıran koddan
 *    alınamaz; güvenilir sunucu bağlamındaki `actorMembershipId` doğrudan ve zorunlu olarak atanır.
 * 3. Atomik ve Kapsamlı Nihai Yetki Recheck (Batch Invariant):
 *    Batch'in en başında, SQLite düzeyinde atomik CAS assertion ile:
 *    - Aktörün kullanıcı, acente ve üyelik durumlarının ACTIVE olduğu,
 *    - Snapshot'taki `expectedPermissionVersion` ile `m.permission_version`'ın tam eşleştiği,
 *    - OWNER için implicit NORMAL AGENCY yetkisinin geçerli olduğu,
 *    - MEMBER `customer.create` için `customer.create` izninin tam olarak 'UNSCOPED' ve
 *      bağımlılığı olan `customer.read` izninin 'ASSIGNED' veya 'AGENCY' olduğu,
 *    - MEMBER `customer.update` ve `company_contact.*` için `customer.update` ve `customer.read`
 *      izinlerinin mevcut ve yalnız 'ASSIGNED' veya 'AGENCY' olduğu,
 *    - İzin hiyerarşisinin (read kapsamının update kapsamından dar olamayacağı) korunduğu,
 *    - ASSIGNED yükümlülüğü varsa CANLI veritabanındaki hedef müşterinin `assignee_membership_id`
 *      değerinin aktörün `actorMembershipId`'sine tam eşleştiği (stale assignee race önleme)
 *    doğrulanır. Herhangi bir tutarsızlıkta tüm batch (makbuz, veri, denetim) veritabanı
 *    düzeyinde ROLLBACK olur.
 * 4. Deterministik Idempotency: Aynı anahtar ve aynı kanonik payload tekrarlarında replay döner.
 * 5. Güvenli Denetim (Safe Audit): Asla PII loglanmaz.
 */

import { computePayloadHash } from '../canonical';
import { IdempotencyConflictError } from '../idempotency';
import { buildSafeAuditRecord } from '../audit';
import { OptimisticConcurrencyError } from '../../db/optimistic';

export class DomainConstraintViolationError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? `DOMAIN_CONSTRAINT_VIOLATION: ${code}`);
    this.name = 'DomainConstraintViolationError';
    this.code = code;
  }
}

export type CustomerDomainCommand =
  | {
      readonly kind: 'customer.create';
      readonly customerId: string;
      readonly type: 'INDIVIDUAL' | 'COMPANY';
      readonly displayName: string;
      readonly firstName?: string | null;
      readonly lastName?: string | null;
      readonly companyTitle?: string | null;
      readonly email?: string | null;
      readonly phone?: string | null;
      readonly address?: string | null;
      // Güvenlik Kuralı: assigneeMembershipId çağıran tarafından SEÇİLEMEZ.
      // Yürütücü aktörün güvenilir üyeliğini (actorMembershipId) doğrudan atar.
    }
  | {
      readonly kind: 'customer.update';
      readonly customerId: string;
      readonly expectedVersion: number;
      readonly displayName?: string;
      readonly firstName?: string | null;
      readonly lastName?: string | null;
      readonly companyTitle?: string | null;
      readonly email?: string | null;
      readonly phone?: string | null;
      readonly address?: string | null;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'company_contact.create';
      readonly customerId: string;
      readonly contactId: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly role?: string | null;
      readonly email?: string | null;
      readonly phone?: string | null;
      readonly isPrimary?: boolean;
    }
  | {
      readonly kind: 'company_contact.update';
      readonly customerId: string;
      readonly contactId: string;
      readonly expectedVersion: number;
      readonly firstName?: string;
      readonly lastName?: string;
      readonly role?: string | null;
      readonly email?: string | null;
      readonly phone?: string | null;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'company_contact.set_primary';
      readonly customerId: string;
      readonly contactId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'company_contact.deactivate';
      readonly customerId: string;
      readonly contactId: string;
      readonly expectedVersion: number;
    };

export interface ExecuteCustomerDomainCommandInput<TResult = unknown> {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly expectedPermissionVersion: number;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly command: CustomerDomainCommand;
  readonly resultProducer: () => { status: number; body: TResult };
}

export interface CustomerDomainCommandResult<TResult = unknown> {
  readonly executed: boolean;
  readonly replayed: boolean;
  readonly status: number;
  readonly body: TResult;
}

interface CommandExecutionPlan {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetCustomerId: string;
  readonly isCreate: boolean;
  readonly auditCode: string;
  readonly auditMetadata: Record<string, unknown>;
  readonly businessStatements: Array<{
    statement: D1PreparedStatement;
    expectedChanges: number;
    failureCode?: string;
  }>;
}

/**
 * Komut türüne göre server-owned eylem, izin, denetim ve SQL ifadelerini planlar.
 * İstemci veya servis katmanı bu eşlemeleri asla değiştiremez.
 */
async function planCommand(
  db: D1Database,
  agencyId: string,
  actorMembershipId: string,
  command: CustomerDomainCommand,
): Promise<CommandExecutionPlan> {
  const now = new Date().toISOString();

  switch (command.kind) {
    case 'customer.create': {
      // Güvenlik Kuralı: Yeni müşterinin sorumlusu (assignee) her zaman aktörün kendi üyeliğidir.
      const insertStmt = db
        .prepare(
          `INSERT INTO customers (
             id, agency_id, type, display_name, first_name, last_name, company_title,
             email, phone, address, assignee_membership_id, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          command.customerId,
          agencyId,
          command.type,
          command.displayName,
          command.firstName ?? null,
          command.lastName ?? null,
          command.companyTitle ?? null,
          command.email ?? null,
          command.phone ?? null,
          command.address ?? null,
          actorMembershipId,
          now,
          now,
        );

      return {
        action: 'customer.create',
        targetType: 'customers',
        targetId: command.customerId,
        targetCustomerId: command.customerId,
        isCreate: true,
        auditCode: 'customer.created',
        auditMetadata: {
          customerId: command.customerId,
          customerType: command.type,
          changedFieldCount: command.type === 'INDIVIDUAL' ? 4 : 3,
        },
        businessStatements: [
          {
            statement: insertStmt,
            expectedChanges: 1,
            failureCode: 'CUSTOMER_INSERT_FAILED',
          },
        ],
      };
    }

    case 'customer.update': {
      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.displayName !== undefined)
        updates.push({ col: 'display_name', val: command.displayName });
      if (command.firstName !== undefined)
        updates.push({ col: 'first_name', val: command.firstName });
      if (command.lastName !== undefined) updates.push({ col: 'last_name', val: command.lastName });
      if (command.companyTitle !== undefined)
        updates.push({ col: 'company_title', val: command.companyTitle });
      if (command.email !== undefined) updates.push({ col: 'email', val: command.email });
      if (command.phone !== undefined) updates.push({ col: 'phone', val: command.phone });
      if (command.address !== undefined) updates.push({ col: 'address', val: command.address });

      const nextVersion = command.expectedVersion + 1;
      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([nextVersion, now, command.customerId, agencyId, command.expectedVersion]);

      const updateStmt = db
        .prepare(
          `UPDATE customers
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action: 'customer.update',
        targetType: 'customers',
        targetId: command.customerId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'customer.updated',
        auditMetadata: {
          customerId: command.customerId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
          changedFieldCount: command.changedFields.length,
        },
        businessStatements: [
          {
            statement: updateStmt,
            expectedChanges: 1,
            failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
          },
        ],
      };
    }

    case 'company_contact.create': {
      const parentCustomer = await db
        .prepare('SELECT id, agency_id, type FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string; agency_id: string; type: string }>();

      if (!parentCustomer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND');
      }
      if (parentCustomer.type !== 'COMPANY') {
        throw new DomainConstraintViolationError('INDIVIDUAL_CONTACT_PROHIBITED');
      }

      const statements = [];
      const isPrimaryInt = command.isPrimary ? 1 : 0;

      if (isPrimaryInt === 1) {
        const resetStmt = db
          .prepare(
            `UPDATE company_contacts
             SET is_primary = 0, updated_at = ?
             WHERE customer_id = ? AND agency_id = ? AND is_primary = 1 AND status = 'ACTIVE'`,
          )
          .bind(now, command.customerId, agencyId);
        statements.push({
          statement: resetStmt,
          expectedChanges: -1, // 0 veya 1 satır
        });
      }

      const insertStmt = db
        .prepare(
          `INSERT INTO company_contacts (
             id, agency_id, customer_id, first_name, last_name, role,
             email, phone, is_primary, status, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        )
        .bind(
          command.contactId,
          agencyId,
          command.customerId,
          command.firstName,
          command.lastName,
          command.role ?? null,
          command.email ?? null,
          command.phone ?? null,
          isPrimaryInt,
          now,
          now,
        );

      statements.push({
        statement: insertStmt,
        expectedChanges: 1,
        failureCode: 'CONTACT_INSERT_FAILED',
      });

      return {
        action: 'company_contact.create',
        targetType: 'company_contacts',
        targetId: command.contactId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'company_contact.created',
        auditMetadata: {
          customerId: command.customerId,
          contactId: command.contactId,
          changedFieldCount: 5,
        },
        businessStatements: statements,
      };
    }

    case 'company_contact.update': {
      const parentCustomer = await db
        .prepare('SELECT id, agency_id FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string; agency_id: string }>();

      if (!parentCustomer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND');
      }

      const existingContact = await db
        .prepare(
          'SELECT id, status, version FROM company_contacts WHERE id = ? AND customer_id = ? AND agency_id = ?',
        )
        .bind(command.contactId, command.customerId, agencyId)
        .first<{ id: string; status: string; version: number }>();

      if (!existingContact) {
        throw new DomainConstraintViolationError('CONTACT_NOT_FOUND');
      }

      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.firstName !== undefined)
        updates.push({ col: 'first_name', val: command.firstName });
      if (command.lastName !== undefined) updates.push({ col: 'last_name', val: command.lastName });
      if (command.role !== undefined) updates.push({ col: 'role', val: command.role });
      if (command.email !== undefined) updates.push({ col: 'email', val: command.email });
      if (command.phone !== undefined) updates.push({ col: 'phone', val: command.phone });

      const nextVersion = command.expectedVersion + 1;
      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([
          nextVersion,
          now,
          command.contactId,
          command.customerId,
          agencyId,
          command.expectedVersion,
        ]);

      const updateStmt = db
        .prepare(
          `UPDATE company_contacts
           SET ${setClauses.join(', ')}
           WHERE id = ? AND customer_id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action: 'company_contact.update',
        targetType: 'company_contacts',
        targetId: command.contactId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'company_contact.updated',
        auditMetadata: {
          customerId: command.customerId,
          contactId: command.contactId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
          changedFieldCount: command.changedFields.length,
        },
        businessStatements: [
          {
            statement: updateStmt,
            expectedChanges: 1,
            failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
          },
        ],
      };
    }

    case 'company_contact.set_primary': {
      const parentCustomer = await db
        .prepare('SELECT id, agency_id FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string; agency_id: string }>();

      if (!parentCustomer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND');
      }

      const existingContact = await db
        .prepare(
          'SELECT id, status, version FROM company_contacts WHERE id = ? AND customer_id = ? AND agency_id = ?',
        )
        .bind(command.contactId, command.customerId, agencyId)
        .first<{ id: string; status: string; version: number }>();

      if (!existingContact) {
        throw new DomainConstraintViolationError('CONTACT_NOT_FOUND');
      }
      if (existingContact.status !== 'ACTIVE') {
        throw new DomainConstraintViolationError('INACTIVE_CONTACT_CANNOT_BE_PRIMARY');
      }

      const nextVersion = command.expectedVersion + 1;
      const resetStmt = db
        .prepare(
          `UPDATE company_contacts
           SET is_primary = 0, updated_at = ?
           WHERE customer_id = ? AND agency_id = ? AND is_primary = 1 AND status = 'ACTIVE' AND id != ?`,
        )
        .bind(now, command.customerId, agencyId, command.contactId);

      const setStmt = db
        .prepare(
          `UPDATE company_contacts
           SET is_primary = 1, version = ?, updated_at = ?
           WHERE id = ? AND customer_id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(
          nextVersion,
          now,
          command.contactId,
          command.customerId,
          agencyId,
          command.expectedVersion,
        );

      return {
        action: 'company_contact.set_primary',
        targetType: 'company_contacts',
        targetId: command.contactId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'company_contact.primary_changed',
        auditMetadata: {
          customerId: command.customerId,
          contactId: command.contactId,
          targetVersion: nextVersion,
          changedFields: ['isPrimary'],
        },
        businessStatements: [
          {
            statement: resetStmt,
            expectedChanges: -1,
          },
          {
            statement: setStmt,
            expectedChanges: 1,
            failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
          },
        ],
      };
    }

    case 'company_contact.deactivate': {
      const parentCustomer = await db
        .prepare('SELECT id, agency_id FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string; agency_id: string }>();

      if (!parentCustomer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND');
      }

      const existingContact = await db
        .prepare(
          'SELECT id, status, version FROM company_contacts WHERE id = ? AND customer_id = ? AND agency_id = ?',
        )
        .bind(command.contactId, command.customerId, agencyId)
        .first<{ id: string; status: string; version: number }>();

      if (!existingContact) {
        throw new DomainConstraintViolationError('CONTACT_NOT_FOUND');
      }
      if (existingContact.status === 'INACTIVE') {
        throw new DomainConstraintViolationError('CONTACT_ALREADY_INACTIVE');
      }

      const nextVersion = command.expectedVersion + 1;
      const deactivateStmt = db
        .prepare(
          `UPDATE company_contacts
           SET status = 'INACTIVE', is_primary = 0, version = ?, updated_at = ?
           WHERE id = ? AND customer_id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(
          nextVersion,
          now,
          command.contactId,
          command.customerId,
          agencyId,
          command.expectedVersion,
        );

      return {
        action: 'company_contact.deactivate',
        targetType: 'company_contacts',
        targetId: command.contactId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'company_contact.deactivated',
        auditMetadata: {
          customerId: command.customerId,
          contactId: command.contactId,
          targetVersion: nextVersion,
          changedFields: ['status', 'isPrimary'],
        },
        businessStatements: [
          {
            statement: deactivateStmt,
            expectedChanges: 1,
            failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
          },
        ],
      };
    }

    default: {
      const exhaustiveCheck: never = command;
      throw new Error(`UNSUPPORTED_DOMAIN_COMMAND: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

/**
 * Normal session domain komutlarını atomik D1 batch olarak yürütür.
 */
export async function executeCustomerDomainCommand<TResult>(
  input: ExecuteCustomerDomainCommandInput<TResult>,
): Promise<CustomerDomainCommandResult<TResult>> {
  const {
    db,
    agencyId,
    actorUserId,
    actorMembershipId,
    expectedPermissionVersion,
    correlationId,
    idempotencyKey,
    command,
  } = input;

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  const trimmedIdempotencyKey = idempotencyKey.trim();

  // 1. Komut Planını Oluştur (Server-Owned Mapping)
  const plan = await planCommand(db, agencyId, actorMembershipId, command);

  // 2. Kanonik Payload Parmak İzi
  const payloadFingerprint = await computePayloadHash(input.payload);

  // 3. Deterministik Idempotency Kontrolü
  const existingReceipt = await db
    .prepare(
      `SELECT action, payload_fingerprint, status, response_status, response_body
       FROM operation_receipts
       WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(agencyId, actorUserId, actorMembershipId, trimmedIdempotencyKey)
    .first<{
      action: string;
      payload_fingerprint: string;
      status: string;
      response_status: number;
      response_body: string;
    }>();

  if (existingReceipt) {
    if (existingReceipt.action !== plan.action) {
      throw new IdempotencyConflictError('IDEMPOTENCY_ACTION_MISMATCH');
    }
    if (existingReceipt.payload_fingerprint !== payloadFingerprint) {
      throw new IdempotencyConflictError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    }
    if (existingReceipt.status === 'COMPLETED') {
      let parsedBody: TResult;
      try {
        parsedBody = JSON.parse(existingReceipt.response_body) as TResult;
      } catch {
        parsedBody = existingReceipt.response_body as unknown as TResult;
      }
      return {
        executed: false,
        replayed: true,
        status: existingReceipt.response_status,
        body: parsedBody,
      };
    }
    throw new IdempotencyConflictError('IDEMPOTENCY_IN_PROGRESS');
  }

  // 4. Canlı DB Yaşam Döngüsü ve Üyelik Doğrulaması (Pre-flight)
  const userRow = await db
    .prepare('SELECT id, status FROM users WHERE id = ?')
    .bind(actorUserId)
    .first<{ id: unknown; status: unknown }>();
  if (!userRow || userRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_USER_REQUIRED');
  }

  const agencyRow = await db
    .prepare('SELECT id, status FROM agencies WHERE id = ?')
    .bind(agencyId)
    .first<{ id: unknown; status: unknown }>();
  if (!agencyRow || agencyRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_AGENCY_REQUIRED');
  }

  const membershipRow = await db
    .prepare(
      'SELECT id, type, status, permission_version FROM agency_memberships WHERE id = ? AND agency_id = ? AND user_id = ?',
    )
    .bind(actorMembershipId, agencyId, actorUserId)
    .first<{ id: unknown; type: unknown; status: unknown; permission_version: number }>();
  if (
    !membershipRow ||
    (membershipRow.type !== 'OWNER' && membershipRow.type !== 'MEMBER') ||
    membershipRow.status !== 'ACTIVE'
  ) {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }

  const batchStatements: D1PreparedStatement[] = [];

  // -------------------------------------------------------------------------
  // A. ATOMİK NİHAİ YETKİ VE KAPSAM DOĞRULAMASI (CANLI PARENT & SCOPE ASSERTION)
  // -------------------------------------------------------------------------
  // Batch'in ilk ifadesi olarak atomik d1_cas_assertions kaydı atılır.
  // 1. OWNER: Kabul edilen implicit NORMAL AGENCY semantiği geçerlidir.
  // 2. MEMBER customer.create: customer.create tam olarak 'UNSCOPED' + dependency
  //    customer.read tam olarak 'ASSIGNED' veya 'AGENCY' olmalı; önerilen assignee
  //    aktörün kendi üyeliğidir ve read ASSIGNED ise aktöre tam eşleşir.
  // 3. MEMBER customer.update ve tüm company_contact.*:
  //    customer.update ve dependency customer.read izinleri mevcut olmalı,
  //    ikisi yalnız 'ASSIGNED' veya 'AGENCY' olmalı,
  //    read kapsamı update kapsamından dar olmamalı (AGENCY update için read de AGENCY olmalı),
  //    ve her ASSIGNED yükümlülüğü CANLI customer'ın assignee_membership_id'sine göre
  //    aktörün üyeliğiyle eşleşmeli (concurrent re-assign yarışında fail-closed).
  // 4. permission_version snapshot'ı tam eşleşmelidir (stale snapshot rollback).
  const isCreateInt = plan.isCreate ? 1 : 0;
  const finalAuthorityRecheckStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       SELECT ?, 1,
         CASE WHEN EXISTS (
           SELECT 1
           FROM agency_memberships m
           INNER JOIN users u ON u.id = m.user_id
           INNER JOIN agencies a ON a.id = m.agency_id
           WHERE m.id = ?
             AND m.agency_id = ?
             AND m.user_id = ?
             AND m.status = 'ACTIVE'
             AND u.status = 'ACTIVE'
             AND a.status = 'ACTIVE'
             AND m.permission_version = ?
             AND (
               (m.type = 'OWNER')
               OR (
                 m.type = 'MEMBER'
                 AND (
                   -- CASE 1: customer.create
                   (
                     ? = 1
                     AND EXISTS (
                       SELECT 1 FROM membership_permissions p_create
                       WHERE p_create.membership_id = m.id
                         AND p_create.permission_code = 'customer.create'
                         AND p_create.scope = 'UNSCOPED'
                     )
                     AND EXISTS (
                       SELECT 1 FROM membership_permissions p_read
                       WHERE p_read.membership_id = m.id
                         AND p_read.permission_code = 'customer.read'
                         AND p_read.scope IN ('ASSIGNED', 'AGENCY')
                     )
                   )
                   OR
                   -- CASE 2: customer.update ve company_contact.*
                   (
                     ? = 0
                     AND EXISTS (
                       SELECT 1
                       FROM customers c
                       INNER JOIN membership_permissions p_upd
                         ON p_upd.membership_id = m.id
                         AND p_upd.permission_code = 'customer.update'
                         AND p_upd.scope IN ('ASSIGNED', 'AGENCY')
                       INNER JOIN membership_permissions p_read
                         ON p_read.membership_id = m.id
                         AND p_read.permission_code = 'customer.read'
                         AND p_read.scope IN ('ASSIGNED', 'AGENCY')
                       WHERE c.id = ?
                         AND c.agency_id = ?
                         AND (p_read.scope = 'AGENCY' OR p_upd.scope = 'ASSIGNED')
                         AND (p_upd.scope = 'AGENCY' OR c.assignee_membership_id = m.id)
                         AND (p_read.scope = 'AGENCY' OR c.assignee_membership_id = m.id)
                     )
                   )
                 )
               )
             )
         ) THEN 1 ELSE 0 END,
         'FINAL_AUTHORITY_RECHECK_FAILED'`,
    )
    .bind(
      crypto.randomUUID(),
      actorMembershipId,
      agencyId,
      actorUserId,
      expectedPermissionVersion,
      isCreateInt,
      isCreateInt,
      plan.targetCustomerId,
      agencyId,
    );
  batchStatements.push(finalAuthorityRecheckStmt);

  // B. Sonuç Nesnesi Üretimi
  const mutationResult = input.resultProducer();
  const serializedResponseBody = JSON.stringify(mutationResult.body);

  // C. Deterministik Makbuz Yazımı
  const receiptId = crypto.randomUUID();
  const receiptStmt = db
    .prepare(
      `INSERT INTO operation_receipts (
         id, agency_id, actor_user_id, actor_membership_id, action,
         idempotency_key, payload_fingerprint, status, response_status, response_body
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)`,
    )
    .bind(
      receiptId,
      agencyId,
      actorUserId,
      actorMembershipId,
      plan.action,
      trimmedIdempotencyKey,
      payloadFingerprint,
      mutationResult.status,
      serializedResponseBody,
    );
  batchStatements.push(receiptStmt);

  // D. İş Etkisi (Business Statements) + Otomatik CAS Assertion
  for (const op of plan.businessStatements) {
    batchStatements.push(op.statement);

    if (op.expectedChanges !== -1) {
      const assertStmt = db
        .prepare(
          `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
           SELECT ?, ?, changes(), ?`,
        )
        .bind(
          crypto.randomUUID(),
          op.expectedChanges,
          op.failureCode || 'OPTIMISTIC_CONCURRENCY_CONFLICT',
        );
      batchStatements.push(assertStmt);
    }
  }

  // E. Başarı Denetim Kaydı (Safe Audit Event)
  const auditId = crypto.randomUUID();
  const safeAudit = buildSafeAuditRecord({
    id: auditId,
    agencyId,
    actorUserId,
    actorMembershipId,
    action: plan.action,
    targetType: plan.targetType,
    targetId: plan.targetId,
    correlationId,
    idempotencyKey: trimmedIdempotencyKey,
    outcome: 'SUCCESS',
    metadata: plan.auditMetadata,
  });

  const auditStmt = db
    .prepare(
      `INSERT INTO audit_events (
         id, agency_id, actor_user_id, actor_membership_id, action,
         target_type, target_id, correlation_id, idempotency_key, outcome, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      safeAudit.id,
      safeAudit.agencyId,
      safeAudit.actorUserId,
      safeAudit.actorMembershipId,
      safeAudit.action,
      safeAudit.targetType,
      safeAudit.targetId,
      safeAudit.correlationId,
      safeAudit.idempotencyKey,
      safeAudit.outcome,
      safeAudit.metadataJson,
      safeAudit.createdAt,
    );
  batchStatements.push(auditStmt);

  // 5. Tek ve Atomik D1 Batch Yürütmesi
  try {
    await db.batch(batchStatements);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (
      errorMsg.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
      errorMsg.includes('CAS_ASSERTION_FAILED')
    ) {
      throw new OptimisticConcurrencyError(0);
    }
    if (errorMsg.includes('FINAL_AUTHORITY_RECHECK_FAILED')) {
      throw new DomainConstraintViolationError(
        'FINAL_AUTHORITY_RECHECK_FAILED',
        'FINAL_AUTHORITY_RECHECK_FAILED: Yetkilendirme recheck başarısız.',
      );
    }
    if (errorMsg.includes('MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED')) {
      throw new DomainConstraintViolationError(
        'MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED',
        'Bir müşterinin aynı anda yalnızca bir adet aktif birincil yetkilisi olabilir.',
      );
    }
    if (errorMsg.includes('INDIVIDUAL_CONTACT_PROHIBITED')) {
      throw new DomainConstraintViolationError(
        'INDIVIDUAL_CONTACT_PROHIBITED',
        'Bireysel müşterilere şirket yetkilisi eklenemez.',
      );
    }
    if (errorMsg.includes('CUSTOMER_NOT_FOUND')) {
      throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND', 'Müşteri kaydı bulunamadı.');
    }
    if (errorMsg.includes('CONTACT_NOT_FOUND')) {
      throw new DomainConstraintViolationError('CONTACT_NOT_FOUND', 'Şirket yetkilisi bulunamadı.');
    }

    if (
      errorMsg.includes('IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN') ||
      errorMsg.includes('operation_receipts_idem_uq') ||
      errorMsg.includes('UNIQUE constraint failed: operation_receipts')
    ) {
      const concurrentReceipt = await db
        .prepare(
          `SELECT action, payload_fingerprint, status, response_status, response_body
           FROM operation_receipts
           WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ?
             AND idempotency_key = ?
           LIMIT 1`,
        )
        .bind(agencyId, actorUserId, actorMembershipId, trimmedIdempotencyKey)
        .first<{
          action: string;
          payload_fingerprint: string;
          status: string;
          response_status: number;
          response_body: string;
        }>();

      if (
        concurrentReceipt?.action === plan.action &&
        concurrentReceipt.payload_fingerprint === payloadFingerprint &&
        concurrentReceipt.status === 'COMPLETED'
      ) {
        let parsedBody: TResult;
        try {
          parsedBody = JSON.parse(concurrentReceipt.response_body) as TResult;
        } catch {
          parsedBody = concurrentReceipt.response_body as unknown as TResult;
        }
        return {
          executed: false,
          replayed: true,
          status: concurrentReceipt.response_status,
          body: parsedBody,
        };
      }

      throw new IdempotencyConflictError('IDEMPOTENCY_CONCURRENT_INSERT_CONFLICT');
    }

    throw err;
  }

  return {
    executed: true,
    replayed: false,
    status: mutationResult.status,
    body: mutationResult.body,
  };
}

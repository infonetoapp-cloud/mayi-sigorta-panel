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

import { z } from 'zod';
import type { EncryptedIdentityEnvelope } from '../../security/identity-crypto';
import { normalizePlate, type VehicleFields } from '../../../shared/vehicles';
import { referenceSearchKey, validBirthDate } from '../../../shared/customer-profile';
import { computePayloadHash } from '../canonical';
import { IdempotencyConflictError } from '../idempotency';
import { buildSafeAuditRecord } from '../audit';
import { OptimisticConcurrencyError } from '../../db/optimistic';
import { evaluateAuthorization } from '../../auth/authorization';
import type { CompanyContactDto, CustomerDto } from '../../../shared/types';

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
      readonly kind: 'customer.vehicle.save';
      readonly customerId: string;
      readonly expectedVersion: number;
      readonly vehicleId: string;
      readonly expectedVehicleVersion: number | null;
      readonly details: VehicleFields;
      readonly status: 'ACTIVE' | 'INACTIVE';
    }
  | {
      readonly kind: 'customer.create';
      readonly identity?: EncryptedIdentityEnvelope;
      readonly insurerNumber?: { readonly insurerId: string; readonly customerNumber: string };
      readonly birthDate?: string | null;
      readonly referenceMembershipId?: string | null;
      readonly referenceName?: string | null;
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
      readonly birthDate?: string | null;
      readonly referenceMembershipId?: string | null;
      readonly referenceName?: string | null;
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
    }
  | {
      readonly kind: 'customer.identity.update';
      readonly customerId: string;
      readonly expectedVersion: number;
      readonly identityType: 'TCKN' | 'VKN' | null;
      readonly identityCiphertext: string | null;
      readonly identityIv: string | null;
      readonly identityTag: string | null;
      readonly identitySearchHash: string | null;
      readonly identityKeyVersion: number | null;
    }
  | {
      readonly kind: 'customer.assign';
      readonly customerId: string;
      readonly expectedVersion: number;
      readonly targetAssigneeMembershipId: string;
    }
  | {
      readonly kind: 'customer.archive';
      readonly customerId: string;
      readonly expectedVersion: number;
      readonly reasonCode: string;
    }
  | {
      readonly kind: 'customer.external_reference.create';
      readonly customerId: string;
      readonly referenceId: string;
      readonly expectedVersion: number;
      readonly sourceNamespace: string;
      readonly externalKey: string;
      readonly insurerId?: string;
      readonly replaceExisting?: boolean;
    };

export interface ExecuteCustomerDomainCommandInput<TResult = unknown> {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
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

type CustomerDomainCommandKind = CustomerDomainCommand['kind'];

interface IdempotencyLookup<TResult> {
  readonly action: string;
  readonly payloadFingerprint: string;
  readonly trimmedIdempotencyKey: string;
  readonly replay: CustomerDomainCommandResult<TResult> | null;
  readonly replayCustomerTargetId?: string;
  readonly replayCompanyContactTargetId?: string;
}

function actionForCommandKind(kind: CustomerDomainCommandKind): string {
  switch (kind) {
    case 'customer.vehicle.save':
      return 'customer.update';
    case 'customer.create':
    case 'customer.update':
    case 'company_contact.create':
    case 'company_contact.update':
    case 'company_contact.set_primary':
    case 'company_contact.deactivate':
    case 'customer.identity.update':
    case 'customer.assign':
    case 'customer.archive':
    case 'customer.external_reference.create':
      return kind;
    default: {
      const exhaustiveCheck: never = kind;
      throw new Error(`UNSUPPORTED_DOMAIN_COMMAND_KIND: ${String(exhaustiveCheck)}`);
    }
  }
}

const CUSTOMER_CREATE_RECEIPT_KEYS = [
  'id',
  'agencyId',
  'type',
  'displayName',
  'firstName',
  'lastName',
  'companyTitle',
  'email',
  'phone',
  'address',
  'assigneeMembershipId',
  'archivedAt',
  'archivedByMembershipId',
  'archiveReasonCode',
  'hasIdentity',
  'identityMasked',
  'version',
  'createdAt',
  'updatedAt',
] as const;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCanonicalReceiptTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isCanonicalTrimmedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0)
  );
}

function isNullableCanonicalTrimmedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string | null {
  return value === null || isCanonicalTrimmedString(value, maxLength, allowEmpty);
}

const CREATE_RECEIPT_EMAIL_SCHEMA = z.string().email();

function parseCustomerCreateReceiptDto(
  responseBody: string,
  responseStatus: number,
  agencyId: string,
  actorMembershipId: string,
  hasIdentity = false,
): CustomerDto {
  if (responseStatus !== 201 || typeof responseBody !== 'string') {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  const dto = parsed as Record<string, unknown>;
  const keys = Object.keys(dto).sort();
  const profileKeys = ['birthDate', 'referenceMembershipId', 'referenceName'];
  const expectedKeys = [
    ...CUSTOMER_CREATE_RECEIPT_KEYS,
    ...profileKeys.filter((key) => Object.hasOwn(dto, key)),
  ].sort();
  if (
    (dto.birthDate !== undefined &&
      dto.birthDate !== null &&
      (typeof dto.birthDate !== 'string' ||
        !validBirthDate(dto.birthDate) ||
        dto.type !== 'INDIVIDUAL')) ||
    (dto.referenceMembershipId !== undefined &&
      !isNullableCanonicalTrimmedString(dto.referenceMembershipId, 128)) ||
    (dto.referenceName !== undefined &&
      !isNullableCanonicalTrimmedString(dto.referenceName, 120)) ||
    (dto.referenceMembershipId != null && !dto.referenceName) ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof dto.id !== 'string' ||
    dto.id.trim() === '' ||
    dto.id !== dto.id.trim() ||
    dto.agencyId !== agencyId ||
    (dto.type !== 'INDIVIDUAL' && dto.type !== 'COMPANY') ||
    !isCanonicalTrimmedString(dto.displayName, 255) ||
    !isNullableCanonicalTrimmedString(dto.firstName, 100) ||
    !isNullableCanonicalTrimmedString(dto.lastName, 100) ||
    !isNullableCanonicalTrimmedString(dto.companyTitle, 255) ||
    !isNullableString(dto.email) ||
    (typeof dto.email === 'string' &&
      (dto.email !== dto.email.trim() ||
        !CREATE_RECEIPT_EMAIL_SCHEMA.safeParse(dto.email).success)) ||
    !isNullableCanonicalTrimmedString(dto.phone, 50) ||
    !isNullableCanonicalTrimmedString(dto.address, 1000, true) ||
    typeof dto.assigneeMembershipId !== 'string' ||
    dto.assigneeMembershipId.trim() === '' ||
    dto.assigneeMembershipId !== dto.assigneeMembershipId.trim() ||
    dto.archivedAt !== null ||
    dto.archivedByMembershipId !== null ||
    dto.archiveReasonCode !== null ||
    dto.hasIdentity !== hasIdentity ||
    dto.identityMasked !== (hasIdentity ? '***' : null) ||
    dto.version !== 1 ||
    !isCanonicalReceiptTimestamp(dto.createdAt) ||
    !isCanonicalReceiptTimestamp(dto.updatedAt) ||
    dto.createdAt !== dto.updatedAt ||
    dto.assigneeMembershipId !== actorMembershipId
  ) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  if (
    (dto.type === 'COMPANY' &&
      (dto.companyTitle === null || dto.firstName !== null || dto.lastName !== null)) ||
    (dto.type === 'INDIVIDUAL' &&
      (dto.companyTitle !== null || dto.firstName === null || dto.lastName === null))
  ) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  return dto as unknown as CustomerDto;
}

const COMPANY_CONTACT_CREATE_RECEIPT_KEYS = [
  'id',
  'agencyId',
  'customerId',
  'firstName',
  'lastName',
  'role',
  'email',
  'phone',
  'isPrimary',
  'status',
  'version',
  'createdAt',
  'updatedAt',
] as const;

function parseCompanyContactCreateReceiptDto(
  responseBody: string,
  responseStatus: number,
  agencyId: string,
  customerId: string,
): CompanyContactDto {
  if (responseStatus !== 201 || typeof responseBody !== 'string') {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  const dto = parsed as Record<string, unknown>;
  const keys = Object.keys(dto).sort();
  const expectedKeys = [...COMPANY_CONTACT_CREATE_RECEIPT_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof dto.id !== 'string' ||
    dto.id.trim() === '' ||
    dto.id !== dto.id.trim() ||
    dto.agencyId !== agencyId ||
    dto.customerId !== customerId ||
    typeof dto.firstName !== 'string' ||
    dto.firstName.trim() === '' ||
    dto.firstName !== dto.firstName.trim() ||
    dto.firstName.length > 100 ||
    typeof dto.lastName !== 'string' ||
    dto.lastName.trim() === '' ||
    dto.lastName !== dto.lastName.trim() ||
    dto.lastName.length > 100 ||
    !isNullableString(dto.role) ||
    (typeof dto.role === 'string' && (dto.role !== dto.role.trim() || dto.role.length > 100)) ||
    !isNullableString(dto.email) ||
    (typeof dto.email === 'string' &&
      (dto.email !== dto.email.trim() ||
        !CREATE_RECEIPT_EMAIL_SCHEMA.safeParse(dto.email).success)) ||
    !isNullableString(dto.phone) ||
    (typeof dto.phone === 'string' &&
      (dto.phone === '' || dto.phone !== dto.phone.trim() || dto.phone.length > 50)) ||
    typeof dto.isPrimary !== 'boolean' ||
    dto.status !== 'ACTIVE' ||
    dto.version !== 1 ||
    !isCanonicalReceiptTimestamp(dto.createdAt) ||
    !isCanonicalReceiptTimestamp(dto.updatedAt) ||
    dto.createdAt !== dto.updatedAt
  ) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  return dto as unknown as CompanyContactDto;
}

async function loadCustomerCreateAuditTarget(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
}): Promise<string> {
  const result = await input.db
    .prepare(
      `SELECT action, target_type, target_id, outcome
       FROM audit_events
       WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ? AND idempotency_key = ?`,
    )
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey)
    .all<{ action: unknown; target_type: unknown; target_id: unknown; outcome: unknown }>();
  const rows = result.results;
  if (
    !result.success ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.action !== 'customer.create' ||
    rows[0]?.target_type !== 'customers' ||
    rows[0]?.outcome !== 'SUCCESS' ||
    typeof rows[0]?.target_id !== 'string' ||
    rows[0].target_id.trim() === '' ||
    rows[0].target_id !== rows[0].target_id.trim()
  ) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  return rows[0].target_id;
}

async function loadCompanyContactCreateAuditTarget(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
}): Promise<string> {
  try {
    const result = await input.db
      .prepare(
        `SELECT action, target_type, target_id, outcome
         FROM audit_events
         WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ? AND idempotency_key = ?`,
      )
      .bind(input.agencyId, input.actorUserId, input.actorMembershipId, input.idempotencyKey)
      .all<{ action: unknown; target_type: unknown; target_id: unknown; outcome: unknown }>();
    const rows = result.results;
    if (!result.success || !Array.isArray(rows) || rows.length !== 1) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    const row = rows[0];
    if (
      !row ||
      row.action !== 'company_contact.create' ||
      row.target_type !== 'company_contacts' ||
      row.outcome !== 'SUCCESS' ||
      typeof row.target_id !== 'string' ||
      row.target_id.trim() === '' ||
      row.target_id !== row.target_id.trim()
    ) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    return row.target_id;
  } catch {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
}

async function assertLiveCustomerReplayScope(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly permissionVersion: number;
  readonly customerId: string;
  readonly scope: string | undefined;
  readonly contactId?: string;
}): Promise<void> {
  if (input.scope !== 'ASSIGNED' && input.scope !== 'AGENCY') {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }

  let row: { id: unknown } | null;
  try {
    row = await input.db
      .prepare(
        `SELECT c.id
         FROM customers c
         JOIN agency_memberships m
           ON m.id = ? AND m.agency_id = c.agency_id AND m.user_id = ?
         JOIN users u ON u.id = m.user_id
         JOIN agencies a ON a.id = m.agency_id
         JOIN auth_identities ai ON ai.id = ? AND ai.user_id = u.id
         WHERE c.id = ? AND c.agency_id = ?
           AND m.status = 'ACTIVE'
           AND m.type IN ('OWNER', 'MEMBER')
           AND m.permission_version = ?
           AND u.status = 'ACTIVE'
           AND a.status = 'ACTIVE'
           AND ai.status = 'ACTIVE'
           AND (? = 'AGENCY' OR (? = 'ASSIGNED' AND c.assignee_membership_id = m.id))
           AND (
             ? IS NULL
             OR EXISTS (
               SELECT 1 FROM company_contacts cc
               WHERE cc.id = ? AND cc.customer_id = c.id AND cc.agency_id = c.agency_id
             )
           )
         LIMIT 1`,
      )
      .bind(
        input.actorMembershipId,
        input.actorUserId,
        input.actorIdentityId,
        input.customerId,
        input.agencyId,
        input.permissionVersion,
        input.scope,
        input.scope,
        input.contactId ?? null,
        input.contactId ?? null,
      )
      .first<{ id: unknown }>();
  } catch {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  if (!row || row.id !== input.customerId) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
}

async function lookupIdempotency<TResult>(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly command: CustomerDomainCommand;
}): Promise<IdempotencyLookup<TResult>> {
  if (
    !input.idempotencyKey ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim().length === 0
  ) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  const trimmedIdempotencyKey = input.idempotencyKey.trim();
  const action = actionForCommandKind(input.command.kind);
  const command = input.command;
  const target =
    command.kind === 'customer.create'
      ? null
      : command.kind === 'company_contact.create' ||
          command.kind === 'company_contact.update' ||
          command.kind === 'company_contact.set_primary' ||
          command.kind === 'company_contact.deactivate'
        ? {
            customerId: command.customerId,
            ...(command.kind === 'company_contact.create' ? {} : { contactId: command.contactId }),
          }
        : { customerId: command.customerId };
  const expectedVersion = 'expectedVersion' in command ? command.expectedVersion : null;
  const payloadFingerprint = await computePayloadHash({
    target,
    expectedVersion,
    payload: input.payload,
  });
  const existingReceipt = await input.db
    .prepare(
      `SELECT action, payload_fingerprint, status, response_status, response_body
       FROM operation_receipts
       WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(input.agencyId, input.actorUserId, input.actorMembershipId, trimmedIdempotencyKey)
    .first<{
      action: string;
      payload_fingerprint: string;
      status: string;
      response_status: number;
      response_body: string;
    }>();

  if (!existingReceipt) {
    return { action, payloadFingerprint, trimmedIdempotencyKey, replay: null };
  }
  if (existingReceipt.action !== action) {
    throw new IdempotencyConflictError('IDEMPOTENCY_ACTION_MISMATCH');
  }
  if (existingReceipt.payload_fingerprint !== payloadFingerprint) {
    throw new IdempotencyConflictError('IDEMPOTENCY_PAYLOAD_MISMATCH');
  }
  if (existingReceipt.status !== 'COMPLETED') {
    throw new IdempotencyConflictError('IDEMPOTENCY_IN_PROGRESS');
  }

  let parsedBody: TResult;
  let replayCustomerTargetId: string | undefined;
  let replayCompanyContactTargetId: string | undefined;
  if (command.kind === 'customer.create') {
    const receiptDto = parseCustomerCreateReceiptDto(
      existingReceipt.response_body,
      existingReceipt.response_status,
      input.agencyId,
      input.actorMembershipId,
      !!command.identity,
    );
    replayCustomerTargetId = await loadCustomerCreateAuditTarget({
      db: input.db,
      agencyId: input.agencyId,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      idempotencyKey: trimmedIdempotencyKey,
    });
    if (receiptDto.id !== replayCustomerTargetId) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    parsedBody = receiptDto as TResult;
  } else if (command.kind === 'company_contact.create') {
    const receiptDto = parseCompanyContactCreateReceiptDto(
      existingReceipt.response_body,
      existingReceipt.response_status,
      input.agencyId,
      command.customerId,
    );
    replayCompanyContactTargetId = await loadCompanyContactCreateAuditTarget({
      db: input.db,
      agencyId: input.agencyId,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      idempotencyKey: trimmedIdempotencyKey,
    });
    if (receiptDto.id !== replayCompanyContactTargetId) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    parsedBody = receiptDto as TResult;
  } else {
    try {
      parsedBody = JSON.parse(existingReceipt.response_body) as TResult;
    } catch {
      parsedBody = existingReceipt.response_body as unknown as TResult;
    }
  }
  return {
    action,
    payloadFingerprint,
    trimmedIdempotencyKey,
    ...(replayCustomerTargetId ? { replayCustomerTargetId } : {}),
    ...(replayCompanyContactTargetId ? { replayCompanyContactTargetId } : {}),
    replay: {
      executed: false,
      replayed: true,
      status: existingReceipt.response_status,
      body: parsedBody,
    },
  };
}

/** Replayed business results remain authoritative only while live read/mutation authority exists. */
async function assertCurrentReplayAuthority(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly command: CustomerDomainCommand;
  readonly replayCustomerTargetId?: string;
  readonly replayCompanyContactTargetId?: string;
}): Promise<void> {
  const membership = await input.db
    .prepare(
      `SELECT type, status, permission_version FROM agency_memberships
       WHERE id=? AND agency_id=? AND user_id=?`,
    )
    .bind(input.actorMembershipId, input.agencyId, input.actorUserId)
    .first<{ type: unknown; status: unknown; permission_version: unknown }>();
  const identity = await input.db
    .prepare('SELECT status FROM auth_identities WHERE id=? AND user_id=?')
    .bind(input.actorIdentityId, input.actorUserId)
    .first<{ status: unknown }>();
  if (
    !membership ||
    membership.status !== 'ACTIVE' ||
    (membership.type !== 'OWNER' && membership.type !== 'MEMBER') ||
    typeof membership.permission_version !== 'number' ||
    !Number.isSafeInteger(membership.permission_version) ||
    membership.permission_version < 1 ||
    identity?.status !== 'ACTIVE'
  ) {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  const context = {
    userId: input.actorUserId,
    identityId: input.actorIdentityId,
    assurance: 'NORMAL' as const,
    memberships: [
      {
        id: input.actorMembershipId,
        agencyId: input.agencyId,
        type: membership.type,
        status: 'ACTIVE' as const,
        permissionVersion: membership.permission_version,
      },
    ],
  };
  const command = input.command;
  if (command.kind === 'customer.create') {
    const customerId = input.replayCustomerTargetId;
    if (!customerId || customerId.trim() === '' || customerId !== customerId.trim()) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    const customer = await input.db
      .prepare(
        'SELECT id, agency_id, assignee_membership_id FROM customers WHERE id=? AND agency_id=?',
      )
      .bind(customerId, input.agencyId)
      .first<{ id: unknown; agency_id: unknown; assignee_membership_id: unknown }>();
    if (
      !customer ||
      customer.id !== customerId ||
      customer.agency_id !== input.agencyId ||
      typeof customer.assignee_membership_id !== 'string' ||
      customer.assignee_membership_id.trim() === ''
    ) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }

    const createAuthorization = await evaluateAuthorization(input.db, {
      context,
      action: 'customer.create',
      resource: { agencyId: input.agencyId, isCollection: true },
    });
    const recordAuthorization = await evaluateAuthorization(input.db, {
      context,
      action: 'customer.read',
      resource: {
        agencyId: input.agencyId,
        id: customer.id,
        assigneeMembershipId: customer.assignee_membership_id,
      },
    });
    if (command.identity) {
      const identityAuthorization = await evaluateAuthorization(input.db, {
        context,
        action: 'customer.identity.update',
        resource: {
          agencyId: input.agencyId,
          id: customer.id,
          assigneeMembershipId: customer.assignee_membership_id,
        },
      });
      if (identityAuthorization.decision !== 'ALLOW')
        throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    if (createAuthorization.decision !== 'ALLOW' || recordAuthorization.decision !== 'ALLOW') {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    await assertLiveCustomerReplayScope({
      db: input.db,
      agencyId: input.agencyId,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      actorIdentityId: input.actorIdentityId,
      permissionVersion: membership.permission_version,
      customerId,
      scope: recordAuthorization.effectiveScope,
    });
    return;
  }

  if (command.kind === 'company_contact.create') {
    const contactId = input.replayCompanyContactTargetId;
    if (!contactId || contactId.trim() === '' || contactId !== contactId.trim()) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    const target = await input.db
      .prepare(
        `SELECT c.id, c.agency_id, c.type, c.assignee_membership_id,
                cc.id AS contact_id, cc.customer_id AS contact_customer_id,
                cc.agency_id AS contact_agency_id
         FROM customers c
         INNER JOIN company_contacts cc
           ON cc.id = ? AND cc.customer_id = c.id AND cc.agency_id = c.agency_id
         WHERE c.id = ? AND c.agency_id = ?
         LIMIT 1`,
      )
      .bind(contactId, command.customerId, input.agencyId)
      .first<{
        id: unknown;
        agency_id: unknown;
        type: unknown;
        assignee_membership_id: unknown;
        contact_id: unknown;
        contact_customer_id: unknown;
        contact_agency_id: unknown;
      }>();
    if (
      !target ||
      target.id !== command.customerId ||
      target.agency_id !== input.agencyId ||
      target.type !== 'COMPANY' ||
      typeof target.assignee_membership_id !== 'string' ||
      target.assignee_membership_id.trim() === '' ||
      target.assignee_membership_id !== target.assignee_membership_id.trim() ||
      target.contact_id !== contactId ||
      target.contact_customer_id !== command.customerId ||
      target.contact_agency_id !== input.agencyId
    ) {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }

    const createAuthorization = await evaluateAuthorization(input.db, {
      context,
      action: 'company_contact.create',
      resource: {
        agencyId: input.agencyId,
        customerId: command.customerId,
        parentAssigneeMembershipId: target.assignee_membership_id,
      },
    });
    const readAuthorization = await evaluateAuthorization(input.db, {
      context,
      action: 'customer.read',
      resource: {
        agencyId: input.agencyId,
        id: command.customerId,
        assigneeMembershipId: target.assignee_membership_id,
      },
    });
    if (createAuthorization.decision !== 'ALLOW' || readAuthorization.decision !== 'ALLOW') {
      throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
    }
    await assertLiveCustomerReplayScope({
      db: input.db,
      agencyId: input.agencyId,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      actorIdentityId: input.actorIdentityId,
      permissionVersion: membership.permission_version,
      customerId: command.customerId,
      contactId,
      scope: createAuthorization.effectiveScope,
    });
    await assertLiveCustomerReplayScope({
      db: input.db,
      agencyId: input.agencyId,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      actorIdentityId: input.actorIdentityId,
      permissionVersion: membership.permission_version,
      customerId: command.customerId,
      contactId,
      scope: readAuthorization.effectiveScope,
    });
    return;
  }

  const customerId = command.customerId;
  const customer = await input.db
    .prepare(
      'SELECT id, agency_id, assignee_membership_id FROM customers WHERE id=? AND agency_id=?',
    )
    .bind(customerId, input.agencyId)
    .first<{ id: string; agency_id: string; assignee_membership_id: string | null }>();
  if (!customer) throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  if (
    command.kind === 'company_contact.update' ||
    command.kind === 'company_contact.set_primary' ||
    command.kind === 'company_contact.deactivate'
  ) {
    const contact = await input.db
      .prepare('SELECT id FROM company_contacts WHERE id=? AND customer_id=? AND agency_id=?')
      .bind(command.contactId, customerId, input.agencyId)
      .first<{ id: string }>();
    if (!contact) throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  const resource: Record<string, unknown> = {
    agencyId: customer.agency_id,
    id: customer.id,
    customerId: customer.id,
    assigneeMembershipId: customer.assignee_membership_id,
    parentAssigneeMembershipId: customer.assignee_membership_id,
  };
  const authorization = await evaluateAuthorization(input.db, {
    context,
    action: actionForCommandKind(command.kind),
    resource,
  });
  if (authorization.decision !== 'ALLOW') {
    throw new DomainConstraintViolationError('REPLAY_AUTHORIZATION_DENIED');
  }
  await assertLiveCustomerReplayScope({
    db: input.db,
    agencyId: input.agencyId,
    actorUserId: input.actorUserId,
    actorMembershipId: input.actorMembershipId,
    actorIdentityId: input.actorIdentityId,
    permissionVersion: membership.permission_version,
    customerId: customer.id,
    scope: authorization.effectiveScope,
    ...(command.kind === 'company_contact.update' ||
    command.kind === 'company_contact.set_primary' ||
    command.kind === 'company_contact.deactivate'
      ? { contactId: command.contactId }
      : {}),
  });
}

/** Authoritative completed-receipt phase for service prechecks. */
export async function replayCompletedCustomerDomainCommand<TResult>(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly actorIdentityId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly command: CustomerDomainCommand;
}): Promise<CustomerDomainCommandResult<TResult> | null> {
  const lookup = await lookupIdempotency<TResult>(input);
  if (lookup.replay) {
    await assertCurrentReplayAuthority({
      ...input,
      replayCustomerTargetId: lookup.replayCustomerTargetId,
      replayCompanyContactTargetId: lookup.replayCompanyContactTargetId,
    });
  }
  return lookup.replay;
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
    case 'customer.vehicle.save': {
      const details = JSON.stringify(command.details),
        plate = normalizePlate(command.details.plate);
      const write =
        command.expectedVehicleVersion === null
          ? db
              .prepare(
                `INSERT INTO customer_vehicles(id,agency_id,customer_id,details_json,normalized_plate,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)`,
              )
              .bind(
                command.vehicleId,
                agencyId,
                command.customerId,
                details,
                plate,
                command.status,
                now,
                now,
              )
          : db
              .prepare(
                `UPDATE customer_vehicles SET details_json=?,normalized_plate=?,status=?,version=version+1,updated_at=? WHERE id=? AND agency_id=? AND customer_id=? AND version=?`,
              )
              .bind(
                details,
                plate,
                command.status,
                now,
                command.vehicleId,
                agencyId,
                command.customerId,
                command.expectedVehicleVersion,
              );
      return {
        action: 'customer.update',
        targetType: 'customer_vehicles',
        targetId: command.vehicleId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'customer.vehicle.saved',
        auditMetadata: {
          customerId: command.customerId,
          targetVersion: command.expectedVersion + 1,
        },
        businessStatements: [
          {
            statement: db
              .prepare(
                'UPDATE customers SET version=version+1,updated_at=? WHERE id=? AND agency_id=? AND version=? AND archived_at IS NULL',
              )
              .bind(now, command.customerId, agencyId, command.expectedVersion),
            expectedChanges: 1,
            failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
          },
          { statement: write, expectedChanges: 1, failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT' },
        ],
      };
    }
    case 'customer.create': {
      if (
        !command.insurerNumber ||
        (command.type === 'COMPANY' && !command.identity) ||
        (command.type !== 'COMPANY' && command.identity)
      )
        throw new DomainConstraintViolationError('CUSTOMER_REGISTRATION_REQUIRED');
      // Güvenlik Kuralı: Yeni müşterinin sorumlusu (assignee) her zaman aktörün kendi üyeliğidir.
      const insertStmt = db
        .prepare(
          `INSERT INTO customers (
             id, agency_id, type, display_name, first_name, last_name, company_title,
             email, phone, address, assignee_membership_id, version, created_at, updated_at,
             birth_date, reference_membership_id, reference_name, reference_search_key,
             identity_type, identity_ciphertext, identity_iv, identity_tag, identity_search_hash, identity_key_version
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS(SELECT 1 FROM insurers WHERE agency_id=? AND id=? AND status='ACTIVE') AND (? IS NULL OR EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id WHERE m.agency_id=? AND m.id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND u.display_name=?))`,
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
          command.birthDate ?? null,
          command.referenceMembershipId ?? null,
          command.referenceName ?? null,
          command.referenceName ? referenceSearchKey(command.referenceName) : null,
          command.identity ? 'VKN' : null,
          command.identity?.ciphertext ?? null,
          command.identity?.iv ?? null,
          command.identity?.tag ?? null,
          command.identity?.searchHash ?? null,
          command.identity?.keyVersion ?? null,
          agencyId,
          command.insurerNumber.insurerId,
          command.referenceMembershipId ?? null,
          agencyId,
          command.referenceMembershipId ?? null,
          command.referenceName ?? null,
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
          {
            statement: db
              .prepare(
                `INSERT INTO external_customer_references
              (id,agency_id,customer_id,source_namespace,external_key,created_at) VALUES(?,?,?,?,?,?)`,
              )
              .bind(
                crypto.randomUUID(),
                agencyId,
                command.customerId,
                'insurer:' + command.insurerNumber.insurerId,
                command.insurerNumber.customerNumber,
                now,
              ),
            expectedChanges: 1,
            failureCode: 'DUPLICATE_EXTERNAL_REFERENCE',
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
      if (command.birthDate !== undefined)
        updates.push({ col: 'birth_date', val: command.birthDate });
      if (command.referenceMembershipId !== undefined)
        updates.push({ col: 'reference_membership_id', val: command.referenceMembershipId });
      if (command.referenceName !== undefined) {
        updates.push({ col: 'reference_name', val: command.referenceName });
        updates.push({
          col: 'reference_search_key',
          val: command.referenceName ? referenceSearchKey(command.referenceName) : null,
        });
      }

      const nextVersion = command.expectedVersion + 1;
      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([
          nextVersion,
          now,
          command.customerId,
          agencyId,
          command.expectedVersion,
          command.referenceMembershipId ?? null,
          agencyId,
          command.referenceMembershipId ?? null,
          command.referenceName ?? null,
        ]);

      const updateStmt = db
        .prepare(
          `UPDATE customers
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ? AND archived_at IS NULL
             AND (? IS NULL OR EXISTS(SELECT 1 FROM agency_memberships m JOIN users u ON u.id=m.user_id WHERE m.agency_id=? AND m.id=? AND m.status='ACTIVE' AND u.status='ACTIVE' AND u.display_name=?))`,
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

    case 'customer.identity.update': {
      const customer = await db
        .prepare('SELECT id, type, version FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string; type: 'INDIVIDUAL' | 'COMPANY'; version: number }>();

      if (!customer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND', 'Müşteri kaydı bulunamadı.');
      }

      if (customer.type === 'COMPANY' && command.identityType === null)
        throw new DomainConstraintViolationError(
          'COMPANY_TAX_NUMBER_REQUIRED',
          'Kurumsal müşterinin vergi numarası silinemez; doğru numara ile değiştirin.',
        );

      if (command.identityType !== null) {
        if (customer.type === 'INDIVIDUAL' && command.identityType !== 'TCKN') {
          throw new DomainConstraintViolationError(
            'IDENTITY_TYPE_MISMATCH',
            'Bireysel müşteriler yalnızca TCKN tipinde kimlik alabilir.',
          );
        }
        if (customer.type === 'COMPANY' && command.identityType !== 'VKN') {
          throw new DomainConstraintViolationError(
            'IDENTITY_TYPE_MISMATCH',
            'Tüzel müşteriler yalnızca VKN tipinde kimlik alabilir.',
          );
        }
      }

      const nextVersion = command.expectedVersion + 1;
      const updateStmt = db
        .prepare(
          `UPDATE customers
           SET identity_type = ?,
               identity_ciphertext = ?,
               identity_iv = ?,
               identity_tag = ?,
               identity_search_hash = ?,
               identity_key_version = ?,
               version = ?,
               updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(
          command.identityType,
          command.identityCiphertext,
          command.identityIv,
          command.identityTag,
          command.identitySearchHash,
          command.identityKeyVersion,
          nextVersion,
          now,
          command.customerId,
          agencyId,
          command.expectedVersion,
        );

      return {
        action: 'customer.identity.update',
        targetType: 'customers',
        targetId: command.customerId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: command.identityType ? 'customer.identity.updated' : 'customer.identity.cleared',
        auditMetadata: {
          customerId: command.customerId,
          targetVersion: nextVersion,
          identityType: command.identityType,
          hasIdentity: command.identityType !== null,
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

    case 'customer.assign': {
      const customer = await db
        .prepare(
          'SELECT id, assignee_membership_id, version FROM customers WHERE id = ? AND agency_id = ?',
        )
        .bind(command.customerId, agencyId)
        .first<{ id: string; assignee_membership_id: string | null; version: number }>();

      if (!customer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND', 'Müşteri kaydı bulunamadı.');
      }

      const targetMember = await db
        .prepare(
          `SELECT m.id, m.status, u.status AS user_status
           FROM agency_memberships m
           INNER JOIN users u ON u.id = m.user_id
           WHERE m.id = ? AND m.agency_id = ?`,
        )
        .bind(command.targetAssigneeMembershipId, agencyId)
        .first<{ id: string; status: string; user_status: string }>();

      if (!targetMember) {
        throw new DomainConstraintViolationError(
          'ASSIGNEE_MEMBERSHIP_NOT_FOUND',
          'Hedef temsilci üyeliği bulunamadı veya farklı acenteye ait.',
        );
      }
      if (targetMember.status !== 'ACTIVE' || targetMember.user_status !== 'ACTIVE') {
        throw new DomainConstraintViolationError(
          'INACTIVE_ASSIGNEE_PROHIBITED',
          'Yalnızca aktif acente üyelerine müşteri atanabilir.',
        );
      }

      const nextVersion = command.expectedVersion + 1;
      const updateStmt = db
        .prepare(
          `UPDATE customers
           SET assignee_membership_id = ?, version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(
          command.targetAssigneeMembershipId,
          nextVersion,
          now,
          command.customerId,
          agencyId,
          command.expectedVersion,
        );

      return {
        action: 'customer.assign',
        targetType: 'customers',
        targetId: command.customerId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'customer.assigned',
        auditMetadata: {
          customerId: command.customerId,
          targetVersion: nextVersion,
          beforeAssigneeMembershipId: customer.assignee_membership_id,
          afterAssigneeMembershipId: command.targetAssigneeMembershipId,
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

    case 'customer.archive': {
      const customer = await db
        .prepare('SELECT id FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string }>();
      if (!customer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND', 'Müşteri kaydı bulunamadı.');
      }
      const updateStmt = db
        .prepare(
          `UPDATE customers
           SET archived_at = ?, archived_by_membership_id = ?, archive_reason_code = ?,
               version = version + 1, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ? AND archived_at IS NULL`,
        )
        .bind(
          now,
          actorMembershipId,
          command.reasonCode,
          now,
          command.customerId,
          agencyId,
          command.expectedVersion,
        );
      return {
        action: 'customer.archive',
        targetType: 'customers',
        targetId: command.customerId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: 'customer.archived',
        auditMetadata: {
          customerId: command.customerId,
          reasonCode: command.reasonCode,
          targetVersion: command.expectedVersion + 1,
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

    case 'customer.external_reference.create': {
      const customer = await db
        .prepare('SELECT id, version FROM customers WHERE id = ? AND agency_id = ?')
        .bind(command.customerId, agencyId)
        .first<{ id: string; version: number }>();

      if (!customer) {
        throw new DomainConstraintViolationError('CUSTOMER_NOT_FOUND', 'Müşteri kaydı bulunamadı.');
      }

      const existingRef = await db
        .prepare(
          `SELECT id FROM external_customer_references
           WHERE agency_id = ? AND source_namespace = ? AND external_key = ?`,
        )
        .bind(agencyId, command.sourceNamespace, command.externalKey)
        .first<{ id: string }>();

      if (existingRef && existingRef.id !== (command.insurerId ? command.referenceId : null)) {
        throw new DomainConstraintViolationError(
          'DUPLICATE_EXTERNAL_REFERENCE',
          'Bu acente için harici kaynak ve referans anahtarı zaten tanımlı.',
        );
      }

      const nextVersion = command.expectedVersion + 1;
      const updateCustStmt = db
        .prepare(
          `UPDATE customers
           SET version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ?
             AND (? IS NULL OR EXISTS (SELECT 1 FROM insurers WHERE agency_id=? AND id=? AND status='ACTIVE'))`,
        )
        .bind(
          nextVersion,
          now,
          command.customerId,
          agencyId,
          command.expectedVersion,
          command.insurerId ?? null,
          agencyId,
          command.insurerId ?? null,
        );

      const insertRefStmt =
        command.replaceExisting && command.insurerId
          ? db
              .prepare(
                `UPDATE external_customer_references SET external_key=?,updated_at=?
          WHERE id=? AND agency_id=? AND customer_id=? AND source_namespace=?`,
              )
              .bind(
                command.externalKey,
                now,
                command.referenceId,
                agencyId,
                command.customerId,
                command.sourceNamespace,
              )
          : db
              .prepare(
                `INSERT INTO external_customer_references (
             id, agency_id, customer_id, source_namespace, external_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                command.referenceId,
                agencyId,
                command.customerId,
                command.sourceNamespace,
                command.externalKey,
                now,
              );

      return {
        action: 'customer.external_reference.create',
        targetType: 'external_customer_references',
        targetId: command.referenceId,
        targetCustomerId: command.customerId,
        isCreate: false,
        auditCode: command.replaceExisting
          ? 'customer.external_reference.updated'
          : 'customer.external_reference.created',
        auditMetadata: {
          customerId: command.customerId,
          referenceId: command.referenceId,
          sourceNamespace: command.sourceNamespace,
          targetCustomerVersion: nextVersion,
        },
        businessStatements: [
          {
            statement: updateCustStmt,
            expectedChanges: 1,
            failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
          },
          {
            statement: insertRefStmt,
            expectedChanges: 1,
            failureCode: 'DUPLICATE_EXTERNAL_REFERENCE',
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
    actorIdentityId,
    expectedPermissionVersion,
    correlationId,
    idempotencyKey,
    command,
  } = input;

  // Authoritative completed replay must precede DB-dependent planning and domain prechecks.
  const idempotency = await lookupIdempotency<TResult>({
    db,
    agencyId,
    actorUserId,
    actorMembershipId,
    idempotencyKey,
    payload: input.payload,
    command,
  });
  if (idempotency.replay) {
    await assertCurrentReplayAuthority({
      db,
      agencyId,
      actorUserId,
      actorMembershipId,
      actorIdentityId,
      command,
      replayCustomerTargetId: idempotency.replayCustomerTargetId,
      replayCompanyContactTargetId: idempotency.replayCompanyContactTargetId,
    });
    return idempotency.replay;
  }
  const { action, payloadFingerprint, trimmedIdempotencyKey } = idempotency;

  let plan: CommandExecutionPlan;
  try {
    plan = await planCommand(db, agencyId, actorMembershipId, command);
  } catch (planningError) {
    // A concurrent exact request may commit after the first receipt lookup but
    // before a state-dependent plan precheck. Re-read the authoritative receipt.
    const afterFailure = await lookupIdempotency<TResult>({
      db,
      agencyId,
      actorUserId,
      actorMembershipId,
      idempotencyKey,
      payload: input.payload,
      command,
    });
    if (afterFailure.replay) {
      await assertCurrentReplayAuthority({
        db,
        agencyId,
        actorUserId,
        actorMembershipId,
        actorIdentityId,
        command,
        replayCustomerTargetId: afterFailure.replayCustomerTargetId,
        replayCompanyContactTargetId: afterFailure.replayCompanyContactTargetId,
      });
      return afterFailure.replay;
    }
    throw planningError;
  }
  if (plan.action !== action) {
    throw new Error('DOMAIN_COMMAND_ACTION_MAPPING_MISMATCH');
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
             AND EXISTS (
               SELECT 1 FROM auth_identities ai
               WHERE ai.id = ? AND ai.user_id = u.id AND ai.status = 'ACTIVE'
             )
             AND (
               (
                 m.type = 'OWNER'
                 AND (
                   ? != 'customer.identity.update'
                   OR (
                     EXISTS (
                       SELECT 1 FROM membership_permissions sp_read
                       WHERE sp_read.membership_id = m.id
                         AND sp_read.permission_code = 'sensitive.identity.read'
                         AND sp_read.scope = 'UNSCOPED'
                     )
                     AND EXISTS (
                       SELECT 1 FROM membership_permissions sp_write
                       WHERE sp_write.membership_id = m.id
                         AND sp_write.permission_code = 'sensitive.identity.write'
                         AND sp_write.scope = 'UNSCOPED'
                     )
                   )
                 )
               )
               OR (
                 m.type = 'MEMBER'
                 AND (
                   -- CASE 1: customer.create
                   (
                     ? = 'customer.create'
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
                   -- CASE 2: customer.assign
                   (
                     ? = 'customer.assign'
                     AND EXISTS (
                       SELECT 1
                       FROM customers c
                       INNER JOIN membership_permissions p_assign
                         ON p_assign.membership_id = m.id
                         AND p_assign.permission_code = 'customer.assign'
                         AND p_assign.scope IN ('ASSIGNED', 'AGENCY')
                       INNER JOIN membership_permissions p_read
                         ON p_read.membership_id = m.id
                         AND p_read.permission_code = 'customer.read'
                         AND p_read.scope IN ('ASSIGNED', 'AGENCY')
                       WHERE c.id = ?
                         AND c.agency_id = ?
                         AND (p_read.scope = 'AGENCY' OR p_assign.scope = 'ASSIGNED')
                         AND (p_assign.scope = 'AGENCY' OR c.assignee_membership_id = m.id)
                         AND (p_read.scope = 'AGENCY' OR c.assignee_membership_id = m.id)
                     )
                   )
                   OR
                   -- CASE 3: customer.archive
                   (
                     ? = 'customer.archive'
                     AND EXISTS (
                       SELECT 1
                       FROM customers c
                       INNER JOIN membership_permissions p_archive
                         ON p_archive.membership_id = m.id
                         AND p_archive.permission_code = 'customer.archive'
                         AND p_archive.scope IN ('ASSIGNED', 'AGENCY')
                       INNER JOIN membership_permissions p_read
                         ON p_read.membership_id = m.id
                         AND p_read.permission_code = 'customer.read'
                         AND p_read.scope IN ('ASSIGNED', 'AGENCY')
                       WHERE c.id = ? AND c.agency_id = ?
                         AND (p_read.scope = 'AGENCY' OR p_archive.scope = 'ASSIGNED')
                         AND (p_archive.scope = 'AGENCY' OR c.assignee_membership_id = m.id)
                         AND (p_read.scope = 'AGENCY' OR c.assignee_membership_id = m.id)
                     )
                   )
                   OR
                   -- CASE 4: customer.identity.update
                   (
                     ? = 'customer.identity.update'
                     AND EXISTS (
                       SELECT 1 FROM membership_permissions sp_read
                       WHERE sp_read.membership_id = m.id
                         AND sp_read.permission_code = 'sensitive.identity.read'
                         AND sp_read.scope = 'UNSCOPED'
                     )
                     AND EXISTS (
                       SELECT 1 FROM membership_permissions sp_write
                       WHERE sp_write.membership_id = m.id
                         AND sp_write.permission_code = 'sensitive.identity.write'
                         AND sp_write.scope = 'UNSCOPED'
                     )
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
                   OR
                   -- CASE 5: customer.update, customer.external_reference.create, ve company_contact.*
                   (
                     ? NOT IN ('customer.create', 'customer.assign', 'customer.archive', 'customer.identity.update')
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
      actorIdentityId,
      plan.action,
      plan.action,
      plan.action,
      plan.targetCustomerId,
      agencyId,
      plan.action,
      plan.targetCustomerId,
      agencyId,
      plan.action,
      plan.targetCustomerId,
      agencyId,
      plan.action,
      plan.targetCustomerId,
      agencyId,
    );
  batchStatements.push(finalAuthorityRecheckStmt);
  if (command.kind === 'customer.create' && command.identity) {
    batchStatements.push(
      db
        .prepare(
          `INSERT INTO d1_cas_assertions(id,expected,actual,failure_code)
      SELECT ?,1,CASE WHEN EXISTS (
        SELECT 1 FROM agency_memberships m WHERE m.id=? AND m.agency_id=?
          AND (m.type='OWNER' OR EXISTS (
            SELECT 1 FROM membership_permissions pu JOIN membership_permissions pr ON pr.membership_id=pu.membership_id
            WHERE pu.membership_id=m.id AND pu.permission_code='customer.update' AND pu.scope IN ('ASSIGNED','AGENCY')
              AND pr.permission_code='customer.read' AND pr.scope IN ('ASSIGNED','AGENCY')
              AND (pu.scope='ASSIGNED' OR pr.scope='AGENCY')))
          AND (SELECT count(DISTINCT permission_code) FROM membership_permissions sp WHERE sp.membership_id=m.id
            AND sp.permission_code IN ('sensitive.identity.read','sensitive.identity.write') AND sp.scope='UNSCOPED')=2
      ) THEN 1 ELSE 0 END,'FINAL_AUTHORITY_RECHECK_FAILED'`,
        )
        .bind(crypto.randomUUID(), actorMembershipId, agencyId),
    );
  }

  if (command.kind === 'customer.assign') {
    const targetAssigneeAssertionStmt = db
      .prepare(
        `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
         SELECT ?, 1,
           CASE WHEN EXISTS (
             SELECT 1
             FROM agency_memberships m
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.id = ?
               AND m.agency_id = ?
               AND m.status = 'ACTIVE'
               AND u.status = 'ACTIVE'
           ) THEN 1 ELSE 0 END,
           'INACTIVE_OR_CROSS_AGENCY_ASSIGNEE'`,
      )
      .bind(crypto.randomUUID(), command.targetAssigneeMembershipId, agencyId);
    batchStatements.push(targetAssigneeAssertionStmt);
  }

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

  // New writes require a live parent, inside the same transaction as every
  // child statement. Keep this AFTER receipt insertion: a concurrent completed
  // exact request must still hit the existing unique-receipt replay path first.
  // Completed replay above never executes this assertion or another write.
  if (
    [
      'company_contact.create',
      'company_contact.update',
      'company_contact.set_primary',
      'company_contact.deactivate',
      'customer.identity.update',
      'customer.external_reference.create',
    ].includes(command.kind)
  ) {
    batchStatements.push(
      db
        .prepare(
          `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
         SELECT ?, 1, CASE WHEN EXISTS (
           SELECT 1 FROM customers WHERE id = ? AND agency_id = ? AND archived_at IS NULL
         ) THEN 1 ELSE 0 END, 'OPTIMISTIC_CONCURRENCY_CONFLICT'`,
        )
        .bind(crypto.randomUUID(), command.customerId, agencyId),
    );
  }

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
    action:
      plan.action === 'customer.archive' ||
      (command.kind === 'customer.external_reference.create' && command.replaceExisting)
        ? plan.auditCode
        : plan.action,
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
    if (errorMsg.includes('OPEN_DEPENDENCIES')) {
      throw new DomainConstraintViolationError(
        'OPEN_DEPENDENCIES',
        'Müşteri açık poliçe bağımlılıkları nedeniyle arşivlenemez.',
      );
    }
    if (errorMsg.includes('CONTACT_NOT_FOUND')) {
      throw new DomainConstraintViolationError('CONTACT_NOT_FOUND', 'Şirket yetkilisi bulunamadı.');
    }
    if (errorMsg.includes('INACTIVE_OR_CROSS_AGENCY_ASSIGNEE')) {
      throw new DomainConstraintViolationError(
        'INACTIVE_ASSIGNEE_PROHIBITED',
        'Yalnızca aktif acente üyelerine müşteri atanabilir.',
      );
    }
    if (
      errorMsg.includes('customer_vehicles_customer_plate_uq') ||
      errorMsg.includes(
        'UNIQUE constraint failed: customer_vehicles.agency_id, customer_vehicles.customer_id, customer_vehicles.normalized_plate',
      )
    )
      throw new DomainConstraintViolationError(
        'DUPLICATE_VEHICLE_PLATE',
        'Bu müşterinin aynı plakalı aracı zaten kayıtlı.',
      );
    if (
      errorMsg.includes('DUPLICATE_EXTERNAL_REFERENCE') ||
      errorMsg.includes('ext_cust_refs_agency_source_key_uq') ||
      errorMsg.includes('external_customer_references_unique_key') ||
      errorMsg.includes('UNIQUE constraint failed: external_customer_references')
    ) {
      throw new DomainConstraintViolationError(
        'DUPLICATE_EXTERNAL_REFERENCE',
        'Bu acente için harici kaynak ve referans anahtarı zaten tanımlı.',
      );
    }

    if (
      errorMsg.includes('IDEMPOTENCY_ROW_REPLACEMENT_FORBIDDEN') ||
      errorMsg.includes('operation_receipts_idem_uq') ||
      errorMsg.includes('UNIQUE constraint failed: operation_receipts')
    ) {
      const concurrentLookup = await lookupIdempotency<TResult>({
        db,
        agencyId,
        actorUserId,
        actorMembershipId,
        idempotencyKey: trimmedIdempotencyKey,
        payload: input.payload,
        command,
      });
      if (concurrentLookup.replay) {
        await assertCurrentReplayAuthority({
          db,
          agencyId,
          actorUserId,
          actorMembershipId,
          actorIdentityId,
          command,
          replayCustomerTargetId: concurrentLookup.replayCustomerTargetId,
          replayCompanyContactTargetId: concurrentLookup.replayCompanyContactTargetId,
        });
        return concurrentLookup.replay;
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

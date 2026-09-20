/**
 * Mayı Sigorta CRM — Müşteri ve Şirket Yetkilisi Domain Servisi (M2-T01)
 *
 * MİMARİ VE GÜVENLİK KURALLARI:
 * 1. Sunucu kanonik yetkilendirmesi (Server-owned action + customer_record_resolver).
 * 2. Non-disclosure Prensibi: Yetkisiz kullanıcılar hedef kaydın varlığını, tipini
 *    veya yaşam döngüsü durumunu öğrenemez (daima 404 üretilir).
 * 3. Strict Zod Şemaları: Bilinmeyen alanlar (.strict) kesinlikle reddedilir.
 *    Mass-assignment ve sahte yetki/versiyon parametreleri engellenir.
 * 4. Deterministik Idempotency ve Optimistic Concurrency (CAS version).
 * 5. Tüm mutasyonlar sunucu mülkiyetindeki kapalı CustomerDomainCommand yürütücüsüne iletilir.
 */

import { z } from 'zod';
import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization } from '../auth/authorization';
import {
  executeCustomerDomainCommand,
  DomainConstraintViolationError,
} from '../mutations/internal/customer-domain-executor';
export { DomainConstraintViolationError };
import type {
  CustomerDto,
  CompanyContactDto,
  CustomerDetailDto,
  CustomerListResponseData,
  CustomerType,
  CompanyContactStatus,
} from '../../shared/types';

export class CustomerNotFoundError extends Error {
  constructor() {
    super('CUSTOMER_NOT_FOUND');
    this.name = 'CustomerNotFoundError';
  }
}

export class ContactNotFoundError extends Error {
  constructor() {
    super('CONTACT_NOT_FOUND');
    this.name = 'ContactNotFoundError';
  }
}

export class CustomerForbiddenError extends Error {
  constructor(message = 'FORBIDDEN') {
    super(message);
    this.name = 'CustomerForbiddenError';
  }
}

export class ValidationError extends Error {
  readonly details: Record<string, string>;

  constructor(message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// ---------------------- ZOD DOĞRULAMA ŞEMALARI (STRICT) ----------------------

export const CreateCustomerSchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'COMPANY']),
    displayName: z.string().trim().min(1).max(255).optional(),
    firstName: z.string().trim().min(1).max(100).optional().nullable(),
    lastName: z.string().trim().min(1).max(100).optional().nullable(),
    companyTitle: z.string().trim().min(1).max(255).optional().nullable(),
    email: z.string().trim().email('Geçerli bir e-posta giriniz').optional().nullable(),
    phone: z.string().trim().min(1).max(50).optional().nullable(),
    address: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

export const UpdateCustomerSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    type: z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
    displayName: z.string().trim().min(1).max(255).optional(),
    firstName: z.string().trim().min(1).max(100).optional().nullable(),
    lastName: z.string().trim().min(1).max(100).optional().nullable(),
    companyTitle: z.string().trim().min(1).max(255).optional().nullable(),
    email: z.string().trim().email('Geçerli bir e-posta giriniz').optional().nullable(),
    phone: z.string().trim().min(1).max(50).optional().nullable(),
    address: z.string().trim().max(1000).optional().nullable(),
  })
  .strict();

export const CreateCompanyContactSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Ad boş olamaz').max(100),
    lastName: z.string().trim().min(1, 'Soyad boş olamaz').max(100),
    role: z.string().trim().max(100).optional().nullable(),
    email: z.string().trim().email('Geçerli bir e-posta giriniz').optional().nullable(),
    phone: z.string().trim().min(1).max(50).optional().nullable(),
    isPrimary: z.boolean().optional().default(false),
  })
  .strict();

export const UpdateCompanyContactSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    role: z.string().trim().max(100).optional().nullable(),
    email: z.string().trim().email('Geçerli bir e-posta giriniz').optional().nullable(),
    phone: z.string().trim().min(1).max(50).optional().nullable(),
  })
  .strict();

export const VersionOnlySchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
  })
  .strict();

// ---------------------- CURSOR YARDIMCILARI ----------------------

export function encodeCursor(
  sortValue: string,
  id: string,
  sortCol: string,
  order: 'asc' | 'desc',
): string {
  return Buffer.from(JSON.stringify({ v: sortValue, id, s: sortCol, o: order }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(
  cursor: string,
  expectedSortCol: string,
  expectedOrder: 'asc' | 'desc',
): { v: string; id: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { v?: unknown; id?: unknown; s?: unknown; o?: unknown };
    if (
      typeof parsed.v === 'string' &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0 &&
      typeof parsed.s === 'string' &&
      typeof parsed.o === 'string'
    ) {
      if (parsed.s !== expectedSortCol || parsed.o.toLowerCase() !== expectedOrder.toLowerCase()) {
        throw new ValidationError(
          'Sayfalama imleci mevcut sıralama alanı veya yönü ile uyuşmuyor.',
        );
      }
      return { v: parsed.v, id: parsed.id };
    }
    throw new ValidationError('Sayfalama imleci biçimi geçersiz.');
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('Geçersiz sayfalama imleci (cursor).');
  }
}

// ---------------------- DTO DÖNÜŞTÜRÜCÜLER ----------------------

export interface RawCustomerRow {
  id: string;
  agency_id: string;
  type: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  company_title: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  assignee_membership_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RawContactRow {
  id: string;
  agency_id: string;
  customer_id: string;
  first_name: string;
  last_name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  is_primary: number;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export function toCustomerDto(row: RawCustomerRow): CustomerDto {
  return {
    id: row.id,
    agencyId: row.agency_id,
    type: row.type as CustomerType,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    companyTitle: row.company_title,
    email: row.email,
    phone: row.phone,
    address: row.address,
    assigneeMembershipId: row.assignee_membership_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCompanyContactDto(row: RawContactRow): CompanyContactDto {
  return {
    id: row.id,
    agencyId: row.agency_id,
    customerId: row.customer_id,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    isPrimary: row.is_primary === 1,
    status: row.status as CompanyContactStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------- MÜŞTERİ HİZMET FONKSİYONLARI ----------------------

export interface CustomerMutationOptions {
  correlationId: string;
  idempotencyKey: string;
}

export async function createCustomer(
  db: D1Database,
  context: AuthenticatedUserContext,
  rawPayload: unknown,
  options: CustomerMutationOptions,
): Promise<CustomerDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }

  const parsed = CreateCustomerSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError('Geçersiz müşteri verisi', details);
  }
  const data = parsed.data;

  if (data.type === 'INDIVIDUAL') {
    if (!data.firstName || !data.lastName || data.companyTitle) {
      throw new DomainConstraintViolationError(
        'INDIVIDUAL_NAMES_REQUIRED',
        'Bireysel müşteride ad ve soyad zorunludur ve şirket unvanı bulunamaz.',
      );
    }
  } else if (data.type === 'COMPANY') {
    if (!data.companyTitle || data.firstName || data.lastName) {
      throw new DomainConstraintViolationError(
        'COMPANY_TITLE_REQUIRED',
        'Kurumsal müşteride şirket unvanı zorunludur ve ad/soyad bulunamaz.',
      );
    }
  }

  const firstName = data.type === 'INDIVIDUAL' ? (data.firstName?.trim() ?? null) : null;
  const lastName = data.type === 'INDIVIDUAL' ? (data.lastName?.trim() ?? null) : null;
  const companyTitle = data.type === 'COMPANY' ? (data.companyTitle?.trim() ?? null) : null;
  const computedDisplayName =
    data.type === 'INDIVIDUAL' ? `${firstName} ${lastName}`.trim() : companyTitle!;

  const agencyId = activeMembership.agencyId;
  const assigneeMembershipId = activeMembership.id;
  const customerId = crypto.randomUUID();

  // Yetkilendirme değerlendirmesi
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'customer.create',
    resource: {
      agencyId,
      assigneeMembershipId,
      isCreate: true,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerForbiddenError('Müşteri oluşturma yetkiniz bulunmamaktadır.');
  }

  const now = new Date().toISOString();
  const resultDto: CustomerDto = {
    id: customerId,
    agencyId,
    type: data.type,
    displayName: computedDisplayName,
    firstName,
    lastName,
    companyTitle,
    email: data.email ?? null,
    phone: data.phone ?? null,
    address: data.address ?? null,
    assigneeMembershipId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const mutationResult = await executeCustomerDomainCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: activeMembership.id,
    expectedPermissionVersion: activeMembership.permissionVersion,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    payload: rawPayload,
    command: {
      kind: 'customer.create',
      customerId,
      type: data.type,
      displayName: computedDisplayName,
      firstName,
      lastName,
      companyTitle,
      email: data.email ?? null,
      phone: data.phone ?? null,
      address: data.address ?? null,
    },
    resultProducer: () => ({ status: 201, body: resultDto }),
  });

  return mutationResult.body;
}

export async function updateCustomer(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  rawPayload: unknown,
  options: CustomerMutationOptions,
): Promise<CustomerDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  // Mevcut müşteriyi yükle
  const existing = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND agency_id = ?')
    .bind(customerId, agencyId)
    .first<RawCustomerRow>();

  if (!existing) {
    throw new CustomerNotFoundError();
  }

  // Yetkilendirme değerlendirmesi (önce yetki kontrolü - non-disclosure)
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'customer.update',
    resource: {
      agencyId: existing.agency_id,
      id: existing.id,
      assigneeMembershipId: existing.assignee_membership_id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerNotFoundError();
  }

  const parsed = UpdateCustomerSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError('Geçersiz güncelleme verisi', details);
  }
  const data = parsed.data;

  // Müşteri türünün değiştirilemezliği kontrolü
  if (data.type !== undefined && data.type !== existing.type) {
    throw new DomainConstraintViolationError(
      'CANNOT_CHANGE_CUSTOMER_TYPE',
      'Müşteri türü değiştirilemez.',
    );
  }

  // Tip uyumluluk kontrolleri (INDIVIDUAL vs COMPANY)
  if (existing.type === 'INDIVIDUAL' && data.companyTitle) {
    throw new DomainConstraintViolationError(
      'INDIVIDUAL_NAMES_REQUIRED',
      'Bireysel müşteride şirket unvanı bulunamaz.',
    );
  }
  if (existing.type === 'COMPANY' && (data.firstName || data.lastName)) {
    throw new DomainConstraintViolationError(
      'COMPANY_TITLE_REQUIRED',
      'Kurumsal müşteride kişi adı/soyadı bulunamaz.',
    );
  }

  const finalFirstName = data.firstName !== undefined ? data.firstName : existing.first_name;
  const finalLastName = data.lastName !== undefined ? data.lastName : existing.last_name;
  const finalCompanyTitle =
    data.companyTitle !== undefined ? data.companyTitle : existing.company_title;
  const computedDisplayName =
    data.displayName ??
    (existing.type === 'INDIVIDUAL'
      ? `${finalFirstName ?? ''} ${finalLastName ?? ''}`.trim()
      : (finalCompanyTitle ?? existing.display_name));

  const changedFields: string[] = [];
  if (computedDisplayName !== existing.display_name) {
    changedFields.push('displayName');
  }
  if (data.firstName !== undefined && data.firstName !== existing.first_name) {
    changedFields.push('firstName');
  }
  if (data.lastName !== undefined && data.lastName !== existing.last_name) {
    changedFields.push('lastName');
  }
  if (data.companyTitle !== undefined && data.companyTitle !== existing.company_title) {
    changedFields.push('companyTitle');
  }
  if (data.email !== undefined && data.email !== existing.email) {
    changedFields.push('email');
  }
  if (data.phone !== undefined && data.phone !== existing.phone) {
    changedFields.push('phone');
  }
  if (data.address !== undefined && data.address !== existing.address) {
    changedFields.push('address');
  }

  const nextVersion = data.expectedVersion + 1;
  const now = new Date().toISOString();

  const updatedDto: CustomerDto = {
    id: existing.id,
    agencyId: existing.agency_id,
    type: existing.type as CustomerType,
    displayName: computedDisplayName,
    firstName: finalFirstName,
    lastName: finalLastName,
    companyTitle: finalCompanyTitle,
    email: data.email !== undefined ? data.email : existing.email,
    phone: data.phone !== undefined ? data.phone : existing.phone,
    address: data.address !== undefined ? data.address : existing.address,
    assigneeMembershipId: existing.assignee_membership_id,
    version: nextVersion,
    createdAt: existing.created_at,
    updatedAt: now,
  };

  const mutationResult = await executeCustomerDomainCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: activeMembership.id,
    expectedPermissionVersion: activeMembership.permissionVersion,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    payload: rawPayload,
    command: {
      kind: 'customer.update',
      customerId,
      expectedVersion: data.expectedVersion,
      displayName: computedDisplayName,
      firstName: data.firstName,
      lastName: data.lastName,
      companyTitle: data.companyTitle,
      email: data.email,
      phone: data.phone,
      address: data.address,
      changedFields,
    },
    resultProducer: () => ({ status: 200, body: updatedDto }),
  });

  return mutationResult.body;
}

export async function getCustomer(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
): Promise<CustomerDetailDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  const row = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND agency_id = ?')
    .bind(customerId, agencyId)
    .first<RawCustomerRow>();

  if (!row) {
    throw new CustomerNotFoundError();
  }

  const authz = await evaluateAuthorization(db, {
    context,
    action: 'customer.read',
    resource: {
      agencyId: row.agency_id,
      id: row.id,
      assigneeMembershipId: row.assignee_membership_id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerNotFoundError();
  }

  const baseDto = toCustomerDto(row);

  if (row.type === 'COMPANY') {
    const contactRows = await db
      .prepare(
        `SELECT * FROM company_contacts
         WHERE customer_id = ? AND agency_id = ?
         ORDER BY is_primary DESC, created_at ASC`,
      )
      .bind(customerId, agencyId)
      .all<RawContactRow>();

    const contacts = (contactRows.results || []).map(toCompanyContactDto);
    return { ...baseDto, contacts };
  }

  return baseDto;
}

export interface ListCustomersQuery {
  limit?: number | string;
  cursor?: string;
  sort?: string;
  order?: string;
  type?: string;
  search?: string;
}

export async function listCustomers(
  db: D1Database,
  context: AuthenticatedUserContext,
  query: ListCustomersQuery,
): Promise<CustomerListResponseData> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  const authz = await evaluateAuthorization(db, {
    context,
    action: 'customer.read',
    resource: {
      agencyId,
      assigneeMembershipId: activeMembership.id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerForbiddenError('Müşteri listeleme yetkiniz bulunmamaktadır.');
  }

  const rawLimit = Number(query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 50;

  if (query.sort !== undefined && query.sort !== null && query.sort !== '') {
    if (
      ![
        'createdAt',
        'created_at',
        'displayName',
        'display_name',
        'updatedAt',
        'updated_at',
      ].includes(query.sort)
    ) {
      throw new ValidationError('Geçersiz sıralama alanı: ' + query.sort);
    }
  }
  const sort = query.sort || 'createdAt';

  if (query.order !== undefined && query.order !== null && query.order !== '') {
    if (!['asc', 'desc'].includes(query.order.toLowerCase())) {
      throw new ValidationError('Geçersiz sıralama yönü: ' + query.order);
    }
  }
  const order = (query.order ? query.order.toLowerCase() : 'desc') as 'asc' | 'desc';

  if (query.type !== undefined && query.type !== null && query.type !== '') {
    if (!['INDIVIDUAL', 'COMPANY'].includes(query.type)) {
      throw new ValidationError('Geçersiz müşteri türü: ' + query.type);
    }
  }

  const sortColMap: Record<string, string> = {
    createdAt: 'created_at',
    created_at: 'created_at',
    displayName: 'display_name',
    display_name: 'display_name',
    updatedAt: 'updated_at',
    updated_at: 'updated_at',
  };
  const sortCol = sortColMap[sort] || 'created_at';

  const conditions: string[] = ['agency_id = ?'];
  const params: unknown[] = [agencyId];

  if (authz.effectiveScope === 'ASSIGNED') {
    conditions.push('assignee_membership_id = ?');
    params.push(activeMembership.id);
  }

  if (query.type === 'INDIVIDUAL' || query.type === 'COMPANY') {
    conditions.push('type = ?');
    params.push(query.type);
  }

  if (query.search && typeof query.search === 'string' && query.search.trim().length > 0) {
    const term = query.search.trim().slice(0, 100);
    conditions.push('(display_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const likePattern = `%${term}%`;
    params.push(likePattern, likePattern, likePattern);
  }

  // Kararlı imleç (Strict cursor decode & sort/order match)
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor, sortCol, order);
    const op = order === 'asc' ? '>' : '<';
    conditions.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND id ${op} ?))`);
    params.push(decoded.v, decoded.v, decoded.id);
  }

  const orderDir = order.toUpperCase();
  const sql = `
    SELECT * FROM customers
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${sortCol} ${orderDir}, id ${orderDir}
    LIMIT ?
  `;
  params.push(limit + 1);

  const queryResult = await db
    .prepare(sql)
    .bind(...params)
    .all<RawCustomerRow>();
  const rows = queryResult.results || [];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    if (lastItem) {
      const sortVal = String((lastItem as unknown as Record<string, unknown>)[sortCol]);
      nextCursor = encodeCursor(sortVal, lastItem.id, sortCol, order);
    }
  }

  return {
    items: items.map(toCustomerDto),
    nextCursor,
    hasMore,
  };
}

// ---------------------- ŞİRKET YETKİLİSİ (CONTACT) HİZMETLERİ ----------------------

export async function createCompanyContact(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  rawPayload: unknown,
  options: CustomerMutationOptions,
): Promise<CompanyContactDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  // 1. Üst müşteriyi yükle
  const customer = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND agency_id = ?')
    .bind(customerId, agencyId)
    .first<RawCustomerRow>();

  if (!customer) {
    throw new CustomerNotFoundError();
  }

  // 2. Yetkilendirme değerlendirmesi (ÖNCE yetkilendirme - non-disclosure)
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'company_contact.create',
    resource: {
      agencyId: customer.agency_id,
      customerId: customer.id,
      parentAssigneeMembershipId: customer.assignee_membership_id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerNotFoundError();
  }

  // 3. Domain invariant kontrolü (YETKİLENDİRMEDEN SONRA)
  if (customer.type !== 'COMPANY') {
    throw new DomainConstraintViolationError(
      'INDIVIDUAL_CONTACT_PROHIBITED',
      'Yalnızca kurumsal müşterilere (COMPANY) şirket yetkilisi eklenebilir.',
    );
  }

  const parsed = CreateCompanyContactSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError('Geçersiz yetkili verisi', details);
  }
  const data = parsed.data;

  const contactId = crypto.randomUUID();
  const now = new Date().toISOString();

  const resultDto: CompanyContactDto = {
    id: contactId,
    agencyId,
    customerId,
    firstName: data.firstName,
    lastName: data.lastName,
    role: data.role ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    isPrimary: data.isPrimary,
    status: 'ACTIVE',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const mutationResult = await executeCustomerDomainCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: activeMembership.id,
    expectedPermissionVersion: activeMembership.permissionVersion,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    payload: rawPayload,
    command: {
      kind: 'company_contact.create',
      customerId,
      contactId,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      isPrimary: data.isPrimary,
    },
    resultProducer: () => ({ status: 201, body: resultDto }),
  });

  return mutationResult.body;
}

export async function updateCompanyContact(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  contactId: string,
  rawPayload: unknown,
  options: CustomerMutationOptions,
): Promise<CompanyContactDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  // 1. Üst müşteriyi yükle
  const customer = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND agency_id = ?')
    .bind(customerId, agencyId)
    .first<RawCustomerRow>();
  if (!customer) throw new CustomerNotFoundError();

  // 2. Yetkilendirme değerlendirmesi (ÖNCE yetkilendirme - non-disclosure)
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'company_contact.update',
    resource: {
      agencyId: customer.agency_id,
      customerId: customer.id,
      parentAssigneeMembershipId: customer.assignee_membership_id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerNotFoundError();
  }

  // 3. Yetkili kaydını yükle
  const contact = await db
    .prepare('SELECT * FROM company_contacts WHERE id = ? AND customer_id = ? AND agency_id = ?')
    .bind(contactId, customerId, agencyId)
    .first<RawContactRow>();
  if (!contact) throw new ContactNotFoundError();

  const parsed = UpdateCompanyContactSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError('Geçersiz yetkili güncelleme verisi', details);
  }
  const data = parsed.data;

  const changedFields: string[] = [];
  if (data.firstName !== undefined && data.firstName !== contact.first_name) {
    changedFields.push('firstName');
  }
  if (data.lastName !== undefined && data.lastName !== contact.last_name) {
    changedFields.push('lastName');
  }
  if (data.role !== undefined && data.role !== contact.role) {
    changedFields.push('role');
  }
  if (data.email !== undefined && data.email !== contact.email) {
    changedFields.push('email');
  }
  if (data.phone !== undefined && data.phone !== contact.phone) {
    changedFields.push('phone');
  }

  const now = new Date().toISOString();
  const nextVersion = data.expectedVersion + 1;

  const updatedDto: CompanyContactDto = {
    id: contact.id,
    agencyId: contact.agency_id,
    customerId: contact.customer_id,
    firstName: data.firstName ?? contact.first_name,
    lastName: data.lastName ?? contact.last_name,
    role: data.role !== undefined ? data.role : contact.role,
    email: data.email !== undefined ? data.email : contact.email,
    phone: data.phone !== undefined ? data.phone : contact.phone,
    isPrimary: contact.is_primary === 1,
    status: contact.status as CompanyContactStatus,
    version: nextVersion,
    createdAt: contact.created_at,
    updatedAt: now,
  };

  const mutationResult = await executeCustomerDomainCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: activeMembership.id,
    expectedPermissionVersion: activeMembership.permissionVersion,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    payload: rawPayload,
    command: {
      kind: 'company_contact.update',
      customerId,
      contactId,
      expectedVersion: data.expectedVersion,
      firstName: data.firstName,
      lastName: data.lastName,
      role: data.role,
      email: data.email,
      phone: data.phone,
      changedFields,
    },
    resultProducer: () => ({ status: 200, body: updatedDto }),
  });

  return mutationResult.body;
}

export async function setPrimaryCompanyContact(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  contactId: string,
  rawPayload: unknown,
  options: CustomerMutationOptions,
): Promise<CompanyContactDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  // 1. Üst müşteriyi yükle
  const customer = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND agency_id = ?')
    .bind(customerId, agencyId)
    .first<RawCustomerRow>();
  if (!customer) throw new CustomerNotFoundError();

  // 2. Yetkilendirme değerlendirmesi (ÖNCE yetkilendirme - non-disclosure)
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'company_contact.set_primary',
    resource: {
      agencyId: customer.agency_id,
      customerId: customer.id,
      parentAssigneeMembershipId: customer.assignee_membership_id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerNotFoundError();
  }

  // 3. Yetkili kaydını yükle
  const contact = await db
    .prepare('SELECT * FROM company_contacts WHERE id = ? AND customer_id = ? AND agency_id = ?')
    .bind(contactId, customerId, agencyId)
    .first<RawContactRow>();
  if (!contact) throw new ContactNotFoundError();

  // 4. Durum kontrolü (YETKİLENDİRMEDEN SONRA)
  if (contact.status !== 'ACTIVE') {
    throw new DomainConstraintViolationError(
      'INACTIVE_CONTACT_CANNOT_BE_PRIMARY',
      'Pasif yetkili birincil kişi yapılamaz.',
    );
  }

  const parsed = VersionOnlySchema.safeParse(rawPayload);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError('Geçersiz versiyon bilgisi', details);
  }

  const now = new Date().toISOString();
  const nextVersion = parsed.data.expectedVersion + 1;

  const updatedDto: CompanyContactDto = {
    id: contact.id,
    agencyId: contact.agency_id,
    customerId: contact.customer_id,
    firstName: contact.first_name,
    lastName: contact.last_name,
    role: contact.role,
    email: contact.email,
    phone: contact.phone,
    isPrimary: true,
    status: 'ACTIVE',
    version: nextVersion,
    createdAt: contact.created_at,
    updatedAt: now,
  };

  const mutationResult = await executeCustomerDomainCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: activeMembership.id,
    expectedPermissionVersion: activeMembership.permissionVersion,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    payload: rawPayload,
    command: {
      kind: 'company_contact.set_primary',
      customerId,
      contactId,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => ({ status: 200, body: updatedDto }),
  });

  return mutationResult.body;
}

export async function deactivateCompanyContact(
  db: D1Database,
  context: AuthenticatedUserContext,
  customerId: string,
  contactId: string,
  rawPayload: unknown,
  options: CustomerMutationOptions,
): Promise<CompanyContactDto> {
  const activeMembership = context.memberships[0];
  if (!activeMembership || activeMembership.status !== 'ACTIVE') {
    throw new CustomerForbiddenError('Aktif üyelik bulunamadı.');
  }
  const agencyId = activeMembership.agencyId;

  // 1. Üst müşteriyi yükle
  const customer = await db
    .prepare('SELECT * FROM customers WHERE id = ? AND agency_id = ?')
    .bind(customerId, agencyId)
    .first<RawCustomerRow>();
  if (!customer) throw new CustomerNotFoundError();

  // 2. Yetkilendirme değerlendirmesi (ÖNCE yetkilendirme - non-disclosure)
  const authz = await evaluateAuthorization(db, {
    context,
    action: 'company_contact.deactivate',
    resource: {
      agencyId: customer.agency_id,
      customerId: customer.id,
      parentAssigneeMembershipId: customer.assignee_membership_id,
    },
  });

  if (authz.decision !== 'ALLOW') {
    throw new CustomerNotFoundError();
  }

  // 3. Yetkili kaydını yükle
  const contact = await db
    .prepare('SELECT * FROM company_contacts WHERE id = ? AND customer_id = ? AND agency_id = ?')
    .bind(contactId, customerId, agencyId)
    .first<RawContactRow>();
  if (!contact) throw new ContactNotFoundError();

  // 4. Durum kontrolü (YETKİLENDİRMEDEN SONRA)
  if (contact.status === 'INACTIVE') {
    throw new DomainConstraintViolationError(
      'CONTACT_ALREADY_INACTIVE',
      'Yetkili zaten pasif durumda.',
    );
  }

  const parsed = VersionOnlySchema.safeParse(rawPayload);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.')] = issue.message;
    }
    throw new ValidationError('Geçersiz versiyon bilgisi', details);
  }

  const now = new Date().toISOString();
  const nextVersion = parsed.data.expectedVersion + 1;

  const updatedDto: CompanyContactDto = {
    id: contact.id,
    agencyId: contact.agency_id,
    customerId: contact.customer_id,
    firstName: contact.first_name,
    lastName: contact.last_name,
    role: contact.role,
    email: contact.email,
    phone: contact.phone,
    isPrimary: false,
    status: 'INACTIVE',
    version: nextVersion,
    createdAt: contact.created_at,
    updatedAt: now,
  };

  const mutationResult = await executeCustomerDomainCommand({
    db,
    agencyId,
    actorUserId: context.userId,
    actorMembershipId: activeMembership.id,
    expectedPermissionVersion: activeMembership.permissionVersion,
    correlationId: options.correlationId,
    idempotencyKey: options.idempotencyKey,
    payload: rawPayload,
    command: {
      kind: 'company_contact.deactivate',
      customerId,
      contactId,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => ({ status: 200, body: updatedDto }),
  });

  return mutationResult.body;
}

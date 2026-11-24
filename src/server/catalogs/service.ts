/**
 * Mayı Sigorta CRM — Katalog ve Acente Ayarları Domain Servisi (M2-T03)
 *
 * MİMARİ VE GÜVENLİK KURALLARI:
 * 1. Sunucu kanonik yetkilendirmesi (Server-owned action evaluation).
 * 2. Non-disclosure Prensibi: Yetkisiz kullanıcılar veya farklı acenteler için 404/403 fail-closed.
 * 3. Strict Zod Şemaları: Bilinmeyen alanlar (.strict()) kesinlikle reddedilir.
 * 4. Deterministik Idempotency ve Optimistic Concurrency (CAS expectedVersion).
 * 5. Tüm mutasyonlar sunucu mülkiyetindeki kapalı CatalogDomainCommand yürütücüsüne iletilir.
 */

import { z } from 'zod';
import { BRANCH_CLASSIFICATION_CORRECTION_REASONS } from '../../shared/constants';
import type { AuthenticatedUserContext } from '../auth/identity';
import { evaluateAuthorization } from '../auth/authorization';
import {
  executeCatalogDomainCommand,
  DomainConstraintViolationError,
} from '../mutations/internal/catalog-domain-executor';
export { DomainConstraintViolationError };

import type {
  InsurerDto,
  InsuranceBranchDto,
  InsuranceProductDto,
  PaymentMethodDto,
  LossReasonDto,
  AgencySettingsDto,
  SelectableCatalogsDto,
  CatalogLifecycleStatus,
} from '../../shared/types';

export class CatalogItemNotFoundError extends Error {
  constructor(message = 'CATALOG_ITEM_NOT_FOUND') {
    super(message);
    this.name = 'CatalogItemNotFoundError';
  }
}

export class CatalogForbiddenError extends Error {
  constructor(message = 'FORBIDDEN') {
    super(message);
    this.name = 'CatalogForbiddenError';
  }
}

export class CatalogValidationError extends Error {
  readonly details: Record<string, string>;

  constructor(message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'CatalogValidationError';
    this.details = details;
  }
}

function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

// ---------------------- ZOD DOĞRULAMA ŞEMALARI (STRICT) ----------------------

export const CreateInsurerSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'Kod boş olamaz')
      .max(50, 'Kod en fazla 50 karakter olabilir')
      .regex(/^[A-Za-z0-9_.-]+$/, 'Kod yalnızca harf, rakam, altçizgi, nokta ve tire içerebilir'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
  })
  .strict();

export const UpdateInsurerSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
  })
  .strict();

export const CreateBranchSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'Kod boş olamaz')
      .max(50, 'Kod en fazla 50 karakter olabilir')
      .regex(/^[A-Za-z0-9_.-]+$/, 'Kod yalnızca harf, rakam, altçizgi, nokta ve tire içerebilir'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
    supportsVehicleDetails: z.boolean().optional(),
    dataClassification: z.enum(['GENERAL', 'HEALTH']).default('GENERAL'),
  })
  .strict();

export const UpdateBranchSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
    supportsVehicleDetails: z.boolean().optional(),
  })
  .strict();

export const CreateProductSchema = z
  .object({
    insurerId: z.string().trim().min(1, 'insurerId zorunludur'),
    branchId: z.string().trim().min(1, 'branchId zorunludur'),
    code: z
      .string()
      .trim()
      .min(1, 'Kod boş olamaz')
      .max(50, 'Kod en fazla 50 karakter olabilir')
      .regex(/^[A-Za-z0-9_.-]+$/, 'Kod yalnızca harf, rakam, altçizgi, nokta ve tire içerebilir'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
  })
  .strict();

export const UpdateProductSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir')
      .optional(),
    branchId: z.string().trim().min(1, 'branchId boş olamaz').optional(),
  })
  .strict();

export const CreatePaymentMethodSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'Kod boş olamaz')
      .max(50, 'Kod en fazla 50 karakter olabilir')
      .regex(/^[A-Za-z0-9_.-]+$/, 'Kod yalnızca harf, rakam, altçizgi, nokta ve tire içerebilir'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
    supportsInstallments: z.boolean().default(false),
    maxInstallments: z.number().int().min(2).max(36).default(12),
  })
  .strict();

export const UpdatePaymentMethodSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir')
      .optional(),
    supportsInstallments: z.boolean().optional(),
    maxInstallments: z.number().int().min(2).max(36).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 1, 'En az bir değişiklik zorunludur.');

export const CreateLossReasonSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'Kod boş olamaz')
      .max(50, 'Kod en fazla 50 karakter olabilir')
      .regex(/^[A-Za-z0-9_.-]+$/, 'Kod yalnızca harf, rakam, altçizgi, nokta ve tire içerebilir'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
  })
  .strict();

export const UpdateLossReasonSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    name: z
      .string()
      .trim()
      .min(1, 'İsim boş olamaz')
      .max(255, 'İsim en fazla 255 karakter olabilir'),
  })
  .strict();

export const DeactivateSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
  })
  .strict();

export const UpdateAgencySettingsSchema = z
  .object({
    expectedVersion: z.number().int().min(1, 'expectedVersion zorunludur ve en az 1 olmalıdır'),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .refine(isValidIanaTimezone, 'Geçerli bir IANA timezone değeri gereklidir')
      .optional(),
    renewalWindowDays: z
      .number()
      .int()
      .min(1, 'Pencere en az 1 gün olmalıdır')
      .max(120, 'Pencere en fazla 120 gün olabilir')
      .optional(),
    defaultInsurerId: z.string().trim().min(1).nullable().optional(),
    deactivateOldDefault: z.boolean().optional(),
  })
  .strict();

// ---------------------- YETKİ VE BAĞLAM YARDIMCILARI ----------------------

function getActiveMembership(context: AuthenticatedUserContext) {
  const membership = context.memberships[0];
  if (!membership || membership.status !== 'ACTIVE') {
    throw new CatalogForbiddenError('Aktif acente üyeliği bulunamadı.');
  }
  return membership;
}

async function authorizeAction(
  db: D1Database,
  context: AuthenticatedUserContext,
  action: string,
  resourceAgencyId: string,
) {
  const authResult = await evaluateAuthorization(db, {
    context,
    action,
    agencyId: resourceAgencyId,
  });
  if (authResult.decision !== 'ALLOW') {
    throw new CatalogForbiddenError(
      authResult.message || 'Bu işlem için yetkiniz bulunmamaktadır.',
    );
  }
}

// ---------------------- OKUMA METOTLARI ----------------------

export async function listInsurers(
  context: AuthenticatedUserContext,
  db: D1Database,
  options: { includeInactive?: boolean } = {},
): Promise<InsurerDto[]> {
  const mem = getActiveMembership(context);
  const statusFilter = options.includeInactive ? '' : "AND i.status = 'ACTIVE'";

  const rows = await db
    .prepare(
      `SELECT i.id, i.agency_id, i.code, i.name, i.status, i.version, i.created_at, i.updated_at,
              i.id IS s.default_insurer_id AS is_default
       FROM insurers i
       LEFT JOIN agency_settings s ON s.agency_id = i.agency_id
       WHERE i.agency_id = ? ${statusFilter}
       ORDER BY is_default DESC, i.name ASC, i.id ASC`,
    )
    .bind(mem.agencyId)
    .all<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      status: CatalogLifecycleStatus;
      is_default: number;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  return (rows.results || []).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    code: r.code,
    name: r.name,
    status: r.status,
    isDefault: r.is_default === 1,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getInsurer(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<InsurerDto> {
  const mem = getActiveMembership(context);
  const row = await db
    .prepare(
      `SELECT id, agency_id, code, name, status, version, created_at, updated_at
       FROM insurers
       WHERE id = ? AND agency_id = ?`,
    )
    .bind(id, mem.agencyId)
    .first<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    throw new CatalogItemNotFoundError('Sigorta şirketi bulunamadı.');
  }

  const settings = await db
    .prepare('SELECT default_insurer_id FROM agency_settings WHERE agency_id = ?')
    .bind(mem.agencyId)
    .first<{ default_insurer_id: string | null }>();

  return {
    id: row.id,
    agencyId: row.agency_id,
    code: row.code,
    name: row.name,
    status: row.status,
    isDefault: settings?.default_insurer_id === row.id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listBranches(
  context: AuthenticatedUserContext,
  db: D1Database,
  options: { includeInactive?: boolean; includeCorrectionAuthority?: boolean } = {},
): Promise<InsuranceBranchDto[]> {
  const mem = getActiveMembership(context);
  const statusFilter = options.includeInactive ? '' : "AND status = 'ACTIVE'";

  const rows = await db
    .prepare(
      `SELECT id, agency_id, code, name, data_classification, supports_vehicle_details, status, version, created_at, updated_at
       FROM insurance_branches
       WHERE agency_id = ? ${statusFilter}
       ORDER BY name ASC`,
    )
    .bind(mem.agencyId)
    .all<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      data_classification: 'GENERAL' | 'HEALTH';
      supports_vehicle_details: number;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  const correctionAuthority = options.includeCorrectionAuthority
    ? await evaluateAuthorization(db, {
        context,
        action: 'catalog.branch.correct_classification',
        agencyId: mem.agencyId,
      })
    : null;
  return (rows.results || []).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    code: r.code,
    name: r.name,
    dataClassification: r.data_classification,
    ...(correctionAuthority && {
      canCorrectClassification:
        correctionAuthority.decision === 'ALLOW' && r.data_classification === 'GENERAL',
    }),
    supportsVehicleDetails: r.supports_vehicle_details === 1,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getBranch(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<InsuranceBranchDto> {
  const mem = getActiveMembership(context);
  const row = await db
    .prepare(
      `SELECT id, agency_id, code, name, data_classification, supports_vehicle_details, status, version, created_at, updated_at
       FROM insurance_branches
       WHERE id = ? AND agency_id = ?`,
    )
    .bind(id, mem.agencyId)
    .first<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      data_classification: 'GENERAL' | 'HEALTH';
      supports_vehicle_details: number;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    throw new CatalogItemNotFoundError('Branş bulunamadı.');
  }

  return {
    id: row.id,
    agencyId: row.agency_id,
    code: row.code,
    name: row.name,
    dataClassification: row.data_classification,
    supportsVehicleDetails: row.supports_vehicle_details === 1,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProducts(
  context: AuthenticatedUserContext,
  db: D1Database,
  options: { includeInactive?: boolean } = {},
): Promise<InsuranceProductDto[]> {
  const mem = getActiveMembership(context);
  const statusFilter = options.includeInactive
    ? ''
    : `AND p.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1 FROM insurers i
         WHERE i.id = p.insurer_id AND i.agency_id = p.agency_id AND i.status = 'ACTIVE'
       )
       AND EXISTS (
         SELECT 1 FROM insurance_branches b
         WHERE b.id = p.branch_id AND b.agency_id = p.agency_id AND b.status = 'ACTIVE'
       )`;

  const rows = await db
    .prepare(
      `SELECT id, agency_id, insurer_id, branch_id, code, name, status, version, created_at, updated_at
       FROM insurance_products p
       WHERE p.agency_id = ? ${statusFilter}
       ORDER BY p.name ASC`,
    )
    .bind(mem.agencyId)
    .all<{
      id: string;
      agency_id: string;
      insurer_id: string;
      branch_id: string;
      code: string;
      name: string;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  return (rows.results || []).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    insurerId: r.insurer_id,
    branchId: r.branch_id,
    code: r.code,
    name: r.name,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getProduct(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<InsuranceProductDto> {
  const mem = getActiveMembership(context);
  const row = await db
    .prepare(
      `SELECT id, agency_id, insurer_id, branch_id, code, name, status, version, created_at, updated_at
       FROM insurance_products
       WHERE id = ? AND agency_id = ?`,
    )
    .bind(id, mem.agencyId)
    .first<{
      id: string;
      agency_id: string;
      insurer_id: string;
      branch_id: string;
      code: string;
      name: string;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    throw new CatalogItemNotFoundError('Ürün bulunamadı.');
  }

  return {
    id: row.id,
    agencyId: row.agency_id,
    insurerId: row.insurer_id,
    branchId: row.branch_id,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPaymentMethods(
  context: AuthenticatedUserContext,
  db: D1Database,
  options: { includeInactive?: boolean } = {},
): Promise<PaymentMethodDto[]> {
  const mem = getActiveMembership(context);
  const statusFilter = options.includeInactive ? '' : "AND status = 'ACTIVE'";

  const rows = await db
    .prepare(
      `SELECT id, agency_id, code, name, supports_installments, max_installments, status, version, created_at, updated_at
       FROM payment_methods
       WHERE agency_id = ? ${statusFilter}
       ORDER BY name ASC`,
    )
    .bind(mem.agencyId)
    .all<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      supports_installments: number;
      max_installments: number;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  return (rows.results || []).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    code: r.code,
    name: r.name,
    supportsInstallments: r.supports_installments === 1,
    maxInstallments: r.max_installments,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getPaymentMethod(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<PaymentMethodDto> {
  const mem = getActiveMembership(context);
  const row = await db
    .prepare(
      `SELECT id, agency_id, code, name, supports_installments, max_installments, status, version, created_at, updated_at
       FROM payment_methods
       WHERE id = ? AND agency_id = ?`,
    )
    .bind(id, mem.agencyId)
    .first<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      supports_installments: number;
      max_installments: number;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    throw new CatalogItemNotFoundError('Ödeme yöntemi bulunamadı.');
  }

  return {
    id: row.id,
    agencyId: row.agency_id,
    code: row.code,
    name: row.name,
    supportsInstallments: row.supports_installments === 1,
    maxInstallments: row.max_installments,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLossReasons(
  context: AuthenticatedUserContext,
  db: D1Database,
  options: { includeInactive?: boolean } = {},
): Promise<LossReasonDto[]> {
  const mem = getActiveMembership(context);
  const statusFilter = options.includeInactive ? '' : "AND status = 'ACTIVE'";

  const rows = await db
    .prepare(
      `SELECT id, agency_id, code, name, status, version, created_at, updated_at
       FROM loss_reasons
       WHERE agency_id = ? ${statusFilter}
       ORDER BY name ASC`,
    )
    .bind(mem.agencyId)
    .all<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  return (rows.results || []).map((r) => ({
    id: r.id,
    agencyId: r.agency_id,
    code: r.code,
    name: r.name,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getLossReason(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
): Promise<LossReasonDto> {
  const mem = getActiveMembership(context);
  const row = await db
    .prepare(
      `SELECT id, agency_id, code, name, status, version, created_at, updated_at
       FROM loss_reasons
       WHERE id = ? AND agency_id = ?`,
    )
    .bind(id, mem.agencyId)
    .first<{
      id: string;
      agency_id: string;
      code: string;
      name: string;
      status: CatalogLifecycleStatus;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    throw new CatalogItemNotFoundError('Kayıp nedeni bulunamadı.');
  }

  return {
    id: row.id,
    agencyId: row.agency_id,
    code: row.code,
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getAgencySettings(
  context: AuthenticatedUserContext,
  db: D1Database,
): Promise<AgencySettingsDto> {
  const mem = getActiveMembership(context);
  const row = await db
    .prepare(
      `SELECT id, agency_id, default_insurer_id, timezone, renewal_window_days, version, created_at, updated_at
       FROM agency_settings
       WHERE agency_id = ?`,
    )
    .bind(mem.agencyId)
    .first<{
      id: string;
      agency_id: string;
      default_insurer_id: string | null;
      timezone: string;
      renewal_window_days: number;
      version: number;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) {
    // If not seeded yet, return coherent defaults for this agency
    const now = new Date().toISOString();
    return {
      id: `sett-${mem.agencyId}`,
      agencyId: mem.agencyId,
      defaultInsurerId: null,
      timezone: 'Europe/Istanbul',
      renewalWindowDays: 30,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  return {
    id: row.id,
    agencyId: row.agency_id,
    defaultInsurerId: row.default_insurer_id,
    timezone: row.timezone,
    renewalWindowDays: row.renewal_window_days,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSelectableCatalogs(
  context: AuthenticatedUserContext,
  db: D1Database,
): Promise<SelectableCatalogsDto> {
  getActiveMembership(context);
  const [insurers, branches, products, paymentMethods, lossReasons] = await Promise.all([
    listInsurers(context, db, { includeInactive: false }),
    listBranches(context, db, { includeInactive: false }),
    listProducts(context, db, { includeInactive: false }),
    listPaymentMethods(context, db, { includeInactive: false }),
    listLossReasons(context, db, { includeInactive: false }),
  ]);

  return {
    insurers,
    branches,
    products,
    paymentMethods,
    lossReasons,
    defaultInsurerId: insurers.find((insurer) => insurer.isDefault)?.id ?? null,
  };
}

export async function resolveCatalogItem(
  context: AuthenticatedUserContext,
  db: D1Database,
  type: string,
  id: string,
): Promise<
  InsurerDto | InsuranceBranchDto | InsuranceProductDto | PaymentMethodDto | LossReasonDto
> {
  const normalizedType = type.toLowerCase().replace(/-/g, '_');
  switch (normalizedType) {
    case 'insurer':
    case 'insurers':
      return getInsurer(context, db, id);
    case 'branch':
    case 'branches':
    case 'insurance_branch':
    case 'insurance_branches':
      return getBranch(context, db, id);
    case 'product':
    case 'products':
    case 'insurance_product':
    case 'insurance_products':
      return getProduct(context, db, id);
    case 'payment_method':
    case 'payment_methods':
      return getPaymentMethod(context, db, id);
    case 'loss_reason':
    case 'loss_reasons':
      return getLossReason(context, db, id);
    default:
      throw new CatalogItemNotFoundError(`Bilinmeyen katalog türü: ${type}`);
  }
}

// ---------------------- MUTASYON METOTLARI ----------------------

export async function createInsurer(
  context: AuthenticatedUserContext,
  db: D1Database,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsurerDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.insurer.create', mem.agencyId);

  const parsed = CreateInsurerSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz sigorta şirketi bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const insurerId = crypto.randomUUID();
  const res = await executeCatalogDomainCommand<InsurerDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'insurer.create',
      insurerId,
      code: parsed.data.code,
      name: parsed.data.name,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 201,
        body: {
          id: insurerId,
          agencyId: mem.agencyId,
          code: parsed.data.code,
          name: parsed.data.name,
          status: 'ACTIVE',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function updateInsurer(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsurerDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.insurer.update', mem.agencyId);

  const parsed = UpdateInsurerSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz sigorta şirketi güncelleme bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const current = await getInsurer(context, db, id);

  const res = await executeCatalogDomainCommand<InsurerDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'insurer.update',
      insurerId: id,
      expectedVersion: parsed.data.expectedVersion,
      name: parsed.data.name,
      changedFields: ['name'],
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          name: parsed.data.name,
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function deactivateInsurer(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsurerDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.insurer.deactivate', mem.agencyId);

  const parsed = DeactivateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz devre dışı bırakma parametreleri');
  }

  const current = await getInsurer(context, db, id);

  const res = await executeCatalogDomainCommand<InsurerDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'insurer.deactivate',
      insurerId: id,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          status: 'INACTIVE',
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function createBranch(
  context: AuthenticatedUserContext,
  db: D1Database,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceBranchDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.branch.create', mem.agencyId);

  const parsed = CreateBranchSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz branş bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const branchId = crypto.randomUUID();
  const res = await executeCatalogDomainCommand<InsuranceBranchDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'branch.create',
      branchId,
      code: parsed.data.code,
      name: parsed.data.name,
      dataClassification: parsed.data.dataClassification,
      supportsVehicleDetails: parsed.data.supportsVehicleDetails ?? false,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 201,
        body: {
          id: branchId,
          agencyId: mem.agencyId,
          code: parsed.data.code,
          name: parsed.data.name,
          dataClassification: parsed.data.dataClassification,
          supportsVehicleDetails: parsed.data.supportsVehicleDetails ?? false,
          status: 'ACTIVE',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function updateBranch(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceBranchDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.branch.update', mem.agencyId);

  const parsed = UpdateBranchSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz branş güncelleme bilgileri');
  }

  const current = await getBranch(context, db, id);

  const res = await executeCatalogDomainCommand<InsuranceBranchDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'branch.update',
      branchId: id,
      expectedVersion: parsed.data.expectedVersion,
      name: parsed.data.name,
      supportsVehicleDetails: parsed.data.supportsVehicleDetails,
      changedFields: Object.keys(parsed.data).filter((field) => field !== 'expectedVersion'),
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          name: parsed.data.name,
          supportsVehicleDetails:
            parsed.data.supportsVehicleDetails ?? current.supportsVehicleDetails,
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function correctBranchClassification(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceBranchDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.branch.correct_classification', mem.agencyId);
  const parsed = z
    .object({
      expectedVersion: z.number().int().positive(),
      reasonCode: z.enum(BRANCH_CLASSIFICATION_CORRECTION_REASONS),
    })
    .strict()
    .safeParse(payload);
  if (!parsed.success) throw new CatalogValidationError('Geçerli bir düzeltme gerekçesi seçin.');

  const current = await getBranch(context, db, id);
  const { expectedVersion, reasonCode } = parsed.data;
  const result = await executeCatalogDomainCommand<InsuranceBranchDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: { branchId: id, expectedVersion, reasonCode },
    command: { kind: 'branch.correct_classification', branchId: id, expectedVersion, reasonCode },
    resultProducer: () => ({
      status: 200,
      body: {
        ...current,
        dataClassification: 'HEALTH',
        canCorrectClassification: false,
        version: expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      },
    }),
  });
  return { status: result.status, data: result.body };
}

export async function deactivateBranch(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceBranchDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.branch.deactivate', mem.agencyId);

  const parsed = DeactivateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz devre dışı bırakma parametreleri');
  }

  const current = await getBranch(context, db, id);

  const res = await executeCatalogDomainCommand<InsuranceBranchDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'branch.deactivate',
      branchId: id,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          status: 'INACTIVE',
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function createProduct(
  context: AuthenticatedUserContext,
  db: D1Database,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceProductDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.product.create', mem.agencyId);

  const parsed = CreateProductSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz ürün bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const productId = crypto.randomUUID();
  const res = await executeCatalogDomainCommand<InsuranceProductDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'product.create',
      productId,
      insurerId: parsed.data.insurerId,
      branchId: parsed.data.branchId,
      code: parsed.data.code,
      name: parsed.data.name,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 201,
        body: {
          id: productId,
          agencyId: mem.agencyId,
          insurerId: parsed.data.insurerId,
          branchId: parsed.data.branchId,
          code: parsed.data.code,
          name: parsed.data.name,
          status: 'ACTIVE',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function updateProduct(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceProductDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.product.update', mem.agencyId);

  const parsed = UpdateProductSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz ürün güncelleme bilgileri');
  }

  const current = await getProduct(context, db, id);
  const changedFields: string[] = [];
  if (parsed.data.name !== undefined) changedFields.push('name');
  if (parsed.data.branchId !== undefined) changedFields.push('branchId');

  const res = await executeCatalogDomainCommand<InsuranceProductDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'product.update',
      productId: id,
      expectedVersion: parsed.data.expectedVersion,
      name: parsed.data.name,
      branchId: parsed.data.branchId,
      changedFields,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          name: parsed.data.name ?? current.name,
          branchId: parsed.data.branchId ?? current.branchId,
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function deactivateProduct(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: InsuranceProductDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.product.deactivate', mem.agencyId);

  const parsed = DeactivateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz devre dışı bırakma parametreleri');
  }

  const current = await getProduct(context, db, id);

  const res = await executeCatalogDomainCommand<InsuranceProductDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'product.deactivate',
      productId: id,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          status: 'INACTIVE',
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function createPaymentMethod(
  context: AuthenticatedUserContext,
  db: D1Database,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: PaymentMethodDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.payment_method.create', mem.agencyId);

  const parsed = CreatePaymentMethodSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz ödeme yöntemi bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const paymentMethodId = crypto.randomUUID();
  const res = await executeCatalogDomainCommand<PaymentMethodDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'payment_method.create',
      paymentMethodId,
      code: parsed.data.code,
      name: parsed.data.name,
      supportsInstallments: parsed.data.supportsInstallments,
      maxInstallments: parsed.data.maxInstallments,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 201,
        body: {
          id: paymentMethodId,
          agencyId: mem.agencyId,
          code: parsed.data.code,
          name: parsed.data.name,
          supportsInstallments: parsed.data.supportsInstallments,
          maxInstallments: parsed.data.maxInstallments,
          status: 'ACTIVE',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function updatePaymentMethod(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: PaymentMethodDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.payment_method.update', mem.agencyId);

  const parsed = UpdatePaymentMethodSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz ödeme yöntemi güncelleme bilgileri');
  }

  const current = await getPaymentMethod(context, db, id);

  const res = await executeCatalogDomainCommand<PaymentMethodDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'payment_method.update',
      paymentMethodId: id,
      expectedVersion: parsed.data.expectedVersion,
      name: parsed.data.name,
      supportsInstallments: parsed.data.supportsInstallments,
      maxInstallments: parsed.data.maxInstallments,
      changedFields: Object.keys(parsed.data).filter((field) => field !== 'expectedVersion'),
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.supportsInstallments !== undefined
            ? { supportsInstallments: parsed.data.supportsInstallments }
            : {}),
          ...(parsed.data.maxInstallments !== undefined
            ? { maxInstallments: parsed.data.maxInstallments }
            : {}),
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function deactivatePaymentMethod(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: PaymentMethodDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.payment_method.deactivate', mem.agencyId);

  const parsed = DeactivateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz devre dışı bırakma parametreleri');
  }

  const current = await getPaymentMethod(context, db, id);

  const res = await executeCatalogDomainCommand<PaymentMethodDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'payment_method.deactivate',
      paymentMethodId: id,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          status: 'INACTIVE',
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function createLossReason(
  context: AuthenticatedUserContext,
  db: D1Database,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: LossReasonDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.loss_reason.create', mem.agencyId);

  const parsed = CreateLossReasonSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz kayıp nedeni bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const lossReasonId = crypto.randomUUID();
  const res = await executeCatalogDomainCommand<LossReasonDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'loss_reason.create',
      lossReasonId,
      code: parsed.data.code,
      name: parsed.data.name,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 201,
        body: {
          id: lossReasonId,
          agencyId: mem.agencyId,
          code: parsed.data.code,
          name: parsed.data.name,
          status: 'ACTIVE',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function updateLossReason(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: LossReasonDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.loss_reason.update', mem.agencyId);

  const parsed = UpdateLossReasonSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz kayıp nedeni güncelleme bilgileri');
  }

  const current = await getLossReason(context, db, id);

  const res = await executeCatalogDomainCommand<LossReasonDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'loss_reason.update',
      lossReasonId: id,
      expectedVersion: parsed.data.expectedVersion,
      name: parsed.data.name,
      changedFields: ['name'],
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          name: parsed.data.name,
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function deactivateLossReason(
  context: AuthenticatedUserContext,
  db: D1Database,
  id: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: LossReasonDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'catalog.loss_reason.deactivate', mem.agencyId);

  const parsed = DeactivateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError('Geçersiz devre dışı bırakma parametreleri');
  }

  const current = await getLossReason(context, db, id);

  const res = await executeCatalogDomainCommand<LossReasonDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'loss_reason.deactivate',
      lossReasonId: id,
      expectedVersion: parsed.data.expectedVersion,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          ...current,
          status: 'INACTIVE',
          version: parsed.data.expectedVersion + 1,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

export async function updateAgencySettings(
  context: AuthenticatedUserContext,
  db: D1Database,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; data: AgencySettingsDto }> {
  const mem = getActiveMembership(context);
  await authorizeAction(db, context, 'agency.settings.update_operations', mem.agencyId);

  const parsed = UpdateAgencySettingsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CatalogValidationError(
      'Geçersiz acente ayarları bilgileri',
      parsed.error.flatten().fieldErrors as Record<string, string>,
    );
  }

  const current = await getAgencySettings(context, db);
  const changedFields: string[] = [];
  if (parsed.data.timezone !== undefined) changedFields.push('timezone');
  if (parsed.data.renewalWindowDays !== undefined) changedFields.push('renewalWindowDays');
  if (parsed.data.defaultInsurerId !== undefined) changedFields.push('defaultInsurerId');
  if (parsed.data.deactivateOldDefault) changedFields.push('deactivateOldDefault');

  const res = await executeCatalogDomainCommand<AgencySettingsDto>({
    db,
    agencyId: mem.agencyId,
    actorUserId: context.userId,
    actorMembershipId: mem.id,
    expectedPermissionVersion: mem.permissionVersion,
    correlationId: crypto.randomUUID(),
    idempotencyKey,
    payload: parsed.data,
    command: {
      kind: 'agency_settings.update_operations',
      settingsId: current.id,
      expectedVersion: parsed.data.expectedVersion,
      timezone: parsed.data.timezone,
      renewalWindowDays: parsed.data.renewalWindowDays,
      defaultInsurerId: parsed.data.defaultInsurerId,
      deactivateOldDefault: parsed.data.deactivateOldDefault,
      oldDefaultInsurerId: current.defaultInsurerId,
      changedFields,
    },
    resultProducer: () => {
      const now = new Date().toISOString();
      return {
        status: 200,
        body: {
          id: current.id,
          agencyId: mem.agencyId,
          defaultInsurerId:
            parsed.data.defaultInsurerId !== undefined
              ? parsed.data.defaultInsurerId
              : current.defaultInsurerId,
          timezone: parsed.data.timezone ?? current.timezone,
          renewalWindowDays: parsed.data.renewalWindowDays ?? current.renewalWindowDays,
          version: parsed.data.expectedVersion + 1,
          createdAt: current.createdAt,
          updatedAt: now,
        },
      };
    },
  });

  return { status: res.status, data: res.body };
}

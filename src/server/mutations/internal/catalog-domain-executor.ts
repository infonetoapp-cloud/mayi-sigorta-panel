/**
 * Mayı Sigorta CRM — Dahili Katalog ve Acente Ayarları Domain Mutasyon Yürütücüsü (M2-T03 Sealed Internal Capability)
 *
 * MİMARİ VE GÜVENLİK SÖZLEŞMESİ:
 * 1. Kapalı Dahili Yetenek (Sealed Internal Capability):
 *    Bu modül YALNIZCA `src/server/catalogs/service.ts` tarafından içe aktarılabilir.
 *    Başka hiçbir production sunucu dosyası, route handler veya harici modül doğrudan erişemez.
 * 2. Caller-Selected Authority Girdisi Yasağı:
 *    İstemci yetki, sürüm veya acente sınırını belirleyemez.
 * 3. Atomik ve Kapsamlı Nihai Yetki Recheck (Batch Invariant):
 *    Batch'in en başında, SQLite düzeyinde atomik CAS assertion ile:
 *    - Aktörün kullanıcı, acente ve üyelik durumlarının ACTIVE olduğu,
 *    - Snapshot'taki `expectedPermissionVersion` ile `m.permission_version`'ın tam eşleştiği,
 *    - OWNER için implicit NORMAL yetkisinin geçerli olduğu,
 *    - MEMBER için catalog.* eylemlerinde 'catalog.manage' (UNSCOPED),
 *      agency.settings.update_operations eyleminde 'agency.settings.manage' (UNSCOPED) izninin bulunduğu,
 *    - Bir iznin diğerini kesinlikle açmadığı,
 *    doğrulanır. Herhangi bir ihlalde tüm batch (makbuz, veri, denetim) veritabanı düzeyinde ROLLBACK olur.
 * 4. Deterministik Idempotency: Aynı anahtar ve aynı kanonik payload tekrarlarında replay döner.
 * 5. Güvenli Denetim (Safe Audit): Asla serbest metin (label/body) veya PII loglanmaz.
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

export type CatalogDomainCommand =
  | {
      readonly kind: 'insurer.create';
      readonly insurerId: string;
      readonly code: string;
      readonly name: string;
    }
  | {
      readonly kind: 'insurer.update';
      readonly insurerId: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'insurer.deactivate';
      readonly insurerId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'branch.create';
      readonly branchId: string;
      readonly code: string;
      readonly name: string;
      readonly dataClassification?: 'GENERAL' | 'HEALTH';
    }
  | {
      readonly kind: 'branch.update';
      readonly branchId: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'branch.deactivate';
      readonly branchId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'product.create';
      readonly productId: string;
      readonly insurerId: string;
      readonly branchId: string;
      readonly code: string;
      readonly name: string;
    }
  | {
      readonly kind: 'product.update';
      readonly productId: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly branchId?: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'product.deactivate';
      readonly productId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'payment_method.create';
      readonly paymentMethodId: string;
      readonly code: string;
      readonly name: string;
      readonly supportsInstallments?: boolean;
      readonly maxInstallments?: number;
    }
  | {
      readonly kind: 'payment_method.update';
      readonly paymentMethodId: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly supportsInstallments?: boolean;
      readonly maxInstallments?: number;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'payment_method.deactivate';
      readonly paymentMethodId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'loss_reason.create';
      readonly lossReasonId: string;
      readonly code: string;
      readonly name: string;
    }
  | {
      readonly kind: 'loss_reason.update';
      readonly lossReasonId: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: 'loss_reason.deactivate';
      readonly lossReasonId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: 'agency_settings.update_operations';
      readonly settingsId: string;
      readonly expectedVersion: number;
      readonly timezone?: string;
      readonly renewalWindowDays?: number;
      readonly defaultInsurerId?: string | null;
      readonly deactivateOldDefault?: boolean;
      readonly oldDefaultInsurerId?: string | null;
      readonly changedFields: readonly string[];
    };

export interface ExecuteCatalogDomainCommandInput<TResult = unknown> {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly expectedPermissionVersion: number;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly command: CatalogDomainCommand;
  readonly resultProducer: () => { status: number; body: TResult };
}

export interface CatalogDomainCommandResult<TResult = unknown> {
  readonly executed: boolean;
  readonly replayed: boolean;
  readonly status: number;
  readonly body: TResult;
}

type CatalogDomainCommandKind = CatalogDomainCommand['kind'];

interface IdempotencyLookup<TResult> {
  readonly action: string;
  readonly payloadFingerprint: string;
  readonly trimmedIdempotencyKey: string;
  readonly replay: CatalogDomainCommandResult<TResult> | null;
}

function actionForCommandKind(kind: CatalogDomainCommandKind): string {
  switch (kind) {
    case 'insurer.create':
      return 'catalog.insurer.create';
    case 'insurer.update':
      return 'catalog.insurer.update';
    case 'insurer.deactivate':
      return 'catalog.insurer.deactivate';
    case 'branch.create':
      return 'catalog.branch.create';
    case 'branch.update':
      return 'catalog.branch.update';
    case 'branch.deactivate':
      return 'catalog.branch.deactivate';
    case 'product.create':
      return 'catalog.product.create';
    case 'product.update':
      return 'catalog.product.update';
    case 'product.deactivate':
      return 'catalog.product.deactivate';
    case 'payment_method.create':
      return 'catalog.payment_method.create';
    case 'payment_method.update':
      return 'catalog.payment_method.update';
    case 'payment_method.deactivate':
      return 'catalog.payment_method.deactivate';
    case 'loss_reason.create':
      return 'catalog.loss_reason.create';
    case 'loss_reason.update':
      return 'catalog.loss_reason.update';
    case 'loss_reason.deactivate':
      return 'catalog.loss_reason.deactivate';
    case 'agency_settings.update_operations':
      return 'agency.settings.update_operations';
    default: {
      const exhaustiveCheck: never = kind;
      throw new Error(`UNSUPPORTED_CATALOG_COMMAND_KIND: ${String(exhaustiveCheck)}`);
    }
  }
}

async function lookupIdempotency<TResult>(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly commandKind: CatalogDomainCommandKind;
}): Promise<IdempotencyLookup<TResult>> {
  if (
    !input.idempotencyKey ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim().length === 0
  ) {
    throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  }

  const trimmedIdempotencyKey = input.idempotencyKey.trim();
  const action = actionForCommandKind(input.commandKind);
  const payloadFingerprint = await computePayloadHash(input.payload);
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
  try {
    parsedBody = JSON.parse(existingReceipt.response_body) as TResult;
  } catch {
    parsedBody = existingReceipt.response_body as unknown as TResult;
  }
  return {
    action,
    payloadFingerprint,
    trimmedIdempotencyKey,
    replay: {
      executed: false,
      replayed: true,
      status: existingReceipt.response_status,
      body: parsedBody,
    },
  };
}

export async function replayCompletedCatalogDomainCommand<TResult>(input: {
  readonly db: D1Database;
  readonly agencyId: string;
  readonly actorUserId: string;
  readonly actorMembershipId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly commandKind: CatalogDomainCommandKind;
}): Promise<CatalogDomainCommandResult<TResult> | null> {
  return (await lookupIdempotency<TResult>(input)).replay;
}

interface CommandExecutionPlan {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly auditMetadata: Record<string, unknown>;
  readonly businessStatements: Array<{
    statement: D1PreparedStatement;
    expectedChanges: number;
    failureCode?: string;
  }>;
}

async function planCommand(
  db: D1Database,
  agencyId: string,
  command: CatalogDomainCommand,
): Promise<CommandExecutionPlan> {
  const now = new Date().toISOString();
  const action = actionForCommandKind(command.kind);

  switch (command.kind) {
    case 'insurer.create': {
      const insertStmt = db
        .prepare(
          `INSERT INTO insurers (
             id, agency_id, code, name, status, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        )
        .bind(command.insurerId, agencyId, command.code, command.name, now, now);

      return {
        action,
        targetType: 'insurers',
        targetId: command.insurerId,
        auditMetadata: {
          insurerId: command.insurerId,
          code: command.code,
          status: 'ACTIVE',
        },
        businessStatements: [
          {
            statement: insertStmt,
            expectedChanges: 1,
            failureCode: 'INSURER_INSERT_FAILED',
          },
        ],
      };
    }

    case 'insurer.update': {
      const nextVersion = command.expectedVersion + 1;
      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.name !== undefined) updates.push({ col: 'name', val: command.name });

      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([nextVersion, now, command.insurerId, agencyId, command.expectedVersion]);

      const updateStmt = db
        .prepare(
          `UPDATE insurers
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action,
        targetType: 'insurers',
        targetId: command.insurerId,
        auditMetadata: {
          insurerId: command.insurerId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
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

    case 'insurer.deactivate': {
      // Current default insurer cannot simply be deactivated!
      const currentDefault = await db
        .prepare(
          `SELECT default_insurer_id FROM agency_settings
           WHERE agency_id = ? AND default_insurer_id = ? LIMIT 1`,
        )
        .bind(agencyId, command.insurerId)
        .first<{ default_insurer_id: string }>();

      if (currentDefault) {
        throw new DomainConstraintViolationError(
          'CANNOT_DEACTIVATE_DEFAULT_INSURER',
          'Varsayılan sigortacı doğrudan devre dışı bırakılamaz. Önce yeni bir varsayılan atanmalıdır.',
        );
      }

      const nextVersion = command.expectedVersion + 1;
      const deactivateStmt = db
        .prepare(
          `UPDATE insurers
           SET status = 'INACTIVE', version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(nextVersion, now, command.insurerId, agencyId, command.expectedVersion);

      return {
        action,
        targetType: 'insurers',
        targetId: command.insurerId,
        auditMetadata: {
          insurerId: command.insurerId,
          targetVersion: nextVersion,
          status: 'INACTIVE',
          activeResult: 'INACTIVE',
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

    case 'branch.create': {
      const insertStmt = db
        .prepare(
          `INSERT INTO insurance_branches (
             id, agency_id, code, name, data_classification, status, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        )
        .bind(
          command.branchId,
          agencyId,
          command.code,
          command.name,
          command.dataClassification ?? 'GENERAL',
          now,
          now,
        );

      return {
        action,
        targetType: 'insurance_branches',
        targetId: command.branchId,
        auditMetadata: {
          branchId: command.branchId,
          code: command.code,
          status: 'ACTIVE',
        },
        businessStatements: [
          {
            statement: insertStmt,
            expectedChanges: 1,
            failureCode: 'BRANCH_INSERT_FAILED',
          },
        ],
      };
    }

    case 'branch.update': {
      const nextVersion = command.expectedVersion + 1;
      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.name !== undefined) updates.push({ col: 'name', val: command.name });

      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([nextVersion, now, command.branchId, agencyId, command.expectedVersion]);

      const updateStmt = db
        .prepare(
          `UPDATE insurance_branches
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action,
        targetType: 'insurance_branches',
        targetId: command.branchId,
        auditMetadata: {
          branchId: command.branchId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
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

    case 'branch.deactivate': {
      const nextVersion = command.expectedVersion + 1;
      const deactivateStmt = db
        .prepare(
          `UPDATE insurance_branches
           SET status = 'INACTIVE', version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(nextVersion, now, command.branchId, agencyId, command.expectedVersion);

      return {
        action,
        targetType: 'insurance_branches',
        targetId: command.branchId,
        auditMetadata: {
          branchId: command.branchId,
          targetVersion: nextVersion,
          status: 'INACTIVE',
          activeResult: 'INACTIVE',
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

    case 'product.create': {
      // Enforce insurer and branch are same-agency and ACTIVE in application
      const insurerRow = await db
        .prepare('SELECT id, status FROM insurers WHERE id = ? AND agency_id = ?')
        .bind(command.insurerId, agencyId)
        .first<{ id: string; status: string }>();
      if (!insurerRow) {
        throw new DomainConstraintViolationError(
          'INSURER_NOT_FOUND',
          'Belirtilen sigorta şirketi bulunamadı veya başka acenteye ait.',
        );
      }
      if (insurerRow.status !== 'ACTIVE') {
        throw new DomainConstraintViolationError(
          'INSURER_NOT_ACTIVE',
          'Yalnızca aktif bir sigorta şirketine ürün bağlanabilir.',
        );
      }

      const branchRow = await db
        .prepare('SELECT id, status FROM insurance_branches WHERE id = ? AND agency_id = ?')
        .bind(command.branchId, agencyId)
        .first<{ id: string; status: string }>();
      if (!branchRow) {
        throw new DomainConstraintViolationError(
          'BRANCH_NOT_FOUND',
          'Belirtilen branş bulunamadı veya başka acenteye ait.',
        );
      }
      if (branchRow.status !== 'ACTIVE') {
        throw new DomainConstraintViolationError(
          'BRANCH_NOT_ACTIVE',
          'Yalnızca aktif bir branşa ürün bağlanabilir.',
        );
      }

      const insertStmt = db
        .prepare(
          `INSERT INTO insurance_products (
             id, agency_id, insurer_id, branch_id, code, name, status, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        )
        .bind(
          command.productId,
          agencyId,
          command.insurerId,
          command.branchId,
          command.code,
          command.name,
          now,
          now,
        );

      return {
        action,
        targetType: 'insurance_products',
        targetId: command.productId,
        auditMetadata: {
          productId: command.productId,
          insurerId: command.insurerId,
          branchId: command.branchId,
          code: command.code,
          status: 'ACTIVE',
        },
        businessStatements: [
          {
            statement: insertStmt,
            expectedChanges: 1,
            failureCode: 'PRODUCT_INSERT_FAILED',
          },
        ],
      };
    }

    case 'product.update': {
      if (command.branchId !== undefined) {
        const branchRow = await db
          .prepare('SELECT id, status FROM insurance_branches WHERE id = ? AND agency_id = ?')
          .bind(command.branchId, agencyId)
          .first<{ id: string; status: string }>();
        if (!branchRow || branchRow.status !== 'ACTIVE') {
          throw new DomainConstraintViolationError('BRANCH_NOT_ACTIVE_OR_NOT_FOUND');
        }
      }

      const nextVersion = command.expectedVersion + 1;
      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.name !== undefined) updates.push({ col: 'name', val: command.name });
      if (command.branchId !== undefined) updates.push({ col: 'branch_id', val: command.branchId });

      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([nextVersion, now, command.productId, agencyId, command.expectedVersion]);

      const updateStmt = db
        .prepare(
          `UPDATE insurance_products
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action,
        targetType: 'insurance_products',
        targetId: command.productId,
        auditMetadata: {
          productId: command.productId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
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

    case 'product.deactivate': {
      const nextVersion = command.expectedVersion + 1;
      const deactivateStmt = db
        .prepare(
          `UPDATE insurance_products
           SET status = 'INACTIVE', version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(nextVersion, now, command.productId, agencyId, command.expectedVersion);

      return {
        action,
        targetType: 'insurance_products',
        targetId: command.productId,
        auditMetadata: {
          productId: command.productId,
          targetVersion: nextVersion,
          status: 'INACTIVE',
          activeResult: 'INACTIVE',
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

    case 'payment_method.create': {
      const insertStmt = db
        .prepare(
          `INSERT INTO payment_methods (
             id, agency_id, code, name, supports_installments, max_installments, status, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        )
        .bind(
          command.paymentMethodId,
          agencyId,
          command.code,
          command.name,
          command.supportsInstallments === true ? 1 : 0,
          command.maxInstallments ?? 12,
          now,
          now,
        );

      return {
        action,
        targetType: 'payment_methods',
        targetId: command.paymentMethodId,
        auditMetadata: {
          paymentMethodId: command.paymentMethodId,
          code: command.code,
          status: 'ACTIVE',
        },
        businessStatements: [
          {
            statement: insertStmt,
            expectedChanges: 1,
            failureCode: 'PAYMENT_METHOD_INSERT_FAILED',
          },
        ],
      };
    }

    case 'payment_method.update': {
      const nextVersion = command.expectedVersion + 1;
      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.name !== undefined) updates.push({ col: 'name', val: command.name });
      if (command.supportsInstallments !== undefined)
        updates.push({ col: 'supports_installments', val: command.supportsInstallments ? 1 : 0 });
      if (command.maxInstallments !== undefined)
        updates.push({ col: 'max_installments', val: command.maxInstallments });

      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([nextVersion, now, command.paymentMethodId, agencyId, command.expectedVersion]);

      const updateStmt = db
        .prepare(
          `UPDATE payment_methods
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action,
        targetType: 'payment_methods',
        targetId: command.paymentMethodId,
        auditMetadata: {
          paymentMethodId: command.paymentMethodId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
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

    case 'payment_method.deactivate': {
      const nextVersion = command.expectedVersion + 1;
      const deactivateStmt = db
        .prepare(
          `UPDATE payment_methods
           SET status = 'INACTIVE', version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(nextVersion, now, command.paymentMethodId, agencyId, command.expectedVersion);

      return {
        action,
        targetType: 'payment_methods',
        targetId: command.paymentMethodId,
        auditMetadata: {
          paymentMethodId: command.paymentMethodId,
          targetVersion: nextVersion,
          status: 'INACTIVE',
          activeResult: 'INACTIVE',
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

    case 'loss_reason.create': {
      const insertStmt = db
        .prepare(
          `INSERT INTO loss_reasons (
             id, agency_id, code, name, status, version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
        )
        .bind(command.lossReasonId, agencyId, command.code, command.name, now, now);

      return {
        action,
        targetType: 'loss_reasons',
        targetId: command.lossReasonId,
        auditMetadata: {
          lossReasonId: command.lossReasonId,
          code: command.code,
          status: 'ACTIVE',
        },
        businessStatements: [
          {
            statement: insertStmt,
            expectedChanges: 1,
            failureCode: 'LOSS_REASON_INSERT_FAILED',
          },
        ],
      };
    }

    case 'loss_reason.update': {
      const nextVersion = command.expectedVersion + 1;
      const updates: Array<{ col: string; val: unknown }> = [];
      if (command.name !== undefined) updates.push({ col: 'name', val: command.name });

      const setClauses = updates
        .map((u) => `${u.col} = ?`)
        .concat(['version = ?', 'updated_at = ?']);
      const bindValues = updates
        .map((u) => u.val)
        .concat([nextVersion, now, command.lossReasonId, agencyId, command.expectedVersion]);

      const updateStmt = db
        .prepare(
          `UPDATE loss_reasons
           SET ${setClauses.join(', ')}
           WHERE id = ? AND agency_id = ? AND version = ?`,
        )
        .bind(...bindValues);

      return {
        action,
        targetType: 'loss_reasons',
        targetId: command.lossReasonId,
        auditMetadata: {
          lossReasonId: command.lossReasonId,
          targetVersion: nextVersion,
          changedFields: [...command.changedFields],
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

    case 'loss_reason.deactivate': {
      const nextVersion = command.expectedVersion + 1;
      const deactivateStmt = db
        .prepare(
          `UPDATE loss_reasons
           SET status = 'INACTIVE', version = ?, updated_at = ?
           WHERE id = ? AND agency_id = ? AND version = ? AND status = 'ACTIVE'`,
        )
        .bind(nextVersion, now, command.lossReasonId, agencyId, command.expectedVersion);

      return {
        action,
        targetType: 'loss_reasons',
        targetId: command.lossReasonId,
        auditMetadata: {
          lossReasonId: command.lossReasonId,
          targetVersion: nextVersion,
          status: 'INACTIVE',
          activeResult: 'INACTIVE',
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

    case 'agency_settings.update_operations': {
      // Check existing settings
      const existingSettings = await db
        .prepare(
          `SELECT id, default_insurer_id, timezone, renewal_window_days, version
           FROM agency_settings WHERE agency_id = ? LIMIT 1`,
        )
        .bind(agencyId)
        .first<{
          id: string;
          default_insurer_id: string | null;
          timezone: string;
          renewal_window_days: number;
          version: number;
        }>();

      if (command.defaultInsurerId) {
        const ins = await db
          .prepare('SELECT id, status FROM insurers WHERE id = ? AND agency_id = ?')
          .bind(command.defaultInsurerId, agencyId)
          .first<{ id: string; status: string }>();
        if (!ins) {
          throw new DomainConstraintViolationError(
            'INSURER_NOT_FOUND',
            'Varsayılan atanacak sigorta şirketi bulunamadı veya başka acenteye ait.',
          );
        }
        if (ins.status !== 'ACTIVE') {
          throw new DomainConstraintViolationError(
            'DEFAULT_INSURER_MUST_BE_ACTIVE',
            'Yalnızca aktif bir sigorta şirketi varsayılan yapılabilir.',
          );
        }
      }

      const businessStatements: CommandExecutionPlan['businessStatements'] = [];
      const nextVersion = command.expectedVersion + 1;
      let targetSettingsId: string;

      if (!existingSettings) {
        // First time insertion of agency_settings
        targetSettingsId = command.settingsId || crypto.randomUUID();
        const insertStmt = db
          .prepare(
            `INSERT INTO agency_settings (
               id, agency_id, default_insurer_id, timezone, renewal_window_days, version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            targetSettingsId,
            agencyId,
            command.defaultInsurerId ?? null,
            command.timezone ?? 'Europe/Istanbul',
            command.renewalWindowDays ?? 30,
            nextVersion,
            now,
            now,
          );
        businessStatements.push({
          statement: insertStmt,
          expectedChanges: 1,
          failureCode: 'SETTINGS_INSERT_FAILED',
        });
      } else {
        targetSettingsId = existingSettings.id;
        const updates: Array<{ col: string; val: unknown }> = [];
        if (command.timezone !== undefined)
          updates.push({ col: 'timezone', val: command.timezone });
        if (command.renewalWindowDays !== undefined)
          updates.push({ col: 'renewal_window_days', val: command.renewalWindowDays });
        if (command.defaultInsurerId !== undefined)
          updates.push({ col: 'default_insurer_id', val: command.defaultInsurerId });

        const setClauses = updates
          .map((u) => `${u.col} = ?`)
          .concat(['version = ?', 'updated_at = ?']);
        const bindValues = updates
          .map((u) => u.val)
          .concat([nextVersion, now, targetSettingsId, agencyId, command.expectedVersion]);

        const updateStmt = db
          .prepare(
            `UPDATE agency_settings
             SET ${setClauses.join(', ')}
             WHERE id = ? AND agency_id = ? AND version = ?`,
          )
          .bind(...bindValues);

        businessStatements.push({
          statement: updateStmt,
          expectedChanges: 1,
          failureCode: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
        });
      }

      // If atomic switch with old deactivation requested:
      const oldDefaultToDeactivate =
        command.deactivateOldDefault &&
        command.defaultInsurerId &&
        (command.oldDefaultInsurerId || existingSettings?.default_insurer_id);

      if (oldDefaultToDeactivate) {
        const oldId = command.oldDefaultInsurerId || existingSettings?.default_insurer_id;
        if (oldId && oldId !== command.defaultInsurerId) {
          const deactOldStmt = db
            .prepare(
              `UPDATE insurers
               SET status = 'INACTIVE', version = version + 1, updated_at = ?
               WHERE id = ? AND agency_id = ? AND status = 'ACTIVE'`,
            )
            .bind(now, oldId, agencyId);

          businessStatements.push({
            statement: deactOldStmt,
            expectedChanges: 1,
            failureCode: 'OLD_DEFAULT_DEACTIVATION_FAILED',
          });
        }
      }

      return {
        action,
        targetType: 'agency_settings',
        targetId: targetSettingsId,
        auditMetadata: {
          settingsId: targetSettingsId,
          targetVersion: nextVersion,
          beforeDefaultInsurerId: existingSettings?.default_insurer_id ?? null,
          afterDefaultInsurerId:
            command.defaultInsurerId !== undefined
              ? command.defaultInsurerId
              : (existingSettings?.default_insurer_id ?? null),
          deactivatedOldDefault: Boolean(command.deactivateOldDefault),
          changedFields: [...command.changedFields],
        },
        businessStatements,
      };
    }

    default: {
      const exhaustiveCheck: never = command;
      throw new Error(`UNSUPPORTED_DOMAIN_COMMAND: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function executeCatalogDomainCommand<TResult>(
  input: ExecuteCatalogDomainCommandInput<TResult>,
): Promise<CatalogDomainCommandResult<TResult>> {
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

  const idempotency = await lookupIdempotency<TResult>({
    db,
    agencyId,
    actorUserId,
    actorMembershipId,
    idempotencyKey,
    payload: input.payload,
    commandKind: command.kind,
  });
  if (idempotency.replay) return idempotency.replay;
  const { action, payloadFingerprint, trimmedIdempotencyKey } = idempotency;

  let plan: CommandExecutionPlan;
  try {
    plan = await planCommand(db, agencyId, command);
  } catch (planningError) {
    const afterFailure = await lookupIdempotency<TResult>({
      db,
      agencyId,
      actorUserId,
      actorMembershipId,
      idempotencyKey,
      payload: input.payload,
      commandKind: command.kind,
    });
    if (afterFailure.replay) return afterFailure.replay;
    throw planningError;
  }
  if (plan.action !== action) {
    throw new Error('DOMAIN_COMMAND_ACTION_MAPPING_MISMATCH');
  }

  // Pre-flight checks on user, agency, membership
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
      'SELECT id, status, type, permission_version FROM agency_memberships WHERE id = ? AND agency_id = ?',
    )
    .bind(actorMembershipId, agencyId)
    .first<{ id: unknown; status: unknown; type: unknown; permission_version: number }>();
  if (!membershipRow || membershipRow.status !== 'ACTIVE') {
    throw new Error('ACTIVE_MEMBERSHIP_REQUIRED');
  }

  const batchStatements: D1PreparedStatement[] = [];

  // 1. Atomic Final Authority & CAS Assertion (At Start of Batch)
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
               m.type = 'OWNER'
               OR (
                 -- Action begins with catalog.* -> requires catalog.manage (UNSCOPED)
                 (
                   ? LIKE 'catalog.%'
                   AND EXISTS (
                     SELECT 1 FROM membership_permissions p
                     WHERE p.membership_id = m.id
                       AND p.permission_code = 'catalog.manage'
                       AND p.scope = 'UNSCOPED'
                   )
                 )
                 OR
                 -- Action is agency.settings.update_operations -> requires agency.settings.manage (UNSCOPED)
                 (
                   ? = 'agency.settings.update_operations'
                   AND EXISTS (
                     SELECT 1 FROM membership_permissions p
                     WHERE p.membership_id = m.id
                       AND p.permission_code = 'agency.settings.manage'
                       AND p.scope = 'UNSCOPED'
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
      plan.action,
      plan.action,
    );
  batchStatements.push(finalAuthorityRecheckStmt);

  // 2. Receipt statement
  const mutationResult = input.resultProducer();
  const serializedResponseBody = JSON.stringify(mutationResult.body);
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

  // 3. Business statements + expected changes checks
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

  // 4. Safe Audit Event
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
         target_type, target_id, correlation_id, idempotency_key, outcome,
         metadata_json, created_at
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

  // 5. Atomic Batch Execution
  try {
    await db.batch(batchStatements);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('FINAL_AUTHORITY_RECHECK_FAILED')) {
      throw new Error('FINAL_AUTHORITY_RECHECK_FAILED', { cause: err });
    }
    if (message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT')) {
      throw new OptimisticConcurrencyError(0);
    }
    if (message.includes('CANNOT_DEACTIVATE_DEFAULT_INSURER')) {
      throw new DomainConstraintViolationError(
        'CANNOT_DEACTIVATE_DEFAULT_INSURER',
        'Varsayılan sigortacı devre dışı bırakılamaz.',
      );
    }
    if (message.includes('DEFAULT_INSURER_MUST_BE_ACTIVE')) {
      throw new DomainConstraintViolationError(
        'DEFAULT_INSURER_MUST_BE_ACTIVE',
        'Varsayılan sigortacı aktif olmalıdır.',
      );
    }
    if (message.includes('CROSS_AGENCY_OR_MISSING_INSURER_PROHIBITED')) {
      throw new DomainConstraintViolationError(
        'INSURER_NOT_ACTIVE_OR_NOT_FOUND',
        'Ürün için aynı acenteye ait aktif bir sigorta şirketi gereklidir.',
      );
    }
    if (message.includes('CROSS_AGENCY_OR_MISSING_BRANCH_PROHIBITED')) {
      throw new DomainConstraintViolationError(
        'BRANCH_NOT_ACTIVE_OR_NOT_FOUND',
        'Ürün için aynı acenteye ait aktif bir branş gereklidir.',
      );
    }
    if (
      message.includes('UNIQUE constraint failed') ||
      message.includes('PRIMARY KEY') ||
      message.includes('operation_receipts')
    ) {
      if (message.includes('operation_receipts')) {
        throw new IdempotencyConflictError('IDEMPOTENCY_CONCURRENT_INSERT');
      }
      throw new DomainConstraintViolationError('DUPLICATE_ENTITY_CODE', message);
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

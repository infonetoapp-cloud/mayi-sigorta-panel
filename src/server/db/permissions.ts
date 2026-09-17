/**
 * Mayı Sigorta CRM — İzin Kalıcılık Yardımcısı (M1-T04)
 *
 * KRİTİK GÜVENLİK VE MİMARİ KURALLAR:
 * 1. Bu modül sunucu içi (internal server persistence helper) bir yardımcıdır;
 *    HTTP endpoint'i, UI bileşeni veya genel authorize() değerlendiricisi DEĞİLDİR.
 * 2. İzin kodlarını ve kapsamlarını src/shared/permissions.ts içindeki sabit katalog ile doğrular.
 * 3. Her operasyon güvenilir agencyId ile sınırlandırılır (membership_id + agency_id eşleşmesi zorunludur).
 * 4. OWNER için NORMAL izin satırı oluşturulmasını kesinlikle reddeder (fail-closed).
 *    OWNER normal operasyonel izinleri çalışma zamanında örtük (implicit) alır.
 * 5. OWNER için SENSITIVE izin satırı oluşturulabilir (explicit grant zorunludur).
 * 6. MEMBER için hem NORMAL hem SENSITIVE pozitif izin satırları oluşturulabilir.
 * 7. Önkoşul bağımlılıkları (catalog dependencies) ve kapsam hiyerarşisi (scope hierarchy)
 *    desteklenen mutasyon sınırında tam olarak denetlenir.
 * 8. Her grant/revoke/scope değişikliği atomik olarak izin satırını mutasyona uğratır ve
 *    AgencyMembership.permission_version değerini CAS (expectedPermissionVersion) ile artırır.
 * 9. Sıfır satır güncelleyen bayat versiyon (stale version) durumunda d1_cas_assertions tablosu
 *    ve veritabanı tetikleyicisi (RAISE(ABORT)) üzerinden tüm D1 batch'i geri alınır (rollback).
 */

import {
  getPermissionDefinition,
  type PermissionCode,
  type PermissionScopeKind,
} from '../../shared/permissions';
import { OptimisticConcurrencyError } from './optimistic';

export class UnknownPermissionError extends Error {
  readonly code = 'UNKNOWN_PERMISSION';

  constructor(permissionCode: string) {
    super(`UNKNOWN_PERMISSION: '${permissionCode}' izin kataloğunda bulunamadı.`);
    this.name = 'UnknownPermissionError';
  }
}

export class InvalidPermissionScopeError extends Error {
  readonly code = 'INVALID_PERMISSION_SCOPE';

  constructor(permissionCode: string, scope: string, expectedKind?: PermissionScopeKind) {
    super(
      `INVALID_PERMISSION_SCOPE: '${permissionCode}' izni için '${scope}' kapsamı geçersizdir.` +
        (expectedKind ? ` Beklenen kapsam türü: ${expectedKind}.` : ''),
    );
    this.name = 'InvalidPermissionScopeError';
  }
}

export class OwnerNormalPermissionProhibitedError extends Error {
  readonly code = 'OWNER_NORMAL_PERMISSION_PROHIBITED';

  constructor(membershipId: string, permissionCode: string) {
    super(
      `OWNER_NORMAL_PERMISSION_PROHIBITED: OWNER üyeliğine ('${membershipId}') NORMAL izin ('${permissionCode}') verilemez. OWNER bu izinleri örtük (implicit) olarak alır.`,
    );
    this.name = 'OwnerNormalPermissionProhibitedError';
  }
}

export class MembershipNotFoundError extends Error {
  readonly code = 'MEMBERSHIP_NOT_FOUND';

  constructor(membershipId: string) {
    super(
      `MEMBERSHIP_NOT_FOUND: '${membershipId}' kimlikli üyelik belirtilen acentede bulunamadı.`,
    );
    this.name = 'MembershipNotFoundError';
  }
}

export class MembershipPermissionNotFoundError extends Error {
  readonly code = 'MEMBERSHIP_PERMISSION_NOT_FOUND';

  constructor(membershipId: string, permissionCode: string) {
    super(
      `MEMBERSHIP_PERMISSION_NOT_FOUND: '${membershipId}' üyeliğinde '${permissionCode}' izni bulunamadı.`,
    );
    this.name = 'MembershipPermissionNotFoundError';
  }
}

export class DuplicatePermissionGrantError extends Error {
  readonly code = 'DUPLICATE_PERMISSION_GRANT';

  constructor(membershipId: string, permissionCode: string) {
    super(
      `DUPLICATE_PERMISSION_GRANT: '${membershipId}' üyeliğinde '${permissionCode}' izni zaten tanımlıdır.`,
    );
    this.name = 'DuplicatePermissionGrantError';
  }
}

export class MissingPermissionDependencyError extends Error {
  readonly code = 'MISSING_PERMISSION_DEPENDENCY';

  constructor(permissionCode: string, dependencyCode: string) {
    super(
      `MISSING_PERMISSION_DEPENDENCY: '${permissionCode}' izni için zorunlu önkoşul bağımlılığı ('${dependencyCode}') bu üyelikte tanımlı değildir.`,
    );
    this.name = 'MissingPermissionDependencyError';
  }
}

export class IncompatibleDependencyScopeError extends Error {
  readonly code = 'INCOMPATIBLE_DEPENDENCY_SCOPE';

  constructor(
    permissionCode: string,
    scope: string,
    dependencyCode: string,
    dependencyScope: string,
  ) {
    super(
      `INCOMPATIBLE_DEPENDENCY_SCOPE: '${permissionCode}' (${scope}) izni, bağımlı olduğu '${dependencyCode}' (${dependencyScope}) izninin kapsamından daha geniş olamaz.`,
    );
    this.name = 'IncompatibleDependencyScopeError';
  }
}

export class ActivePermissionDependencyError extends Error {
  readonly code = 'ACTIVE_PERMISSION_DEPENDENCY';

  constructor(permissionCode: string, dependentCode: string) {
    super(
      `ACTIVE_PERMISSION_DEPENDENCY: '${permissionCode}' izni kaldırılamaz veya kapsamı daraltılamaz; bu izne bağımlı aktif izin mevcuttur: '${dependentCode}'.`,
    );
    this.name = 'ActivePermissionDependencyError';
  }
}

export type StoredScope = 'UNSCOPED' | 'ASSIGNED' | 'AGENCY';

export interface GrantPermissionInput {
  agencyId: string;
  membershipId: string;
  permissionCode: string;
  scope: StoredScope;
  expectedPermissionVersion: number;
  grantId?: string;
}

export interface GrantPermissionResult {
  grantId: string;
  membershipId: string;
  permissionCode: PermissionCode;
  scope: StoredScope;
  newPermissionVersion: number;
}

export interface RevokePermissionInput {
  agencyId: string;
  membershipId: string;
  permissionCode: string;
  expectedPermissionVersion: number;
}

export interface RevokePermissionResult {
  membershipId: string;
  permissionCode: PermissionCode;
  newPermissionVersion: number;
}

export interface ChangePermissionScopeInput {
  agencyId: string;
  membershipId: string;
  permissionCode: string;
  newScope: 'ASSIGNED' | 'AGENCY';
  expectedPermissionVersion: number;
}

export interface ChangePermissionScopeResult {
  membershipId: string;
  permissionCode: PermissionCode;
  scope: 'ASSIGNED' | 'AGENCY';
  newPermissionVersion: number;
}

interface MembershipRow {
  id: string;
  agency_id: string;
  user_id: string;
  type: 'OWNER' | 'MEMBER';
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  permission_version: number;
  version: number;
}

interface PermissionRow {
  id: string;
  membership_id: string;
  permission_code: string;
  scope: StoredScope;
}

function scopeWeight(scope: StoredScope): number {
  if (scope === 'ASSIGNED') return 1;
  if (scope === 'AGENCY') return 2;
  return 0; // UNSCOPED
}

function assertValidScopeForCatalog(
  permissionCode: string,
  scope: StoredScope,
  scopeKind: PermissionScopeKind,
): void {
  if (scopeKind === 'UNSCOPED') {
    if (scope !== 'UNSCOPED') {
      throw new InvalidPermissionScopeError(permissionCode, scope, 'UNSCOPED');
    }
  } else {
    // RECORD_SCOPED
    if (scope !== 'ASSIGNED' && scope !== 'AGENCY') {
      throw new InvalidPermissionScopeError(permissionCode, scope, 'RECORD_SCOPED');
    }
  }
}

/**
 * Bir üyeliğe yeni pozitif izin tanımlar.
 * Atomik olarak izin satırını ekler ve membership.permission_version değerini 1 artırır.
 */
export async function grantPermission(
  db: D1Database,
  input: GrantPermissionInput,
): Promise<GrantPermissionResult> {
  const { agencyId, membershipId, permissionCode, scope, expectedPermissionVersion } = input;

  // 1. Katalog doğrulaması (fail-closed)
  const definition = getPermissionDefinition(permissionCode);
  if (!definition) {
    throw new UnknownPermissionError(permissionCode);
  }

  // 2. Kapsam uygunluk doğrulaması
  assertValidScopeForCatalog(permissionCode, scope, definition.scopeKind);

  // 3. Üyelik sorgulama (id + agency_id sınırlandırması ile)
  const membership = await db
    .prepare(
      'SELECT id, agency_id, user_id, type, status, permission_version, version FROM agency_memberships WHERE id = ? AND agency_id = ?',
    )
    .bind(membershipId, agencyId)
    .first<MembershipRow>();

  if (!membership) {
    throw new MembershipNotFoundError(membershipId);
  }

  // 4. OWNER için NORMAL izin satırı oluşturulamaz
  if (membership.type === 'OWNER' && definition.classification === 'NORMAL') {
    throw new OwnerNormalPermissionProhibitedError(membershipId, permissionCode);
  }

  // 5. Mevcut izinleri sorgula
  const existingGrantsResult = await db
    .prepare(
      'SELECT id, membership_id, permission_code, scope FROM membership_permissions WHERE membership_id = ?',
    )
    .bind(membershipId)
    .all<PermissionRow>();

  const existingGrants = existingGrantsResult.results ?? [];

  // 7. Zaten tanımlı mı kontrolü
  const alreadyGranted = existingGrants.some((g) => g.permission_code === permissionCode);
  if (alreadyGranted) {
    throw new DuplicatePermissionGrantError(membershipId, permissionCode);
  }

  // 8. Bağımlılık ve Kapsam Doğrulaması (Katalog Bağımlılık Sözleşmesi)
  // OWNER için örtük NORMAL bağımlılıklar karşılanmış kabul edilir (AGENCY kapsamında).
  // SENSITIVE bağımlılıklar ise OWNER için de açık tanımlama (explicit grant) gerektirir.
  for (const depCode of definition.dependencies) {
    const depDef = getPermissionDefinition(depCode);
    if (!depDef) {
      throw new UnknownPermissionError(depCode);
    }

    let isSatisfied = false;
    let depScope: StoredScope = 'UNSCOPED';

    if (membership.type === 'OWNER' && depDef.classification === 'NORMAL') {
      isSatisfied = true;
      depScope = 'AGENCY';
    } else {
      const explicitGrant = existingGrants.find((g) => g.permission_code === depCode);
      if (explicitGrant) {
        isSatisfied = true;
        depScope = explicitGrant.scope;
      }
    }

    if (!isSatisfied) {
      throw new MissingPermissionDependencyError(permissionCode, depCode);
    }

    // Kapsam hiyerarşisi: Kayıt kapsamlı izin bağımlı olduğu izinden daha geniş olamaz!
    if (definition.scopeKind === 'RECORD_SCOPED' && depDef.scopeKind === 'RECORD_SCOPED') {
      if (scopeWeight(scope) > scopeWeight(depScope)) {
        throw new IncompatibleDependencyScopeError(permissionCode, scope, depCode, depScope);
      }
    }
  }

  const grantId = input.grantId || crypto.randomUUID();
  const assertionId = crypto.randomUUID();

  // 9. Atomik D1 Batch işlemi
  const updateMembershipStmt = db
    .prepare(
      `UPDATE agency_memberships
       SET permission_version = permission_version + 1,
           version = version + 1,
           updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ? AND agency_id = ? AND permission_version = ?`,
    )
    .bind(membershipId, agencyId, expectedPermissionVersion);

  const assertVersionStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       VALUES (?, 1, changes(), 'OPTIMISTIC_CONCURRENCY_CONFLICT')`,
    )
    .bind(assertionId);

  const insertGrantStmt = db
    .prepare(
      `INSERT INTO membership_permissions (id, membership_id, permission_code, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    )
    .bind(grantId, membershipId, permissionCode, scope);

  try {
    const results = await db.batch([updateMembershipStmt, assertVersionStmt, insertGrantStmt]);

    for (const res of results) {
      if (!res.success) {
        throw new Error('D1_BATCH_EXECUTION_FAILED');
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
      message.includes('STALE_MEMBERSHIP_VERSION')
    ) {
      throw new OptimisticConcurrencyError(0);
    }
    if (
      message.includes('UNIQUE constraint failed') ||
      message.includes('MEMBERSHIP_PERMISSION_ROW_REPLACEMENT_FORBIDDEN')
    ) {
      throw new DuplicatePermissionGrantError(membershipId, permissionCode);
    }
    throw error;
  }

  return {
    grantId,
    membershipId,
    permissionCode: definition.code as PermissionCode,
    scope,
    newPermissionVersion: expectedPermissionVersion + 1,
  };
}

/**
 * Bir üyelikten mevcut pozitif izni kaldırır (revoke).
 * Atomik olarak izin satırını siler ve membership.permission_version değerini 1 artırır.
 */
export async function revokePermission(
  db: D1Database,
  input: RevokePermissionInput,
): Promise<RevokePermissionResult> {
  const { agencyId, membershipId, permissionCode, expectedPermissionVersion } = input;

  // 1. Katalog doğrulaması
  const definition = getPermissionDefinition(permissionCode);
  if (!definition) {
    throw new UnknownPermissionError(permissionCode);
  }

  // 2. Üyelik sorgulama
  const membership = await db
    .prepare(
      'SELECT id, agency_id, user_id, type, status, permission_version, version FROM agency_memberships WHERE id = ? AND agency_id = ?',
    )
    .bind(membershipId, agencyId)
    .first<MembershipRow>();

  if (!membership) {
    throw new MembershipNotFoundError(membershipId);
  }

  // 3. Mevcut izinleri sorgula
  const existingGrantsResult = await db
    .prepare(
      'SELECT id, membership_id, permission_code, scope FROM membership_permissions WHERE membership_id = ?',
    )
    .bind(membershipId)
    .all<PermissionRow>();

  const existingGrants = existingGrantsResult.results ?? [];

  const existingTarget = existingGrants.find((g) => g.permission_code === permissionCode);
  if (!existingTarget) {
    throw new MembershipPermissionNotFoundError(membershipId, permissionCode);
  }

  // 5. Bağımlı izin denetimi: Kaldırılacak izne bağımlı başka bir aktif izin varsa silme reddedilir!
  for (const grant of existingGrants) {
    if (grant.permission_code === permissionCode) continue;

    const grantDef = getPermissionDefinition(grant.permission_code);
    if (grantDef && grantDef.dependencies.includes(permissionCode)) {
      throw new ActivePermissionDependencyError(permissionCode, grant.permission_code);
    }
  }

  const assertionVersionId = crypto.randomUUID();
  const assertionDeleteId = crypto.randomUUID();

  // 6. Atomik D1 Batch işlemi
  const updateMembershipStmt = db
    .prepare(
      `UPDATE agency_memberships
       SET permission_version = permission_version + 1,
           version = version + 1,
           updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ? AND agency_id = ? AND permission_version = ?`,
    )
    .bind(membershipId, agencyId, expectedPermissionVersion);

  const assertVersionStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       VALUES (?, 1, changes(), 'OPTIMISTIC_CONCURRENCY_CONFLICT')`,
    )
    .bind(assertionVersionId);

  const deleteGrantStmt = db
    .prepare('DELETE FROM membership_permissions WHERE membership_id = ? AND permission_code = ?')
    .bind(membershipId, permissionCode);

  const assertDeleteStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       VALUES (?, 1, changes(), 'MEMBERSHIP_PERMISSION_NOT_FOUND')`,
    )
    .bind(assertionDeleteId);

  try {
    const results = await db.batch([
      updateMembershipStmt,
      assertVersionStmt,
      deleteGrantStmt,
      assertDeleteStmt,
    ]);

    for (const res of results) {
      if (!res.success) {
        throw new Error('D1_BATCH_EXECUTION_FAILED');
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
      message.includes('STALE_MEMBERSHIP_VERSION')
    ) {
      throw new OptimisticConcurrencyError(0);
    }
    if (message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND')) {
      throw new MembershipPermissionNotFoundError(membershipId, permissionCode);
    }
    throw error;
  }

  return {
    membershipId,
    permissionCode: definition.code as PermissionCode,
    newPermissionVersion: expectedPermissionVersion + 1,
  };
}

/**
 * Bir üyeliğin kayıt kapsamlı (RECORD_SCOPED) izninin kapsamını günceller.
 * Atomik olarak kapsamı (ASSIGNED <-> AGENCY) günceller ve membership.permission_version değerini 1 artırır.
 */
export async function changePermissionScope(
  db: D1Database,
  input: ChangePermissionScopeInput,
): Promise<ChangePermissionScopeResult> {
  const { agencyId, membershipId, permissionCode, newScope, expectedPermissionVersion } = input;

  // 1. Katalog doğrulaması
  const definition = getPermissionDefinition(permissionCode);
  if (!definition) {
    throw new UnknownPermissionError(permissionCode);
  }

  // 2. Kapsam geçerliliği - Yalnızca RECORD_SCOPED izinlerin kapsamı ASSIGNED/AGENCY olarak değiştirilebilir
  if (definition.scopeKind !== 'RECORD_SCOPED') {
    throw new InvalidPermissionScopeError(permissionCode, newScope, 'RECORD_SCOPED');
  }

  if (newScope !== 'ASSIGNED' && newScope !== 'AGENCY') {
    throw new InvalidPermissionScopeError(permissionCode, newScope, 'RECORD_SCOPED');
  }

  // 3. Üyelik sorgulama
  const membership = await db
    .prepare(
      'SELECT id, agency_id, user_id, type, status, permission_version, version FROM agency_memberships WHERE id = ? AND agency_id = ?',
    )
    .bind(membershipId, agencyId)
    .first<MembershipRow>();

  if (!membership) {
    throw new MembershipNotFoundError(membershipId);
  }

  // 4. Mevcut izinleri sorgula
  const existingGrantsResult = await db
    .prepare(
      'SELECT id, membership_id, permission_code, scope FROM membership_permissions WHERE membership_id = ?',
    )
    .bind(membershipId)
    .all<PermissionRow>();

  const existingGrants = existingGrantsResult.results ?? [];

  const existingTarget = existingGrants.find((g) => g.permission_code === permissionCode);
  if (!existingTarget) {
    throw new MembershipPermissionNotFoundError(membershipId, permissionCode);
  }

  // 6. Kapsam Uyumluluk Doğrulaması (Scope Dependency Constraints):
  // 6a. İznin kendisinin doğrudan bağımlı olduğu izinlerin doğrulanması:
  // Herhangi bir doğrudan katalog bağımlılığı eksikse fail-closed olarak MissingPermissionDependencyError fırlatılır.
  // OWNER için örtük NORMAL bağımlılıklar AGENCY kabul edilir; SENSITIVE bağımlılıklar açık grant gerektirir.
  for (const depCode of definition.dependencies) {
    const depDef = getPermissionDefinition(depCode);
    if (!depDef) {
      throw new UnknownPermissionError(depCode);
    }

    let isSatisfied = false;
    let depScope: StoredScope = 'UNSCOPED';

    if (membership.type === 'OWNER' && depDef.classification === 'NORMAL') {
      isSatisfied = true;
      depScope = 'AGENCY';
    } else {
      const depGrant = existingGrants.find((g) => g.permission_code === depCode);
      if (depGrant) {
        isSatisfied = true;
        depScope = depGrant.scope;
      }
    }

    if (!isSatisfied) {
      throw new MissingPermissionDependencyError(permissionCode, depCode);
    }

    if (definition.scopeKind === 'RECORD_SCOPED' && depDef.scopeKind === 'RECORD_SCOPED') {
      if (scopeWeight(newScope) > scopeWeight(depScope)) {
        throw new IncompatibleDependencyScopeError(permissionCode, newScope, depCode, depScope);
      }
    }
  }

  // 6b. Bu izne bağımlı olan mevcut izinlerin kapsamından daha dar olmasını engelle
  for (const grant of existingGrants) {
    if (grant.permission_code === permissionCode) continue;

    const grantDef = getPermissionDefinition(grant.permission_code);
    if (
      grantDef &&
      grantDef.dependencies.includes(permissionCode) &&
      grantDef.scopeKind === 'RECORD_SCOPED'
    ) {
      if (scopeWeight(newScope) < scopeWeight(grant.scope)) {
        throw new ActivePermissionDependencyError(permissionCode, grant.permission_code);
      }
    }
  }

  const assertionVersionId = crypto.randomUUID();
  const assertionUpdateId = crypto.randomUUID();

  // 7. Atomik D1 Batch işlemi
  const updateMembershipStmt = db
    .prepare(
      `UPDATE agency_memberships
       SET permission_version = permission_version + 1,
           version = version + 1,
           updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ? AND agency_id = ? AND permission_version = ?`,
    )
    .bind(membershipId, agencyId, expectedPermissionVersion);

  const assertVersionStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       VALUES (?, 1, changes(), 'OPTIMISTIC_CONCURRENCY_CONFLICT')`,
    )
    .bind(assertionVersionId);

  const updateGrantStmt = db
    .prepare(
      `UPDATE membership_permissions
       SET scope = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE membership_id = ? AND permission_code = ?`,
    )
    .bind(newScope, membershipId, permissionCode);

  const assertUpdateStmt = db
    .prepare(
      `INSERT INTO d1_cas_assertions (id, expected, actual, failure_code)
       VALUES (?, 1, changes(), 'MEMBERSHIP_PERMISSION_NOT_FOUND')`,
    )
    .bind(assertionUpdateId);

  try {
    const results = await db.batch([
      updateMembershipStmt,
      assertVersionStmt,
      updateGrantStmt,
      assertUpdateStmt,
    ]);

    for (const res of results) {
      if (!res.success) {
        throw new Error('D1_BATCH_EXECUTION_FAILED');
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('OPTIMISTIC_CONCURRENCY_CONFLICT') ||
      message.includes('STALE_MEMBERSHIP_VERSION')
    ) {
      throw new OptimisticConcurrencyError(0);
    }
    if (message.includes('MEMBERSHIP_PERMISSION_NOT_FOUND')) {
      throw new MembershipPermissionNotFoundError(membershipId, permissionCode);
    }
    throw error;
  }

  return {
    membershipId,
    permissionCode: definition.code as PermissionCode,
    scope: newScope,
    newPermissionVersion: expectedPermissionVersion + 1,
  };
}

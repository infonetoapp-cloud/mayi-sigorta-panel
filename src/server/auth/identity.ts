import type { VerifiedAccessPrincipal, AccessAssurance } from './types';
import type { UserMeDto, UserMeMembershipDto } from '../../shared/types';

/**
 * Sunucu-Özel Kimlik Çözümleyici ve Aktif Üyelik Bağlamı (M1-T06).
 *
 * KRİTİK GÜVENLİK VE MİMARİ SÖZLEŞMESİ (RG-00 & NIHAI_MIMARI_VE_UYGULAMA_PLANI):
 * 1. Kimlik tespiti YALNIZCA doğrulanmış (issuer, subject) anahtarı üzerinden yapılır.
 *    E-posta, kullanıcı adı, belirteç claim'leri veya istemci başlıkları asla kimlik tespitinde kullanılamaz.
 * 2. Yalnızca ACTIVE AuthIdentity, ACTIVE User, ACTIVE AgencyMembership ve ACTIVE Agency bağlamları kabul edilir.
 *    INVITED, SUSPENDED ve INACTIVE üyelikler ile PROVISIONING durumundaki acenteler operasyonel bağlam sayılmaz.
 * 3. Kullanıcının aktif geçerli bir üyeliği yoksa fail-closed olarak reddedilir (NO_ACTIVE_MEMBERSHIPS).
 * 4. Çoklu aktif üyelikler deterministik sıralamayla (agencyId ASC, id ASC) temsil edilir;
 *    oturumda sahte veya örtük bir "mevcut acente seçicisi" (current-agency selector) icat edilmez.
 * 5. Belirteçteki OWNER/agency/permission iddiaları tamamen yok sayılır; üyelik türü YALNIZCA veritabanından okunur.
 * 6. İzin değerlendirmesi (M1-T07) bu modülde kesinlikle yapılmaz.
 * 7. Hata mesajları güvenli taksonomiye sahiptir; issuer, subject, email, SQL veya ham satır değerleri sızdırmaz.
 */

export type IdentityResolutionErrorCode =
  | 'IDENTITY_NOT_FOUND'
  | 'IDENTITY_REVOKED'
  | 'USER_NOT_FOUND'
  | 'USER_INACTIVE'
  | 'NO_ACTIVE_MEMBERSHIPS'
  | 'CORRUPT_IDENTITY_DATA'
  | 'CORRUPT_MEMBERSHIP_DATA'
  | 'DATABASE_ERROR';

const SAFE_IDENTITY_ERROR_MESSAGES: Record<IdentityResolutionErrorCode, string> = {
  IDENTITY_NOT_FOUND: 'Kayıtlı kimlik bulunamadı.',
  IDENTITY_REVOKED: 'Kimlik erişimi iptal edilmiş.',
  USER_NOT_FOUND: 'Kullanıcı hesabı bulunamadı.',
  USER_INACTIVE: 'Kullanıcı hesabı etkin değil.',
  NO_ACTIVE_MEMBERSHIPS: 'Kullanıcının etkin bir acente üyeliği bulunmuyor.',
  CORRUPT_IDENTITY_DATA: 'Kimlik verisi tutarsız veya bozuk.',
  CORRUPT_MEMBERSHIP_DATA: 'Üyelik verisi tutarsız veya bozuk.',
  DATABASE_ERROR: 'Veritabanı erişim hatası oluştu.',
};

export class IdentityResolutionError extends Error {
  readonly code: IdentityResolutionErrorCode;
  readonly isPublicSafe: boolean = true;

  constructor(code: IdentityResolutionErrorCode) {
    const message = SAFE_IDENTITY_ERROR_MESSAGES[code] ?? 'Kimlik bağlamı doğrulanamadı.';
    super(message);
    this.name = 'IdentityResolutionError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
    };
  }
}

export interface ActiveMembershipContext {
  readonly id: string;
  readonly agencyId: string;
  readonly type: 'OWNER' | 'MEMBER';
  readonly status: 'ACTIVE';
  readonly permissionVersion: number;
}

export interface AuthenticatedUserContext {
  readonly userId: string;
  readonly identityId: string;
  readonly email?: string;
  readonly assurance: AccessAssurance;
  readonly memberships: readonly ActiveMembershipContext[];
}

export interface ApplicationIdentityResolver {
  resolve(principal: VerifiedAccessPrincipal): Promise<AuthenticatedUserContext>;
}

interface RawAuthIdentityRow {
  id: unknown;
  user_id: unknown;
  issuer: unknown;
  subject: unknown;
  verified_email: unknown;
  status: unknown;
}

interface RawUserRow {
  id: unknown;
  status: unknown;
}

interface RawMembershipAgencyRow {
  id: unknown;
  agency_id: unknown;
  user_id: unknown;
  type: unknown;
  status: unknown;
  permission_version: unknown;
  joined_agency_id: unknown;
  agency_status: unknown;
}

function isValidEmailShape(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length <= 3) return false;
  const atIndex = trimmed.indexOf('@');
  return atIndex > 0 && atIndex < trimmed.length - 1 && atIndex === trimmed.lastIndexOf('@');
}

/**
 * D1 sorgu sonucunun kapsayıcı bütünlüğünü ve satır nesnesi geçerliliğini denetler.
 * Başarısız (success !== true) veya biçimsiz kapsayıcılar DATABASE_ERROR (503),
 * null veya nesne olmayan satırlar ise ilgili veri bozulması hatası (503) fırlatır.
 */
function validateD1QueryResult<T>(
  result: unknown,
  corruptErrorCode: 'CORRUPT_IDENTITY_DATA' | 'CORRUPT_MEMBERSHIP_DATA' = 'CORRUPT_IDENTITY_DATA',
): T[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  const d1Result = result as { success?: unknown; results?: unknown };

  if (d1Result.success !== true) {
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  if (!Array.isArray(d1Result.results)) {
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  for (const row of d1Result.results) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new IdentityResolutionError(corruptErrorCode);
    }
  }

  return d1Result.results as T[];
}

/**
 * Doğrulanmış Access principal nesnesini D1 üzerindeki aktif kimlik ve üyelik bağlamına çözümler.
 */
export async function resolveAuthenticatedUserContext(
  db: D1Database,
  principal: VerifiedAccessPrincipal,
): Promise<AuthenticatedUserContext> {
  // Girdi savunması
  if (!principal || typeof principal !== 'object') {
    throw new IdentityResolutionError('IDENTITY_NOT_FOUND');
  }
  if (typeof principal.issuer !== 'string' || principal.issuer.trim() === '') {
    throw new IdentityResolutionError('IDENTITY_NOT_FOUND');
  }
  if (typeof principal.subject !== 'string' || principal.subject.trim() === '') {
    throw new IdentityResolutionError('IDENTITY_NOT_FOUND');
  }
  if (principal.assurance !== 'NORMAL' && principal.assurance !== 'SECURE') {
    throw new IdentityResolutionError('CORRUPT_IDENTITY_DATA');
  }

  if (!db || typeof db !== 'object' || typeof db.prepare !== 'function') {
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  // 1. AuthIdentity Sorgusu (Exact issuer + subject)
  let identityRows: RawAuthIdentityRow[];
  try {
    const identityStmt = db.prepare(`
      SELECT
        id,
        user_id,
        issuer,
        subject,
        verified_email,
        status
      FROM auth_identities
      WHERE issuer = ? AND subject = ?
    `);
    const result = await identityStmt
      .bind(principal.issuer, principal.subject)
      .all<RawAuthIdentityRow>();
    identityRows = validateD1QueryResult<RawAuthIdentityRow>(result, 'CORRUPT_IDENTITY_DATA');
  } catch (error) {
    if (error instanceof IdentityResolutionError) throw error;
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  if (identityRows.length === 0) {
    throw new IdentityResolutionError('IDENTITY_NOT_FOUND');
  }
  if (identityRows.length > 1) {
    // UNIQUE(issuer, subject) kısıtı bozulmuş: fail-closed
    throw new IdentityResolutionError('CORRUPT_IDENTITY_DATA');
  }

  const rawIdentity = identityRows[0]!;

  if (
    typeof rawIdentity.id !== 'string' ||
    rawIdentity.id.trim() === '' ||
    typeof rawIdentity.user_id !== 'string' ||
    rawIdentity.user_id.trim() === '' ||
    rawIdentity.issuer !== principal.issuer ||
    rawIdentity.subject !== principal.subject ||
    !isValidEmailShape(rawIdentity.verified_email) ||
    (rawIdentity.status !== 'ACTIVE' && rawIdentity.status !== 'REVOKED')
  ) {
    throw new IdentityResolutionError('CORRUPT_IDENTITY_DATA');
  }

  if (rawIdentity.status !== 'ACTIVE') {
    throw new IdentityResolutionError('IDENTITY_REVOKED');
  }

  // 2. User Sorgusu
  let userRows: RawUserRow[];
  try {
    const userStmt = db.prepare(`
      SELECT
        id,
        status
      FROM users
      WHERE id = ?
    `);
    const result = await userStmt.bind(rawIdentity.user_id).all<RawUserRow>();
    userRows = validateD1QueryResult<RawUserRow>(result, 'CORRUPT_IDENTITY_DATA');
  } catch (error) {
    if (error instanceof IdentityResolutionError) throw error;
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  if (userRows.length === 0) {
    throw new IdentityResolutionError('USER_NOT_FOUND');
  }
  if (userRows.length > 1) {
    throw new IdentityResolutionError('CORRUPT_IDENTITY_DATA');
  }

  const rawUser = userRows[0]!;

  if (
    typeof rawUser.id !== 'string' ||
    rawUser.id !== rawIdentity.user_id ||
    (rawUser.status !== 'ACTIVE' && rawUser.status !== 'INACTIVE')
  ) {
    throw new IdentityResolutionError('CORRUPT_IDENTITY_DATA');
  }

  if (rawUser.status !== 'ACTIVE') {
    throw new IdentityResolutionError('USER_INACTIVE');
  }

  // 3. AgencyMemberships & Agencies Sorgusu
  let membershipRows: RawMembershipAgencyRow[];
  try {
    const membershipStmt = db.prepare(`
      SELECT
        m.id AS id,
        m.agency_id AS agency_id,
        m.user_id AS user_id,
        m.type AS type,
        m.status AS status,
        m.permission_version AS permission_version,
        a.id AS joined_agency_id,
        a.status AS agency_status
      FROM agency_memberships m
      INNER JOIN agencies a ON m.agency_id = a.id
      WHERE m.user_id = ?
      ORDER BY m.agency_id ASC, m.id ASC
    `);
    const result = await membershipStmt.bind(rawUser.id).all<RawMembershipAgencyRow>();
    membershipRows = validateD1QueryResult<RawMembershipAgencyRow>(
      result,
      'CORRUPT_MEMBERSHIP_DATA',
    );
  } catch (error) {
    if (error instanceof IdentityResolutionError) throw error;
    throw new IdentityResolutionError('DATABASE_ERROR');
  }

  const activeMemberships: ActiveMembershipContext[] = [];
  const seenAgencies = new Set<string>();

  for (const row of membershipRows) {
    if (
      typeof row.id !== 'string' ||
      row.id.trim() === '' ||
      typeof row.agency_id !== 'string' ||
      row.agency_id.trim() === '' ||
      typeof row.user_id !== 'string' ||
      row.user_id !== rawUser.id ||
      row.joined_agency_id !== row.agency_id ||
      (row.type !== 'OWNER' && row.type !== 'MEMBER') ||
      (row.status !== 'INVITED' &&
        row.status !== 'ACTIVE' &&
        row.status !== 'SUSPENDED' &&
        row.status !== 'INACTIVE') ||
      (row.agency_status !== 'PROVISIONING' && row.agency_status !== 'ACTIVE') ||
      typeof row.permission_version !== 'number' ||
      !Number.isInteger(row.permission_version) ||
      row.permission_version < 1
    ) {
      throw new IdentityResolutionError('CORRUPT_MEMBERSHIP_DATA');
    }

    // Yalnızca ACTIVE Agency ve ACTIVE Membership bağlamları kabul edilir
    if (row.status === 'ACTIVE' && row.agency_status === 'ACTIVE') {
      if (seenAgencies.has(row.agency_id)) {
        // Aynı kullanıcı için tek acentede birden fazla aktif üyelik olamaz
        throw new IdentityResolutionError('CORRUPT_MEMBERSHIP_DATA');
      }
      seenAgencies.add(row.agency_id);

      activeMemberships.push(
        Object.freeze({
          id: row.id,
          agencyId: row.agency_id,
          type: row.type,
          status: 'ACTIVE' as const,
          permissionVersion: row.permission_version,
        }),
      );
    }
  }

  // Deterministik sıralama güvencesi (agencyId ASC, id ASC)
  activeMemberships.sort(
    (a, b) => a.agencyId.localeCompare(b.agencyId) || a.id.localeCompare(b.id),
  );

  // Hiçbir aktif üyelik bulunmuyorsa fail-closed ret
  if (activeMemberships.length === 0) {
    throw new IdentityResolutionError('NO_ACTIVE_MEMBERSHIPS');
  }

  const informationalEmail =
    typeof principal.email === 'string' && principal.email.trim() !== ''
      ? principal.email
      : typeof rawIdentity.verified_email === 'string' && rawIdentity.verified_email.trim() !== ''
        ? rawIdentity.verified_email
        : undefined;

  return Object.freeze({
    userId: rawUser.id,
    identityId: rawIdentity.id,
    ...(informationalEmail ? { email: informationalEmail } : {}),
    assurance: principal.assurance,
    memberships: Object.freeze(activeMemberships),
  });
}

/**
 * Resolver oluşturucu yardımcı fonksiyonu (Factory pattern).
 */
export function createApplicationIdentityResolver(db: D1Database): ApplicationIdentityResolver {
  return {
    resolve: (principal: VerifiedAccessPrincipal) => resolveAuthenticatedUserContext(db, principal),
  };
}

/**
 * Sunucu tarafı kimlik bağlamını istemci için güvenli DTO'ya dönüştürür.
 * Veritabanı kimlikleri (identityId), zaman damgaları ve içsel alanlar sızdırılmaz.
 */
export function toUserMeDto(context: AuthenticatedUserContext): UserMeDto {
  const membershipDtos: UserMeMembershipDto[] = context.memberships.map((m) =>
    Object.freeze({
      id: m.id,
      agencyId: m.agencyId,
      type: m.type,
      status: m.status,
    }),
  );

  return Object.freeze({
    userId: context.userId,
    ...(context.email ? { email: context.email } : {}),
    assurance: context.assurance,
    memberships: Object.freeze(membershipDtos),
  });
}

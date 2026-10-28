// Dormant historical principal contract.
/**
 * Cloudflare Access Kimlik Doğrulama Tipleri (M1-T05).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ (RG-00 & NIHAI_MIMARI_VE_UYGULAMA_PLANI):
 * - Bu tipler yalnızca sunucu tarafında (Server-Only) kimlik doğrulaması içindir.
 * - VerifiedAccessPrincipal YALNIZCA issuer, subject, assurance, exp ve isteğe bağlı
 *   bilgilendirme amaçlı email taşır.
 * - role, agency_id, permissions, is_admin, groups, arbitrary claims veya OWNER
 *   gibi yetkilendirme alanları bu nesneye KESİNLİKLE DAHİL EDİLEMEZ.
 */

export type AccessAssurance = 'NORMAL' | 'SECURE';

export interface VerifiedAccessPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly assurance: AccessAssurance;
  readonly expiresAt: number;
  readonly issuedAt?: number;
  readonly notBefore?: number;
  /** Safe server-only hash binding; never the browser session secret. */
  readonly sessionHash?: string;
  /**
   * Bilgilendirme amaçlı doğrulanmış e-posta adresi (varsa).
   * ASLA kimlik/subject veya yetkilendirme yerine kullanılamaz!
   */
  readonly email?: string;
}

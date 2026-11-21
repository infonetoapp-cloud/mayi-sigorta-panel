/**
 * Paylaşılan sabitler (İstemci ve Sunucu arasında ortak kullanılır).
 *
 * KRİTİK GÜVENLİK KURALI:
 * Bu dosyada asla gizli anahtar, DB erişim bilgisi veya sunucuya özel yapılandırma bulunamaz.
 */

export const API_PREFIX = '/api' as const;
export const APP_NAME = 'Mayı Sigorta CRM' as const;
export const DEFAULT_TIMEZONE = 'Europe/Istanbul' as const;
export const BRANCH_CLASSIFICATION_CORRECTION_REASONS = [
  'WRONG_INITIAL_CLASSIFICATION',
  'LEGACY_IMPORT_CLASSIFICATION',
] as const;

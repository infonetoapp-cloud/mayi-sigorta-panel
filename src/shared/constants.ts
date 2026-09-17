/**
 * Paylaşılan sabitler (İstemci ve Sunucu arasında ortak kullanılır).
 *
 * KRİTİK GÜVENLİK KURALI:
 * Bu dosyada asla gizli anahtar, DB erişim bilgisi veya sunucuya özel yapılandırma bulunamaz.
 */

export const API_PREFIX = '/api' as const;
export const APP_NAME = 'Mayı Sigorta CRM' as const;
export const DEFAULT_TIMEZONE = 'Europe/Istanbul' as const;

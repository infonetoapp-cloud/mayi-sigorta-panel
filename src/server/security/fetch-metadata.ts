import type { FetchMetadataValidationResult } from './types';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * W3C Fetch Metadata (Sec-Fetch-*) başlıklarını ek savunma katmanı (additive signal) olarak doğrular.
 *
 * KRİTİK GÜVENLİK KURALLARI:
 * 1. Sec-Fetch-Site 'cross-site' ise istek derhal engellenir.
 * 2. Mutasyon isteklerinde Sec-Fetch-Mode 'no-cors' veya 'navigate' (HTML form submission) ise engellenir.
 * 3. Eski tarayıcı veya sentetik ortamlarda bu başlıkların bulunmaması isteği tek başına geçersiz kılmaz
 *    (asıl sınır Origin başlığıdır).
 */
export function validateFetchMetadata(request: Request): FetchMetadataValidationResult {
  const method = request.method.toUpperCase();
  const secFetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
  const secFetchMode = request.headers.get('sec-fetch-mode')?.toLowerCase();

  // 1. Çapraz kaynak (cross-site) istek engeli
  if (secFetchSite === 'cross-site') {
    return {
      valid: false,
      code: 'CROSS_SITE_FETCH_BLOCKED',
      message: 'Çapraz kaynaklı (cross-site) isteklere izin verilmez.',
    };
  }

  // 2. Mutasyon isteklerinde geçersiz fetch modları
  if (MUTATION_METHODS.has(method)) {
    if (secFetchMode === 'no-cors') {
      return {
        valid: false,
        code: 'INVALID_FETCH_MODE',
        message: 'no-cors modundaki mutasyon isteklerine izin verilmez.',
      };
    }

    if (secFetchMode === 'navigate') {
      return {
        valid: false,
        code: 'INVALID_FETCH_MODE',
        message: 'Doğrudan tarayıcı form navigasyonu ile mutasyon gerçekleştirilemez.',
      };
    }
  }

  return { valid: true };
}

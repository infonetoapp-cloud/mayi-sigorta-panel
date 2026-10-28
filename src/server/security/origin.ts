import { DEFAULT_TRUSTED_ORIGIN } from './headers';
import type { OriginValidationResult } from './types';

export class SecurityConfigurationError extends Error {
  readonly code: string = 'SECURITY_CONFIGURATION_ERROR';

  constructor(message: string) {
    super(`[Güvenlik Yapılandırma Hatası] ${message}`);
    this.name = 'SecurityConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Güvenilen origin yapılandırmasını doğrular.
 * Bozuk, güvensiz veya standart dışı yapılandırmalarda sessizce varsayılana düşmez;
 * kesin olarak fail-closed hata fırlatır.
 */
export function parseAndValidateTrustedOrigin(trustedOrigin: string): string {
  if (
    typeof trustedOrigin !== 'string' ||
    trustedOrigin.trim() !== trustedOrigin ||
    trustedOrigin.length === 0
  ) {
    throw new SecurityConfigurationError(
      `Güvenilen origin dizesi geçersiz veya boşluk içeriyor: '${String(trustedOrigin)}'`,
    );
  }

  if (!trustedOrigin.startsWith('https://')) {
    throw new SecurityConfigurationError(
      `Güvenilen origin protokolü HTTPS olmalıdır; '${trustedOrigin}' kabul edilemez.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trustedOrigin);
  } catch {
    throw new SecurityConfigurationError(
      `Güvenilen origin geçerli bir URL biçiminde değil: '${trustedOrigin}'`,
    );
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    trustedOrigin.endsWith('/') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== trustedOrigin
  ) {
    throw new SecurityConfigurationError(
      `Güvenilen origin kanonik HTTPS origin olmalıdır (yol, sorgu veya kimlik bilgisi içeremez): '${trustedOrigin}'`,
    );
  }

  return parsed.origin;
}

/**
 * Gelen isteğin Origin başlığını doğrular.
 *
 * KRİTİK GÜVENLİK KURALLARI:
 * 1. Güven asla Host, X-Forwarded-Host veya istek URL'sinden dinamik olarak türetilemez.
 * 2. Yalnızca yapılandırılmış exact trustedOrigin ile tam eşleşme aranır (RFC 6454).
 * 3. Prefix/suffix lookalike (ör. panel.mayisigorta.com.evil.com veya evil-panel.mayisigorta.com),
 *    PHP aynı-site apex alanı (https://mayisigorta.com), güvensiz http ve 'null' origin derhal reddedilir.
 * 4. Yol, sorgu parametresi, yetki (user:pass) veya boşluk içeren bozuk origin'ler reddedilir.
 * 5. Yapılandırma hatasında asla sessiz fallback uygulanmaz; doğrudan fail-closed yapılandırma hatası üretilir.
 */
export function validateRequestOrigin(
  requestOrOrigin: Request | string,
  trustedOrigin: string = DEFAULT_TRUSTED_ORIGIN,
): OriginValidationResult {
  const canonicalTrustedOrigin = parseAndValidateTrustedOrigin(trustedOrigin);

  const rawOrigin =
    typeof requestOrOrigin === 'string' ? requestOrOrigin : requestOrOrigin.headers.get('origin');

  if (!rawOrigin || rawOrigin.trim().length === 0) {
    return {
      valid: false,
      code: 'MISSING_ORIGIN',
      message: 'İstekte Origin başlığı bulunamadı veya boş.',
    };
  }

  // Boşluk veya tehlikeli kontrol karakterleri (CRLF, null byte) denetimi
  if (rawOrigin !== rawOrigin.trim() || /[\r\n\0\t]/.test(rawOrigin)) {
    return {
      valid: false,
      code: 'MALFORMED_ORIGIN',
      message: 'Origin başlığı geçersiz veya standart dışı karakterler içeriyor.',
    };
  }

  // 'null' origin (data: URI veya korumalı iframe'ler) fail-closed reddedilir
  if (rawOrigin.toLowerCase() === 'null') {
    return {
      valid: false,
      code: 'UNTRUSTED_ORIGIN',
      message: "'null' Origin kabul edilmez.",
    };
  }

  let parsedOriginUrl: URL;
  try {
    parsedOriginUrl = new URL(rawOrigin);
  } catch {
    return {
      valid: false,
      code: 'MALFORMED_ORIGIN',
      message: 'Origin başlığı geçerli bir URL biçiminde değil.',
    };
  }

  // RFC 6454 uyarınca Origin: <scheme> "://" <host> [ ":" <port> ] biçiminde olmalıdır.
  // URL ayrıştırıldığında pathname boşluk veya tek '/' dışında olamaz, search ve hash bulunamaz,
  // kullanıcı adı veya şifre bulunamaz.
  if (
    parsedOriginUrl.username !== '' ||
    parsedOriginUrl.password !== '' ||
    (parsedOriginUrl.pathname !== '' && parsedOriginUrl.pathname !== '/') ||
    parsedOriginUrl.search !== '' ||
    parsedOriginUrl.hash !== ''
  ) {
    return {
      valid: false,
      code: 'MALFORMED_ORIGIN',
      message: 'Origin başlığı yol, sorgu parametresi veya kullanıcı kimlik bilgisi içeremez.',
    };
  }

  // Eğer rawOrigin sonunda '/' varsa ancak RFC Origin'de trailing slash olamaz
  if (rawOrigin.endsWith('/')) {
    return {
      valid: false,
      code: 'MALFORMED_ORIGIN',
      message: 'Origin başlığı sonunda bölü işareti (trailing slash) içeremez.',
    };
  }

  // Protokol (scheme) ve exact origin eşleşmesi
  if (parsedOriginUrl.origin !== canonicalTrustedOrigin) {
    return {
      valid: false,
      code: 'UNTRUSTED_ORIGIN',
      message: 'Origin güvenilir kaynak alan adı ile eşleşmiyor.',
    };
  }

  return {
    valid: true,
    origin: parsedOriginUrl.origin,
  };
}

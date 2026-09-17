/**
 * Cloudflare Access Kimlik Doğrulama Hata Taksonomisi (M1-T05).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ:
 * - Hata mesajları ve serileştirilmiş nesneler ham belirteç (raw token), imza baytları,
 *   anahtar malzemesi veya kütüphane istisna detaylarını KESİNLİKLE İÇEREMEZ.
 * - Beklenmeyen tüm hatalar fail-closed olarak ele alınır.
 */

export type AccessVerificationErrorCode =
  | 'MISSING_ASSERTION'
  | 'INVALID_ASSERTION_FORMAT'
  | 'ASSERTION_TOO_LARGE'
  | 'AMBIGUOUS_ASSERTION_HEADER'
  | 'INVALID_TOKEN'
  | 'INVALID_SIGNATURE'
  | 'INVALID_ALGORITHM'
  | 'KEY_NOT_FOUND'
  | 'JWKS_FETCH_FAILED'
  | 'INVALID_ISSUER'
  | 'INVALID_AUDIENCE'
  | 'AMBIGUOUS_AUDIENCE'
  | 'INVALID_SUBJECT'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_YET_VALID'
  | 'INVALID_CLAIM_TYPES'
  | 'CONFIGURATION_ERROR';

const SAFE_ERROR_MESSAGES: Record<AccessVerificationErrorCode, string> = {
  MISSING_ASSERTION: 'Cloudflare Access kimlik doğrulama başlığı (Cf-Access-Jwt-Assertion) eksik.',
  INVALID_ASSERTION_FORMAT: 'Cloudflare Access belirteç biçimi geçersiz.',
  ASSERTION_TOO_LARGE: 'Cloudflare Access belirteci izin verilen maksimum boyutu aşıyor.',
  AMBIGUOUS_ASSERTION_HEADER: 'Birden fazla veya belirsiz kimlik doğrulama başlığı tespit edildi.',
  INVALID_TOKEN: 'Cloudflare Access belirteci geçersiz veya desteklenmeyen başlıklar içeriyor.',
  INVALID_SIGNATURE: 'Cloudflare Access belirteç imzası doğrulanamadı.',
  INVALID_ALGORITHM: 'Yalnızca RS256 algoritması desteklenir; geçersiz veya güvensiz algoritma.',
  KEY_NOT_FOUND: 'Belirteç imzasını doğrulayacak genel anahtar (kid) bulunamadı.',
  JWKS_FETCH_FAILED: 'Cloudflare Access genel anahtar seti (JWKS) alınamadı veya ayrıştırılamadı.',
  INVALID_ISSUER: 'Belirteç yayıncısı (iss) güvenilen takım etki alanıyla eşleşmiyor.',
  INVALID_AUDIENCE: 'Belirteç hedef kitlesi (aud) geçerli bir uygulama hedefiyle eşleşmiyor.',
  AMBIGUOUS_AUDIENCE: 'Belirteç hedef kitlesi çelişkili veya belirsiz birden çok hedef içeriyor.',
  INVALID_SUBJECT: 'Belirteç kimlik konusu (sub) geçersiz veya eksik.',
  TOKEN_EXPIRED: 'Cloudflare Access belirtecinin süresi dolmuş.',
  TOKEN_NOT_YET_VALID: 'Cloudflare Access belirteci henüz geçerli değil (nbf gelecekte).',
  INVALID_CLAIM_TYPES: 'Belirteç içindeki standart alan tipleri sözleşmeye uygun değil.',
  CONFIGURATION_ERROR: 'Cloudflare Access sunucu yapılandırması eksik veya geçersiz.',
};

export class AccessVerificationError extends Error {
  readonly code: AccessVerificationErrorCode;
  readonly isPublicSafe: boolean = true;

  constructor(code: AccessVerificationErrorCode) {
    const message = SAFE_ERROR_MESSAGES[code] ?? 'Kimlik doğrulama başarısız oldu.';
    super(message);
    this.name = 'AccessVerificationError';
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

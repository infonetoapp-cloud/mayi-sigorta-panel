/**
 * Mayı Sigorta CRM — İstek Güvenlik Sınırı ve Başlık Türleri (M1-T08)
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ (NIHAI_MIMARI_VE_UYGULAMA_PLANI Bölüm 9 ve 11):
 * 1. Same-Origin Mutation: POST/PUT/PATCH/DELETE mutasyonları tam trusted origin gerektirir.
 * 2. Host Güvensizliği: Güvenilen origin asla Host/X-Forwarded-Host başlığından türetilmez.
 * 3. Fail-Closed: Eksik veya geçersiz Origin başlığı tarayıcı API mutasyonlarında 403 üretir.
 * 4. Additive Fetch Metadata: Sec-Fetch-* başlıkları savunma derinliği olarak denetlenir.
 * 5. Güvenli OPTIONS: Yansıtılan (reflected) veya jokerli (wildcard) CORS başlıkları yasaktır.
 * 6. Güvenlik Başlıkları: CSP, X-Frame-Options: DENY, nosniff, Referrer-Policy: no-referrer,
 *    Permissions-Policy ve production-HTTPS-only HSTS zorunludur.
 * 7. API Önbellek Duruşu: Tüm API ve hata yanıtları private/no-store ile sunulur.
 */

export interface SecurityBoundaryConfig {
  readonly trustedOrigin?: string;
  readonly appEnv?: 'development' | 'test' | 'staging' | 'production';
  readonly hstsMaxAge?: number;
  readonly csrfSecret?: string;
}

export type OriginFailureCode = 'MISSING_ORIGIN' | 'UNTRUSTED_ORIGIN' | 'MALFORMED_ORIGIN';

export type OriginValidationResult =
  | { readonly valid: true; readonly origin: string }
  | { readonly valid: false; readonly code: OriginFailureCode; readonly message: string };

export type FetchMetadataFailureCode = 'CROSS_SITE_FETCH_BLOCKED' | 'INVALID_FETCH_MODE';

export type FetchMetadataValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly code: FetchMetadataFailureCode; readonly message: string };

export type CsrfFailureCode =
  'MALFORMED_TOKEN' | 'INVALID_SIGNATURE' | 'SUBJECT_MISMATCH' | 'EXPIRED_TOKEN';

export type CsrfVerificationResult =
  | { readonly valid: true; readonly subject: string; readonly issuedAt: number }
  | { readonly valid: false; readonly code: CsrfFailureCode; readonly message: string };

export interface SecurityHeadersOptions {
  readonly appEnv?: string;
  readonly isHttps?: boolean;
  readonly isApi?: boolean;
  readonly hstsMaxAge?: number;
}

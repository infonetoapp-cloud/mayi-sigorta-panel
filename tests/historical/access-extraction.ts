// DORMANT F-27 historical Access unit evidence; never a Worker runtime dependency.
import { AccessVerificationError } from './access-errors';

/**
 * Cloudflare Access Başlık Çıkarma Yardımcısı (M1-T05).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ:
 * - Tek kanonik kimlik doğrulama kaynağı 'Cf-Access-Jwt-Assertion' başlığıdır.
 * - Authorization başlığı, çerezler (CF_Authorization dahil), e-posta başlıkları
 *   veya sorgu parametreleri (?token=, ?jwt= vb.) KESİNLİKLE KABUL EDİLMEZ.
 * - Aşırı büyük belirteçler (>16 KiB) ve belirsiz/çift başlıklı istekler deterministik reddedilir.
 */

export const MAX_ASSERTION_LENGTH_BYTES = 16 * 1024; // 16 KiB (16384 bayt)

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function extractAccessJwtAssertion(input: Request | Headers): string {
  if (
    !input ||
    typeof input !== 'object' ||
    (!(input instanceof Request) && !(input instanceof Headers))
  ) {
    throw new AccessVerificationError('MISSING_ASSERTION');
  }

  const headers = input instanceof Request ? input.headers : input;

  const rawHeader = headers.get('cf-access-jwt-assertion');
  if (rawHeader === null || rawHeader === undefined) {
    throw new AccessVerificationError('MISSING_ASSERTION');
  }

  // Çift veya birleştirilmiş (comma-joined) belirsiz başlık denetimi
  if (rawHeader.includes(',')) {
    throw new AccessVerificationError('AMBIGUOUS_ASSERTION_HEADER');
  }

  // Açık kırpma (explicit trim) politikası
  const token = rawHeader.trim();
  if (token.length === 0) {
    throw new AccessVerificationError('MISSING_ASSERTION');
  }

  // Boyut sınırı denetimi (DoS ve aşırı bellek tüketimi önleme)
  if (token.length > MAX_ASSERTION_LENGTH_BYTES) {
    throw new AccessVerificationError('ASSERTION_TOO_LARGE');
  }

  // Kompakt JWS biçim kontrolü: tam olarak 3 parçadan oluşmalıdır
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AccessVerificationError('INVALID_ASSERTION_FORMAT');
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  if (
    !headerPart ||
    !payloadPart ||
    !BASE64URL_PATTERN.test(headerPart) ||
    !BASE64URL_PATTERN.test(payloadPart) ||
    (signaturePart !== undefined && !SIGNATURE_BASE64URL_PATTERN.test(signaturePart))
  ) {
    throw new AccessVerificationError('INVALID_ASSERTION_FORMAT');
  }

  return token;
}

import type { SecurityHeadersOptions } from './types';

export const DEFAULT_TRUSTED_ORIGIN = 'https://panel.mayisigorta.com' as const;

export const CSP_DIRECTIVE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const LOGIN_CSP_DIRECTIVE =
  CSP_DIRECTIVE.replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`) +
  `; frame-src ${TURNSTILE_ORIGIN}`;

export const PERMISSIONS_POLICY_DIRECTIVE = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

export const DEFAULT_HSTS_MAX_AGE = 86400; // 1 gün (önce bir gün, pilot sonrası 180 gün)

/**
 * NIHAI_MIMARI_VE_UYGULAMA_PLANI Bölüm 11.2 uyarınca gerekli HTTP güvenlik ve önbellek başlıklarını üretir.
 */
export function getSecurityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  const {
    appEnv = 'development',
    isHttps = false,
    isApi = false,
    hstsMaxAge = DEFAULT_HSTS_MAX_AGE,
    allowTurnstile = false,
  } = options;

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY_DIRECTIVE,
    'Content-Security-Policy': allowTurnstile ? LOGIN_CSP_DIRECTIVE : CSP_DIRECTIVE,
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  };

  // HSTS Postürü: Yalnızca production ortamında ve HTTPS protokolüyle gelen isteklerde
  // Ana domain includeSubDomains veya preload bayrakları eklenmez (Bölüm 11.2).
  if (appEnv === 'production' && isHttps) {
    headers['Strict-Transport-Security'] = `max-age=${hstsMaxAge}`;
  }

  // API Önbellek Duruşu: PII içeren API ve tüm hata yanıtları private/no-store ile işaretlenir.
  if (isApi) {
    headers['Cache-Control'] = 'private, no-store, no-cache, must-revalidate';
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  }

  return headers;
}

/**
 * Yanıt nesnesine güvenlik başlıklarını mevcut başlıkları ezmeden/uygun şekilde ekler.
 */
export function applySecurityHeaders(
  response: Response,
  options: SecurityHeadersOptions = {},
): Response {
  const securityHeaders = getSecurityHeaders(options);
  const newHeaders = new Headers(response.headers);

  for (const [name, value] of Object.entries(securityHeaders)) {
    // Statik varlıklar kendi Cache-Control başlıklarını taşıyorsa API dışı durumlarda ezme
    if (
      name.toLowerCase() === 'cache-control' &&
      !options.isApi &&
      newHeaders.has('cache-control')
    ) {
      continue;
    }
    newHeaders.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

import type { Context, MiddlewareHandler, Env } from 'hono';
import type { CsrfFailureCode, CsrfVerificationResult } from './types';
import { csrfSessionSubject } from '../auth/session';

interface CsrfPayload {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
}

const DEFAULT_CSRF_TTL_SECONDS = 900; // 15 dakika
const MAX_CSRF_TTL_SECONDS = 900;
const MAX_CLOCK_SKEW_SECONDS = 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array | null {
  if (
    typeof str !== 'string' ||
    str.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(str) ||
    str.length % 4 === 1
  ) {
    return null;
  }

  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return base64UrlEncode(bytes) === str ? bytes : null;
  } catch {
    return null;
  }
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Kimliğe bağlı (identity-bound), imzalı ve kısa ömürlü (short-lived) CSRF belirteci üretir.
 */
export async function generateIdentityBoundCsrfToken(
  options: {
    subject: string;
    issuedAt?: number;
    ttlSeconds?: number;
  },
  secret: string,
): Promise<string> {
  const now = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_CSRF_TTL_SECONDS;

  if (
    typeof options.subject !== 'string' ||
    options.subject.trim() === '' ||
    options.subject !== options.subject.trim() ||
    !Number.isInteger(now) ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > MAX_CSRF_TTL_SECONDS ||
    typeof secret !== 'string' ||
    secret.length < 32
  ) {
    throw new Error('INVALID_CSRF_TOKEN_INPUT');
  }

  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64UrlEncode(nonceBytes);

  const payload: CsrfPayload = {
    sub: options.subject,
    iat: now,
    exp: now + ttl,
    nonce,
  };

  const encoder = new TextEncoder();
  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = base64UrlEncode(encoder.encode(payloadJson));

  const key = await getHmacKey(secret);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadEncoded));
  const signatureEncoded = base64UrlEncode(new Uint8Array(signatureBuffer));

  return `${payloadEncoded}.${signatureEncoded}`;
}

/**
 * Kimliğe bağlı CSRF belirtecini doğrular.
 */
export async function verifyIdentityBoundCsrfToken(
  token: string,
  expectedSubject: string,
  secret: string,
): Promise<CsrfVerificationResult> {
  if (typeof token !== 'string' || !token.includes('.')) {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci bozuk veya geçersiz biçimde.',
    };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci iki parçalı olmalıdır.',
    };
  }

  const payloadEncoded = parts[0];
  const signatureEncoded = parts[1];

  if (!payloadEncoded || !signatureEncoded) {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci parçaları boş olamaz.',
    };
  }

  const signatureBytes = base64UrlDecode(signatureEncoded);
  if (!signatureBytes) {
    return {
      valid: false,
      code: 'INVALID_SIGNATURE',
      message: 'CSRF belirteci imzası çözümlenemedi.',
    };
  }

  const encoder = new TextEncoder();
  const key = await getHmacKey(secret);
  const isValidSignature = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes as unknown as BufferSource,
    encoder.encode(payloadEncoded),
  );

  if (!isValidSignature) {
    return {
      valid: false,
      code: 'INVALID_SIGNATURE',
      message: 'CSRF belirteci imzası geçersiz.',
    };
  }

  const payloadBytes = base64UrlDecode(payloadEncoded);
  if (!payloadBytes) {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci verisi çözümlenemedi.',
    };
  }

  let payload: CsrfPayload;
  try {
    const decoder = new TextDecoder();
    payload = JSON.parse(decoder.decode(payloadBytes)) as CsrfPayload;
  } catch {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci JSON verisi okunamadı.',
    };
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof payload.sub !== 'string' ||
    payload.sub.trim() === '' ||
    payload.sub !== payload.sub.trim() ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    typeof payload.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{20,24}$/.test(payload.nonce) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_CSRF_TTL_SECONDS
  ) {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci güvenlik sınırlarını karşılamıyor.',
    };
  }

  // 1. Kimlik eşleşmesi (Identity-Bound)
  if (payload.sub !== expectedSubject) {
    return {
      valid: false,
      code: 'SUBJECT_MISMATCH',
      message: 'CSRF belirteci aktif kullanıcı kimliği ile uyuşmuyor.',
    };
  }

  // 2. Süre dolumu denetimi (Short-Lived)
  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now + MAX_CLOCK_SKEW_SECONDS) {
    return {
      valid: false,
      code: 'MALFORMED_TOKEN',
      message: 'CSRF belirteci henüz geçerli değil.',
    };
  }

  if (now >= payload.exp) {
    return {
      valid: false,
      code: 'EXPIRED_TOKEN',
      message: 'CSRF belirtecinin süresi dolmuş.',
    };
  }

  return {
    valid: true,
    subject: payload.sub,
    issuedAt: payload.iat,
  };
}

export const CSRF_HEADER_NAME = 'X-CSRF-Token' as const;

export interface AuthenticatedCsrfContext {
  readonly authenticatedSubject: string;
  readonly secret: string;
}

export type CsrfGuardFailureCode = CsrfFailureCode | 'MISSING_CSRF_TOKEN';

export type CsrfGuardResult =
  | { readonly allowed: true; readonly subject: string }
  | {
      readonly allowed: false;
      readonly status: 403;
      readonly code: CsrfGuardFailureCode;
      readonly message: string;
    };

/**
 * Sunucu tarafından kimliği doğrulanmış kullanıcıya karşı mutasyon CSRF korumasını çalıştırır.
 *
 * KRİTİK GÜVENLİK KURALI:
 * authenticatedSubject parametresi YALNIZCA sunucu kimlik katmanından (T05/T06) sağlanabilir;
 * asla istemci başlığı, sorgu parametresi veya istek gövdesinden türetilemez.
 */
export async function verifyCsrfMutationGuard(
  request: Request,
  context: AuthenticatedCsrfContext,
): Promise<CsrfGuardResult> {
  const { authenticatedSubject, secret } = context;

  if (
    !authenticatedSubject ||
    typeof authenticatedSubject !== 'string' ||
    authenticatedSubject.trim() === ''
  ) {
    return {
      allowed: false,
      status: 403,
      code: 'SUBJECT_MISMATCH',
      message: 'Sunucu tarafından doğrulanmış kullanıcı kimliği (subject) eksik veya geçersiz.',
    };
  }

  const rawToken = request.headers.get('x-csrf-token') ?? request.headers.get(CSRF_HEADER_NAME);

  if (!rawToken || rawToken.length === 0 || rawToken !== rawToken.trim()) {
    return {
      allowed: false,
      status: 403,
      code: 'MISSING_CSRF_TOKEN',
      message: 'Mutasyon işlemi için X-CSRF-Token başlığı zorunludur.',
    };
  }

  const verification = await verifyIdentityBoundCsrfToken(
    rawToken,
    csrfSessionSubject(request, authenticatedSubject.trim()),
    secret,
  );

  if (!verification.valid) {
    return {
      allowed: false,
      status: 403,
      code: verification.code,
      message: verification.message,
    };
  }

  return {
    allowed: true,
    subject: verification.subject,
  };
}

/**
 * Hono rotaları için kimlik-doğrulaması-sonrası (post-auth) CSRF mutasyon koruma ara yazılımı.
 */
export function createAuthenticatedCsrfGuard<E extends Env = Env>(
  resolveAuthContext: (
    c: Context<E>,
  ) => Promise<AuthenticatedCsrfContext> | AuthenticatedCsrfContext,
): MiddlewareHandler<E> {
  return async (c, next) => {
    const authContext = await resolveAuthContext(c);
    const result = await verifyCsrfMutationGuard(c.req.raw, authContext);

    if (!result.allowed) {
      return c.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: result.message,
          },
          timestamp: new Date().toISOString(),
        },
        403,
      );
    }

    await next();
  };
}

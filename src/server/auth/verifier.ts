import {
  jwtVerify,
  createRemoteJWKSet,
  decodeProtectedHeader,
  customFetch,
  errors as joseErrors,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { assertTrustedAccessConfig, type AccessConfig } from './config';
import { AccessVerificationError } from './errors';
import { extractAccessJwtAssertion } from './extraction';
import type { VerifiedAccessPrincipal, AccessAssurance } from './types';

/**
 * Cloudflare Access JWT Doğrulayıcı Temeli (M1-T05).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ:
 * - Sadece 'RS256' algoritmasına izin verilir; none, HS* ve diğer tüm algoritmalar yasaktır.
 * - jku ve x5u başlıkları reddedilir; anahtar seçimi YALNIZCA güvenilir sunucu yapılandırmasından
 *   türetilen JWKS adresi üzerinden yapılır.
 * - Hata mesajlarına saldırgan kontrollü değerler (alg, claim vb.) KESİNLİKLE sızdırılmaz.
 * - aud claim'i exact match ile doğrulanır ve NORMAL vs SECURE ayrımı deterministik yapılır.
 * - aud hem normal hem secure içerirse AMBIGUOUS_AUDIENCE ile fail-closed reddedilir.
 * - payload.type === 'app' zorunludur.
 * - Döndürülen VerifiedAccessPrincipal YALNIZCA minimal alanları içerir.
 */

export type AccessKeyResolver = JWTVerifyGetKey;

export interface AccessVerifierOptions {
  readonly config: AccessConfig;
  readonly keyResolver?: AccessKeyResolver;
  readonly clockToleranceSeconds?: number;
  readonly cooldownDurationMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
}

export interface AccessVerifier {
  readonly config: AccessConfig;
  verify(
    requestOrHeaders: Request | Headers,
    expectedAssurance?: AccessAssurance,
  ): Promise<VerifiedAccessPrincipal>;
}

/**
 * Yönlendirmeleri (redirects) katı şekilde reddeden ve yalnızca güvenilen
 * exact URL/origin hedefini çağıran korumalı JWKS fetch sarmalayıcısı.
 */
export function createHardenedJwksFetch(trustedJwksUrl: string, baseFetch: typeof fetch = fetch) {
  const expectedUrl = new URL(trustedJwksUrl);

  return async (
    url: string,
    options: {
      headers: Headers;
      method: 'GET';
      redirect: 'manual';
      signal: AbortSignal;
    },
  ): Promise<Response> => {
    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch {
      throw new Error('Geçersiz JWKS URL adresi.');
    }

    // 1. Hedef URL, güvenilir beklenen URL ile tam href eşitliği sağlamalıdır (query, hash veya path farkı reddedilir)
    if (targetUrl.href !== expectedUrl.href) {
      throw new Error('JWKS fetch hedefi güvenilen adresle tam eşleşmiyor.');
    }

    // 2. Kimlik bilgisi ve gereksiz başlıkların aktarılması engellenir
    const sanitizedHeaders = new Headers();
    if (options.headers.has('accept')) {
      sanitizedHeaders.set('accept', options.headers.get('accept')!);
    }
    if (options.headers.has('user-agent')) {
      sanitizedHeaders.set('user-agent', options.headers.get('user-agent')!);
    }

    // 3. baseFetch çağrısında YALNIZCA güvenilen beklenen URL (expectedUrl.href) kullanılır ve redirect: 'manual' zorunlu kılınır
    const res = await baseFetch(expectedUrl.href, {
      method: 'GET',
      headers: sanitizedHeaders,
      redirect: 'manual',
      signal: options.signal,
    });

    // 4. Yönlendirmeler (301, 302, 307, 308) ve 200 harici durumlar fail-closed reddedilir
    // Hata mesajı jeneriktir; durum kodu, URL veya yapılandırma değeri sızdırmaz
    if (
      (res.status >= 300 && res.status < 400) ||
      res.type === 'opaqueredirect' ||
      res.status !== 200
    ) {
      throw new Error('JWKS HTTP yanıtı 200 OK değil veya yönlendirme içeriyor.');
    }

    return res;
  };
}

// Güvenilir JWKS URL başına modül seviyesinde JWKS önbelleği (Cross-request kimlik durumu içermez)
const jwksResolversCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function getOrCreateRemoteJWKSet(
  config: AccessConfig,
  fetchFn?: typeof fetch,
  cooldownDurationMs?: number,
): ReturnType<typeof createRemoteJWKSet> {
  assertTrustedAccessConfig(config);

  // Özel fetchFn veya cooldownDurationMs sağlandığında önbellek dışı yeni örnek döndür
  if (fetchFn || cooldownDurationMs !== undefined) {
    const hardenedFetch = createHardenedJwksFetch(config.jwksUrl, fetchFn ?? fetch);
    return createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: cooldownDurationMs ?? 30000,
      cacheMaxAge: 600000,
      [customFetch]: hardenedFetch,
    });
  }

  let resolver = jwksResolversCache.get(config.jwksUrl);
  if (!resolver) {
    const hardenedFetch = createHardenedJwksFetch(config.jwksUrl, fetch);
    resolver = createRemoteJWKSet(new URL(config.jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
      [customFetch]: hardenedFetch,
    });
    jwksResolversCache.set(config.jwksUrl, resolver);
  }
  return resolver;
}

function mapJoseErrorToAccessError(err: unknown): AccessVerificationError {
  if (err instanceof AccessVerificationError) {
    return err;
  }

  if (err instanceof joseErrors.JWTExpired) {
    return new AccessVerificationError('TOKEN_EXPIRED');
  }

  if (
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWSInvalid
  ) {
    return new AccessVerificationError('INVALID_SIGNATURE');
  }

  if (err instanceof joseErrors.JWKSNoMatchingKey) {
    return new AccessVerificationError('KEY_NOT_FOUND');
  }

  if (err instanceof joseErrors.JWKSTimeout) {
    return new AccessVerificationError('JWKS_FETCH_FAILED');
  }

  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.reason === 'invalid') {
      return new AccessVerificationError('INVALID_CLAIM_TYPES');
    }
    switch (err.claim) {
      case 'iss':
        return new AccessVerificationError('INVALID_ISSUER');
      case 'nbf':
        return new AccessVerificationError('TOKEN_NOT_YET_VALID');
      case 'aud':
        return new AccessVerificationError('INVALID_AUDIENCE');
      case 'sub':
        return new AccessVerificationError('INVALID_SUBJECT');
      case 'exp':
        return new AccessVerificationError('TOKEN_EXPIRED');
      default:
        return new AccessVerificationError('INVALID_CLAIM_TYPES');
    }
  }

  if (err instanceof joseErrors.JWKSMultipleMatchingKeys) {
    return new AccessVerificationError('INVALID_TOKEN');
  }

  if (err instanceof joseErrors.JOSEError) {
    return new AccessVerificationError('JWKS_FETCH_FAILED');
  }

  const message = err instanceof Error ? err.message : String(err);

  if (
    message.includes('Expected 200 OK') ||
    message.includes('Failed to parse') ||
    message.includes('JSON Web Key Set HTTP response') ||
    message.includes('fetch') ||
    message.includes('Network') ||
    message.includes('JWKS') ||
    message.includes('JSON structure') ||
    message.includes('yönlendirme') ||
    message.includes('redirect') ||
    message.includes('tam eşleşmiyor')
  ) {
    return new AccessVerificationError('JWKS_FETCH_FAILED');
  }

  if (message.includes('alg') || message.includes('algorithm')) {
    return new AccessVerificationError('INVALID_ALGORITHM');
  }

  if (message.includes('no matching key') || message.includes('kid')) {
    return new AccessVerificationError('KEY_NOT_FOUND');
  }

  return new AccessVerificationError('INVALID_SIGNATURE');
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  const { config } = options;

  // Çözücü sınırında yapılandırmanın güvenilir ve tahrif edilmemiş olduğunu doğrula
  try {
    assertTrustedAccessConfig(config);
  } catch {
    throw new AccessVerificationError('CONFIGURATION_ERROR');
  }

  const clockTolerance = options.clockToleranceSeconds ?? 5;

  if (clockTolerance < 0 || clockTolerance > 5) {
    throw new AccessVerificationError('CONFIGURATION_ERROR');
  }

  const keyResolver =
    options.keyResolver ??
    getOrCreateRemoteJWKSet(config, options.fetchFn, options.cooldownDurationMs);

  return {
    config,
    async verify(
      requestOrHeaders: Request | Headers,
      expectedAssurance?: AccessAssurance,
    ): Promise<VerifiedAccessPrincipal> {
      const token = extractAccessJwtAssertion(requestOrHeaders);

      // 1. Korumalı başlık (protected header) denetimi
      let protectedHeader: Record<string, unknown>;
      try {
        protectedHeader = decodeProtectedHeader(token) as Record<string, unknown>;
      } catch {
        throw new AccessVerificationError('INVALID_ASSERTION_FORMAT');
      }

      // Güvenlik kapısı: jku ve x5u kesinlikle reddedilir
      if ('jku' in protectedHeader && protectedHeader.jku !== undefined) {
        throw new AccessVerificationError('INVALID_TOKEN');
      }
      if ('x5u' in protectedHeader && protectedHeader.x5u !== undefined) {
        throw new AccessVerificationError('INVALID_TOKEN');
      }

      // Algoritma sabitleme: Yalnızca RS256
      // Hata mesajına saldırgan kontrollü alg değeri kesinlikle dahil edilmez
      if (protectedHeader.alg !== 'RS256') {
        throw new AccessVerificationError('INVALID_ALGORITHM');
      }

      // kid zorunluluğu
      if (
        !protectedHeader.kid ||
        typeof protectedHeader.kid !== 'string' ||
        protectedHeader.kid.trim() === ''
      ) {
        throw new AccessVerificationError('KEY_NOT_FOUND');
      }

      // 2. Kriptografik imza ve temel standart claim doğrulama
      let payload: JWTPayload;
      try {
        const verifyResult = await jwtVerify(token, keyResolver, {
          issuer: config.issuer,
          algorithms: ['RS256'],
          clockTolerance,
          currentDate: options.now ? options.now() : undefined,
        });
        payload = verifyResult.payload;
      } catch (err: unknown) {
        throw mapJoseErrorToAccessError(err);
      }

      // 3. Katı claim ve tip doğrulamaları
      // A. iss doğrulaması
      if (typeof payload.iss !== 'string' || payload.iss !== config.issuer) {
        throw new AccessVerificationError('INVALID_ISSUER');
      }

      // B. sub doğrulaması
      if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
        throw new AccessVerificationError('INVALID_SUBJECT');
      }

      // C. aud doğrulaması ve NORMAL vs SECURE sınıflandırması
      if (payload.aud === undefined || payload.aud === null) {
        throw new AccessVerificationError('INVALID_AUDIENCE');
      }

      let matchesNormal = false;
      let matchesSecure = false;

      if (typeof payload.aud === 'string') {
        matchesNormal = payload.aud === config.normalAudience;
        matchesSecure = payload.aud === config.secureAudience;
      } else if (Array.isArray(payload.aud)) {
        for (const item of payload.aud) {
          if (typeof item !== 'string') {
            throw new AccessVerificationError('INVALID_CLAIM_TYPES');
          }
          if (item === config.normalAudience) matchesNormal = true;
          if (item === config.secureAudience) matchesSecure = true;
        }
      } else {
        throw new AccessVerificationError('INVALID_CLAIM_TYPES');
      }

      if (matchesNormal && matchesSecure) {
        throw new AccessVerificationError('AMBIGUOUS_AUDIENCE');
      }

      if (!matchesNormal && !matchesSecure) {
        throw new AccessVerificationError('INVALID_AUDIENCE');
      }

      const assurance: AccessAssurance = matchesNormal ? 'NORMAL' : 'SECURE';

      if (expectedAssurance !== undefined && assurance !== expectedAssurance) {
        throw new AccessVerificationError('INVALID_AUDIENCE');
      }

      // D. exp doğrulaması
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new AccessVerificationError('INVALID_CLAIM_TYPES');
      }

      // E. nbf doğrulaması (varsa)
      if (
        payload.nbf !== undefined &&
        (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf))
      ) {
        throw new AccessVerificationError('INVALID_CLAIM_TYPES');
      }

      // F. iat doğrulaması (varsa)
      if (
        payload.iat !== undefined &&
        (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat))
      ) {
        throw new AccessVerificationError('INVALID_CLAIM_TYPES');
      }

      // G. type alanı doğrulaması: Access uygulama belirteci için zorunlu ('app')
      if (payload.type !== 'app') {
        throw new AccessVerificationError('INVALID_CLAIM_TYPES');
      }

      // H. email alanı doğrulaması (varsa string olmalı)
      if (payload.email !== undefined && typeof payload.email !== 'string') {
        throw new AccessVerificationError('INVALID_CLAIM_TYPES');
      }

      // 4. Minimal ve korumalı VerifiedAccessPrincipal inşası
      const principal: VerifiedAccessPrincipal = {
        issuer: payload.iss,
        subject: payload.sub,
        assurance,
        expiresAt: payload.exp,
        ...(typeof payload.iat === 'number' ? { issuedAt: payload.iat } : {}),
        ...(typeof payload.nbf === 'number' ? { notBefore: payload.nbf } : {}),
        ...(typeof payload.email === 'string' && payload.email.trim().length > 0
          ? { email: payload.email.trim() }
          : {}),
      };

      return Object.freeze(principal);
    },
  };
}

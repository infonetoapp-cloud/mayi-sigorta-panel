import type { Context, MiddlewareHandler, Next } from 'hono';
import {
  applySecurityHeaders,
  DEFAULT_HSTS_MAX_AGE,
  DEFAULT_TRUSTED_ORIGIN,
  getSecurityHeaders,
} from './headers';
import { validateRequestOrigin } from './origin';
import { validateFetchMetadata } from './fetch-metadata';
import type { SecurityBoundaryConfig } from './types';
import type { ApiResponse } from '../../shared/types';

/**
 * Hono API İstek Güvenlik Sınırı Ara Yazılımı (Request Security Boundary Middleware).
 *
 * KRİTİK GÜVENLİK SÖZLEŞMESİ (Bölüm 9 ve 11):
 * 1. Safe explicit OPTIONS: Hostile origin'e 403 döner, asla origin yansıtmaz, asla wildcard credential vermez.
 * 2. Additive Sec-Fetch-* denetimi: cross-site veya geçersiz modlar derhal 403 üretir.
 * 3. GET/HEAD politikası: Origin zorunlu değildir fakat cross-site veya yabancı origin varsa 403 ile engellenir.
 * 4. Mutasyon politikası (POST/PUT/PATCH/DELETE): Origin zorunludur ve exact trustedOrigin ile eşleşmelidir.
 * 5. Başlık garantisi: Başarılı veya hatalı (4xx, 5xx) tüm yanıtlara güvenlik ve private/no-store başlıkları eklenir.
 */
export function createSecurityBoundaryMiddleware(
  config: SecurityBoundaryConfig = {},
): MiddlewareHandler {
  const baseTrustedOrigin = config.trustedOrigin ?? DEFAULT_TRUSTED_ORIGIN;
  const baseAppEnv = config.appEnv ?? 'development';
  const baseHstsMaxAge = config.hstsMaxAge ?? DEFAULT_HSTS_MAX_AGE;

  return async function securityBoundaryMiddleware(
    c: Context,
    next: Next,
  ): Promise<Response | void> {
    const rawReq = c.req.raw;
    const url = new URL(rawReq.url);
    const isHttps = url.protocol === 'https:';
    const method = rawReq.method.toUpperCase();

    // Dinamik ortam yapılandırması (eğer env içinde tanımlıysa)
    const envObj = (c.env ?? {}) as Record<string, unknown>;
    const appEnv =
      (envObj.APP_ENV as 'development' | 'test' | 'staging' | 'production' | undefined) ??
      baseAppEnv;
    const trustedOrigin = (envObj.PANEL_ORIGIN as string | undefined) ?? baseTrustedOrigin;
    const hstsMaxAge = baseHstsMaxAge;

    // 1. OPTIONS İstek Yönetimi (Explicit Safe Preflight)
    if (method === 'OPTIONS') {
      const originHeader = rawReq.headers.get('origin');
      if (originHeader) {
        const originCheck = validateRequestOrigin(rawReq, trustedOrigin);
        if (!originCheck.valid) {
          // Düşmanca veya tanınmayan origin: Kesinlikle CORS başlığı açılmaz, 403 döner
          const headers = getSecurityHeaders({ appEnv, isHttps, isApi: true, hstsMaxAge });
          return new Response(null, {
            status: 403,
            headers,
          });
        }

        // Güvenilen same-origin preflight: Açık ve sınırlı başlıklar
        const headers = {
          ...getSecurityHeaders({ appEnv, isHttps, isApi: true, hstsMaxAge }),
          Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
          'Access-Control-Allow-Origin': trustedOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, Cf-Access-Jwt-Assertion, X-Requested-With, X-CSRF-Token',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        };
        return new Response(null, {
          status: 204,
          headers,
        });
      }

      // Origin başlığı içermeyen standart HTTP OPTIONS sorgusu
      const headers = {
        ...getSecurityHeaders({ appEnv, isHttps, isApi: true, hstsMaxAge }),
        Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
      };
      return new Response(null, {
        status: 204,
        headers,
      });
    }

    // 2. Fetch Metadata Savunma Derinliği
    const fetchMetaCheck = validateFetchMetadata(rawReq);
    if (!fetchMetaCheck.valid) {
      const errorBody: ApiResponse<never> = {
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: fetchMetaCheck.message,
        },
        timestamp: new Date().toISOString(),
      };
      const res = Response.json(errorBody, { status: 403 });
      return applySecurityHeaders(res, { appEnv, isHttps, isApi: true, hstsMaxAge });
    }

    // 3. GET / HEAD Güvenlik Politikası
    if (method === 'GET' || method === 'HEAD') {
      const originHeader = rawReq.headers.get('origin');
      if (originHeader) {
        const originCheck = validateRequestOrigin(rawReq, trustedOrigin);
        if (!originCheck.valid) {
          const errorBody: ApiResponse<never> = {
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'Çapraz kaynaklı (cross-origin) API okuma isteklerine izin verilmez.',
            },
            timestamp: new Date().toISOString(),
          };
          const res = Response.json(errorBody, { status: 403 });
          return applySecurityHeaders(res, { appEnv, isHttps, isApi: true, hstsMaxAge });
        }
      }
    } else {
      // 4. Mutasyon İstekleri (POST, PUT, PATCH, DELETE)
      // Tarayıcı API mutasyonlarında Origin başlığı zorunludur ve exact trustedOrigin olmalıdır (Fail-Closed)
      const originCheck = validateRequestOrigin(rawReq, trustedOrigin);
      if (!originCheck.valid) {
        const errorBody: ApiResponse<never> = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: originCheck.message,
          },
          timestamp: new Date().toISOString(),
        };
        const res = Response.json(errorBody, { status: 403 });
        return applySecurityHeaders(res, { appEnv, isHttps, isApi: true, hstsMaxAge });
      }
    }

    // Sonraki işleyiciye geç
    await next();

    // 5. Yanıt Güvenlik Başlıklarının Eklenmesi
    if (c.res) {
      c.res = applySecurityHeaders(c.res, {
        appEnv,
        isHttps,
        isApi: true,
        hstsMaxAge,
      });
    }
  };
}

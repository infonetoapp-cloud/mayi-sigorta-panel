import { Hono } from 'hono';
import { API_PREFIX } from '../shared/constants';
import type { ApiResponse, CsrfTokenDto, HealthCheckData, UserMeDto } from '../shared/types';
import { parseCsrfConfig, parseServerConfig } from './config';
import { parseAccessConfig, type AccessConfig } from './auth/config';
import { AccessVerificationError } from './auth/errors';
import { createAccessVerifier, type AccessVerifier } from './auth/verifier';
import {
  createApplicationIdentityResolver,
  IdentityResolutionError,
  toUserMeDto,
  type ApplicationIdentityResolver,
} from './auth/identity';
import type { VerifiedAccessPrincipal } from './auth/types';
import { applySecurityHeaders, createSecurityBoundaryMiddleware } from './security';
import { generateIdentityBoundCsrfToken } from './security/csrf';
import { registerCustomerRoutes } from './customers/routes';
import { registerCatalogRoutes } from './catalogs/routes';
import { registerPolicyRoutes } from './policies/routes';
import { registerTaskRoutes } from './tasks/routes';
import { registerRenewalCommandRoutes } from './renewals/routes';
import { runScheduledRenewalGeneration } from './renewals/generation';
import { dispatchDueDocumentJobs, type DocumentJobQueueMessage } from './documents/queue';
import { registerDocumentRoutes } from './documents/routes';

/**
 * Mayı Sigorta CRM - Cloudflare Worker Sunucu Kabuğu (Hono Worker Shell).
 *
 * Mimari Sözleşme (NIHAI_MIMARI_VE_UYGULAMA_PLANI):
 * 1. /api/* yolları öncelikli olarak Hono tarafından işlenir.
 * 2. Eşleşmeyen /api/* istekleri asla SPA HTML'e düşmez; standart JSON 404 döner.
 * 3. Statik varlıklar Cloudflare Static Assets (ASSETS binding) üzerinden sunulur.
 */

export interface Env {
  ASSETS?: Fetcher;
  DB: D1Database;
  DOCS_QUARANTINE?: R2Bucket;
  DOCUMENT_SCAN_QUEUE?: Queue<DocumentJobQueueMessage>;
  DOCUMENTS_ENABLED?: string;
  [key: string]: unknown;
}

export interface AppDependencies {
  readonly createVerifier?: (config: AccessConfig) => AccessVerifier;
  readonly createResolver?: (db: D1Database) => ApplicationIdentityResolver;
}

function apiNotFoundResponse(): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Bilinmeyen API uç noktası',
      },
      timestamp: new Date().toISOString(),
    },
    { status: 404 },
  );
}

function canonicalizeRoutePath(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let depth = 0; depth <= pathname.length; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        const segments: string[] = [];
        for (const segment of decoded.replace(/\\/g, '/').split('/')) {
          if (!segment || segment === '.') continue;
          if (segment === '..') {
            segments.pop();
          } else {
            segments.push(segment);
          }
        }
        return `/${segments.join('/')}`;
      }
      decoded = next;
    }
  } catch {
    return null;
  }
  return null;
}

function isNamespacePath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (!accept) return false;

  let selectedSpecificity = -1;
  let selectedQuality = 0;
  for (const rawRange of accept.toLowerCase().split(',')) {
    const [rawMediaType, ...parameters] = rawRange.trim().split(';');
    const mediaType = rawMediaType?.trim();
    const specificity = mediaType === 'text/html' ? 2 : mediaType === 'text/*' ? 1 : 0;
    if (mediaType !== 'text/html' && mediaType !== 'text/*' && mediaType !== '*/*') continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split('=');
      if (name === 'q') {
        const parsed = Number(value);
        quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    if (specificity > selectedSpecificity) {
      selectedSpecificity = specificity;
      selectedQuality = quality;
    }
  }
  return selectedQuality > 0;
}

function isStaticAssetPath(pathname: string): boolean {
  if (isNamespacePath(pathname, '/assets')) return true;
  const finalSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return finalSegment.includes('.');
}

async function serveFrontend(
  request: Request,
  assets: Fetcher,
  canonicalPath: string | null,
): Promise<Response> {
  const assetResponse = await assets.fetch(request);
  if (assetResponse.status !== 404) return assetResponse;

  const canUseSpaFallback =
    canonicalPath !== null &&
    request.method === 'GET' &&
    acceptsHtml(request) &&
    !isStaticAssetPath(canonicalPath);
  if (!canUseSpaFallback) return assetResponse;

  const indexUrl = new URL('/index.html', request.url);
  const indexRequest = new Request(indexUrl, request);
  return assets.fetch(indexRequest);
}

export function createApp(
  dependencies: AppDependencies = {},
  configureRoutes?: (app: Hono<{ Bindings: Env }>) => void,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // İstek Güvenlik Sınırı ve Başlık Ara Yazılımı (M1-T08 Request Security Boundary)
  app.use('*', createSecurityBoundaryMiddleware());

  // Temel sistem sağlık kontrolü (Baseline Health Endpoint)
  app.get(`${API_PREFIX}/health`, (c) => {
    const config = parseServerConfig(c.env);
    const response: ApiResponse<HealthCheckData> = {
      success: true,
      data: {
        status: 'healthy',
        version: '0.1.0',
        environment: config.APP_ENV,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };
    return c.json(response, 200);
  });

  // Doğrulanmış Kullanıcı ve Aktif Üyelik Bağlamı (M1-T06 - GET /api/me)
  // Akış: Request -> Access Config -> Verifier -> Assertion Header -> Identity Resolver -> Safe DTO
  app.get(`${API_PREFIX}/me`, async (c) => {
    c.header('Cache-Control', 'no-store');

    if (!c.env.DB) {
      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Veritabanı bağlantısı kullanılamıyor.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 503);
    }

    let accessConfig: AccessConfig;
    try {
      accessConfig = parseAccessConfig(c.env);
    } catch {
      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Kimlik doğrulama yapılandırması eksik veya geçersiz.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 503);
    }

    let principal: VerifiedAccessPrincipal;
    try {
      const verifier: AccessVerifier = dependencies.createVerifier
        ? dependencies.createVerifier(accessConfig)
        : createAccessVerifier({ config: accessConfig });

      principal = await verifier.verify(c.req.raw);
    } catch (err) {
      if (err instanceof AccessVerificationError) {
        if (err.code === 'JWKS_FETCH_FAILED' || err.code === 'CONFIGURATION_ERROR') {
          const errorResponse: ApiResponse<never> = {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Kimlik doğrulama altyapısı geçici olarak kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          };
          return c.json(errorResponse, 503);
        }
      }

      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Kimlik doğrulaması sağlanamadı.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 401);
    }

    try {
      const resolver: ApplicationIdentityResolver = dependencies.createResolver
        ? dependencies.createResolver(c.env.DB)
        : createApplicationIdentityResolver(c.env.DB);

      const context = await resolver.resolve(principal);
      const data = toUserMeDto(context);

      const response: ApiResponse<UserMeDto> = {
        success: true,
        data,
        timestamp: new Date().toISOString(),
      };
      return c.json(response, 200);
    } catch (err) {
      if (err instanceof IdentityResolutionError) {
        if (
          err.code === 'DATABASE_ERROR' ||
          err.code === 'CORRUPT_IDENTITY_DATA' ||
          err.code === 'CORRUPT_MEMBERSHIP_DATA'
        ) {
          const errorResponse: ApiResponse<never> = {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Hizmet şu anda kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          };
          return c.json(errorResponse, 503);
        }

        // Bilinmeyen / iptal edilmiş kimlik, inaktif kullanıcı veya aktif üyeliği olmayan durumlar:
        // Ayrıntı sızdırmayan genel fail-closed 403 (do not reveal which lookup failed)
        const errorResponse: ApiResponse<never> = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Erişim reddedildi.',
          },
          timestamp: new Date().toISOString(),
        };
        return c.json(errorResponse, 403);
      }

      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Beklenmeyen bir hata oluştu.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 500);
    }
  });

  // Doğrulanmış Kullanıcı ve Aktif Üyelik Bağlamına Bağlı CSRF Belirteci Sağlama (GET /api/csrf-token)
  // Akış: Request -> Security Boundary -> Access Config -> Verifier -> Identity Resolver -> Identity-Bound CSRF Token
  app.get(`${API_PREFIX}/csrf-token`, async (c) => {
    c.header('Cache-Control', 'no-store, private');
    c.header('Pragma', 'no-cache');

    if (!c.env.DB) {
      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Veritabanı bağlantısı kullanılamıyor.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 503);
    }

    let accessConfig: AccessConfig;
    try {
      accessConfig = parseAccessConfig(c.env);
    } catch {
      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Kimlik doğrulama yapılandırması eksik veya geçersiz.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 503);
    }

    let principal: VerifiedAccessPrincipal;
    try {
      const verifier: AccessVerifier = dependencies.createVerifier
        ? dependencies.createVerifier(accessConfig)
        : createAccessVerifier({ config: accessConfig });

      principal = await verifier.verify(c.req.raw);
    } catch (err) {
      if (err instanceof AccessVerificationError) {
        if (err.code === 'JWKS_FETCH_FAILED' || err.code === 'CONFIGURATION_ERROR') {
          const errorResponse: ApiResponse<never> = {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Kimlik doğrulama altyapısı geçici olarak kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          };
          return c.json(errorResponse, 503);
        }
      }

      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Kimlik doğrulaması sağlanamadı.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 401);
    }

    try {
      const resolver: ApplicationIdentityResolver = dependencies.createResolver
        ? dependencies.createResolver(c.env.DB)
        : createApplicationIdentityResolver(c.env.DB);

      await resolver.resolve(principal);
    } catch (err) {
      if (err instanceof IdentityResolutionError) {
        if (
          err.code === 'DATABASE_ERROR' ||
          err.code === 'CORRUPT_IDENTITY_DATA' ||
          err.code === 'CORRUPT_MEMBERSHIP_DATA'
        ) {
          const errorResponse: ApiResponse<never> = {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Hizmet şu anda kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          };
          return c.json(errorResponse, 503);
        }

        const errorResponse: ApiResponse<never> = {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Erişim reddedildi.',
          },
          timestamp: new Date().toISOString(),
        };
        return c.json(errorResponse, 403);
      }

      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Beklenmeyen bir hata oluştu.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 500);
    }

    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'CSRF güvenlik yapılandırması eksik veya geçersiz.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 503);
    }

    try {
      const token = await generateIdentityBoundCsrfToken(
        { subject: principal.subject },
        csrfSecret,
      );

      const response: ApiResponse<CsrfTokenDto> = {
        success: true,
        data: {
          token,
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(response, 200);
    } catch {
      const errorResponse: ApiResponse<never> = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'CSRF belirteci üretilemedi.',
        },
        timestamp: new Date().toISOString(),
      };
      return c.json(errorResponse, 500);
    }
  });

  // M2-T01 Müşteri ve Kişi API Rotaları (Customer & CompanyContact Domain Routes)
  registerCustomerRoutes(app, dependencies);

  // M2-T03 Katalog ve Acente Ayarları API Rotaları (Catalog & Agency Settings Domain Routes)
  registerCatalogRoutes(app, dependencies);

  // M2-T04 Policy CORE API routes
  registerPolicyRoutes(app, dependencies);

  // M3-T02 primary renewal Task and Today’s Work API routes
  registerTaskRoutes(app, dependencies);

  // M3-T03 explicit Renewal outcome commands
  registerRenewalCommandRoutes(app, dependencies);

  // M4: belge yükleme akışı yalnız yetkili parent kapsamı ve karantina state'i üretir.
  registerDocumentRoutes(app, dependencies);

  if (configureRoutes) {
    configureRoutes(app);
  }

  // Bilinmeyen /api/* isteklerini yakalayan güvenlik kapısı (Fail-Closed API Fallback)
  // NIHAI_MIMARI_VE_UYGULAMA_PLANI Bölüm 9: "Bilinmeyen API yolu SPA HTML cevabına düşmez."
  app.all(`${API_PREFIX}/*`, (_c) => {
    return apiNotFoundResponse();
  });

  return app;
}

export const app = createApp();

export function createWorker(appInstance: Hono<{ Bindings: Env }> = app) {
  return {
    scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
      if (!controller.cron || controller.cron === '0 0 * * *') {
        ctx.waitUntil(runScheduledRenewalGeneration(env.DB));
      }
      if (controller.cron === '*/5 * * * *' && env.DOCUMENT_SCAN_QUEUE) {
        ctx.waitUntil(dispatchDueDocumentJobs(env.DB, env.DOCUMENT_SCAN_QUEUE));
      }
    },
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const canonicalPath = canonicalizeRoutePath(url.pathname);
      const isApiRequest =
        canonicalPath === null
          ? url.pathname.startsWith(API_PREFIX)
          : isNamespacePath(canonicalPath, API_PREFIX);
      const isSecureRequest =
        canonicalPath === null
          ? url.pathname.startsWith('/secure')
          : isNamespacePath(canonicalPath, '/secure');

      const appEnv =
        (env?.APP_ENV as 'development' | 'test' | 'staging' | 'production' | undefined) ??
        'development';
      const isHttps = url.protocol === 'https:';

      // API veya güvenlik onay istekleri doğrudan Hono'ya yönlendirilir
      if (isApiRequest || isSecureRequest) {
        if (canonicalPath !== url.pathname && isApiRequest) {
          return applySecurityHeaders(apiNotFoundResponse(), {
            appEnv,
            isHttps,
            isApi: true,
          });
        }
        return appInstance.fetch(request, env, ctx);
      }

      // Statik varlıklar mevcutsa ASSETS binding'e yönlendirilir
      if (env.ASSETS) {
        const frontendResponse = await serveFrontend(request, env.ASSETS, canonicalPath);
        return applySecurityHeaders(frontendResponse, {
          appEnv,
          isHttps,
          isApi: false,
        });
      }

      return applySecurityHeaders(
        new Response('Static assets binding unavailable', { status: 503 }),
        {
          appEnv,
          isHttps,
          isApi: false,
        },
      );
    },
  };
}

export const worker = createWorker(app);
export default worker;

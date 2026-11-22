import { Hono } from 'hono';
import { API_PREFIX } from '../shared/constants';
import { parseCsrfConfig, parseServerConfig } from './config';
import {
  createLocalSessionVerifier,
  parseLocalSessionConfig,
  csrfSessionSubject,
  getRequestSession,
  loadLocalSession,
  type LocalSessionConfig,
  type LocalSessionVerifier,
} from './auth/session';
import {
  createApplicationIdentityResolver,
  IdentityResolutionError,
  toUserMeDto,
  type ApplicationIdentityResolver,
} from './auth/identity';
import { registerLocalAuthRoutes, auditAuthDenial } from './auth/routes';
import { REAUTH_PAGE, REAUTH_SCRIPT } from './auth/reauth-page';
import { SessionVerificationError } from './auth/errors';
import { sessionBoundDatabase } from './auth/session-database';
import { registerPersonnelRoutes } from './auth/personnel';
import type { PasswordHasher } from './auth/password';
import type { PasswordKdfDurableObject } from './auth/password-do';
import type { DocumentUploadDurableObject } from './documents/upload-do';
import { applySecurityHeaders, createSecurityBoundaryMiddleware } from './security';
import { generateIdentityBoundCsrfToken } from './security/csrf';
import { registerCustomerRoutes } from './customers/routes';
import { registerCatalogRoutes } from './catalogs/routes';
import { registerPolicyRoutes } from './policies/routes';
import { registerClaimRoutes } from './claims/routes';
import { registerSalesRoutes } from './sales/routes';
import { registerFinanceRoutes } from './finance/routes';
import { registerTaskRoutes } from './tasks/routes';
import { registerGeneralTaskRoutes } from './tasks/general-routes';
import { registerRenewalCommandRoutes } from './renewals/routes';
import { runScheduledRenewalGeneration, RENEWAL_CONTINUATION_CRON } from './renewals/generation';
import { dispatchDueDocumentJobs, type DocumentJobQueueMessage } from './documents/queue';
import { consumeDurableDocumentJobs } from './documents/jobs';
import { consumeWithDocumentCustody } from './documents/queue-custody';
import { runDocumentHealthMonitoring } from './documents/health';
import { composePrivateDocumentCapabilities } from './documents/private-capabilities';
import { trackedDocumentBucket } from './documents/resource-admission';
import { isClosedCanaryPermit } from './documents/closed-canary';
import type { DocumentBackupCapability } from './documents/backup-capability-contract';
import { registerDocumentRoutes } from './documents/routes';
import type { DocumentBackupAdapter } from './documents/backup-storage';
import type { DocumentReconcileStorage } from './documents/reconcile-storage';
import { OPS_READINESS_PATH, registerOpsReadiness } from './ops/readiness';
import type { Decision as BackupObservation } from './backup-monitor/evidence';

export interface Env {
  PASSWORD_KDF?: DurableObjectNamespace<PasswordKdfDurableObject>;
  DOCUMENT_UPLOAD_RUNTIME?: DurableObjectNamespace<DocumentUploadDurableObject>;
  ASSETS?: Fetcher;
  DB: D1Database;
  OPS_BACKUP_STATUS?: Fetcher;
  DOCS_QUARANTINE?: R2Bucket;
  DOCUMENT_QUEUE_CUSTODY?: R2Bucket;
  DOCUMENT_JOB_QUEUE?: Queue<DocumentJobQueueMessage>;
  DOCUMENTS_ENABLED?: string;
  DOCUMENT_JOBS_ENABLED?: string;
  DOCUMENT_CRON_ENABLED?: string;
  RENEWAL_CONTINUATION_ENABLED?: string;
  DOCUMENT_BACKUP_CAPABILITY?: DocumentBackupCapability;
  AUTH_ACCOUNT_RATE_LIMITER?: RateLimit;
  DOCUMENT_UPLOAD_RATE_LIMITER?: RateLimit;
  DOCUMENT_DOWNLOAD_RATE_LIMITER?: RateLimit;
  AUTH_SOURCE_RATE_LIMITER?: RateLimit;
  [key: string]: unknown;
}
/** Explicit trusted composition seams, never selected by Env/request/header/config. */
export interface AppDependencies {
  readonly createSessionVerifier?: (config: LocalSessionConfig) => LocalSessionVerifier;
  readonly passwordHasher?: PasswordHasher;
  readonly createResolver?: (db: D1Database) => ApplicationIdentityResolver;
  readonly readBackupObservation?: (signal: AbortSignal) => Promise<BackupObservation | null>;
}
function apiNotFoundResponse(): Response {
  return Response.json(
    {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Bilinmeyen API uç noktası' },
      timestamp: new Date().toISOString(),
    },
    { status: 404 },
  );
}
function canonicalizeRoutePath(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let depth = 0; depth <= pathname.length; depth++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        const segments: string[] = [];
        for (const segment of decoded.replace(/\\/g, '/').split('/')) {
          if (!segment || segment === '.') continue;
          if (segment === '..') segments.pop();
          else segments.push(segment);
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
  let selectedSpecificity = -1,
    selectedQuality = 0;
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
  return (
    isNamespacePath(pathname, '/assets') ||
    pathname.slice(pathname.lastIndexOf('/') + 1).includes('.')
  );
}
async function serveFrontend(
  request: Request,
  assets: Fetcher,
  canonicalPath: string | null,
): Promise<Response> {
  const assetResponse = await assets.fetch(request);
  if (assetResponse.status !== 404) return assetResponse;
  if (
    canonicalPath === null ||
    request.method !== 'GET' ||
    !acceptsHtml(request) ||
    isStaticAssetPath(canonicalPath)
  )
    return assetResponse;
  return assets.fetch(new Request(new URL('/index.html', request.url), request));
}
export function createApp(
  dependencies: AppDependencies = {},
  configureRoutes?: (app: Hono<{ Bindings: Env }>) => void,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', createSecurityBoundaryMiddleware());
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/auth/') || path === '/api/health' || !c.req.header('cookie')) {
      await next();
      return;
    }
    try {
      const config = parseLocalSessionConfig(c.env);
      await (
        dependencies.createSessionVerifier?.(config) ?? createLocalSessionVerifier({ config })
      ).verify(c.req.raw);
      const session = getRequestSession(c.req.raw);
      if (session)
        c.env = {
          ...c.env,
          DB: sessionBoundDatabase(
            c.env.DB,
            session,
            isNamespacePath(canonicalizeRoutePath(path) ?? path, '/secure'),
          ),
        };
      await next();
    } catch (error) {
      if (
        path === OPS_READINESS_PATH &&
        (!(error instanceof SessionVerificationError) || error.code === 'CONFIGURATION_ERROR')
      ) {
        return c.json({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
      }
      if (path.startsWith('/secure/')) await auditAuthDenial(c, 'auth.secure.denied');
      if (
        error instanceof SessionVerificationError &&
        error.code === 'REAUTH_REQUIRED' &&
        c.req.method === 'GET' &&
        path.startsWith('/secure/') &&
        acceptsHtml(c.req.raw)
      ) {
        try {
          await loadLocalSession(c.env.DB, c.req.raw);
          return c.html(REAUTH_PAGE);
        } catch {
          /* Invalid/restricted sessions never receive any domain data. */
        }
      }
      return c.json(
        {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Oturum veya güncel şifre doğrulaması gerekli.' },
          timestamp: new Date().toISOString(),
        },
        401,
      );
    }
  });
  registerLocalAuthRoutes(app, dependencies);
  app.get('/api/auth/reauth.js', (c) =>
    c.body(REAUTH_SCRIPT, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }),
  );
  registerPersonnelRoutes(app, dependencies);
  registerOpsReadiness(app, dependencies);
  app.get(`${API_PREFIX}/health`, (c) =>
    c.json(
      { success: true, data: { status: 'healthy' }, timestamp: new Date().toISOString() },
      200,
    ),
  );
  for (const path of [`${API_PREFIX}/me`, `${API_PREFIX}/csrf-token`])
    app.get(path, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      if (!c.env.DB)
        return c.json(
          {
            success: false,
            error: { code: 'SERVICE_UNAVAILABLE', message: 'Hizmet kullanılamıyor.' },
            timestamp: new Date().toISOString(),
          },
          503,
        );
      try {
        const config = parseLocalSessionConfig(c.env);
        const verifier =
          dependencies.createSessionVerifier?.(config) ?? createLocalSessionVerifier({ config });
        const principal = await verifier.verify(c.req.raw);
        const context = await (
          dependencies.createResolver?.(c.env.DB) ?? createApplicationIdentityResolver(c.env.DB)
        ).resolve(principal);
        if (path.endsWith('/me'))
          return c.json(
            { success: true, data: toUserMeDto(context), timestamp: new Date().toISOString() },
            200,
          );
        let secret: string;
        try {
          secret = parseCsrfConfig(c.env).CSRF_SECRET;
        } catch {
          return c.json(
            {
              success: false,
              error: { code: 'SERVICE_UNAVAILABLE', message: 'Güvenlik yapılandırması eksik.' },
              timestamp: new Date().toISOString(),
            },
            503,
          );
        }
        const token = await generateIdentityBoundCsrfToken(
          { subject: csrfSessionSubject(c.req.raw, principal.subject) },
          secret,
        );
        return c.json({ success: true, data: { token }, timestamp: new Date().toISOString() }, 200);
      } catch (error) {
        const infrastructure =
          error instanceof IdentityResolutionError &&
          ['DATABASE_ERROR', 'CORRUPT_IDENTITY_DATA', 'CORRUPT_MEMBERSHIP_DATA'].includes(
            error.code,
          );
        const forbidden = error instanceof IdentityResolutionError && !infrastructure;
        return c.json(
          {
            success: false,
            error: {
              code: infrastructure
                ? 'SERVICE_UNAVAILABLE'
                : forbidden
                  ? 'FORBIDDEN'
                  : 'UNAUTHORIZED',
              message: 'Oturum veya erişim kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          },
          infrastructure ? 503 : forbidden ? 403 : 401,
        );
      }
    });
  registerCustomerRoutes(app, dependencies);
  registerCatalogRoutes(app, dependencies);
  registerPolicyRoutes(app, dependencies);
  registerFinanceRoutes(app, dependencies);
  registerClaimRoutes(app, dependencies);
  registerSalesRoutes(app, dependencies);
  registerTaskRoutes(app, dependencies);
  registerGeneralTaskRoutes(app, dependencies);
  registerRenewalCommandRoutes(app, dependencies);
  registerDocumentRoutes(app, dependencies);
  configureRoutes?.(app);
  app.all(`${API_PREFIX}/*`, () => apiNotFoundResponse());
  app.all('/secure/*', () => apiNotFoundResponse());
  return app;
}
export const app = createApp();
// Compile only the completed static router during startup, not the first auth request.
// Matching executes no handler or I/O; createApp() remains open for trusted composition.
app.router.match('GET', '/api/health');
export function createWorker(
  appInstance: Hono<{ Bindings: Env }> = app,
  documentBackup?: DocumentBackupAdapter,
  documentReconcile?: DocumentReconcileStorage,
) {
  return {
    queue(
      batch: MessageBatch<DocumentJobQueueMessage>,
      env: Env,
      _ctx?: ExecutionContext,
      closedCanary?: unknown,
    ): Promise<void> {
      // The platform invokes only three args. A fourth opaque, env+message-bound
      // capability exists only in the separate private synthetic commissioner;
      // flags, Queue bodies and HTTP inputs cannot manufacture it.
      const enabled =
        env.DOCUMENT_JOBS_ENABLED === 'true' || isClosedCanaryPermit(closedCanary, env, batch);
      const privatePeer = enabled ? env.DOCUMENT_BACKUP_CAPABILITY : undefined;
      const primary =
        enabled && env.DOCS_QUARANTINE
          ? Object.freeze({ get: env.DOCS_QUARANTINE.get.bind(env.DOCS_QUARANTINE) })
          : undefined;
      const consume = (delivery: MessageBatch<DocumentJobQueueMessage>) =>
        consumeDurableDocumentJobs(
          delivery,
          env.DB,
          primary,
          enabled,
          documentBackup,
          documentReconcile,
          (permit) =>
            composePrivateDocumentCapabilities(
              primary ? trackedDocumentBucket(primary, permit) : undefined,
              privatePeer,
              permit,
            ),
        );
      return env.APP_ENV === 'production'
        ? consumeWithDocumentCustody(batch, env.DOCUMENT_QUEUE_CUSTODY, consume)
        : consume(batch);
    },
    scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
      if (!controller.cron || controller.cron === '0 0 * * *')
        ctx.waitUntil(runScheduledRenewalGeneration(env.DB));
      // Separate invocation budget from the existing document tick. This source
      // path is dormant: neither a trigger nor its opt-in flag is provisioned here.
      if (
        controller.cron === RENEWAL_CONTINUATION_CRON &&
        env.RENEWAL_CONTINUATION_ENABLED === 'true'
      )
        ctx.waitUntil(runScheduledRenewalGeneration(env.DB, true));
      if (controller.cron === '*/5 * * * *' && env.DOCUMENT_CRON_ENABLED === 'true')
        ctx.waitUntil(runDocumentHealthMonitoring(env.DB));
      if (
        controller.cron === '*/5 * * * *' &&
        env.DOCUMENT_JOB_QUEUE &&
        env.DOCUMENT_CRON_ENABLED === 'true'
      )
        ctx.waitUntil(
          dispatchDueDocumentJobs(env.DB, env.DOCUMENT_JOB_QUEUE, [
            'DOCUMENT_BACKUP',
            'DOCUMENT_RECONCILE',
          ]),
        );
    },
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url),
        canonicalPath = canonicalizeRoutePath(url.pathname);
      const appEnv =
        (env.APP_ENV as 'development' | 'test' | 'staging' | 'production' | undefined) ??
        'development';
      const isHttps = url.protocol === 'https:';
      let origin: string;
      try {
        origin = parseServerConfig(env).PANEL_ORIGIN;
      } catch {
        return applySecurityHeaders(new Response(null, { status: 503 }), {
          appEnv,
          isHttps,
          isApi: true,
        });
      }
      if (
        !isHttps ||
        url.origin !== origin ||
        (request.headers.has('host') && request.headers.get('host') !== url.host)
      )
        return applySecurityHeaders(new Response(null, { status: 403 }), {
          appEnv,
          isHttps,
          isApi: true,
        });
      const isApiRequest =
        canonicalPath === null
          ? url.pathname.startsWith(API_PREFIX)
          : isNamespacePath(canonicalPath, API_PREFIX);
      const isSecureRequest =
        canonicalPath === null
          ? url.pathname.startsWith('/secure')
          : isNamespacePath(canonicalPath, '/secure');
      if (isApiRequest || isSecureRequest) {
        if (canonicalPath !== url.pathname)
          return applySecurityHeaders(apiNotFoundResponse(), { appEnv, isHttps, isApi: true });
        return appInstance.fetch(request, env, ctx);
      }
      if (env.ASSETS) {
        const response = await serveFrontend(request, env.ASSETS, canonicalPath);
        const isHtml = response.headers.get('content-type')?.includes('text/html') ?? false;
        return applySecurityHeaders(response, {
          appEnv,
          isHttps,
          isApi: isHtml,
          allowTurnstile: isHtml && typeof env.TURNSTILE_SITE_KEY === 'string',
        });
      }
      return applySecurityHeaders(
        new Response('Static assets binding unavailable', { status: 503 }),
        { appEnv, isHttps, isApi: false },
      );
    },
  };
}
export const worker = createWorker(app);
export default worker;

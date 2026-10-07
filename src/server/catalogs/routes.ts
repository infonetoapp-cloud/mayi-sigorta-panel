/**
 * Mayı Sigorta CRM — Katalog ve Acente Ayarları API Uç Noktaları (M2-T03)
 *
 * MİMARİ VE GÜVENLİK KURALLARI:
 * 1. Tüm mutasyonlarda gövde ayrıştırılmadan (before body parse) CSRF doğrulaması.
 * 2. Cache-Control: no-store zorunludur.
 * 3. Hata durumlarında fail-closed ve non-disclosure prensibi uygulanır.
 */

import type { Hono, Context } from 'hono';
import { API_PREFIX } from '../../shared/constants';
import { parseCsrfConfig } from '../config';
import { parseLocalSessionConfig } from '../auth/session';
import { SessionVerificationError } from '../auth/errors';
import { createLocalSessionVerifier } from '../auth/session';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import { verifyCsrfMutationGuard } from '../security/csrf';
import { OptimisticConcurrencyError } from '../db/optimistic';
import { IdempotencyConflictError } from '../mutations/idempotency';
import {
  listInsurers,
  getInsurer,
  createInsurer,
  updateInsurer,
  deactivateInsurer,
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deactivateBranch,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deactivateProduct,
  listPaymentMethods,
  getPaymentMethod,
  createPaymentMethod,
  updatePaymentMethod,
  deactivatePaymentMethod,
  listLossReasons,
  getLossReason,
  createLossReason,
  updateLossReason,
  deactivateLossReason,
  getAgencySettings,
  updateAgencySettings,
  getSelectableCatalogs,
  resolveCatalogItem,
  CatalogItemNotFoundError,
  CatalogForbiddenError,
  CatalogValidationError,
  DomainConstraintViolationError,
} from './service';
import type { AppDependencies, Env } from '../index';

type CatalogRouteEnv = { Bindings: Env };

export function registerCatalogRoutes(
  app: Hono<CatalogRouteEnv>,
  dependencies: AppDependencies = {},
): void {
  async function authenticateAndResolve(c: Context<CatalogRouteEnv>) {
    if (!c.env.DB) {
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Veritabanı bağlantısı kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          },
          503,
        ),
      };
    }

    let accessConfig;
    try {
      accessConfig = parseLocalSessionConfig(c.env);
    } catch {
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Kimlik doğrulama yapılandırması eksik.',
            },
            timestamp: new Date().toISOString(),
          },
          503,
        ),
      };
    }

    let principal;
    try {
      const verifier = dependencies.createSessionVerifier
        ? dependencies.createSessionVerifier(accessConfig)
        : createLocalSessionVerifier({ config: accessConfig });
      principal = await verifier.verify(c.req.raw);
    } catch (err) {
      if (err instanceof SessionVerificationError) {
        if (err.code === 'CONFIGURATION_ERROR') {
          return {
            error: c.json(
              {
                success: false,
                error: {
                  code: 'SERVICE_UNAVAILABLE',
                  message: 'Kimlik doğrulama altyapısı geçici olarak kullanılamıyor.',
                },
                timestamp: new Date().toISOString(),
              },
              503,
            ),
          };
        }
      }
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Kimlik doğrulaması sağlanamadı.',
            },
            timestamp: new Date().toISOString(),
          },
          401,
        ),
      };
    }

    try {
      const resolver = dependencies.createResolver
        ? dependencies.createResolver(c.env.DB)
        : createApplicationIdentityResolver(c.env.DB);
      const context = await resolver.resolve(principal);
      return { context, principal };
    } catch (err) {
      if (err instanceof IdentityResolutionError) {
        if (
          err.code === 'DATABASE_ERROR' ||
          err.code === 'CORRUPT_IDENTITY_DATA' ||
          err.code === 'CORRUPT_MEMBERSHIP_DATA'
        ) {
          return {
            error: c.json(
              {
                success: false,
                error: {
                  code: 'SERVICE_UNAVAILABLE',
                  message: 'Hizmet şu anda kullanılamıyor.',
                },
                timestamp: new Date().toISOString(),
              },
              503,
            ),
          };
        }
        return {
          error: c.json(
            {
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Erişim reddedildi.',
              },
              timestamp: new Date().toISOString(),
            },
            403,
          ),
        };
      }
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Beklenmeyen bir hata oluştu.',
            },
            timestamp: new Date().toISOString(),
          },
          500,
        ),
      };
    }
  }

  async function verifyMutationGuard(c: Context<CatalogRouteEnv>, principal: { subject: string }) {
    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'CSRF güvenlik yapılandırması eksik.',
            },
            timestamp: new Date().toISOString(),
          },
          503,
        ),
      };
    }

    const csrfResult = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: principal.subject,
      secret: csrfSecret,
    });
    if (!csrfResult.allowed) {
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: csrfResult.code,
              message: csrfResult.message,
            },
            timestamp: new Date().toISOString(),
          },
          403,
        ),
      };
    }

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return {
        error: c.json(
          {
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Idempotency-Key başlığı zorunludur.',
            },
            timestamp: new Date().toISOString(),
          },
          400,
        ),
      };
    }

    return { idempotencyKey: idempotencyKey.trim() };
  }

  function handleServiceError(c: Context<CatalogRouteEnv>, err: unknown) {
    c.header('Cache-Control', 'no-store');

    if (err instanceof CatalogValidationError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message,
            details: err.details,
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
    if (err instanceof CatalogItemNotFoundError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: err.message,
          },
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }
    if (err instanceof CatalogForbiddenError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: err.message,
          },
          timestamp: new Date().toISOString(),
        },
        403,
      );
    }
    if (err instanceof OptimisticConcurrencyError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'CONFLICT',
            message:
              'Kayıt başka bir işlem tarafından güncellenmiş. Lütfen sayfayı yenileyip tekrar deneyiniz.',
          },
          timestamp: new Date().toISOString(),
        },
        409,
      );
    }
    if (err instanceof IdempotencyConflictError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'Aynı anahtar farklı bir istek yükü ile daha önce kullanılmış.',
          },
          timestamp: new Date().toISOString(),
        },
        409,
      );
    }
    if (err instanceof DomainConstraintViolationError) {
      return c.json(
        {
          success: false,
          error: {
            code: err.code || 'CONFLICT',
            message: err.message,
          },
          timestamp: new Date().toISOString(),
        },
        409,
      );
    }

    return c.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Beklenmeyen bir hata oluştu.',
        },
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }

  // ---------------------- SELECTABLE CATALOGS ----------------------
  app.get(`${API_PREFIX}/catalogs/selectable`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getSelectableCatalogs(auth.context, c.env.DB);
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- RESOLVE CATALOG ITEM ----------------------
  app.get(`${API_PREFIX}/catalogs/resolve/:type/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await resolveCatalogItem(
        auth.context,
        c.env.DB,
        c.req.param('type'),
        c.req.param('id'),
      );
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- INSURERS ----------------------
  app.get(`${API_PREFIX}/catalogs/insurers`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const includeInactive = c.req.query('include_inactive') === 'true';
    try {
      const data = await listInsurers(auth.context, c.env.DB, { includeInactive });
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.get(`${API_PREFIX}/catalogs/insurers/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getInsurer(auth.context, c.env.DB, c.req.param('id'));
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/insurers`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await createInsurer(auth.context, c.env.DB, body, guard.idempotencyKey);
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 201,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.patch(`${API_PREFIX}/catalogs/insurers/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await updateInsurer(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/insurers/:id/deactivate`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await deactivateInsurer(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- BRANCHES ----------------------
  app.get(`${API_PREFIX}/catalogs/branches`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const includeInactive = c.req.query('include_inactive') === 'true';
    try {
      const data = await listBranches(auth.context, c.env.DB, { includeInactive });
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.get(`${API_PREFIX}/catalogs/branches/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getBranch(auth.context, c.env.DB, c.req.param('id'));
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/branches`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await createBranch(auth.context, c.env.DB, body, guard.idempotencyKey);
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 201,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.patch(`${API_PREFIX}/catalogs/branches/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await updateBranch(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/branches/:id/deactivate`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await deactivateBranch(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- PRODUCTS ----------------------
  app.get(`${API_PREFIX}/catalogs/products`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const includeInactive = c.req.query('include_inactive') === 'true';
    try {
      const data = await listProducts(auth.context, c.env.DB, { includeInactive });
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.get(`${API_PREFIX}/catalogs/products/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getProduct(auth.context, c.env.DB, c.req.param('id'));
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/products`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await createProduct(auth.context, c.env.DB, body, guard.idempotencyKey);
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 201,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.patch(`${API_PREFIX}/catalogs/products/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await updateProduct(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/products/:id/deactivate`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await deactivateProduct(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- PAYMENT METHODS ----------------------
  app.get(`${API_PREFIX}/catalogs/payment-methods`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const includeInactive = c.req.query('include_inactive') === 'true';
    try {
      const data = await listPaymentMethods(auth.context, c.env.DB, { includeInactive });
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.get(`${API_PREFIX}/catalogs/payment-methods/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getPaymentMethod(auth.context, c.env.DB, c.req.param('id'));
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/payment-methods`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await createPaymentMethod(auth.context, c.env.DB, body, guard.idempotencyKey);
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 201,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.patch(`${API_PREFIX}/catalogs/payment-methods/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await updatePaymentMethod(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/payment-methods/:id/deactivate`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await deactivatePaymentMethod(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- LOSS REASONS ----------------------
  app.get(`${API_PREFIX}/catalogs/loss-reasons`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const includeInactive = c.req.query('include_inactive') === 'true';
    try {
      const data = await listLossReasons(auth.context, c.env.DB, { includeInactive });
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.get(`${API_PREFIX}/catalogs/loss-reasons/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getLossReason(auth.context, c.env.DB, c.req.param('id'));
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/loss-reasons`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await createLossReason(auth.context, c.env.DB, body, guard.idempotencyKey);
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 201,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.patch(`${API_PREFIX}/catalogs/loss-reasons/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await updateLossReason(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.post(`${API_PREFIX}/catalogs/loss-reasons/:id/deactivate`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await deactivateLossReason(
        auth.context,
        c.env.DB,
        c.req.param('id'),
        body,
        guard.idempotencyKey,
      );
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  // ---------------------- AGENCY SETTINGS ----------------------
  app.get(`${API_PREFIX}/agency/settings`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    try {
      const data = await getAgencySettings(auth.context, c.env.DB);
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleServiceError(c, err);
    }
  });

  app.patch(`${API_PREFIX}/agency/settings`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if ('error' in auth) return auth.error;

    const guard = await verifyMutationGuard(c, auth.principal);
    if ('error' in guard) return guard.error;

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const result = await updateAgencySettings(auth.context, c.env.DB, body, guard.idempotencyKey);
      return c.json(
        { success: true, data: result.data, timestamp: new Date().toISOString() },
        result.status as 200,
      );
    } catch (err) {
      return handleServiceError(c, err);
    }
  });
}

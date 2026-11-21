/**
 * Mayı Sigorta CRM — Müşteri ve Şirket Yetkilisi API Uç Noktaları (M2-T01)
 *
 * MİMARİ VE GÜVENLİK KURALLARI:
 * 1. GET/POST /api/customers
 * 2. GET/PATCH /api/customers/:id
 * 3. POST /api/customers/:id/contacts
 * 4. PATCH /api/customers/:id/contacts/:contactId
 * 5. POST /api/customers/:id/contacts/:contactId/set-primary
 * 6. POST /api/customers/:id/contacts/:contactId/deactivate
 * 7. Tüm mutasyonlarda gövde ayrıştırılmadan (before body parse) CSRF doğrulaması.
 * 8. Cache-Control: no-store zorunludur.
 * 9. Hata durumlarında non-disclosure prensibi uygulanır; varlık bilgisi sızdırılmaz.
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
  createCustomer,
  updateCustomer,
  getCustomer,
  listCustomers,
  listCustomerReferenceOptions,
  createCompanyContact,
  updateCompanyContact,
  setPrimaryCompanyContact,
  deactivateCompanyContact,
  getCustomerIdentity,
  updateCustomerIdentity,
  searchSensitiveCustomers,
  assignCustomer,
  archiveCustomer,
  listCustomerAssignmentOptions,
  createExternalReference,
  listExternalReferences,
  listInsurerCustomerNumbers,
  listCustomerVehicles,
  saveCustomerVehicle,
  listInsurerNumberOptions,
  setInsurerCustomerNumber,
  CustomerNotFoundError,
  ContactNotFoundError,
  CustomerForbiddenError,
  DomainConstraintViolationError,
  ValidationError,
  type ListCustomersQuery,
} from './service';
import { IdentityCryptoConfigError, parseIdentityCryptoConfig } from '../security/identity-crypto';
import type { AppDependencies, Env } from '../index';
import { createCustomerNote, listCustomerNotes, CustomerNoteError } from './notes';
import { AuthHttpError, readBoundedJson } from '../auth/routes';
import { CustomerCoverageError, readCustomerCoverage } from './coverage';

type CustomerRouteEnv = { Bindings: Env };

export function registerCustomerRoutes(
  app: Hono<CustomerRouteEnv>,
  dependencies: AppDependencies = {},
): void {
  // Kimlik doğrulama ve bağlam çözümleme yardımcısı
  async function authenticateAndResolve(c: Context<CustomerRouteEnv>) {
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
      if (err instanceof SessionVerificationError && err.code === 'CONFIGURATION_ERROR') {
        return {
          error: c.json(
            {
              success: false,
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Kimlik doğrulama altyapısı kullanılamıyor.',
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
            error: { code: 'UNAUTHORIZED', message: 'Kimlik doğrulaması sağlanamadı.' },
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
      return { principal, context };
    } catch (err) {
      if (
        err instanceof IdentityResolutionError &&
        (err.code === 'DATABASE_ERROR' ||
          err.code === 'CORRUPT_IDENTITY_DATA' ||
          err.code === 'CORRUPT_MEMBERSHIP_DATA')
      ) {
        return {
          error: c.json(
            {
              success: false,
              error: { code: 'SERVICE_UNAVAILABLE', message: 'Hizmet şu anda kullanılamıyor.' },
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
            error: { code: 'FORBIDDEN', message: 'Erişim reddedildi.' },
            timestamp: new Date().toISOString(),
          },
          403,
        ),
      };
    }
  }

  // Mutasyonlarda gövde ayrıştırılmadan CSRF denetim yardımcısı
  async function checkCsrf(c: Context<CustomerRouteEnv>, subject: string) {
    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return c.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'CSRF güvenlik yapılandırması eksik veya geçersiz.',
          },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    const csrfResult = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: subject,
      secret: csrfSecret,
    });

    if (!csrfResult.allowed) {
      return c.json(
        {
          success: false,
          error: { code: csrfResult.code, message: csrfResult.message },
          timestamp: new Date().toISOString(),
        },
        403,
      );
    }
    return null;
  }

  // Ortak hata yakalama ve dönüştürme yardımcısı
  function handleError(c: Context<CustomerRouteEnv>, err: unknown) {
    if (err instanceof IdentityCryptoConfigError)
      return c.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Kimlik şifreleme altyapısı kullanılamıyor.',
          },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    if (err instanceof CustomerCoverageError)
      return c.json(
        {
          success: false,
          error: {
            code:
              err.status === 404
                ? 'NOT_FOUND'
                : err.status === 400
                  ? 'VALIDATION_ERROR'
                  : 'SERVICE_UNAVAILABLE',
            message:
              err.status === 404
                ? 'Kayıt kullanılamıyor veya erişiminiz yok.'
                : 'Poliçe özeti şu anda alınamıyor.',
          },
          timestamp: new Date().toISOString(),
        },
        err.status,
      );
    if (err instanceof AuthHttpError)
      return c.json(
        {
          success: false,
          error: { code: err.code, message: err.message },
          timestamp: new Date().toISOString(),
        },
        err.status,
      );
    if (err instanceof CustomerNoteError)
      return c.json(
        {
          success: false,
          error: {
            code: err.code,
            message:
              err.status === 404
                ? 'Kayıt bulunamadı.'
                : err.status === 409
                  ? 'İstek çakışması.'
                  : 'Müşteri notu işlemi tamamlanamadı.',
          },
          timestamp: new Date().toISOString(),
        },
        err.status,
      );
    if (err instanceof CustomerNotFoundError || err instanceof ContactNotFoundError) {
      return c.json(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Kayıt bulunamadı.' },
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }

    if (err instanceof CustomerForbiddenError) {
      return c.json(
        {
          success: false,
          error: { code: 'FORBIDDEN', message: 'Erişim reddedildi.' },
          timestamp: new Date().toISOString(),
        },
        403,
      );
    }

    if (err instanceof ValidationError) {
      return c.json(
        {
          success: false,
          error: { code: 'VALIDATION_ERROR', message: err.message, details: err.details },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    if (err instanceof OptimisticConcurrencyError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
            message:
              'Kayıt başka bir işlem tarafından güncellendi. Lütfen sayfayı yenileyip tekrar deneyiniz.',
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
          error: { code: err.code, message: 'İstek çakışması tespit edildi.' },
          timestamp: new Date().toISOString(),
        },
        409,
      );
    }

    if (err instanceof DomainConstraintViolationError) {
      const status =
        err.code === 'REPLAY_AUTHORIZATION_DENIED'
          ? 404
          : err.code === 'MULTIPLE_ACTIVE_PRIMARY_CONTACTS_PROHIBITED' ||
              err.code === 'DUPLICATE_EXTERNAL_REFERENCE' ||
              err.code === 'DUPLICATE_VEHICLE_PLATE' ||
              err.code === 'OPEN_DEPENDENCIES'
            ? 409
            : err.code === 'INDIVIDUAL_CONTACT_PROHIBITED'
              ? 400
              : 400;
      return c.json(
        {
          success: false,
          error: {
            code: err.code,
            message: err.code === 'REPLAY_AUTHORIZATION_DENIED' ? 'Kayıt bulunamadı.' : err.message,
          },
          timestamp: new Date().toISOString(),
        },
        status,
      );
    }

    return c.json(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Beklenmeyen bir hata oluştu.' },
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }

  app.get(`${API_PREFIX}/customers/reference-options`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    try {
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some((key) => key !== 'cursor' || params.getAll(key).length !== 1))
        throw new ValidationError('Geçersiz sayfalama.');
      const data = await listCustomerReferenceOptions(
        c.env.DB,
        auth.context,
        c.req.query('cursor'),
      );
      return c.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 1. GET /api/customers - Müşteri listeleme
  app.get(`${API_PREFIX}/customers`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    try {
      const include = c.req.query('include');
      if (include !== undefined && include !== 'coverage') throw new CustomerCoverageError(400);
      if (include) {
        const params = new URL(c.req.url).searchParams;
        if (
          [...params.keys()].some(
            (key) =>
              ![
                'include',
                'limit',
                'cursor',
                'sort',
                'order',
                'type',
                'search',
                'reference',
                'referenceMembershipId',
              ].includes(key) || params.getAll(key).length !== 1,
          )
        )
          throw new CustomerCoverageError(400);
        const limit = c.req.query('limit') ?? '20';
        if (!/^(?:[1-9]|1[0-9]|20)$/.test(limit)) throw new CustomerCoverageError(400);
      }
      const query: ListCustomersQuery = {
        reference: c.req.query('reference'),
        referenceMembershipId: c.req.query('referenceMembershipId'),
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : include ? 20 : undefined,
        cursor: c.req.query('cursor') || undefined,
        sort: c.req.query('sort') as ListCustomersQuery['sort'],
        order: c.req.query('order') as ListCustomersQuery['order'],
        type: c.req.query('type') as ListCustomersQuery['type'],
        search: c.req.query('search') || undefined,
      };

      const result = await listCustomers(c.env.DB, auth.context, query);
      const summaries = include
        ? await readCustomerCoverage(
            c.env.DB,
            auth.context,
            result.items.map((item) => item.id),
          )
        : null;
      return c.json(
        {
          success: true,
          data: summaries
            ? {
                ...result,
                items: result.items.map((item) => ({ ...item, coverage: summaries.get(item.id) })),
              }
            : result,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get(`${API_PREFIX}/customers/:id/coverage`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    try {
      if (new URL(c.req.url).search) throw new CustomerCoverageError(400);
      const id = c.req.param('id');
      const summaries = await readCustomerCoverage(c.env.DB, auth.context, [id]);
      return c.json(
        { success: true, data: summaries.get(id), timestamp: new Date().toISOString() },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 2. POST /api/customers - Müşteri oluşturma
  app.post(`${API_PREFIX}/customers`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF kontrolü
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const idempotencyKey = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const customer = await createCustomer(c.env.DB, auth.context, rawBody, {
        identityCryptoConfig: () => parseIdentityCryptoConfig(c.env),
        correlationId,
        idempotencyKey: idempotencyKey.trim(),
      });
      return c.json(
        {
          success: true,
          data: customer,
          timestamp: new Date().toISOString(),
        },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 3. GET /api/customers/:id - Müşteri detayı
  app.get(`${API_PREFIX}/customers/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    const customerId = c.req.param('id');
    try {
      const customer = await getCustomer(c.env.DB, auth.context, customerId);
      return c.json(
        {
          success: true,
          data: customer,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 4. PATCH /api/customers/:id - Müşteri temel bilgisi güncelleme
  app.get(`${API_PREFIX}/customers/:id/notes`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    try {
      return c.json({
        success: true,
        data: await listCustomerNotes(c.env.DB, auth.context, c.req.param('id'), c.req.query()),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return handleError(c, error);
    }
  });
  app.post(`${API_PREFIX}/customers/:id/notes`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;
    let body: unknown;
    try {
      body = await readBoundedJson(c.req.raw, 16384);
    } catch (error) {
      return handleError(
        c,
        error instanceof AuthHttpError ? error : new CustomerNoteError('VALIDATION_ERROR', 400),
      );
    }
    try {
      const result = await createCustomerNote(
        c.env.DB,
        auth.context,
        c.req.param('id'),
        body,
        c.req.header('idempotency-key') ?? '',
      );
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : 201,
      );
    } catch (error) {
      return handleError(c, error);
    }
  });

  app.patch(`${API_PREFIX}/customers/:id`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF kontrolü
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const customerId = c.req.param('id');
    const idempotencyKey = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const updated = await updateCustomer(c.env.DB, auth.context, customerId, rawBody, {
        correlationId,
        idempotencyKey: idempotencyKey.trim(),
      });
      return c.json(
        {
          success: true,
          data: updated,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 5. POST /api/customers/:id/contacts - Şirket yetkilisi ekleme
  app.post(`${API_PREFIX}/customers/:id/contacts`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF kontrolü
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const customerId = c.req.param('id');
    const idempotencyKey = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const contact = await createCompanyContact(c.env.DB, auth.context, customerId, rawBody, {
        correlationId,
        idempotencyKey: idempotencyKey.trim(),
      });
      return c.json(
        {
          success: true,
          data: contact,
          timestamp: new Date().toISOString(),
        },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 6. PATCH /api/customers/:id/contacts/:contactId - Şirket yetkilisi güncelleme (generic PATCH)
  app.patch(`${API_PREFIX}/customers/:id/contacts/:contactId`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF kontrolü
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const customerId = c.req.param('id');
    const contactId = c.req.param('contactId');
    const idempotencyKey = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // Generic lifecycle PATCH engeli: isPrimary veya status kabul edilmez
    if (
      typeof rawBody === 'object' &&
      rawBody !== null &&
      ('isPrimary' in rawBody || 'status' in rawBody)
    ) {
      return c.json(
        {
          success: false,
          error: {
            code: 'LIFECYCLE_MUTATION_VIA_PATCH_PROHIBITED',
            message:
              'Birincil kişi veya durum değişiklikleri için açık uç noktaları (set-primary, deactivate) kullanınız.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const updated = await updateCompanyContact(
        c.env.DB,
        auth.context,
        customerId,
        contactId,
        rawBody,
        {
          correlationId,
          idempotencyKey: idempotencyKey.trim(),
        },
      );
      return c.json(
        {
          success: true,
          data: updated,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 7. POST /api/customers/:id/contacts/:contactId/set-primary - Birincil kişi belirleme
  app.post(`${API_PREFIX}/customers/:id/contacts/:contactId/set-primary`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF kontrolü
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const customerId = c.req.param('id');
    const contactId = c.req.param('contactId');
    const idempotencyKey = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const updated = await setPrimaryCompanyContact(
        c.env.DB,
        auth.context,
        customerId,
        contactId,
        rawBody,
        {
          correlationId,
          idempotencyKey: idempotencyKey.trim(),
        },
      );
      return c.json(
        {
          success: true,
          data: updated,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 8. POST /api/customers/:id/contacts/:contactId/deactivate - Kişi pasifleştirme
  app.post(`${API_PREFIX}/customers/:id/contacts/:contactId/deactivate`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF kontrolü
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const customerId = c.req.param('id');
    const contactId = c.req.param('contactId');
    const idempotencyKey = c.req.header('idempotency-key') || c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const updated = await deactivateCompanyContact(
        c.env.DB,
        auth.context,
        customerId,
        contactId,
        rawBody,
        {
          correlationId,
          idempotencyKey: idempotencyKey.trim(),
        },
      );
      return c.json(
        {
          success: true,
          data: updated,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 7. GET /api/customers/:id/identity - Hassas Kimlik Görüntüleme (Reveal)
  app.get(`${API_PREFIX}/customers/:id/identity`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    let cryptoConfig;
    try {
      cryptoConfig = parseIdentityCryptoConfig(c.env);
    } catch {
      return c.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Kimlik şifreleme altyapısı kullanılamıyor.',
          },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    const customerId = c.req.param('id');
    try {
      const revealed = await getCustomerIdentity(c.env.DB, auth.context, customerId, cryptoConfig);
      return c.json(
        {
          success: true,
          data: revealed,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 8. PUT /api/customers/:id/identity - Hassas Kimlik Güncelleme veya Temizleme
  app.put(`${API_PREFIX}/customers/:id/identity`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    // Gövde ayrıştırılmadan önce CSRF doğrulaması
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let cryptoConfig;
    try {
      cryptoConfig = parseIdentityCryptoConfig(c.env);
    } catch {
      return c.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Kimlik şifreleme altyapısı kullanılamıyor.',
          },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    const customerId = c.req.param('id');
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const result = await updateCustomerIdentity(
        c.env.DB,
        auth.context,
        customerId,
        rawBody,
        {
          correlationId,
          idempotencyKey: idempotencyKey.trim(),
        },
        cryptoConfig,
      );
      return c.json(
        {
          success: true,
          data: result,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 9. POST /api/customers/search-sensitive - Hassas Kimlik ile Müşteri Arama (Exact HMAC)
  app.post(`${API_PREFIX}/customers/search-sensitive`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    // URL parametreleri ile hassas arama YASAKTIR (URL/access log sızıntısı önleme)
    const url = new URL(c.req.url);
    if (url.search && url.search.trim().length > 1) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'Hassas arama URL sorgu parametreleri üzerinden yapılamaz. Yalnızca istek gövdesi kullanılmalıdır.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let cryptoConfig;
    try {
      cryptoConfig = parseIdentityCryptoConfig(c.env);
    } catch {
      return c.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Kimlik şifreleme altyapısı kullanılamıyor.',
          },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const items = await searchSensitiveCustomers(c.env.DB, auth.context, rawBody, cryptoConfig);
      return c.json(
        {
          success: true,
          data: items,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 10. GET /api/customers/:id/assignment-options - Geçerli aktif sorumlular
  app.get(`${API_PREFIX}/customers/:id/assignment-options`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    try {
      const options = await listCustomerAssignmentOptions(
        c.env.DB,
        auth.context,
        c.req.param('id'),
      );
      return c.json({ success: true, data: options, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 11. POST /api/customers/:id/assign - Müşteri Sorumlusu Atama (Reassign)
  app.post(`${API_PREFIX}/customers/:id/assign`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const customerId = c.req.param('id');
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const updated = await assignCustomer(c.env.DB, auth.context, customerId, rawBody, {
        correlationId,
        idempotencyKey: idempotencyKey.trim(),
      });
      return c.json(
        {
          success: true,
          data: updated,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post(`${API_PREFIX}/customers/:id/archive`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;
    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey?.trim()) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
    try {
      const archived = await archiveCustomer(c.env.DB, auth.context, c.req.param('id'), rawBody, {
        correlationId: crypto.randomUUID(),
        idempotencyKey: idempotencyKey.trim(),
      });
      return c.json({ success: true, data: archived, timestamp: new Date().toISOString() }, 200);
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get(`${API_PREFIX}/customers/:id/vehicles`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    try {
      return c.json({
        success: true,
        data: await listCustomerVehicles(
          c.env.DB,
          auth.context,
          c.req.param('id'),
          c.req.query('after') ?? '',
        ),
      });
    } catch (e) {
      return handleError(c, e);
    }
  });
  for (const mode of ['create', 'update'] as const) {
    const handler = async (c: Context<CustomerRouteEnv>) => {
      c.header('Cache-Control', 'no-store');
      const auth = await authenticateAndResolve(c);
      if (auth.error) return auth.error;
      const csrf = await checkCsrf(c, auth.principal.subject);
      if (csrf) return csrf;
      const key = c.req.header('Idempotency-Key')?.trim();
      if (!key)
        return c.json(
          {
            success: false,
            error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'İşlem anahtarı zorunlu.' },
          },
          400,
        );
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { success: false, error: { code: 'MALFORMED_JSON', message: 'Geçersiz istek.' } },
          400,
        );
      }
      try {
        const data = await saveCustomerVehicle(
          c.env.DB,
          auth.context,
          c.req.param('id')!,
          mode === 'update' ? c.req.param('vehicleId')! : null,
          body,
          { idempotencyKey: key, correlationId: crypto.randomUUID() },
        );
        return c.json({ success: true, data }, mode === 'create' ? 201 : 200);
      } catch (e) {
        return handleError(c, e);
      }
    };
    if (mode === 'create') app.post(`${API_PREFIX}/customers/:id/vehicles`, handler);
    else app.put(`${API_PREFIX}/customers/:id/vehicles/:vehicleId`, handler);
  }
  app.get(`${API_PREFIX}/customers/:id/insurer-number-options`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    try {
      return c.json({
        success: true,
        data: await listInsurerNumberOptions(
          c.env.DB,
          auth.context,
          c.req.param('id'),
          c.req.query('after') ?? '',
        ),
      });
    } catch (error) {
      return handleError(c, error);
    }
  });
  app.get(`${API_PREFIX}/customers/:id/insurer-numbers`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    try {
      return c.json({
        success: true,
        data: await listInsurerCustomerNumbers(c.env.DB, auth.context, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return handleError(c, error);
    }
  });
  app.put(`${API_PREFIX}/customers/:id/insurer-numbers/:insurerId`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;
    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;
    const key = c.req.header('Idempotency-Key')?.trim();
    if (!key)
      return c.json(
        {
          success: false,
          error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'İşlem anahtarı zorunludur.' },
        },
        400,
      );
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { success: false, error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' } },
        400,
      );
    }
    try {
      const data = await setInsurerCustomerNumber(
        c.env.DB,
        auth.context,
        c.req.param('id'),
        c.req.param('insurerId'),
        body,
        { idempotencyKey: key, correlationId: crypto.randomUUID() },
      );
      return c.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (error) {
      return handleError(c, error);
    }
  });

  // 11. POST /api/customers/:id/external-references - Harici Müşteri Referansı Oluşturma
  app.post(`${API_PREFIX}/customers/:id/external-references`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    const csrfError = await checkCsrf(c, auth.principal.subject);
    if (csrfError) return csrfError;

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return c.json(
        {
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'Idempotency-Key başlığı zorunludur.',
          },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const customerId = c.req.param('id');
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          success: false,
          error: { code: 'MALFORMED_JSON', message: 'Geçersiz JSON gövdesi.' },
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    try {
      const correlationId = crypto.randomUUID();
      const refDto = await createExternalReference(c.env.DB, auth.context, customerId, rawBody, {
        correlationId,
        idempotencyKey: idempotencyKey.trim(),
      });
      return c.json(
        {
          success: true,
          data: refDto,
          timestamp: new Date().toISOString(),
        },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  // 12. GET /api/customers/:id/external-references - Harici Müşteri Referanslarını Listeleme
  app.get(`${API_PREFIX}/customers/:id/external-references`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const auth = await authenticateAndResolve(c);
    if (auth.error) return auth.error;

    const customerId = c.req.param('id');
    try {
      const items = await listExternalReferences(c.env.DB, auth.context, customerId);
      return c.json(
        {
          success: true,
          data: items,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });
}

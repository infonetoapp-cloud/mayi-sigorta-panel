import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants';
import { parseAccessConfig } from '../auth/config';
import { AccessVerificationError } from '../auth/errors';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import { createAccessVerifier } from '../auth/verifier';
import type { AppDependencies, Env } from '../index';
import { parseCsrfConfig } from '../config';
import { verifyCsrfMutationGuard } from '../security/csrf';
import { RenewalCommandError, closeRenewalLost, reopenRenewal, voidRenewal } from './commands';
import { closeRenewalLostSchema, reopenRenewalSchema, voidRenewalSchema } from './validation';

type RenewalRouteEnv = { Bindings: Env };

export function registerRenewalCommandRoutes(
  app: Hono<RenewalRouteEnv>,
  dependencies: AppDependencies = {},
): void {
  const fail = (
    c: Context<RenewalRouteEnv>,
    status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    code: string,
    message: string,
  ) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      { success: false, error: { code, message }, timestamp: new Date().toISOString() },
      status,
    );
  };

  async function authenticateAndResolve(c: Context<RenewalRouteEnv>) {
    if (!c.env.DB) return { error: fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet kullanılamıyor.') };
    let accessConfig;
    try {
      accessConfig = parseAccessConfig(c.env);
    } catch {
      return { error: fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet kullanılamıyor.') };
    }
    let principal;
    try {
      const verifier = dependencies.createVerifier
        ? dependencies.createVerifier(accessConfig)
        : createAccessVerifier({ config: accessConfig });
      principal = await verifier.verify(c.req.raw);
    } catch (error) {
      const unavailable =
        error instanceof AccessVerificationError &&
        (error.code === 'JWKS_FETCH_FAILED' || error.code === 'CONFIGURATION_ERROR');
      return {
        error: fail(
          c,
          unavailable ? 503 : 401,
          unavailable ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED',
          unavailable ? 'Hizmet kullanılamıyor.' : 'Kimlik doğrulanamadı.',
        ),
      };
    }
    try {
      const resolver = dependencies.createResolver
        ? dependencies.createResolver(c.env.DB)
        : createApplicationIdentityResolver(c.env.DB);
      return { principal, context: await resolver.resolve(principal) };
    } catch (error) {
      const unavailable =
        error instanceof IdentityResolutionError &&
        ['DATABASE_ERROR', 'CORRUPT_IDENTITY_DATA', 'CORRUPT_MEMBERSHIP_DATA'].includes(error.code);
      return {
        error: fail(
          c,
          unavailable ? 503 : 403,
          unavailable ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN',
          unavailable ? 'Hizmet kullanılamıyor.' : 'Erişim reddedildi.',
        ),
      };
    }
  }

  app.post(`${API_PREFIX}/renewals/:id/close-lost`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;

    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet kullanılamıyor.');
    }
    const csrf = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: authenticated.principal.subject,
      secret: csrfSecret,
    });
    if (!csrf.allowed) return fail(c, 403, csrf.code, csrf.message);

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
      return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'İşlem anahtarı geçersiz.');
    }
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
      closeRenewalLostSchema.parse(raw);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    try {
      const result = await closeRenewalLost(
        authenticated.context,
        c.env.DB,
        renewalId,
        raw,
        idempotencyKey,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 404
            ? 'Kayıt bulunamadı.'
            : error.status === 403
              ? 'Erişim reddedildi.'
              : error.status === 409
                ? 'Kayıt güncel değil veya işlem çakıştı.'
                : 'Geçersiz istek.';
        return fail(c, error.status, error.code, message);
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/void`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;

    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet kullanılamıyor.');
    }
    const csrf = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: authenticated.principal.subject,
      secret: csrfSecret,
    });
    if (!csrf.allowed) return fail(c, 403, csrf.code, csrf.message);

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
      return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'İşlem anahtarı geçersiz.');
    }
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
      voidRenewalSchema.parse(raw);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    try {
      const result = await voidRenewal(
        authenticated.context,
        c.env.DB,
        renewalId,
        raw,
        idempotencyKey,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 404
            ? 'Kayıt bulunamadı.'
            : error.status === 403
              ? 'Erişim reddedildi.'
              : error.status === 409
                ? 'Kayıt güncel değil veya işlem çakıştı.'
                : 'Geçersiz istek.';
        return fail(c, error.status, error.code, message);
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/reopen`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;

    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet kullanılamıyor.');
    }
    const csrf = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: authenticated.principal.subject,
      secret: csrfSecret,
    });
    if (!csrf.allowed) return fail(c, 403, csrf.code, csrf.message);

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (!idempotencyKey || !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)) {
      return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'İşlem anahtarı geçersiz.');
    }
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
      reopenRenewalSchema.parse(raw);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    try {
      const result = await reopenRenewal(
        authenticated.context,
        c.env.DB,
        renewalId,
        raw,
        idempotencyKey,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 404
            ? 'Kayıt bulunamadı.'
            : error.status === 403
              ? 'Erişim reddedildi.'
              : error.status === 409
                ? 'Kayıt güncel değil veya işlem çakıştı.'
                : 'Geçersiz istek.';
        return fail(c, error.status, error.code, message);
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });
}

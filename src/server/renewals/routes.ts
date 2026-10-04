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
import {
  RenewalCommandError,
  closeRenewalLost,
  closeRenewalWon,
  reopenRenewal,
  voidRenewal,
} from './commands';
import { correctWonRenewal, issueWonRenewalCorrectionGrant } from './won-correction';
import { closeRenewalWonGroup, issueRenewalWonGroupGrant } from './won-group-atomic';
import {
  closeRenewalLostSchema,
  closeRenewalWonGroupSchema,
  closeRenewalWonGroupGrantSchema,
  closeRenewalWonSchema,
  correctWonRenewalSchema,
  createRenewalInteractionSchema,
  previewRenewalWhatsAppSchema,
  openRenewalWhatsAppSchema,
  createRenewalQuoteSchema,
  createRenewalQuoteVersionSchema,
  reopenRenewalSchema,
  sendRenewalQuoteSchema,
  voidRenewalSchema,
  wonRenewalCorrectionGrantSchema,
} from './validation';
import { allocateRenewalPolicyLinks, issueRenewalPolicyLinksGrant } from './policy-links';
import {
  createRenewalInteraction,
  previewRenewalWhatsApp,
  openRenewalWhatsApp,
  createRenewalQuote,
  createRenewalQuoteVersion,
  listRenewalInteractions,
  listRenewalQuotes,
  sendRenewalQuote,
} from './engagement';
import { correctWonPolicyPremium, correctWonPolicyPremiumSchema } from './won-premium-correction';

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

  async function authenticateAndResolve(
    c: Context<RenewalRouteEnv>,
    expectedAssurance?: 'NORMAL' | 'SECURE',
  ) {
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
      principal = await verifier.verify(c.req.raw, expectedAssurance);
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

  async function secureMutationKey(
    c: Context<RenewalRouteEnv>,
    subject: string,
  ): Promise<string | null> {
    try {
      const result = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      if (!result.allowed) return null;
      const key = c.req.header('Idempotency-Key');
      if (!key || key !== key.trim() || key.length > 128) return null;
      return key;
    } catch {
      return null;
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

  app.post(`${API_PREFIX}/renewals/:id/close-won`, async (c) => {
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
      closeRenewalWonSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await closeRenewalWon(
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
        result.replayed ? 200 : result.status,
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

  app.post('/secure/api/renewals/policy-links/grants', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz JSON isteği.');
    }
    try {
      const result = await issueRenewalPolicyLinksGrant(
        authenticated.context,
        c.env.DB,
        raw,
        key,
        parseCsrfConfig(c.env).CSRF_SECRET,
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
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : error.status === 409
                ? 'İşlem çakıştı; kayıtları yeniden yükleyin.'
                : 'Geçersiz istek.';
        return fail(c, error.status, error.code, message);
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post('/secure/api/renewals/won-group/grants', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      closeRenewalWonGroupGrantSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await issueRenewalWonGroupGrant(
        authenticated.context,
        c.env.DB,
        raw,
        key,
        parseCsrfConfig(c.env).CSRF_SECRET,
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
      if (error instanceof RenewalCommandError) {
        return fail(
          c,
          error.status,
          error.code,
          error.status === 403 ? 'Erişim reddedildi.' : 'İşlem çakıştı.',
        );
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post('/secure/api/renewals/won-group', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      closeRenewalWonGroupSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await closeRenewalWonGroup(authenticated.context, c.env.DB, raw, key);
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        return fail(
          c,
          error.status,
          error.code,
          error.status === 403 ? 'Erişim reddedildi.' : 'İşlem çakıştı.',
        );
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post('/secure/api/renewals/policy-links', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz JSON isteği.');
    }
    try {
      const result = await allocateRenewalPolicyLinks(authenticated.context, c.env.DB, raw, key);
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : error.status === 409
                ? 'İşlem çakıştı; kayıtları yeniden yükleyin.'
                : 'Geçersiz istek.';
        return fail(c, error.status, error.code, message);
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post('/secure/api/policies/:id/correct-won-premium', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    const policyId = c.req.param('id');
    if (!policyId || policyId !== policyId.trim() || policyId.length > 128) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
      correctWonPolicyPremiumSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await correctWonPolicyPremium(
        authenticated.context,
        c.env.DB,
        policyId,
        raw,
        key,
      );
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : error.status === 409
                ? 'İşlem çakıştı; kayıtları yeniden yükleyin.'
                : 'Geçersiz istek.';
        return fail(c, error.status, error.code, message);
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post('/secure/api/renewals/:id/won-correction-grants', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      wonRenewalCorrectionGrantSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await issueWonRenewalCorrectionGrant(
        authenticated.context,
        c.env.DB,
        renewalId,
        raw,
        key,
        parseCsrfConfig(c.env).CSRF_SECRET,
      );
      const { replayed, ...data } = result;
      return c.json(
        {
          success: true,
          data,
          replayed,
          timestamp: new Date().toISOString(),
        },
        replayed ? 200 : 201,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        return fail(
          c,
          error.status,
          error.code,
          error.status === 403 ? 'Erişim reddedildi.' : 'İşlem çakıştı.',
        );
      }
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post('/secure/api/renewals/:id/correct-won', async (c) => {
    const authenticated = await authenticateAndResolve(c, 'SECURE');
    if ('error' in authenticated) return authenticated.error;
    if (authenticated.context.assurance !== 'SECURE') {
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    }
    c.header('Cache-Control', 'private, no-store');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      correctWonRenewalSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await correctWonRenewal(authenticated.context, c.env.DB, renewalId, raw, key);
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
        return fail(
          c,
          error.status,
          error.code,
          error.status === 403 ? 'Erişim reddedildi.' : 'İşlem çakıştı.',
        );
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

  app.get(`${API_PREFIX}/renewals/:id/quotes`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128)
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    try {
      const result = await listRenewalQuotes(authenticated.context, c.env.DB, renewalId);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data: result, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      if (error instanceof RenewalCommandError)
        return fail(
          c,
          error.status,
          error.code,
          error.status === 403 ? 'Erişim reddedildi.' : 'Kayıt bulunamadı.',
        );
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/quotes`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    if (!renewalId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(renewalId))
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'CSRF_OR_IDEMPOTENCY_INVALID', 'İstek doğrulanamadı.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      createRenewalQuoteSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await createRenewalQuote(authenticated.context, c.env.DB, renewalId, raw, key);
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : 'İşlem çakıştı.';
        return fail(c, error.status, error.code, message);
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/quotes/:quoteId/versions`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    const quoteId = c.req.param('quoteId');
    if (
      !renewalId ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(renewalId) ||
      !quoteId ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(quoteId)
    )
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'CSRF_OR_IDEMPOTENCY_INVALID', 'İstek doğrulanamadı.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      createRenewalQuoteVersionSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await createRenewalQuoteVersion(
        authenticated.context,
        c.env.DB,
        renewalId,
        quoteId,
        raw,
        key,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : 'İşlem çakıştı.';
        return fail(c, error.status, error.code, message);
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/quotes/:quoteId/send`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    const quoteId = c.req.param('quoteId');
    if (
      !renewalId ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(renewalId) ||
      !quoteId ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(quoteId)
    )
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'CSRF_OR_IDEMPOTENCY_INVALID', 'İstek doğrulanamadı.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      sendRenewalQuoteSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await sendRenewalQuote(
        authenticated.context,
        c.env.DB,
        renewalId,
        quoteId,
        raw,
        key,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : 'İşlem çakıştı.';
        return fail(c, error.status, error.code, message);
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  const whatsAppFailure = (c: Context<RenewalRouteEnv>, error: unknown) => {
    if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    if (error instanceof RenewalCommandError) {
      const message = ['WHATSAPP_PHONE_REQUIRED', 'WHATSAPP_PHONE_INVALID'].includes(error.code)
        ? 'Telefon eksik veya geçersiz. Müşteri/şirket yetkilisinin iletişim bilgisini tamamlayın.'
        : error.code === 'COMPANY_CONTACT_REQUIRED'
          ? 'Şirket iletişim kişisini seçin.'
          : error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : 'Kayıt değişti. Önizlemeyi yenileyin.';
      return fail(c, error.status, error.code, message);
    }
    return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
  };

  app.get(`${API_PREFIX}/renewals/:id/whatsapp-preview`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    if (!renewalId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(renewalId))
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    try {
      const query = c.req.queries();
      if (
        Object.keys(query).some((key) => key !== 'companyContactId') ||
        (query.companyContactId && query.companyContactId.length !== 1)
      )
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      const input = previewRenewalWhatsAppSchema.parse({
        companyContactId: query.companyContactId?.[0] ?? null,
      });
      const data = await previewRenewalWhatsApp(authenticated.context, c.env.DB, renewalId, input);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      return whatsAppFailure(c, error);
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/whatsapp-open`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    if (!renewalId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(renewalId))
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'CSRF_OR_IDEMPOTENCY_INVALID', 'İstek doğrulanamadı.');
    let input: unknown;
    try {
      input = openRenewalWhatsAppSchema.parse(await c.req.json());
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await openRenewalWhatsApp(
        authenticated.context,
        c.env.DB,
        renewalId,
        input,
        key,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      return whatsAppFailure(c, error);
    }
  });

  app.get(`${API_PREFIX}/renewals/:id/interactions`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    if (!renewalId || renewalId !== renewalId.trim() || renewalId.length > 128)
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    try {
      const result = await listRenewalInteractions(authenticated.context, c.env.DB, renewalId);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data: result, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      if (error instanceof RenewalCommandError)
        return fail(
          c,
          error.status,
          error.code,
          error.status === 403 ? 'Erişim reddedildi.' : 'Kayıt bulunamadı.',
        );
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/interactions`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    const renewalId = c.req.param('id');
    if (!renewalId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(renewalId))
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    const key = await secureMutationKey(c, authenticated.principal.subject);
    if (!key) return fail(c, 403, 'CSRF_OR_IDEMPOTENCY_INVALID', 'İstek doğrulanamadı.');
    let raw: unknown;
    try {
      raw = await c.req.json();
      createRenewalInteractionSchema.parse(raw);
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }
    try {
      const result = await createRenewalInteraction(
        authenticated.context,
        c.env.DB,
        renewalId,
        raw,
        key,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json(
        {
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        },
        result.replayed ? 200 : result.status,
      );
    } catch (error) {
      if (error instanceof RenewalCommandError) {
        const message =
          error.status === 403
            ? 'Erişim reddedildi.'
            : error.status === 404
              ? 'Kayıt bulunamadı.'
              : 'İşlem çakıştı.';
        return fail(c, error.status, error.code, message);
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });
}

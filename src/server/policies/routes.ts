import {
  policyCancellationContext,
  policyLifecycleHistory,
  executePolicyLifecycle,
  PolicyLifecycleError,
  RenewalCommandError,
} from './cancellation';
import { AuthHttpError } from '../auth/routes';
import { readCommandJson } from '../security/command-json';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants';
import { parseLocalSessionConfig } from '../auth/session';
import { createLocalSessionVerifier, csrfSessionSubject } from '../auth/session';
import { createApplicationIdentityResolver } from '../auth/identity';
import { parseCsrfConfig } from '../config';
import { generateIdentityBoundCsrfToken, verifyCsrfMutationGuard } from '../security/csrf';
import type { AppDependencies, Env } from '../index';
import {
  assignPolicy,
  archivePolicy,
  createPolicyAmendment,
  createPolicyExternalReference,
  createPolicyParty,
  deactivatePolicyParty,
  createPolicy,
  createPolicyIdentityVariant,
  getPolicy,
  listPolicyAmendments,
  listPolicyExternalReferences,
  listPolicyParties,
  listPolicies,
  listPolicyAssignmentOptions,
  issuePolicyIdentityVariantGrant,
  updatePolicy,
  setPolicyVehicle,
  PolicyAuthorizationRaceError,
  PolicyConstraintError,
  PolicyForbiddenError,
  PolicyNotFoundError,
} from './service';
import { IdempotencyConflictError } from '../mutations/idempotency';
import { OptimisticConcurrencyError } from '../db/optimistic';
import { renderPolicyIdentityVariantConfirmation, SECURE_CONFIRM_SCRIPT } from './secure-confirm';
import { ensureRenewalForPolicy } from '../renewals/generation';

type E = { Bindings: Env };
export function registerPolicyRoutes(app: Hono<E>, dependencies: AppDependencies = {}) {
  const fail = (
    c: Context<E>,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503,
    code: string,
    message: string,
  ) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      { success: false, error: { code, message }, timestamp: new Date().toISOString() },
      status,
    );
  };
  async function auth(c: Context<E>, expectedAssurance?: 'NORMAL' | 'SECURE') {
    try {
      if (!c.env.DB) return null;
      const config = parseLocalSessionConfig(c.env);
      const verifier = dependencies.createSessionVerifier
        ? dependencies.createSessionVerifier(config)
        : createLocalSessionVerifier({ config });
      const principal = await verifier.verify(c.req.raw, expectedAssurance);
      const resolver = dependencies.createResolver
        ? dependencies.createResolver(c.env.DB)
        : createApplicationIdentityResolver(c.env.DB);
      return { principal, context: await resolver.resolve(principal) };
    } catch {
      return null;
    }
  }
  async function csrfAllowed(c: Context<E>, subject: string) {
    try {
      const result = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      return result.allowed;
    } catch {
      return false;
    }
  }
  async function guard(c: Context<E>, subject: string) {
    try {
      if (!(await csrfAllowed(c, subject))) return null;
      const key = c.req.header('Idempotency-Key')?.trim();
      return key || null;
    } catch {
      return null;
    }
  }
  function error(c: Context<E>, e: unknown) {
    if (e instanceof Error && e.message.includes('SALES_RENEWAL_SOURCE_IMMUTABLE'))
      return fail(
        c,
        409,
        'RENEWAL_SOURCE_IMMUTABLE',
        'Teklif çalışmasına bağlı poliçenin müşterisi ve branşı değiştirilemez. Ayrı ihtiyaç için yeni çalışma açın.',
      );
    if (
      e instanceof Error &&
      /MEMBERSHIP_PERMISSION_NOT_FOUND|LOCAL_SESSION_REVOKED/.test(e.message)
    )
      return fail(c, 403, 'FORBIDDEN', 'Oturum veya kayıt yetkisi değişti.');
    if (e instanceof AuthHttpError) return fail(c, e.status, e.code, e.message);
    if (e instanceof PolicyLifecycleError || e instanceof RenewalCommandError)
      return fail(
        c,
        e.status,
        e.code,
        e.status === 403
          ? 'Bu işlem için ilgili kayıt ve takip yetkileri gerekli.'
          : e.code === 'POLICY_CANCELLATION_DATE_INVALID'
            ? 'İptal tarihi poliçe döneminde ve gelecekte olmayan bir gün olmalıdır.'
            : e.code === 'LOSS_REASON_REQUIRED' || e.code === 'LOSS_REASON_MISMATCH'
              ? 'İptal nedenine uygun aktif yenilenmeme nedeni katalogda bulunmalıdır.'
              : 'Poliçe işlemi doğrulanamadı. Güncel kaydı kontrol edin; yeni bir işlem göndermeden aynı isteğin sonucunu doğrulayın.',
      );
    if (e instanceof SyntaxError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz JSON isteği.');
    if (e instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    if (e instanceof PolicyNotFoundError) return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
    if (e instanceof PolicyForbiddenError || e instanceof PolicyAuthorizationRaceError)
      return fail(c, 403, 'FORBIDDEN', 'Erişim reddedildi.');
    if (e instanceof PolicyConstraintError)
      return fail(c, e.code === 'INVALID_CURSOR' ? 400 : 409, e.code, e.message);
    if (e instanceof IdempotencyConflictError)
      return fail(c, 409, 'IDEMPOTENCY_CONFLICT', 'İşlem anahtarı çakıştı.');
    if (e instanceof OptimisticConcurrencyError)
      return fail(c, 409, 'CONFLICT', 'Kayıt güncellendi; yeniden yükleyin.');
    return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
  }
  for (const kind of ['cancel', 'void'] as const) {
    app.get(
      `${API_PREFIX}/policies/:id/${kind === 'cancel' ? 'cancellation-context' : 'void-context'}`,
      async (c) => {
        c.header('Cache-Control', 'private, no-store');
        const a = await auth(c);
        if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Oturum gerekli.');
        try {
          return c.json({
            success: true,
            data: await policyCancellationContext(c.env.DB, a.context, c.req.param('id'), kind),
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          return error(c, e);
        }
      },
    );
    app.post(`${API_PREFIX}/policies/:id/${kind}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Oturum gerekli.');
      const key = await guard(c, a.principal.subject);
      if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
      if (key.length > 128) return fail(c, 400, 'VALIDATION_ERROR', 'İşlem anahtarı çok uzun.');
      try {
        const result = await executePolicyLifecycle(
          c.env.DB,
          a.context,
          c.req.param('id'),
          kind,
          await readCommandJson(c.req.raw),
          key,
        );
        return c.json({
          success: true,
          data: result.data,
          replayed: result.replayed,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  app.get(`${API_PREFIX}/policies/:id/cancellations`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Oturum gerekli.');
    try {
      return c.json({
        success: true,
        data: await policyLifecycleHistory(c.env.DB, a.context, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.put(`${API_PREFIX}/policies/:id/vehicle`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHENTICATED', 'Oturum gerekli.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const result = await setPolicyVehicle(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json({ success: true, data: result.data, timestamp: new Date().toISOString() });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`${API_PREFIX}/policies`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    try {
      const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      return c.json({
        success: true,
        data: await listPolicies(a.context, c.env.DB, query),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await createPolicy(a.context, c.env.DB, await c.req.json(), key);
      await ensureRenewalForPolicy(c.env.DB, r.data.agencyId, r.data.id);
      return c.json(
        { success: true, data: r.data, replayed: r.replayed, timestamp: new Date().toISOString() },
        r.status as 201,
      );
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`${API_PREFIX}/policies/:id`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    try {
      return c.json({
        success: true,
        data: await getPolicy(a.context, c.env.DB, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.patch(`${API_PREFIX}/policies/:id`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await updatePolicy(a.context, c.env.DB, c.req.param('id'), await c.req.json(), key);
      await ensureRenewalForPolicy(c.env.DB, r.data.agencyId, r.data.id);
      return c.json({
        success: true,
        data: r.data,
        replayed: r.replayed,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`${API_PREFIX}/policies/:id/assignment-options`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    try {
      return c.json({
        success: true,
        data: await listPolicyAssignmentOptions(a.context, c.env.DB, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies/:id/assign`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await assignPolicy(a.context, c.env.DB, c.req.param('id'), await c.req.json(), key);
      return c.json({
        success: true,
        data: r.data,
        replayed: r.replayed,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`${API_PREFIX}/policies/:id/parties`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    try {
      return c.json({
        success: true,
        data: await listPolicyParties(a.context, c.env.DB, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies/:id/parties`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await createPolicyParty(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json(
        { success: true, data: r.data, replayed: r.replayed, timestamp: new Date().toISOString() },
        r.status as 201,
      );
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies/:id/parties/:partyId/deactivate`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await deactivatePolicyParty(
        a.context,
        c.env.DB,
        c.req.param('id'),
        c.req.param('partyId'),
        await c.req.json(),
        key,
      );
      return c.json({
        success: true,
        data: r.data,
        replayed: r.replayed,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`${API_PREFIX}/policies/:id/amendments`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    try {
      return c.json({
        success: true,
        data: await listPolicyAmendments(a.context, c.env.DB, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies/:id/amendments`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await createPolicyAmendment(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json(
        { success: true, data: r.data, replayed: r.replayed, timestamp: new Date().toISOString() },
        r.status as 201,
      );
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`${API_PREFIX}/policies/:id/external-references`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    try {
      return c.json({
        success: true,
        data: await listPolicyExternalReferences(a.context, c.env.DB, c.req.param('id')),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies/:id/external-references`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await createPolicyExternalReference(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json(
        { success: true, data: r.data, replayed: r.replayed, timestamp: new Date().toISOString() },
        r.status as 201,
      );
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`${API_PREFIX}/policies/:id/archive`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED', 'Kimlik doğrulanamadı.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await archivePolicy(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json({
        success: true,
        data: r.data,
        replayed: r.replayed,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`/secure/api/csrf-token`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c, 'SECURE');
    if (!a || a.context.assurance !== 'SECURE')
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    try {
      const token = await generateIdentityBoundCsrfToken(
        { subject: csrfSessionSubject(c.req.raw, a.principal.subject) },
        parseCsrfConfig(c.env).CSRF_SECRET,
      );
      return c.json({ success: true, data: { token }, timestamp: new Date().toISOString() });
    } catch {
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Güvenli işlem başlatılamadı.');
    }
  });
  app.get(`/secure/confirm/policies/:id/identity-variant`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c, 'SECURE');
    if (!a || a.context.assurance !== 'SECURE')
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    try {
      const policy = await getPolicy(a.context, c.env.DB, c.req.param('id'));
      return c.html(renderPolicyIdentityVariantConfirmation(policy));
    } catch (e) {
      return error(c, e);
    }
  });
  app.get(`/secure/confirm.js`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c, 'SECURE');
    if (!a || a.context.assurance !== 'SECURE')
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    return c.body(SECURE_CONFIRM_SCRIPT, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    });
  });
  app.post(`/secure/api/policies/:id/identity-variant-grants`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c, 'SECURE');
    if (!a || a.context.assurance !== 'SECURE')
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const data = await issuePolicyIdentityVariantGrant(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 201);
    } catch (e) {
      return error(c, e);
    }
  });
  app.post(`/secure/api/policies/:id/identity-variants`, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c, 'SECURE');
    if (!a || a.context.assurance !== 'SECURE')
      return fail(c, 403, 'FORBIDDEN', 'Secure doğrulama zorunludur.');
    const key = await guard(c, a.principal.subject);
    if (!key) return fail(c, 403, 'FORBIDDEN', 'CSRF veya işlem anahtarı geçersiz.');
    try {
      const r = await createPolicyIdentityVariant(
        a.context,
        c.env.DB,
        c.req.param('id'),
        await c.req.json(),
        key,
      );
      return c.json(
        { success: true, data: r.data, replayed: r.replayed, timestamp: new Date().toISOString() },
        r.status as 201,
      );
    } catch (e) {
      return error(c, e);
    }
  });
}

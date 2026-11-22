import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { SessionVerificationError } from '../auth/errors';
import type { AppDependencies, Env } from '../index';
import { parseLocalSessionConfig, createLocalSessionVerifier } from '../auth/session';
import { createApplicationIdentityResolver } from '../auth/identity';
import { parseCsrfConfig } from '../config';
import { verifyCsrfMutationGuard } from '../security/csrf';
import { AuthHttpError } from '../auth/routes';
import { readCommandJson } from '../security/command-json';
import { FinanceError, financeDetail, listFinance, writeFinance } from './service';
export function registerFinanceRoutes(app: Hono<{ Bindings: Env }>, deps: AppDependencies = {}) {
  const fail = (
    c: Context<{ Bindings: Env }>,
    status: 400 | 401 | 403 | 404 | 409 | 500,
    code: string,
  ) =>
    c.json(
      {
        success: false,
        error: {
          code,
          message:
            status === 409
              ? 'Kayıt değişti veya tutar kalan alacakla uyuşmuyor. Bilgileri yeniden kontrol edin.'
              : status === 400
                ? 'Tutarı, tarihleri ve seçimleri kontrol edin.'
                : status === 403
                  ? 'Muhasebe için ayrıca yetki gerekiyor.'
                  : status === 404
                    ? 'Kayıt kullanılamıyor veya bu kayda erişiminiz yok.'
                    : 'İşlem tamamlanamadı. Yeniden deneyin.',
        },
      },
      status,
    );
  async function auth(c: Context<{ Bindings: Env }>) {
    try {
      const config = parseLocalSessionConfig(c.env),
        p = await (
          deps.createSessionVerifier?.(config) ?? createLocalSessionVerifier({ config })
        ).verify(c.req.raw),
        resolver = deps.createResolver?.(c.env.DB) ?? createApplicationIdentityResolver(c.env.DB);
      return { principal: p, context: await resolver.resolve(p) };
    } catch {
      return null;
    }
  }
  function error(c: Context<{ Bindings: Env }>, e: unknown) {
    if (e instanceof AuthHttpError)
      return c.json({ success: false, error: { code: e.code, message: e.message } }, e.status);
    if (e instanceof SessionVerificationError) return fail(c, 401, 'UNAUTHENTICATED');
    if (e instanceof FinanceError) return fail(c, e.status, e.code);
    if (e instanceof z.ZodError || e instanceof SyntaxError)
      return fail(c, 400, 'VALIDATION_ERROR');
    return fail(c, 500, 'INTERNAL_ERROR');
  }
  app.get('/api/finance/receivables', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHENTICATED');
    try {
      return c.json({ success: true, data: await listFinance(c.env.DB, a.context, c.req.query()) });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get('/api/finance/receivables/:id', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHENTICATED');
    try {
      return c.json({
        success: true,
        data: await financeDetail(c.env.DB, a.context, c.req.param('id'), c.req.query()),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post('/api/finance/commands', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHENTICATED');
    try {
      const csrf = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: a.principal.subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      if (!csrf.allowed) return fail(c, 403, csrf.code);
      const key = c.req.header('Idempotency-Key');
      if (!key || !key.trim() || key !== key.trim())
        return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED');
      const r = await writeFinance(c.env.DB, a.context, await readCommandJson(c.req.raw), key);
      return c.json({ success: true, ...r });
    } catch (e) {
      return error(c, e);
    }
  });
}

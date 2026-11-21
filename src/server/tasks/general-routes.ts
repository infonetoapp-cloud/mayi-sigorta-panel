import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppDependencies, Env } from '../index';
import { parseLocalSessionConfig, createLocalSessionVerifier } from '../auth/session';
import { createApplicationIdentityResolver } from '../auth/identity';
import { verifyCsrfMutationGuard } from '../security/csrf';
import { parseCsrfConfig } from '../config';
import { readBoundedJson, AuthHttpError } from '../auth/routes';
import {
  GeneralTaskError,
  readGeneralTask,
  generalTaskOperation,
  generalTaskAssignmentOptions,
  writeGeneralTask,
} from './general-commands';
type E = { Bindings: Env };
export function registerGeneralTaskRoutes(app: Hono<E>, dependencies: AppDependencies = {}) {
  const fail = (
    c: Context<E>,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503,
    code: string,
    message = 'Takip işlemi tamamlanamadı. Güncel kaydı kontrol edin.',
  ) => c.json({ success: false, error: { code, message } }, status);
  async function auth(c: Context<E>) {
    let config;
    try {
      config = parseLocalSessionConfig(c.env);
    } catch {
      return { error: fail(c, 503, 'SERVICE_UNAVAILABLE') };
    }
    let principal;
    try {
      principal = await (
        dependencies.createSessionVerifier?.(config) ?? createLocalSessionVerifier({ config })
      ).verify(c.req.raw);
    } catch {
      return { error: fail(c, 401, 'UNAUTHORIZED', 'Oturum gerekli.') };
    }
    try {
      return {
        principal,
        context: await (
          dependencies.createResolver?.(c.env.DB) ?? createApplicationIdentityResolver(c.env.DB)
        ).resolve(principal),
      };
    } catch {
      return { error: fail(c, 403, 'FORBIDDEN', 'Takip erişimi doğrulanamadı.') };
    }
  }
  function error(c: Context<E>, e: unknown) {
    if (e instanceof GeneralTaskError)
      return fail(
        c,
        e.status,
        e.code,
        e.code === 'CASE_ACTION_REQUIRED'
          ? 'Teklif çalışmasına bağlı takibi çalışma ekranından yönetin.'
          : e.status === 403
            ? 'Bu takip işlemi için yetkiniz yok.'
            : e.status === 404
              ? 'Takip kullanılamıyor veya bu kaydı görme yetkiniz yok.'
              : e.code === 'INVALID_CURSOR'
                ? 'Çalışan listesi değişmiş. İlk sayfadan başlayın.'
                : e.status === 409
                  ? 'Takip veya çalışan bilgileri değişmiş. Taslağı koruyarak güncel bilgileri kontrol edin.'
                  : undefined,
      );
    if (e instanceof AuthHttpError) return fail(c, e.status, e.code, e.message);
    if (e instanceof z.ZodError || e instanceof SyntaxError)
      return fail(c, 400, 'VALIDATION_ERROR', 'Takip bilgilerini kontrol edin.');
    if (/MEMBERSHIP_PERMISSION|LOCAL_SESSION/.test(String(e)))
      return fail(c, 403, 'FORBIDDEN', 'Oturum veya takip yetkisi değişti.');
    return fail(c, 500, 'INTERNAL_ERROR');
  }
  for (const kind of ['general-context', 'assignment-options', 'operations'] as const) {
    app.get(
      kind === 'operations' ? '/api/tasks/:id/operations/:operationId' : `/api/tasks/:id/${kind}`,
      async (c) => {
        c.header('Cache-Control', 'private, no-store');
        const a = await auth(c);
        if ('error' in a) return a.error;
        try {
          const data =
            kind === 'general-context'
              ? await readGeneralTask(c.env.DB, a.context, c.req.param('id'))
              : kind === 'assignment-options'
                ? await generalTaskAssignmentOptions(
                    c.env.DB,
                    a.context,
                    c.req.param('id'),
                    c.req.query(),
                  )
                : await generalTaskOperation(
                    c.env.DB,
                    a.context,
                    c.req.param('id'),
                    c.req.param('operationId')!,
                  );
          return c.json({ success: true, data });
        } catch (e) {
          return error(c, e);
        }
      },
    );
  }
  for (const kind of ['reschedule', 'complete', 'assign'] as const)
    app.post(`/api/tasks/:id/${kind}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if ('error' in a) return a.error;
      try {
        const csrf = await verifyCsrfMutationGuard(c.req.raw, {
          authenticatedSubject: a.principal.subject,
          secret: parseCsrfConfig(c.env).CSRF_SECRET,
        });
        if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN', 'İşlem doğrulanamadı.');
        const key = c.req.header('Idempotency-Key')?.trim();
        if (!key || key.length > 128)
          return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY', 'İşlem anahtarı geçersiz.');
        const result = await writeGeneralTask(
          c.env.DB,
          a.context,
          c.req.param('id'),
          kind,
          await readBoundedJson(c.req.raw, 32 * 1024),
          key,
        );
        return c.json({ success: true, data: result.data, replayed: result.replayed });
      } catch (e) {
        return error(c, e);
      }
    });
}

import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { API_PREFIX } from '../../shared/constants';
import { parseLocalSessionConfig } from '../auth/session';
import { parseCsrfConfig } from '../config';
import { SessionVerificationError } from '../auth/errors';
import { createLocalSessionVerifier } from '../auth/session';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import type { AppDependencies, Env } from '../index';
import { IdempotencyConflictError } from '../mutations/idempotency';
import { OptimisticConcurrencyError } from '../db/optimistic';
import { verifyCsrfMutationGuard } from '../security/csrf';
import {
  assignRenewalTask,
  completeRenewalTaskWithReplacement,
  listRenewalTaskAssignmentOptions,
  listTodayTasks,
} from './service';
import {
  TaskConstraintError,
  TaskForbiddenError,
  TaskNotFoundError,
  TaskReplayNotAuthorizedError,
  TaskValidationError,
} from './errors';
import { todayTasksQuerySchema } from './validation';
import { readTaskStatistics } from './statistics';

type TaskRouteEnv = { Bindings: Env };

export function registerTaskRoutes(
  app: Hono<TaskRouteEnv>,
  dependencies: AppDependencies = {},
): void {
  const fail = (
    c: Context<TaskRouteEnv>,
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

  async function authenticateAndResolve(c: Context<TaskRouteEnv>) {
    if (!c.env.DB) {
      return { error: fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor.') };
    }
    let config;
    try {
      config = parseLocalSessionConfig(c.env);
    } catch {
      return { error: fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor.') };
    }
    let principal;
    try {
      const verifier = dependencies.createSessionVerifier
        ? dependencies.createSessionVerifier(config)
        : createLocalSessionVerifier({ config });
      principal = await verifier.verify(c.req.raw);
    } catch (error) {
      const unavailable =
        error instanceof SessionVerificationError && error.code === 'CONFIGURATION_ERROR';
      return {
        error: fail(
          c,
          unavailable ? 503 : 401,
          unavailable ? 'SERVICE_UNAVAILABLE' : 'UNAUTHORIZED',
          unavailable ? 'Hizmet şu anda kullanılamıyor.' : 'Kimlik doğrulanamadı.',
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
          unavailable ? 'Hizmet şu anda kullanılamıyor.' : 'Erişim reddedildi.',
        ),
      };
    }
  }

  app.get(`${API_PREFIX}/tasks/statistics`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    try {
      // Reject duplicate parameters rather than silently choosing a filter value.
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      const data = await readTaskStatistics(c.env.DB, authenticated.context, c.req.query());
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      if (error instanceof TaskForbiddenError)
        return fail(c, 403, 'FORBIDDEN', 'Erişim reddedildi.');
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'İstatistikler şu anda kullanılamıyor.');
    }
  });

  app.get(`${API_PREFIX}/tasks/today`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    try {
      const query = todayTasksQuerySchema.parse(c.req.query());
      const data = await listTodayTasks(authenticated.context, c.env.DB, query);
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      if (error instanceof TaskForbiddenError) {
        return fail(c, 403, 'FORBIDDEN', 'Erişim reddedildi.');
      }
      if (error instanceof TaskValidationError) {
        const badRequest = error.code === 'INVALID_CURSOR';
        return fail(
          c,
          badRequest ? 400 : 503,
          badRequest ? 'INVALID_CURSOR' : 'SERVICE_UNAVAILABLE',
          badRequest ? 'Sayfalama imleci geçersiz.' : 'Hizmet şu anda kullanılamıyor.',
        );
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.get(`${API_PREFIX}/tasks/:taskId/context`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    try {
      const params = new URL(c.req.url).searchParams;
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      const { queue = 'WORK', unified } = z
        .object({
          queue: z.enum(['WORK', 'UNASSIGNED', 'REASSIGNMENT']).optional(),
          unified: z.literal('true').optional(),
        })
        .strict()
        .parse(c.req.query());
      const taskId = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/)
        .parse(c.req.param('taskId'));
      const data = await listTodayTasks(
        authenticated.context,
        c.env.DB,
        {
          limit: 1,
          unified,
          ...(queue === 'REASSIGNMENT' ? { needsReassignment: 'true' as const } : {}),
        },
        taskId,
      );
      const items = queue === 'UNASSIGNED' ? data.unassignedItems : data.items;
      if (
        (queue === 'UNASSIGNED' && !data.canSeeUnassigned) ||
        !items.some((item) => item.taskId === taskId)
      )
        return fail(c, 404, 'NOT_FOUND', 'Takip kullanılamıyor veya bu takibi görme yetkiniz yok.');
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      if (error instanceof z.ZodError) return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      if (error instanceof TaskForbiddenError)
        return fail(c, 403, 'FORBIDDEN', 'Erişim reddedildi.');
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Takip şu anda doğrulanamıyor. Yeniden deneyin.');
    }
  });

  app.get(`${API_PREFIX}/renewals/:id/tasks/:taskId/assignment-options`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    try {
      const renewalId = c.req.param('id');
      const taskId = c.req.param('taskId');
      if (
        renewalId.trim() === '' ||
        renewalId !== renewalId.trim() ||
        renewalId.length > 128 ||
        taskId.trim() === '' ||
        taskId !== taskId.trim() ||
        taskId.length > 128
      ) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      const data = await listRenewalTaskAssignmentOptions(
        authenticated.context,
        c.env.DB,
        renewalId,
        taskId,
      );
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data, timestamp: new Date().toISOString() }, 200);
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
      }
      if (error instanceof TaskForbiddenError) {
        return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
      }
      if (error instanceof TaskValidationError) {
        return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor.');
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/tasks/:taskId/assign`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor.');
    }
    const csrf = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: authenticated.principal.subject,
      secret: csrfSecret,
    });
    if (!csrf.allowed) return fail(c, 403, csrf.code, csrf.message);

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (
      !idempotencyKey ||
      idempotencyKey !== idempotencyKey.trim() ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)
    ) {
      return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'İşlem anahtarı geçersiz.');
    }
    const renewalId = c.req.param('id');
    const taskId = c.req.param('taskId');
    if (
      renewalId.trim() === '' ||
      renewalId !== renewalId.trim() ||
      renewalId.length > 128 ||
      taskId.trim() === '' ||
      taskId !== taskId.trim() ||
      taskId.length > 128
    ) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz JSON isteği.');
    }
    try {
      const result = await assignRenewalTask(
        authenticated.context,
        c.env.DB,
        renewalId,
        taskId,
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
      if (error instanceof z.ZodError) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      if (error instanceof TaskNotFoundError || error instanceof TaskReplayNotAuthorizedError) {
        return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
      }
      if (error instanceof TaskForbiddenError) {
        return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
      }
      if (error instanceof OptimisticConcurrencyError) {
        return fail(c, 409, 'CONFLICT', 'Kayıt güncellendi; yeniden yükleyin.');
      }
      if (error instanceof IdempotencyConflictError) {
        return fail(c, 409, error.code, 'İşlem anahtarı çakıştı.');
      }
      if (error instanceof TaskConstraintError) {
        return fail(c, 409, error.code, 'Atama hedefi uygun değil.');
      }
      if (error instanceof TaskValidationError) {
        return fail(c, 400, error.code, 'Geçersiz istek.');
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });

  app.post(`${API_PREFIX}/renewals/:id/tasks/:taskId/complete`, async (c) => {
    const authenticated = await authenticateAndResolve(c);
    if ('error' in authenticated) return authenticated.error;
    let csrfSecret: string;
    try {
      csrfSecret = parseCsrfConfig(c.env).CSRF_SECRET;
    } catch {
      return fail(c, 503, 'SERVICE_UNAVAILABLE', 'Hizmet şu anda kullanılamıyor.');
    }
    const csrf = await verifyCsrfMutationGuard(c.req.raw, {
      authenticatedSubject: authenticated.principal.subject,
      secret: csrfSecret,
    });
    if (!csrf.allowed) return fail(c, 403, csrf.code, csrf.message);

    const idempotencyKey = c.req.header('Idempotency-Key');
    if (
      !idempotencyKey ||
      idempotencyKey !== idempotencyKey.trim() ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey)
    ) {
      return fail(c, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'İşlem anahtarı geçersiz.');
    }
    const renewalId = c.req.param('id');
    const taskId = c.req.param('taskId');
    if (
      renewalId.trim() === '' ||
      renewalId !== renewalId.trim() ||
      renewalId.length > 128 ||
      taskId.trim() === '' ||
      taskId !== taskId.trim() ||
      taskId.length > 128
    ) {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz JSON isteği.');
    }
    try {
      const result = await completeRenewalTaskWithReplacement(
        authenticated.context,
        c.env.DB,
        renewalId,
        taskId,
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
      if (error instanceof z.ZodError) {
        return fail(c, 400, 'VALIDATION_ERROR', 'Geçersiz istek.');
      }
      if (error instanceof TaskNotFoundError || error instanceof TaskReplayNotAuthorizedError) {
        return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
      }
      if (error instanceof TaskForbiddenError) {
        return fail(c, 404, 'NOT_FOUND', 'Kayıt bulunamadı.');
      }
      if (error instanceof OptimisticConcurrencyError) {
        return fail(c, 409, 'CONFLICT', 'Kayıt güncellendi; yeniden yükleyin.');
      }
      if (error instanceof IdempotencyConflictError) {
        return fail(c, 409, error.code, 'İşlem anahtarı çakıştı.');
      }
      if (error instanceof TaskConstraintError) {
        return fail(c, 409, error.code, 'Yeni takip görevi oluşturulamadı.');
      }
      if (error instanceof TaskValidationError) {
        return fail(c, 400, error.code, 'Geçersiz istek.');
      }
      return fail(c, 500, 'INTERNAL_ERROR', 'Beklenmeyen hata.');
    }
  });
}

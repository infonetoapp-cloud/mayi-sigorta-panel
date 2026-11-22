import {
  correctSalesWon,
  issueSalesWonCorrectionGrant,
  readSalesWonCorrectionContext,
  readSalesWonCorrectionOperation,
} from './won-correction';
import { readRenewalLossCycleOperation } from './renewal-loss-cycle';
import { readSalesVoidContext, readSalesVoidOperation, voidSalesCase } from './void';
import { readSalesReopenContext, readSalesReopenOperation, reopenSalesCase } from './reopen';
import {
  issueSalesPolicy,
  readIssuePolicyContext,
  listIssuePrices,
  readIssuePolicyOperation,
} from './issue-policy';
import { RenewalCommandError } from '../renewals/commands';
import { closeSalesLost, salesLossContext, salesLossSummary, readSalesLossOperation } from './loss';
import {
  readSalesPriceEventContext,
  readSalesPriceEvents,
  readSalesPriceEventOperation,
  writeSalesPriceEvent,
} from './price-events';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppDependencies, Env } from '../index';
import { parseLocalSessionConfig, createLocalSessionVerifier } from '../auth/session';
import { createApplicationIdentityResolver } from '../auth/identity';
import { verifyCsrfMutationGuard } from '../security/csrf';
import { parseCsrfConfig } from '../config';
import { AuthHttpError } from '../auth/routes';
import { readCommandJson } from '../security/command-json';
import { adoptRenewalCase } from './adoption';
import {
  readSalesPrices,
  readSalesPriceHistory,
  readSalesPriceRevision,
  salesPriceOperation,
  writeSalesPrice,
} from './prices';
import {
  SalesError,
  listSales,
  salesDetail,
  salesTask,
  writeSales,
  salesOperation,
} from './service';
export function registerSalesRoutes(app: Hono<{ Bindings: Env }>, deps: AppDependencies = {}) {
  const fail = (
    c: Context<{ Bindings: Env }>,
    status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503,
    code: string,
    message = 'İşlem tamamlanamadı. Güncel kaydı ve yetkilerinizi kontrol edin.',
  ) => c.json({ success: false, error: { code, message } }, status);
  const error = (c: Context<{ Bindings: Env }>, e: unknown) =>
    e instanceof SalesError || e instanceof RenewalCommandError
      ? fail(
          c,
          e.status,
          e.code,
          e.code === 'EVENT_DATE_INVALID'
            ? 'İşlem zamanını gelecekte olmayacak şekilde girin.'
            : e.code === 'EVENT_STATE_CONFLICT'
              ? 'Bu fiyatın paylaşım veya onay durumu değişmiş. Önce güncel durumu kontrol edin.'
              : e.code === 'INSURER_PRICE_EXISTS'
                ? 'Bu şirketin fiyatı zaten kayıtlı. Yeni satır eklemek yerine Fiyatı güncelle işlemini kullanın.'
                : e.code === 'INSURER_NOT_ACTIVE'
                  ? 'Aktif bir sigorta şirketi seçin.'
                  : e.code === 'RENEWAL_USE_EXISTING_WORKFLOW'
                    ? 'Bu çalışmanın takibini yenileme ekranından güncelleyin.'
                    : e.code === 'RENEWAL_CASE_EXISTS'
                      ? 'Bu yenilemenin çalışması zaten var. Mevcut çalışmayı yeniden açın.'
                      : e.code === 'SIMILAR_OPEN_CASES'
                        ? 'Aynı müşteri ve branşta açık çalışma var. İnceleyin; ayrı ihtiyaçsa yeni çalışma açmayı onaylayın.'
                        : e.status === 403
                          ? 'Bu çalışma veya kişisel takip için yetkiniz yok.'
                          : e.status === 404
                            ? 'Çalışma veya takip kullanılamıyor.'
                            : e.code === 'INVALID_CURSOR'
                              ? 'Liste bağlantısı değişmiş. İlk sayfadan başlayın.'
                              : e.code === 'CONFLICT'
                                ? 'Çalışma veya takip değişmiş. Taslağınızı koruyarak güncel bilgileri kontrol edin.'
                                : 'Çalışma bilgilerini ve aktif müşteri / branş seçimini kontrol edin.',
        )
      : e instanceof AuthHttpError
        ? fail(c, e.status, e.code, e.message)
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? fail(c, 400, 'VALIDATION_ERROR')
          : /LOCAL_SESSION|MEMBERSHIP_PERMISSION/.test(String(e))
            ? fail(c, 403, 'FORBIDDEN')
            : fail(c, 500, 'INTERNAL_ERROR');
  async function auth(c: Context<{ Bindings: Env }>, assurance?: 'SECURE') {
    try {
      const p = await (
        deps.createSessionVerifier?.(parseLocalSessionConfig(c.env)) ??
        createLocalSessionVerifier({ config: parseLocalSessionConfig(c.env) })
      ).verify(c.req.raw, assurance);
      return {
        principal: p,
        context: await (
          deps.createResolver?.(c.env.DB) ?? createApplicationIdentityResolver(c.env.DB)
        ).resolve(p),
      };
    } catch {
      return null;
    }
  }
  for (const kind of ['events', 'event-context', 'event-operation'] as const) {
    const path =
      kind === 'events'
        ? '/api/sales-cases/:id/prices/:priceId/revisions/:revisionId/events'
        : kind === 'event-context'
          ? '/api/sales-cases/:id/price-event-context/:revisionId'
          : '/api/sales-cases/:id/price-event-operations/:operationId';
    app.get(path, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        const id = c.req.param('id')!;
        if (kind === 'events')
          await readSalesPriceRevision(
            c.env.DB,
            a.context,
            id,
            c.req.param('priceId')!,
            c.req.param('revisionId')!,
          );
        const data =
          kind === 'events'
            ? await readSalesPriceEvents(
                c.env.DB,
                a.context,
                id,
                c.req.param('revisionId')!,
                c.req.query(),
              )
            : kind === 'event-context'
              ? await readSalesPriceEventContext(
                  c.env.DB,
                  a.context,
                  id,
                  c.req.param('revisionId')!,
                )
              : await readSalesPriceEventOperation(
                  c.env.DB,
                  a.context,
                  id,
                  c.req.param('operationId')!,
                );
        return c.json({ success: true, data });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  app.post('/api/sales-cases/:id/price-events', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    try {
      const csrf = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: a.principal.subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
      const key = c.req.header('Idempotency-Key')?.trim();
      if (!key || key.length > 128) return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
      const result = await writeSalesPriceEvent(
        c.env.DB,
        a.context,
        c.req.param('id')!,
        await readCommandJson(c.req.raw, 8 * 1024),
        key,
      );
      return c.json({ success: true, data: result.data, replayed: result.replayed }, 201);
    } catch (e) {
      return error(c, e);
    }
  });
  for (const kind of ['loss-context', 'loss-result', 'loss-operations/:operationId'] as const) {
    app.get(`/api/sales-cases/:id/${kind}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        const data =
          kind === 'loss-context'
            ? await salesLossContext(c.env.DB, a.context, c.req.param('id')!)
            : kind === 'loss-result'
              ? await salesLossSummary(c.env.DB, a.context, c.req.param('id')!)
              : await (async () => {
                  const m = a.context.memberships[0]!;
                  const receipt = await c.env.DB.prepare(
                    'SELECT action FROM operation_receipts WHERE agency_id=? AND id=?',
                  )
                    .bind(m.agencyId, c.req.param('operationId')!)
                    .first<{ action: string }>();
                  return receipt?.action === 'renewal.close_lost'
                    ? readRenewalLossCycleOperation(
                        c.env.DB,
                        a.context,
                        c.req.param('id')!,
                        c.req.param('operationId')!,
                      )
                    : (
                        await readSalesLossOperation(
                          c.env.DB,
                          a.context,
                          c.req.param('id')!,
                          c.req.param('operationId')!,
                        )
                      ).saved.result;
                })();
        return c.json({ success: true, data });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  for (const kind of ['issue-context', 'issue-price-options'] as const) {
    app.get(`/api/sales-cases/:id/${kind}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        const id = c.req.param('id')!;
        const query = (
          kind === 'issue-context'
            ? z.strictObject({})
            : z.strictObject({ after: z.string().min(1).max(128).optional() })
        ).parse(c.req.query()) as { after?: string };
        const data =
          kind === 'issue-context'
            ? await readIssuePolicyContext(c.env.DB, a.context, id)
            : await listIssuePrices(c.env.DB, a.context, id, query.after ?? '');
        return c.json({ success: true, data });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  app.get('/api/sales-cases/:id/issue-operation', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    const key = c.req.header('Idempotency-Key')?.trim();
    if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
      return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
    try {
      return c.json({
        success: true,
        data: await readIssuePolicyOperation(c.env.DB, a.context, c.req.param('id')!, key),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  app.post('/api/sales-cases/:id/issue-policy', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    try {
      const csrf = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: a.principal.subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
      const key = c.req.header('Idempotency-Key')?.trim();
      if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
        return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
      const result = await issueSalesPolicy(
        c.env.DB,
        a.context,
        c.req.param('id')!,
        await readCommandJson(c.req.raw, 32 * 1024),
        key,
      );
      return c.json(
        { success: true, data: result.data, replayed: result.replayed },
        result.data.createdPolicy && !result.replayed ? 201 : 200,
      );
    } catch (e) {
      return error(c, e);
    }
  });
  app.get('/api/sales-cases/:id/won-correction-context', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    try {
      const data = await readSalesWonCorrectionContext(c.env.DB, a.context, c.req.param('id')!);
      return c.json({ success: true, data });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get('/api/sales-cases/:id/won-correction-operation', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    const key = c.req.header('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
      return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
    try {
      const data = await readSalesWonCorrectionOperation(
        c.env.DB,
        a.context,
        c.req.param('id')!,
        key,
      );
      return c.json({ success: true, data });
    } catch (e) {
      return error(c, e);
    }
  });
  for (const command of ['won-correction-grants', 'correct-won'] as const) {
    app.post(`/secure/api/sales-cases/:id/${command}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c, 'SECURE');
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        const { CSRF_SECRET } = parseCsrfConfig(c.env);
        const csrf = await verifyCsrfMutationGuard(c.req.raw, {
          authenticatedSubject: a.principal.subject,
          secret: CSRF_SECRET,
        });
        if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
        const key = c.req.header('Idempotency-Key');
        if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
          return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
        const id = z.string().min(1).max(128).parse(c.req.param('id'));
        const body = await readCommandJson(c.req.raw, 8 * 1024);
        if (command === 'won-correction-grants') {
          const { replayed, ...data } = await issueSalesWonCorrectionGrant(
            c.env.DB,
            a.context,
            id,
            body,
            key,
            CSRF_SECRET,
          );
          return c.json({ success: true, data, replayed }, replayed ? 200 : 201);
        }
        const result = await correctSalesWon(c.env.DB, a.context, id, body, key);
        return c.json({ success: true, ...result });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  for (const operation of [
    {
      name: 'void',
      context: readSalesVoidContext,
      read: readSalesVoidOperation,
      write: voidSalesCase,
    },
    {
      name: 'reopen',
      context: readSalesReopenContext,
      read: readSalesReopenOperation,
      write: reopenSalesCase,
    },
  ]) {
    app.get(`/api/sales-cases/:id/${operation.name}-context`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        return c.json({
          success: true,
          data: await operation.context(c.env.DB, a.context, c.req.param('id')!),
        });
      } catch (e) {
        return error(c, e);
      }
    });
    app.get(`/api/sales-cases/:id/${operation.name}-operation`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      const key = c.req.header('Idempotency-Key')?.trim();
      if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
        return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
      try {
        return c.json({
          success: true,
          data: await operation.read(c.env.DB, a.context, c.req.param('id')!, key),
        });
      } catch (e) {
        return error(c, e);
      }
    });
    app.post(`/api/sales-cases/:id/${operation.name}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        const csrf = await verifyCsrfMutationGuard(c.req.raw, {
          authenticatedSubject: a.principal.subject,
          secret: parseCsrfConfig(c.env).CSRF_SECRET,
        });
        if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
        const key = c.req.header('Idempotency-Key')?.trim();
        if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
          return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
        const result = await operation.write(
          c.env.DB,
          a.context,
          c.req.param('id')!,
          await readCommandJson(c.req.raw, 16 * 1024),
          key,
        );
        return c.json({ success: true, data: result.data, replayed: result.replayed });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  app.post('/api/sales-cases/:id/close-lost', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    try {
      const csrf = await verifyCsrfMutationGuard(c.req.raw, {
        authenticatedSubject: a.principal.subject,
        secret: parseCsrfConfig(c.env).CSRF_SECRET,
      });
      if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
      const key = c.req.header('Idempotency-Key')?.trim();
      if (!key || key.length > 128) return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
      const result = await closeSalesLost(
        c.env.DB,
        a.context,
        c.req.param('id')!,
        await readCommandJson(c.req.raw, 16 * 1024),
        key,
      );
      return c.json({ success: true, data: result.data, replayed: result.replayed });
    } catch (e) {
      return error(c, e);
    }
  });
  app.get('/api/sales-cases', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    try {
      return c.json({ success: true, data: await listSales(c.env.DB, a.context, c.req.query()) });
    } catch (e) {
      return error(c, e);
    }
  });
  for (const kind of ['prices', 'history', 'revision', 'price-operation'] as const) {
    const path =
      kind === 'prices'
        ? '/api/sales-cases/:id/prices'
        : kind === 'history'
          ? '/api/sales-cases/:id/prices/:priceId/history'
          : kind === 'revision'
            ? '/api/sales-cases/:id/prices/:priceId/revisions/:revisionId'
            : '/api/sales-cases/:id/price-operations/:operationId';
    app.get(path, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        const id = c.req.param('id')!;
        const data =
          kind === 'prices'
            ? await readSalesPrices(c.env.DB, a.context, id, c.req.query())
            : kind === 'history'
              ? await readSalesPriceHistory(
                  c.env.DB,
                  a.context,
                  id,
                  c.req.param('priceId')!,
                  c.req.query(),
                )
              : kind === 'revision'
                ? await readSalesPriceRevision(
                    c.env.DB,
                    a.context,
                    id,
                    c.req.param('priceId')!,
                    c.req.param('revisionId')!,
                  )
                : await salesPriceOperation(c.env.DB, a.context, id, c.req.param('operationId')!);
        return c.json({ success: true, data });
      } catch (e) {
        return error(c, e);
      }
    });
  }
  for (const revise of [false, true])
    app.post(
      revise ? '/api/sales-cases/:id/prices/:priceId/revisions' : '/api/sales-cases/:id/prices',
      async (c) => {
        c.header('Cache-Control', 'private, no-store');
        const a = await auth(c);
        if (!a) return fail(c, 401, 'UNAUTHORIZED');
        try {
          const csrf = await verifyCsrfMutationGuard(c.req.raw, {
            authenticatedSubject: a.principal.subject,
            secret: parseCsrfConfig(c.env).CSRF_SECRET,
          });
          if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
          const key = c.req.header('Idempotency-Key')?.trim();
          if (!key || key.length > 128) return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
          const result = await writeSalesPrice(
            c.env.DB,
            a.context,
            c.req.param('id')!,
            revise ? c.req.param('priceId')! : null,
            await readCommandJson(c.req.raw, 32 * 1024),
            key,
          );
          return c.json(
            { success: true, data: result.data, replayed: result.replayed },
            revise ? 200 : 201,
          );
        } catch (e) {
          return error(c, e);
        }
      },
    );
  app.get('/api/sales-cases/:id/operations/:operationId', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const a = await auth(c);
    if (!a) return fail(c, 401, 'UNAUTHORIZED');
    try {
      return c.json({
        success: true,
        data: await salesOperation(
          c.env.DB,
          a.context,
          c.req.param('id'),
          c.req.param('operationId'),
        ),
      });
    } catch (e) {
      return error(c, e);
    }
  });
  for (const suffix of ['', '/task'] as const)
    app.get(`/api/sales-cases/:id${suffix}`, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const a = await auth(c);
      if (!a) return fail(c, 401, 'UNAUTHORIZED');
      try {
        return c.json({
          success: true,
          data: suffix
            ? await salesTask(c.env.DB, a.context, c.req.param('id'))
            : await salesDetail(c.env.DB, a.context, c.req.param('id')),
        });
      } catch (e) {
        return error(c, e);
      }
    });
  for (const kind of ['create', 'followup'] as const)
    app.post(
      kind === 'create' ? '/api/customers/:id/sales-cases' : '/api/sales-cases/:id/followup',
      async (c) => {
        c.header('Cache-Control', 'private, no-store');
        const a = await auth(c);
        if (!a) return fail(c, 401, 'UNAUTHORIZED');
        try {
          const csrf = await verifyCsrfMutationGuard(c.req.raw, {
            authenticatedSubject: a.principal.subject,
            secret: parseCsrfConfig(c.env).CSRF_SECRET,
          });
          if (!csrf.allowed) return fail(c, 403, 'FORBIDDEN');
          const key = c.req.header('Idempotency-Key')?.trim();
          if (!key || key.length > 128) return fail(c, 400, 'INVALID_IDEMPOTENCY_KEY');
          const raw = await readCommandJson(c.req.raw, 32 * 1024);
          const adoption =
            kind === 'create' &&
            typeof raw === 'object' &&
            raw !== null &&
            'context' in raw &&
            raw.context === 'RENEWAL';
          const r = adoption
            ? await adoptRenewalCase(c.env.DB, a.context, c.req.param('id'), raw, key)
            : await writeSales(c.env.DB, a.context, c.req.param('id'), kind, raw, key);
          return c.json(
            { success: true, data: r.data, replayed: r.replayed },
            kind === 'create' ? 201 : 200,
          );
        } catch (e) {
          return error(c, e);
        }
      },
    );
}

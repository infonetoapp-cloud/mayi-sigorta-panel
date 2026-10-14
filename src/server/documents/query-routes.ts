import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDependencies, Env } from '../index';
import {
  createLocalSessionVerifier,
  parseLocalSessionConfig,
  LocalSessionConfigError,
} from '../auth/session';
import { SessionVerificationError } from '../auth/errors';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import { DocumentStreamError } from './stream';
import { documentRateDecision } from './admission';
import { listEmployeeDocuments } from './query';
import { DOCUMENT_ROUTE_CONTRACT } from './route-contract';
export function registerDocumentQueryRoutes(
  app: Hono<{ Bindings: Env }>,
  dependencies: AppDependencies,
) {
  app.get(DOCUMENT_ROUTE_CONTRACT.find((r) => r.operation === 'LIST')!.path, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const fail = (status: 400 | 401 | 404 | 429 | 503) =>
      c.json(
        {
          success: false,
          error: {
            code:
              status === 401
                ? 'UNAUTHORIZED'
                : status === 404
                  ? 'NOT_FOUND'
                  : status === 429
                    ? 'RATE_LIMITED'
                    : status === 400
                      ? 'VALIDATION_ERROR'
                      : 'SERVICE_UNAVAILABLE',
            message:
              status === 404
                ? 'Belge listesi kullanılamıyor.'
                : status === 429
                  ? 'Bir dakika sonra tekrar deneyin.'
                  : 'Belge listesi yüklenemedi.',
          },
        },
        status,
      );
    if (c.env.DOCUMENTS_ENABLED !== 'true') return fail(404);
    if (!c.env.DB) return fail(503);
    let context;
    try {
      const config = parseLocalSessionConfig(c.env),
        principal = await (
          dependencies.createSessionVerifier?.(config) ?? createLocalSessionVerifier({ config })
        ).verify(c.req.raw);
      context = await (
        dependencies.createResolver?.(c.env.DB) ?? createApplicationIdentityResolver(c.env.DB)
      ).resolve(principal);
    } catch (error) {
      return fail(
        error instanceof LocalSessionConfigError ||
          (error instanceof IdentityResolutionError && error.code === 'DATABASE_ERROR') ||
          (error instanceof SessionVerificationError && error.code === 'CONFIGURATION_ERROR')
          ? 503
          : 401,
      );
    }
    const decision = await documentRateDecision(c.env, context, 'DOWNLOAD');
    if (decision !== 'ALLOW') {
      if (decision === 'LIMITED') c.header('Retry-After', '60');
      return fail(decision === 'LIMITED' ? 429 : 503);
    }
    const params = new URL(c.req.url).searchParams;
    const allowed = ['ownerType', 'ownerId', 'limit', 'cursor'];
    for (const key of params.keys())
      if (!allowed.includes(key) || params.getAll(key).length !== 1) return fail(400);
    try {
      const input = z
        .object({
          ownerType: z.enum(['CUSTOMER', 'POLICY', 'QUOTE']),
          ownerId: z.string().min(1).max(128),
          limit: z.coerce.number().int().min(1).max(20).optional(),
          cursor: z.string().max(1024).optional(),
        })
        .strict()
        .parse(Object.fromEntries(params));
      return c.json(
        { success: true, data: await listEmployeeDocuments(c.env.DB, context, input) },
        200,
      );
    } catch (error) {
      return fail(
        error instanceof z.ZodError
          ? 400
          : error instanceof DocumentStreamError
            ? error.status
            : 503,
      );
    }
  });
}

import type { Hono } from 'hono';
import type { AppDependencies, Env } from '../index';
import { AccessConfigError, parseAccessConfig } from '../auth/config';
import { AccessVerificationError } from '../auth/errors';
import { createAccessVerifier } from '../auth/verifier';
import { createApplicationIdentityResolver, IdentityResolutionError } from '../auth/identity';
import { parseCsrfConfig } from '../config';
import { verifyCsrfMutationGuard } from '../security/csrf';
import {
  downloadDocument,
  DocumentStreamError,
  issueDocumentDownloadGrant,
  documentDownloadConfirmation,
} from './stream';

export function registerDocumentStreamRoutes(
  app: Hono<{ Bindings: Env }>,
  dependencies: AppDependencies,
): void {
  for (const [path, secure, issue] of [
    ['/api/documents/:id/download', false, false],
    ['/secure/api/documents/:id/download', true, false],
    ['/secure/api/documents/:id/download-grants', true, true],
    ['/secure/api/documents/:id/download-confirmation', true, false],
  ] as const)
    app.post(path, async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const fail = (status: 401 | 403 | 404 | 503) =>
        c.json(
          {
            success: false,
            error: {
              code:
                status === 503
                  ? 'SERVICE_UNAVAILABLE'
                  : status === 401
                    ? 'UNAUTHORIZED'
                    : status === 403
                      ? 'FORBIDDEN'
                      : 'NOT_FOUND',
              message: 'Belge kullanılamıyor.',
            },
            timestamp: new Date().toISOString(),
          },
          status,
        );
      if (c.env.DOCUMENTS_ENABLED !== 'true') return fail(404);
      if (!c.env.DB || !c.env.DOCS_QUARANTINE) return fail(503);
      if (new URL(c.req.url).search) return fail(404);
      let context;
      let principal;
      try {
        const config = parseAccessConfig(c.env);
        const verifier = dependencies.createVerifier?.(config) ?? createAccessVerifier({ config });
        principal = await verifier.verify(c.req.raw, secure ? 'SECURE' : 'NORMAL');
        const resolver =
          dependencies.createResolver?.(c.env.DB) ?? createApplicationIdentityResolver(c.env.DB);
        context = await resolver.resolve(principal);
        if (
          principal.assurance !== (secure ? 'SECURE' : 'NORMAL') ||
          context.assurance !== principal.assurance
        )
          return fail(401);
      } catch (error) {
        const infrastructureError =
          error instanceof AccessConfigError ||
          (error instanceof IdentityResolutionError && error.code === 'DATABASE_ERROR') ||
          (error instanceof AccessVerificationError &&
            (error.code === 'JWKS_FETCH_FAILED' || error.code === 'CONFIGURATION_ERROR'));
        return fail(infrastructureError ? 503 : 401);
      }
      try {
        const guard = await verifyCsrfMutationGuard(c.req.raw, {
          authenticatedSubject: principal.subject,
          secret: parseCsrfConfig(c.env).CSRF_SECRET,
        });
        if (!guard.allowed) return fail(403);
        const raw = await boundedJson(c.req.raw);
        if (path.endsWith('/download-confirmation')) {
          if (
            typeof raw !== 'object' ||
            raw === null ||
            Array.isArray(raw) ||
            Object.keys(raw).length !== 0
          )
            throw new DocumentStreamError();
          return c.json(
            {
              success: true,
              data: await documentDownloadConfirmation(c.env.DB, context, c.req.param('id')),
              timestamp: new Date().toISOString(),
            },
            200,
          );
        }
        if (issue) {
          const data = await issueDocumentDownloadGrant(
            c.env.DB,
            context,
            c.req.param('id'),
            raw,
            c.req.header('Idempotency-Key') ?? '',
          );
          return c.json({ success: true, data, timestamp: new Date().toISOString() }, 201);
        }
        return await downloadDocument(
          c.env.DB,
          c.env.DOCS_QUARANTINE,
          context,
          c.req.param('id'),
          raw,
        );
      } catch (error) {
        return fail(error instanceof DocumentStreamError ? error.status : 503);
      }
    });
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body || request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new DocumentStreamError();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(4096);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.byteLength) throw new DocumentStreamError();
      bytes.set(value, length);
      length += value.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    } catch {
      throw new DocumentStreamError();
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

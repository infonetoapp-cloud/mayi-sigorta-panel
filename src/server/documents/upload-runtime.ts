import type { Env } from '../index';
import { parseServerConfig } from '../config';
import { applySecurityHeaders } from '../security';
import { createDocumentAdmission, trackedDocumentDatabase } from './resource-admission';

// Shared by every object in this isolate, not a distributed quota or a provider queue bound.
const uploads = createDocumentAdmission();
export function uploadUnavailable(
  request: Request,
  env: Env,
  status: 403 | 404 | 415 | 429 | 503,
): Response {
  const response = Response.json(
    {
      success: false,
      error: {
        code:
          status === 404
            ? 'NOT_FOUND'
            : status === 403
              ? 'FORBIDDEN'
              : status === 415
                ? 'UNSUPPORTED_MEDIA_TYPE'
                : status === 429
                  ? 'RATE_LIMITED'
                  : 'SERVICE_UNAVAILABLE',
        message: 'Belge yükleme hizmeti kullanılamıyor.',
      },
      timestamp: new Date().toISOString(),
    },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        ...(status === 503
          ? { 'Retry-After': '1' }
          : status === 429
            ? { 'Retry-After': '60' }
            : {}),
      },
    },
  );
  return applySecurityHeaders(response, {
    appEnv: env.APP_ENV === 'production' ? 'production' : 'test',
    isHttps: new URL(request.url).protocol === 'https:',
    isApi: true,
  });
}
/** No auth/session/request state is retained between invocations. D1 remains authoritative. */
export function createUploadRuntime(canonical: (request: Request, env: Env) => Promise<Response>) {
  return Object.freeze({
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      let origin: string;
      try {
        origin = parseServerConfig(env).PANEL_ORIGIN;
      } catch {
        return uploadUnavailable(request, env, 503);
      }
      if (
        url.protocol !== 'https:' ||
        url.origin !== origin ||
        (request.headers.has('host') && request.headers.get('host') !== url.host)
      )
        return uploadUnavailable(request, env, 403);
      if (
        env.DOCUMENTS_ENABLED !== 'true' ||
        request.method !== 'POST' ||
        url.pathname !== '/api/documents'
      )
        return uploadUnavailable(request, env, 404);
      // Reject before taking the global permit or entering the generic JSON
      // middleware: only the canonical bounded multipart reader may consume input.
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;'))
        return uploadUnavailable(request, env, 415);
      if (request.signal.aborted) return uploadUnavailable(request, env, 503);
      const permit = uploads.acquire();
      if (!permit) return uploadUnavailable(request, env, 503);
      let rejectDeadline!: () => void;
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = () => reject(new Error('DOCUMENT_UPLOAD_CLOSED'));
      });
      const stop = () => {
        permit.release();
        rejectDeadline();
      };
      const timer = setTimeout(stop, 60000);
      request.signal.addEventListener('abort', stop, { once: true });
      try {
        const db = env.DB ? trackedDocumentDatabase(env.DB, permit) : env.DB;
        const bucket = env.DOCS_QUARANTINE;
        // The canonical upload path only needs put. Capture the provider receiver once.
        const put = bucket?.put.bind(bucket);
        const local: Env = {
          ...env,
          DB: db,
          DOCS_QUARANTINE: put
            ? ({
                put: (...args: Parameters<R2Bucket['put']>) => permit.run(() => put(...args)),
              } as R2Bucket)
            : undefined,
        };
        return await Promise.race([deadline, permit.run(() => canonical(request, local))]);
      } catch {
        return uploadUnavailable(request, env, 503);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', stop);
        // Pending raw D1/R2 promises retain custody even if the handler returned/failed.
        permit.release();
      }
    },
  });
}

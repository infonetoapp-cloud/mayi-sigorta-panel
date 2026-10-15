import type { Env } from '../index';
import { parseServerConfig } from '../config';
import { hashSessionToken } from '../auth/session';
import { uploadUnavailable } from './upload-runtime';

/** The edge never parses/hashes document bytes and never falls back to the HTTP parser. */
export async function dispatchDocumentUpload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (
      url.protocol !== 'https:' ||
      url.origin !== parseServerConfig(env).PANEL_ORIGIN ||
      (request.headers.has('host') && request.headers.get('host') !== url.host)
    )
      return uploadUnavailable(request, env, 403);
    const source = request.headers.get('cf-connecting-ip');
    if (!env.AUTH_SOURCE_RATE_LIMITER || (env.APP_ENV === 'production' && !source))
      return uploadUnavailable(request, env, 503);
    // Separate key-space: upload floods cannot consume the login source allowance.
    const key = 'document-upload:' + (await hashSessionToken(source ?? 'local-source'));
    const limited = await env.AUTH_SOURCE_RATE_LIMITER.limit({ key });
    if (limited.success !== true) return uploadUnavailable(request, env, 429);
    if (!env.DOCUMENT_UPLOAD_RUNTIME) return uploadUnavailable(request, env, 503);
    return await env.DOCUMENT_UPLOAD_RUNTIME.getByName('mayi-document-upload-v1').fetch(request);
  } catch {
    return uploadUnavailable(request, env, 503);
  }
}

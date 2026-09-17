import { Hono } from 'hono';
import { API_PREFIX } from '../shared/constants';
import type { ApiResponse, HealthCheckData } from '../shared/types';
import { parseServerConfig } from './config';

/**
 * Mayı Sigorta CRM - Cloudflare Worker Sunucu Kabuğu (Hono Worker Shell).
 *
 * Mimari Sözleşme (NIHAI_MIMARI_VE_UYGULAMA_PLANI):
 * 1. /api/* yolları öncelikli olarak Hono tarafından işlenir.
 * 2. Eşleşmeyen /api/* istekleri asla SPA HTML'e düşmez; standart JSON 404 döner.
 * 3. Statik varlıklar Cloudflare Static Assets (ASSETS binding) üzerinden sunulur.
 */

export interface Env {
  ASSETS?: Fetcher;
  DB: D1Database;
  [key: string]: unknown;
}

const app = new Hono<{ Bindings: Env }>();

function apiNotFoundResponse(): Response {
  return Response.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Bilinmeyen API uç noktası',
      },
      timestamp: new Date().toISOString(),
    },
    { status: 404 },
  );
}

function canonicalizeRoutePath(pathname: string): string | null {
  let decoded = pathname;
  try {
    for (let depth = 0; depth <= pathname.length; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        const segments: string[] = [];
        for (const segment of decoded.replace(/\\/g, '/').split('/')) {
          if (!segment || segment === '.') continue;
          if (segment === '..') {
            segments.pop();
          } else {
            segments.push(segment);
          }
        }
        return `/${segments.join('/')}`;
      }
      decoded = next;
    }
  } catch {
    return null;
  }
  return null;
}

function isNamespacePath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (!accept) return false;

  let selectedSpecificity = -1;
  let selectedQuality = 0;
  for (const rawRange of accept.toLowerCase().split(',')) {
    const [rawMediaType, ...parameters] = rawRange.trim().split(';');
    const mediaType = rawMediaType?.trim();
    const specificity = mediaType === 'text/html' ? 2 : mediaType === 'text/*' ? 1 : 0;
    if (mediaType !== 'text/html' && mediaType !== 'text/*' && mediaType !== '*/*') continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split('=');
      if (name === 'q') {
        const parsed = Number(value);
        quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    if (specificity > selectedSpecificity) {
      selectedSpecificity = specificity;
      selectedQuality = quality;
    }
  }
  return selectedQuality > 0;
}

function isStaticAssetPath(pathname: string): boolean {
  if (isNamespacePath(pathname, '/assets')) return true;
  const finalSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return finalSegment.includes('.');
}

async function serveFrontend(
  request: Request,
  assets: Fetcher,
  canonicalPath: string | null,
): Promise<Response> {
  const assetResponse = await assets.fetch(request);
  if (assetResponse.status !== 404) return assetResponse;

  const canUseSpaFallback =
    canonicalPath !== null &&
    request.method === 'GET' &&
    acceptsHtml(request) &&
    !isStaticAssetPath(canonicalPath);
  if (!canUseSpaFallback) return assetResponse;

  const indexUrl = new URL('/index.html', request.url);
  const indexRequest = new Request(indexUrl, request);
  return assets.fetch(indexRequest);
}

// Temel sistem sağlık kontrolü (Baseline Health Endpoint)
app.get(`${API_PREFIX}/health`, (c) => {
  const config = parseServerConfig(c.env);
  const response: ApiResponse<HealthCheckData> = {
    success: true,
    data: {
      status: 'healthy',
      version: '0.1.0',
      environment: config.APP_ENV,
      timestamp: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
  return c.json(response, 200);
});

// Bilinmeyen /api/* isteklerini yakalayan güvenlik kapısı (Fail-Closed API Fallback)
// NIHAI_MIMARI_VE_UYGULAMA_PLANI Bölüm 9: "Bilinmeyen API yolu SPA HTML cevabına düşmez."
app.all(`${API_PREFIX}/*`, (_c) => {
  return apiNotFoundResponse();
});

// Cloudflare Worker export sözleşmesi
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const canonicalPath = canonicalizeRoutePath(url.pathname);
    const isApiRequest =
      canonicalPath === null
        ? url.pathname.startsWith(API_PREFIX)
        : isNamespacePath(canonicalPath, API_PREFIX);
    const isSecureRequest =
      canonicalPath === null
        ? url.pathname.startsWith('/secure')
        : isNamespacePath(canonicalPath, '/secure');

    // API veya güvenlik onay istekleri doğrudan Hono'ya yönlendirilir
    if (isApiRequest || isSecureRequest) {
      if (canonicalPath !== url.pathname && isApiRequest) return apiNotFoundResponse();
      return app.fetch(request, env, ctx);
    }

    // Statik varlıklar mevcutsa ASSETS binding'e yönlendirilir
    if (env.ASSETS) {
      return serveFrontend(request, env.ASSETS, canonicalPath);
    }

    return new Response('Static assets binding unavailable', { status: 503 });
  },
};

export default worker;

export { app, worker };

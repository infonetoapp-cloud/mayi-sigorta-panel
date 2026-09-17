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
  [key: string]: unknown;
}

const app = new Hono<{ Bindings: Env }>();

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
app.all(`${API_PREFIX}/*`, (c) => {
  return c.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Bilinmeyen API uç noktası',
      },
      timestamp: new Date().toISOString(),
    },
    404,
  );
});

// Cloudflare Worker export sözleşmesi
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);

    // API veya güvenlik onay istekleri doğrudan Hono'ya yönlendirilir
    if (url.pathname.startsWith(API_PREFIX) || url.pathname.startsWith('/secure')) {
      return app.fetch(request, env, ctx);
    }

    // Statik varlıklar mevcutsa ASSETS binding'e yönlendirilir
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Geliştirme/test fallback
    return app.fetch(request, env, ctx);
  },
};

export { app };

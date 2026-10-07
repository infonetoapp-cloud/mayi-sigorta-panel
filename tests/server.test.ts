import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker, { app } from '../src/server/index';
import { API_PREFIX } from '../src/shared/constants';
import type { ApiResponse, HealthCheckData } from '../src/shared/types';

describe('Sunucu Kabuğu ve API Güvenlik Kapısı (Server Shell & Fallback Tests)', () => {
  it('GET /api/health başarılı durum ve JSON yanıtı döndürmelidir', async () => {
    const res = await app.request(`https://panel.mayisigorta.com${API_PREFIX}/health`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/json');

    const json = (await res.json()) as ApiResponse<HealthCheckData>;
    expect(json.success).toBe(true);
    if (json.success) {
      expect(json.data).toEqual({ status: 'healthy' });
    }
  });

  it('Bilinmeyen /api/* istekleri asla HTML dönmemeli; JSON 404 döndürmelidir (Fail-Closed)', async () => {
    const res = await app.request(
      `https://panel.mayisigorta.com${API_PREFIX}/tanimsiz-bir-yol-404`,
    );
    expect(res.status).toBe(404);

    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/json');

    const json = (await res.json()) as ApiResponse<unknown>;
    expect(json.success).toBe(false);
    if (!json.success) {
      expect(json.error.code).toBe('NOT_FOUND');
      expect(json.error.message).toBe('Bilinmeyen API uç noktası');
    }
  });
});

describe('M1-T02 Worker route / SPA / API boundary', () => {
  it('public health başka host veya HTTP üzerinden request security sınırını aşamaz', async () => {
    for (const origin of ['http://panel.mayisigorta.com', 'https://alternate.example.invalid']) {
      const response = await app.request(`${origin}/api/health`);
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.text()).not.toContain('healthy');
    }
  });
  function createAssetsBinding(): Fetcher {
    return {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        const pathname = new URL(request.url).pathname;

        if (pathname === '/' || pathname === '/index.html') {
          return new Response('<!doctype html><html><body>SPA shell</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        if (pathname === '/assets/app.js') {
          return new Response('console.info("asset");', {
            status: 200,
            headers: { 'content-type': 'text/javascript; charset=utf-8' },
          });
        }
        if (pathname === '/api/health') {
          return new Response('<html>masked API route</html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        return new Response('asset not found', { status: 404 });
      }),
      connect: vi.fn(),
    } as unknown as Fetcher;
  }

  function request(path: string, init?: RequestInit): Promise<Response> {
    return Promise.resolve(
      worker.fetch(
        new Request(`https://panel.mayisigorta.com${path}`, init),
        { ASSETS: createAssetsBinding(), DB: {} as D1Database },
        {} as ExecutionContext,
      ),
    );
  }

  it('known API route Worker katmanında JSON döndürmelidir', async () => {
    const response = await request('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it.each([
    '/api',
    '/api/bilinmeyen',
    '/api%2Fencoded-bilinmeyen',
    '/api%252Fdouble-encoded',
    '/api%252525252Fdeeply-encoded',
    '/api%5Cbackslash',
    '/api%ZZmalformed',
    '/foo%2F..%2Fapi%2Funknown',
    '/foo%252F..%252Fapi%252Funknown',
    '//api/unknown',
  ])('unknown API namespace %s için SPA HTML yerine JSON 404 dönmelidir', async (path) => {
    const response = await request(path, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toContain('SPA shell');
  });

  it('SPA root static index üzerinden sunulmalıdır', async () => {
    const response = await request('/', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('SPA shell');
  });

  it('doğrudan SPA navigasyonu index fallback almalıdır', async () => {
    const response = await request('/yenilemeler/aktif', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('SPA shell');
  });

  it('mevcut static asset doğrudan ve kendi içerik türüyle sunulmalıdır', async () => {
    const response = await request('/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toContain('asset');
  });

  it('eksik static asset SPA HTML fallback almamalıdır', async () => {
    const response = await request('/assets/missing.js', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA shell');
  });

  it.each(['/assets%2Fmissing', '/assets/missing%2Ejs'])(
    'encoded static asset yolu %s SPA HTML fallback almamalıdır',
    async (path) => {
      const response = await request(path, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('SPA shell');
    },
  );

  it('uzun uzantılı asset-looking path SPA fallback almamalıdır', async () => {
    const response = await request('/missing.abcdefghijklmnop', {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA shell');
  });

  it('text/html q=0 ise SPA fallback kullanmamalıdır', async () => {
    const response = await request('/yenilemeler', {
      headers: { accept: 'text/html;q=0, application/json;q=1' },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA shell');
  });

  it('GET dışındaki SPA isteği index fallback almamalıdır', async () => {
    const response = await request('/yenilemeler', {
      method: 'POST',
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA shell');
  });

  it('/apix gibi API namespace olmayan uygulama yolu SPA olarak ele alınmalıdır', async () => {
    const response = await request('/apix', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SPA shell');
  });

  it.each([
    '/secure/confirm',
    '/secure%2Fconfirm',
    '/foo%2F..%2Fsecure%2Fconfirm',
    '//secure/confirm',
  ])('secure namespace %s SPA fallback almamalıdır', async (path) => {
    const response = await request(path, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SPA shell');
  });

  it('ASSETS binding bulunmadığında deterministik 503 dönmelidir', async () => {
    const response = await worker.fetch(
      new Request('https://panel.mayisigorta.com/yenilemeler', {
        headers: { accept: 'text/html' },
      }),
      { DB: {} as D1Database },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
  });

  it('Wrangler asset router missleri redirect etmeden Worker SPA fallback katmanına bırakmalıdır', () => {
    const config = readFileSync(resolve(__dirname, '../wrangler.jsonc'), 'utf-8');
    expect(config).toMatch(/"run_worker_first"\s*:\s*true/);
    expect(config).toMatch(/"html_handling"\s*:\s*"none"/);
    expect(config).toMatch(/"not_found_handling"\s*:\s*"none"/);
  });
});

import { describe, it, expect } from 'vitest';
import { app } from '../src/server/index';
import { API_PREFIX } from '../src/shared/constants';
import type { ApiResponse, HealthCheckData } from '../src/shared/types';

describe('Sunucu Kabuğu ve API Güvenlik Kapısı (Server Shell & Fallback Tests)', () => {
  it('GET /api/health başarılı durum ve JSON yanıtı döndürmelidir', async () => {
    const res = await app.request(`${API_PREFIX}/health`);
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/json');

    const json = (await res.json()) as ApiResponse<HealthCheckData>;
    expect(json.success).toBe(true);
    if (json.success) {
      expect(json.data.status).toBe('healthy');
      expect(json.data.version).toBe('0.1.0');
      expect(json.data.environment).toBeDefined();
    }
  });

  it('Bilinmeyen /api/* istekleri asla HTML dönmemeli; JSON 404 döndürmelidir (Fail-Closed)', async () => {
    const res = await app.request(`${API_PREFIX}/tanimsiz-bir-yol-404`);
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

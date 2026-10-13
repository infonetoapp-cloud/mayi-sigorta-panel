// @vitest-environment node
import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { createApp } from '../src/server/index';
import worker from '../src/server/worker';
import { DOCUMENT_ROUTE_CONTRACT } from '../src/server/documents/route-contract';
it('authoritative registry matches every actual document route, all unavailable while disabled', async () => {
  const app = createApp();
  const registered = app.routes
    .filter((r) => r.path.includes('/documents'))
    .map((r) => ({ path: r.path, method: r.method }));
  expect(registered.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
    DOCUMENT_ROUTE_CONTRACT.map((r) => ({ path: r.path, method: 'POST' })).sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  );
  for (const r of DOCUMENT_ROUTE_CONTRACT) {
    for (const method of ['POST', 'GET', 'PUT', 'DELETE']) {
      const response = await worker.fetch(
        new Request('https://panel.mayisigorta.com' + r.path.replace(':id', 'synthetic-missing'), {
          method,
          headers: { origin: 'https://panel.mayisigorta.com' },
        }),
        {
          APP_ENV: 'test',
          PANEL_ORIGIN: 'https://panel.mayisigorta.com',
          DOCUMENTS_ENABLED: 'false',
        } as never,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(404);
    }
  }
});

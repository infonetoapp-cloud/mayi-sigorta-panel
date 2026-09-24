// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/index';

describe('M3-T02 renewal Task route contract', () => {
  it('registers scoped Today’s Work', () => {
    const routes = createApp().routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toContain('GET /api/tasks/today');
  });

  it('registers assignment options', () => {
    const routes = createApp().routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toContain('GET /api/renewals/:id/tasks/:taskId/assignment-options');
  });

  it('registers Renewal and Task assignment', () => {
    const routes = createApp().routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toContain('POST /api/renewals/:id/tasks/:taskId/assign');
  });

  it('registers replacement-follow-up completion', () => {
    const routes = createApp().routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toContain('POST /api/renewals/:id/tasks/:taskId/complete');
  });
});

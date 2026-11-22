// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerPolicyRoutes } from '../src/server/policies/routes';
import {
  renderPolicyIdentityVariantConfirmation,
  SECURE_CONFIRM_SCRIPT,
} from '../src/server/policies/secure-confirm';
import type { Env } from '../src/server/index';
import type { PolicyDetailDto } from '../src/shared/types';

describe('M2-T04 policy route contract', () => {
  it('renders the secure confirmation without inline script or unescaped policy text', () => {
    const policy = {
      id: 'policy-1',
      policyNumber: '<script>alert(1)</script>',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      version: 4,
    } as PolicyDetailDto;
    const html = renderPolicyIdentityVariantConfirmation(policy);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('<script src="/secure/confirm.js" defer></script>');
    expect(SECURE_CONFIRM_SCRIPT).toContain('const commandKey = crypto.randomUUID()');
    expect(SECURE_CONFIRM_SCRIPT).toContain('let pendingGrant = null');
    expect(SECURE_CONFIRM_SCRIPT).toContain('pendingGrant.body !== grantBody');
    expect(SECURE_CONFIRM_SCRIPT).toContain("'Idempotency-Key': pendingGrant.key");
    expect(SECURE_CONFIRM_SCRIPT).toContain('commandResponse = await executeCommand()');
    expect(SECURE_CONFIRM_SCRIPT).toContain('button.disabled = grantIssued');
  });

  it('registers only the required normal API core and secure identity-variant command', () => {
    const app = new Hono<{ Bindings: Env }>();
    registerPolicyRoutes(app);
    const routes = app.routes.map(({ method, path }) => `${method} ${path}`);
    expect(routes).toEqual([
      'GET /api/policies/:id/cancellation-context',
      'POST /api/policies/:id/cancel',
      'GET /api/policies/:id/void-context',
      'POST /api/policies/:id/void',
      'GET /api/policies/:id/cancellations',
      'PUT /api/policies/:id/vehicle',
      'GET /api/policies',
      'POST /api/policies',
      'GET /api/policies/:id',
      'PATCH /api/policies/:id',
      'GET /api/policies/:id/assignment-options',
      'POST /api/policies/:id/assign',
      'GET /api/policies/:id/parties',
      'POST /api/policies/:id/parties',
      'POST /api/policies/:id/parties/:partyId/deactivate',
      'GET /api/policies/:id/amendments',
      'POST /api/policies/:id/amendments',
      'GET /api/policies/:id/external-references',
      'POST /api/policies/:id/external-references',
      'POST /api/policies/:id/archive',
      'GET /secure/api/csrf-token',
      'GET /secure/confirm/policies/:id/identity-variant',
      'GET /secure/confirm.js',
      'POST /secure/api/policies/:id/identity-variant-grants',
      'POST /secure/api/policies/:id/identity-variants',
    ]);
  });

  it('requests the secure audience before the identity-variant route reaches CSRF or domain code', async () => {
    const app = new Hono<{ Bindings: Env }>();
    let expectedAssurance: string | undefined;
    registerPolicyRoutes(app, {
      createSessionVerifier: (config) => ({
        config,
        verify: async (_request, expected) => {
          expectedAssurance = expected;
          throw new Error('NORMAL_AUDIENCE_REJECTED');
        },
      }),
    });
    const response = await app.request(
      'https://panel.mayisigorta.com/secure/api/policies/policy-1/identity-variants',
      { method: 'POST' },
      {
        DB: {} as D1Database,
      },
    );
    expect(expectedAssurance).toBe('SECURE');
    expect(response.status).toBe(403);
  });

  it('requests the secure audience before rendering the top-level confirmation page', async () => {
    const app = new Hono<{ Bindings: Env }>();
    let expectedAssurance: string | undefined;
    registerPolicyRoutes(app, {
      createSessionVerifier: (config) => ({
        config,
        verify: async (_request, expected) => {
          expectedAssurance = expected;
          throw new Error('NORMAL_AUDIENCE_REJECTED');
        },
      }),
    });
    const response = await app.request(
      'https://panel.mayisigorta.com/secure/confirm/policies/policy-1/identity-variant',
      { method: 'GET', headers: { accept: 'text/html' } },
      {
        DB: {} as D1Database,
      },
    );
    expect(expectedAssurance).toBe('SECURE');
    expect(response.status).toBe(403);
  });

  it('requests the secure audience before the grant route reaches CSRF or domain code', async () => {
    const app = new Hono<{ Bindings: Env }>();
    let expectedAssurance: string | undefined;
    registerPolicyRoutes(app, {
      createSessionVerifier: (config) => ({
        config,
        verify: async (_request, expected) => {
          expectedAssurance = expected;
          throw new Error('NORMAL_AUDIENCE_REJECTED');
        },
      }),
    });
    const response = await app.request(
      'https://panel.mayisigorta.com/secure/api/policies/policy-1/identity-variant-grants',
      { method: 'POST' },
      {
        DB: {} as D1Database,
      },
    );
    expect(expectedAssurance).toBe('SECURE');
    expect(response.status).toBe(403);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M2-T05 explicit route contracts', () => {
  it('exposes only explicit policy relationship/lifecycle mutation routes through the guarded path', () => {
    const source = readFileSync(resolve(__dirname, '../src/server/policies/routes.ts'), 'utf8');
    for (const route of [
      '/policies/:id/parties',
      '/policies/:id/parties/:partyId/deactivate',
      '/policies/:id/amendments',
      '/policies/:id/external-references',
      '/policies/:id/archive',
    ])
      expect(source).toContain(route);
    expect(source).toContain('app.get(`${API_PREFIX}/policies/:id/parties`');
    expect(source).toContain('app.get(`${API_PREFIX}/policies/:id/amendments`');
    expect(source).toContain('app.get(`${API_PREFIX}/policies/:id/external-references`');
    expect(source).not.toContain('generic-assignee');
  });

  it('exposes customer archive as an explicit guarded command route', () => {
    const source = readFileSync(resolve(__dirname, '../src/server/customers/routes.ts'), 'utf8');
    expect(source).toContain('/customers/:id/archive');
    expect(source).toContain('archiveCustomer(');
  });
});

import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
import {
  fullMemberGrants,
  isFullMember,
  selectPermissionGroup,
  removePermissionGroup,
} from '../src/shared/full-staff';
import { PERMISSION_CATALOG } from '../src/shared/permissions';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('maximum grant set contains all delegable permissions at maximum scope but never owner-only management reports', () => {
  const g = fullMemberGrants();
  expect(g).toHaveLength(PERMISSION_CATALOG.length - 1);
  expect(g.some((g) => g.permission_code === 'report.management')).toBe(false);
  expect(g.find((g) => g.permission_code === 'task.team')?.scope).toBe('UNSCOPED');
  for (const p of PERMISSION_CATALOG.filter(
    (p) => p.scopeKind === 'RECORD_SCOPED' && p.code !== 'report.management',
  ))
    expect(g.find((g) => g.permission_code === p.code)?.scope).toBe('AGENCY');
  expect(isFullMember(g)).toBe(true);
  expect(
    isFullMember(
      g.map((p) => (p.permission_code === 'task.read' ? { ...p, scope: 'ASSIGNED' } : p)),
    ),
  ).toBe(false);
  const selected = selectPermissionGroup([], ['policy.update']);
  expect(selected.some((g) => g.permission_code === 'policy.read')).toBe(true);
  expect(
    removePermissionGroup(selected, ['policy.read']).some(
      (g) => g.permission_code === 'policy.update',
    ),
  ).toBe(false);
});
it('one click prepares full permissions, optional empty reason saves only through the real command protocol', async () => {
  const writes: Record<string, unknown>[] = [];
  const f = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/api/personnel'))
      return new Response(
        JSON.stringify({
          data: {
            personnel: [
              {
                id: 'member',
                user_id: 'u',
                display_name: 'Sentetik',
                login_email: 'test@example.invalid',
                status: 'ACTIVE',
                type: 'MEMBER',
                version: 1,
                grants: [],
              },
            ],
            nextCursor: null,
          },
        }),
      );
    if (path.includes('csrf-token'))
      return new Response(JSON.stringify({ data: { token: 'fixture-csrf' } }));
    if (path.endsWith('/grants'))
      return new Response(JSON.stringify({ data: { grantEvidenceToken: 'fixture-evidence' } }));
    writes.push(JSON.parse(String(options!.body)).command);
    return new Response(JSON.stringify({ data: { membershipId: 'member' } }));
  });
  vi.stubGlobal('fetch', f);
  render(<PersonnelPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Tam Yetki Ver' }));
  expect(screen.getByText('Tam yetki taslağı')).toBeTruthy();
  expect(
    (screen.getByLabelText('Görev Görüntüleme kapsamı') as unknown as HTMLSelectElement).value,
  ).toBe('AGENCY');
  expect(writes).toHaveLength(0);
  expect((screen.getByLabelText('Gerekçe') as HTMLTextAreaElement).required).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.reason).toBe('');
  expect(writes[0]!.kind).toBe('permissions');
  expect(writes[0]!.grants).toEqual(fullMemberGrants());
});

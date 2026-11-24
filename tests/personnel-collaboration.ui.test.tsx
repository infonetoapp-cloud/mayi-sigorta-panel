// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
import { createFullPersonnelGrants, FULL_PERSONNEL_TEMPLATE } from '../src/shared/permissions';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('defaults to full worker grants and keeps an editable restricted draft', async () => {
  const fetcher = vi.fn(async (path: string, _init?: RequestInit) => {
    if (path === '/api/auth/csrf-token') return Response.json({ data: { token: 'csrf' } });
    if (path === '/secure/api/personnel/grants')
      return Response.json({ data: { grantEvidenceToken: 'grant' } });
    if (path === '/secure/api/personnel/commands')
      return Response.json({ data: { temporaryPassword: 'synthetic' } }, { status: 201 });
    return Response.json({ data: { personnel: [], nextCursor: null } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PersonnelPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Personel oluştur' }));
  const full = screen.getByRole('radio', { name: 'Tüm yetkileri ver' }) as HTMLInputElement;
  const restricted = screen.getByRole('radio', {
    name: 'Kısıtlı yetkiler ver',
  }) as HTMLInputElement;
  expect(full.checked).toBe(true);
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(restricted);
  expect(restricted.checked).toBe(true);
  const health = screen.getByRole('checkbox', {
    name: /Hassas Sağlık Bilgisi Okuma/,
  }) as HTMLInputElement;
  expect(health.checked).toBe(false);
  fireEvent.click(health);
  expect(health.checked).toBe(true);
  fireEvent.click(full);
  fireEvent.click(restricted);
  expect(
    (screen.getByRole('checkbox', { name: /Hassas Sağlık Bilgisi Okuma/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(full);
  fireEvent.change(screen.getByLabelText('Ad soyad'), { target: { value: 'Örnek Çalışan' } });
  fireEvent.change(screen.getByLabelText('Giriş e-postası'), {
    target: { value: 'worker@example.invalid' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Onayla ve oluştur' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([path]) => path === '/secure/api/personnel/commands')).toBe(
      true,
    ),
  );
  const request = fetcher.mock.calls.find(([path]) => path === '/secure/api/personnel/grants')?.[1];
  expect(JSON.parse(request?.body as string)).toMatchObject({
    template: FULL_PERSONNEL_TEMPLATE,
    grants: createFullPersonnelGrants(),
  });
});
it('preserves existing grants until explicit draft transition and secure confirmation', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            personnel: [
              {
                id: 'member',
                user_id: 'user',
                display_name: 'Ayşe',
                login_email: 'ayse@test.test',
                type: 'MEMBER',
                status: 'ACTIVE',
                version: 2,
                grants: [{ permission_code: 'customer.read', scope: 'ASSIGNED' }],
              },
            ],
            nextCursor: null,
          },
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<PersonnelPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  expect(
    (screen.getByLabelText('Müşteri Görüntüleme kapsamı') as unknown as HTMLSelectElement).value,
  ).toBe('ASSIGNED');
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Standart ortak çalışma izinlerini taslağa uygula' }),
  );
  expect(
    (screen.getByLabelText('Müşteri Görüntüleme kapsamı') as unknown as HTMLSelectElement).value,
  ).toBe('AGENCY');
  expect(
    (screen.getByLabelText('Görev Görüntüleme kapsamı') as unknown as HTMLSelectElement).value,
  ).toBe('ASSIGNED');
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  fireEvent.click(screen.getByRole('button', { name: 'İzinleri düzenle' }));
  expect(
    (screen.getByLabelText('Müşteri Görüntüleme kapsamı') as unknown as HTMLSelectElement).value,
  ).toBe('ASSIGNED');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

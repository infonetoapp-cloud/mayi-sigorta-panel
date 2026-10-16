// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

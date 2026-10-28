import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router';
import { useState } from 'react';
import PolicyDetailPage from '../src/app/pages/policies/PolicyDetailPage';
vi.mock('../src/app/pages/today-work/RenewalQuotesSection', () => ({
  RenewalQuotesSection: ({
    renewalId,
    onRisk,
  }: {
    renewalId: string;
    onRisk: (r: { dirty: boolean; unresolved: boolean }) => void;
  }) => {
    const [value, setValue] = useState('');
    return (
      <>
        <p>Teklif hedefi: {renewalId}</p>
        <label>
          Teklif taslağı
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              onRisk({ dirty: true, unresolved: false });
            }}
          />
        </label>
        <button onClick={() => onRisk({ dirty: true, unresolved: true })}>
          Yanıtı belirsiz bırak
        </button>
      </>
    );
  },
}));
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: () => <p>Görüşme paneli</p>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const f = vi.fn(async (url: string) => {
    const p = {
      id: 'p1',
      customer: { id: 'c1', displayName: 'Sentetik Deniz' },
      customerId: 'c1',
      policyNumber: 'SAME-NUMBER',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      status: 'ACTIVE',
      archivedAt: null,
      grossPremiumMinor: 123450,
      currency: 'TRY',
      insurer: { name: 'Örnek' },
      product: { name: 'Kasko' },
      branch: { name: 'Motor' },
      paymentMethod: { name: 'Kart' },
    };
    return new Response(
      JSON.stringify({
        success: true,
        data: url.startsWith('/api/customers/')
          ? {
              items: [
                {
                  id: 'wrong',
                  policyId: 'p2',
                  policyNumber: 'SAME-NUMBER',
                  state: 'CONTACT_PENDING',
                  version: 1,
                  policyEndDate: '2026-12-31',
                },
                {
                  id: 'correct',
                  policyId: 'p1',
                  policyNumber: 'SAME-NUMBER',
                  state: 'CONTACT_PENDING',
                  version: 1,
                  policyEndDate: '2026-12-31',
                },
              ],
              nextCursor: null,
            }
          : p,
      }),
    );
  });
  vi.stubGlobal('fetch', f);
  render(
    <MemoryRouter initialEntries={['/policies/p1?section=renewal']}>
      <Link to="/policies/p2">Diğer poliçe</Link>
      <Routes>
        <Route path="/policies/:policyId" element={<PolicyDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return f;
}
it('never chooses an equal-number but different-policy renewal and requires an explicit target', async () => {
  const f = setup();
  await screen.findByRole('button', { name: 'SAME-NUMBER yenilemesini aç' });
  expect(screen.queryByLabelText('Teklif taslağı')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'SAME-NUMBER yenilemesini aç' }));
  expect(await screen.findByText('Teklif hedefi: correct')).toBeTruthy();
  expect(screen.queryByText('Teklif hedefi: wrong')).toBeNull();
  expect(f.mock.calls.some(([u]) => u.includes('includePolicyId=true'))).toBe(true);
});
it('does not start an advanced policy mutation while a renewal draft is still open', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'SAME-NUMBER yenilemesini aç' }));
  fireEvent.change(screen.getByLabelText('Teklif taslağı'), {
    target: { value: 'Korunan teklif' },
  });
  fireEvent.click(screen.getByRole('link', { name: 'Sorumlu ve arşiv' }));
  await screen.findByText(/Önce açık yenileme taslağını kaydedin/);
  expect((screen.getByLabelText('Teklif taslağı') as HTMLInputElement).value).toBe(
    'Korunan teklif',
  );
  expect(
    screen.getByRole('link', { name: 'Yenileme ve teklifler' }).getAttribute('aria-current'),
  ).toBe('page');
  const proceed = vi.fn();
  fireEvent(
    document,
    new CustomEvent('mayi-logout-requested', { cancelable: true, detail: { proceed } }),
  );
  await screen.findByRole('dialog');
  expect(proceed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
});
it('keeps quote draft mounted across both work tabs and policy sections, and guards logout/navigation', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'SAME-NUMBER yenilemesini aç' }));
  fireEvent.change(screen.getByLabelText('Teklif taslağı'), {
    target: { value: 'Kayıpsız taslak' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Görüşmeler' }));
  fireEvent.click(screen.getByRole('button', { name: 'Teklifler ve sürümler' }));
  expect((screen.getByLabelText('Teklif taslağı') as HTMLInputElement).value).toBe(
    'Kayıpsız taslak',
  );
  fireEvent.click(screen.getByRole('link', { name: 'Poliçe bilgileri' }));
  fireEvent.click(screen.getByRole('link', { name: 'Yenileme ve teklifler' }));
  expect((screen.getByLabelText('Teklif taslağı') as HTMLInputElement).value).toBe(
    'Kayıpsız taslak',
  );
  expect(
    (screen.getByRole('button', { name: 'Yenileme seçimini değiştir' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Diğer poliçe' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yanıtı belirsiz bırak' }));
  fireEvent.click(screen.getByRole('link', { name: 'Diğer poliçe' }));
  await screen.findByText(/İşlemin sonucu henüz kesinleşmedi/);
  expect(screen.queryByRole('dialog')).toBeNull();
});

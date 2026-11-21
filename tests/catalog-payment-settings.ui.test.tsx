import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatalogsPanel } from '../src/app/components/CatalogsPanel';
import { invalidateCsrfToken } from '../src/app/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  invalidateCsrfToken();
});
function fixture(failFirst = false) {
  invalidateCsrfToken();
  const writes: { body: string; key: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        writes.push({
          body: String(init.body),
          key: String((init.headers as Record<string, string>)['Idempotency-Key']),
          method: init.method,
        });
        if (failFirst && writes.length === 1) throw new Error('synthetic network loss');
        return new Response(JSON.stringify({ success: true, data: { id: 'new' } }));
      }
      const data = url.includes('csrf')
        ? { token: 'test-csrf' }
        : url.includes('selectable')
          ? { insurers: [], branches: [], products: [], paymentMethods: [], lossReasons: [] }
          : [
              {
                id: 'p',
                code: 'CARD',
                name: 'Test kart',
                status: 'ACTIVE',
                version: 7,
                supportsInstallments: true,
                maxInstallments: 36,
              },
            ];
      return new Response(JSON.stringify({ success: true, data }));
    }),
  );
  render(<CatalogsPanel />);
  return writes;
}
async function create(catalog: string) {
  await screen.findByText('Test kart');
  fireEvent.click(screen.getByRole('button', { name: catalog }));
  await screen.findByText('Test kart');
  fireEvent.click(screen.getByRole('button', { name: '+ Yeni Ekle' }));
  fireEvent.change(screen.getByLabelText('Kod (Semantik Değer - Değiştirilemez)'), {
    target: { value: 'NEW' },
  });
  fireEvent.change(screen.getByLabelText('İsim / Tanım'), { target: { value: 'Yeni kayıt' } });
}
it('validates installment bounds and freezes the exact mutation after an uncertain response', async () => {
  const writes = fixture(true);
  await create('Ödeme Yöntemleri');
  fireEvent.click(screen.getByLabelText('Bu ödeme yöntemi taksiti destekler'));
  const maximum = screen.getByLabelText('En fazla taksit sayısı');
  fireEvent.change(maximum, { target: { value: '37' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  expect(document.activeElement).toBe(maximum);
  expect(writes).toHaveLength(0);
  fireEvent.change(maximum, { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Tekrar Dene' });
  expect(
    (maximum as HTMLInputElement).disabled || maximum.closest('fieldset[disabled]'),
  ).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Kaydet' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(retry);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  expect(JSON.parse(writes[0]!.body)).toMatchObject({
    supportsInstallments: true,
    maxInstallments: 9,
  });
});
it('preserves an existing 36-installment catalog limit when only the name changes', async () => {
  const writes = fixture();
  await screen.findByText('Test kart');
  fireEvent.click(screen.getByRole('button', { name: 'Ödeme Yöntemleri' }));
  await screen.findByText('Test kart');
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  expect((screen.getByLabelText('En fazla taksit sayısı') as HTMLInputElement).value).toBe('36');
  fireEvent.change(screen.getByLabelText('İsim / Tanım'), { target: { value: 'Yeni ad' } });
  fireEvent.click(screen.getByRole('button', { name: 'Güncelle' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(JSON.parse(writes[0]!.body)).toEqual({ name: 'Yeni ad', expectedVersion: 7 });
});
it('requires an explicit branch classification and sends HEALTH without changing the API contract', async () => {
  const writes = fixture();
  await create('Branşlar');
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  const field = screen.getByLabelText('Branş veri sınıfı');
  expect(document.activeElement).toBe(field);
  expect(writes).toHaveLength(0);
  fireEvent.change(field, { target: { value: 'HEALTH' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(JSON.parse(writes[0]!.body)).toMatchObject({ dataClassification: 'HEALTH' });
});

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgencySettingsPanel } from '../src/app/components/AgencySettingsPanel';
import { CatalogsPanel } from '../src/app/components/CatalogsPanel';
const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      reply(
        url === '/api/catalogs/capabilities'
          ? { canManage: true }
          : url === '/api/agency/settings'
            ? {
                version: 1,
                timezone: 'Europe/Istanbul',
                defaultInsurerId: null,
                renewalWindowDays: 30,
              }
            : url === '/api/catalogs/selectable'
              ? {
                  insurers: [{ id: 'i', name: 'Sentetik', code: 'S' }],
                  branches: [{ id: 'b', name: 'Genel', code: 'G' }],
                  products: [],
                  paymentMethods: [],
                  lossReasons: [],
                }
              : [{ id: 'i', name: 'Sentetik', code: 'S', status: 'ACTIVE', version: 1 }],
      ),
    ),
  );
}
function associated(name: string) {
  const field = screen.getByLabelText(name) as HTMLInputElement;
  expect(field.labels?.length).toBe(1);
  expect(field.labels?.[0]?.control).toBe(field);
  field.focus();
  expect(document.activeElement).toBe(field);
  return field;
}
it('associates product selectors and edit controls without changing catalog identities', async () => {
  fixture();
  render(<CatalogsPanel />);
  await screen.findByText('Sentetik', { selector: 'strong' });
  fireEvent.click(screen.getByRole('button', { name: 'Ürünler' }));
  await screen.findByText('Sentetik', { selector: 'strong' });
  fireEvent.click(screen.getByRole('button', { name: 'Yeni kayıt' }));
  expect(associated('Sigorta şirketi').required).toBe(true);
  expect(associated('Branş').required).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  associated('Ad');
  associated('Branş');
  const code = screen.getByLabelText('Kod') as HTMLInputElement;
  expect(code.labels?.[0]?.control).toBe(code);
  expect(code.disabled).toBe(true);
  expect(code.value).toBe('S');
});
it('associates all agency settings names and connects required field validation', async () => {
  fixture();
  render(<AgencySettingsPanel />);
  await screen.findByRole('button', { name: 'Ayarları Kaydet' });
  associated('Varsayılan Sigorta Şirketi');
  const timezone = associated('Operasyonel Zaman Dilimi (IANA)');
  const days = associated('Yenileme Bildirim Penceresi (Gün: 1 - 120)');
  expect(timezone.required).toBe(true);
  expect(days.required).toBe(true);
  fireEvent.change(timezone, { target: { value: 'invalid/timezone' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları Kaydet' }));
  expect(timezone.getAttribute('aria-invalid')).toBe('true');
  expect(
    document.getElementById(timezone.getAttribute('aria-describedby')!)?.textContent,
  ).toContain('Geçerli bir IANA');
  fireEvent.change(days, { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları Kaydet' }));
  expect(days.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(days.getAttribute('aria-describedby')!)?.textContent).toContain(
    'en az 1',
  );
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
});
it('names catalog create/edit controls and associates validation without changing the request', async () => {
  fixture();
  render(<CatalogsPanel />);
  await screen.findByText('Sentetik', { selector: 'strong' });
  fireEvent.click(screen.getByRole('button', { name: 'Yeni kayıt' }));
  const code = associated('Kod');
  const name = associated('Ad');
  expect(code.required).toBe(true);
  expect(name.required).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  expect(code.checkValidity()).toBe(false);
  expect(name.checkValidity()).toBe(false);
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

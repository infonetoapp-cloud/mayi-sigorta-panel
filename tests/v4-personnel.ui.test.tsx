import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
const person = {
  id: 'p',
  user_id: 'u',
  display_name: 'Sentetik Çalışan',
  login_email: 'v4@example.invalid',
  type: 'MEMBER',
  status: 'ACTIVE',
  version: 3,
  grants: [{ permission_code: 'customer.read', scope: 'ASSIGNED' }],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(lost = false) {
  let dropped = lost;
  const f = vi.fn(async (path: string, _o?: RequestInit) => {
    if (path.startsWith('/api/personnel'))
      return new Response(JSON.stringify({ data: { personnel: [person], nextCursor: null } }));
    if (path.includes('csrf-token'))
      return new Response(JSON.stringify({ data: { token: 'fixture-csrf' } }));
    if (path.endsWith('/grants'))
      return new Response(JSON.stringify({ data: { grantEvidenceToken: 'fixture-evidence' } }));
    if (dropped) {
      dropped = false;
      throw new TypeError('network lost');
    }
    return new Response(JSON.stringify({ data: { membershipId: 'p' } }));
  });
  vi.stubGlobal('fetch', f);
  render(<PersonnelPanel />);
  return f;
}
it('offers grouped searchable permissions and a current/proposed difference without mutating current grants', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  expect(screen.getByRole('heading', { name: 'Değişiklik özeti' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Müşteri Görüntüleme kapsamı'), {
    target: { value: 'AGENCY' },
  });
  const row = screen.getByRole('region', { name: 'Mevcut ve önerilen izinler' });
  expect(row.textContent).toContain('Atanan kayıtlar');
  expect(row.textContent).toContain('Acente geneli');
  expect(person.grants[0]!.scope).toBe('ASSIGNED');
  fireEvent.change(screen.getByLabelText('İzin ara'), { target: { value: 'kimlik' } });
  expect(screen.queryByRole('checkbox', { name: /^Müşteri Görüntüleme/ })).toBeNull();
  expect(screen.getByRole('checkbox', { name: /^Hassas Kimlik Bilgisi Okuma/ })).toBeTruthy();
});
it('applies a template only to proposed grants and does not write before explicit save', async () => {
  const f = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Standart ortak çalışma izinlerini taslağa uygula' }),
  );
  expect(screen.getByRole('region', { name: 'Mevcut ve önerilen izinler' }).textContent).toContain(
    'Atanan kayıtlar',
  );
  expect(f.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});
it('retries an uncertain command with the same immutable body and command key', async () => {
  const f = setup(true);
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  fireEvent.change(screen.getByLabelText('Gerekçe'), { target: { value: 'Sentetik doğrulama' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı isteği yeniden dene' }));
  await waitFor(() =>
    expect(f.mock.calls.filter(([p]) => p.endsWith('/commands'))).toHaveLength(2),
  );
  const writes = f.mock.calls.filter(([p]) => p.endsWith('/commands'));
  expect(writes[0]![1]!.body).toBe(writes[1]![1]!.body);
  expect((writes[0]![1]!.headers as Record<string, string>)['idempotency-key']).toBe(
    (writes[1]![1]!.headers as Record<string, string>)['idempotency-key'],
  );
});

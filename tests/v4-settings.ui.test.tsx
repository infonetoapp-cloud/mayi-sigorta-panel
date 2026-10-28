import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { AgencySettingsPanel } from '../src/app/components/AgencySettingsWorkspace';
vi.mock('../src/app/App', () => ({
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const settings = {
  id: 's',
  agencyId: 'a',
  defaultInsurerId: 'i',
  timezone: 'Europe/Istanbul',
  renewalWindowDays: 30,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
function fixture(canManage = true) {
  const mock = vi.fn(async (path: string) =>
    reply(
      path.endsWith('/capabilities')
        ? { canManage }
        : path.includes('/insurers')
          ? [{ id: 'i', name: 'Sentetik Sigorta', code: 'S', status: 'ACTIVE' }]
          : settings,
    ),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}
it('presents a useful read-only settings summary, not editable-looking controls, to an unauthorized MEMBER', async () => {
  fixture(false);
  render(<AgencySettingsPanel />);
  await screen.findByText('Salt okunur');
  expect(screen.getByText('Sentetik Sigorta')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Ayarları kaydet' })).toBeNull();
});
it('never retries an accepted PATCH when its readback loses the network response', async () => {
  const base = fixture();
  let accepted = false;
  const writes: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        writes.push(init);
        accepted = true;
        return reply(settings);
      }
      if (path === '/api/agency/settings' && accepted) throw new TypeError('lost readback');
      return base(path);
    }),
  );
  render(<AgencySettingsPanel />);
  const days = await screen.findByLabelText('Takibe başlama süresi');
  fireEvent.change(days, { target: { value: '45' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  await screen.findByRole('button', { name: 'Kaydı yeniden kontrol et' });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydı yeniden kontrol et' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Kayıt onaylandı'));
  expect(writes).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Aynı isteği yeniden dene' })).toBeNull();
});
it('rebases only edited fields after a conflict without overwriting someone else’s timezone', async () => {
  const base = fixture();
  let count = 0;
  const writes: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        writes.push(init);
        count++;
        return count === 1
          ? new Response(
              JSON.stringify({
                success: false,
                error: { code: 'OPTIMISTIC_CONCURRENCY_CONFLICT' },
              }),
              { status: 409 },
            )
          : reply({ ...settings, version: 3 });
      }
      if (path === '/api/agency/settings' && count)
        return reply({ ...settings, timezone: 'Europe/Berlin', version: 2 });
      return base(path);
    }),
  );
  render(<AgencySettingsPanel />);
  fireEvent.change(await screen.findByLabelText('Takibe başlama süresi'), {
    target: { value: '45' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel değerleri karşılaştır' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Taslağımı güncel kayıt üzerine hazırla' }),
  );
  expect((screen.getByLabelText('Saat dilimi') as HTMLInputElement).value).toBe('Europe/Berlin');
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(JSON.parse(writes[1]!.body as string)).toEqual({
    expectedVersion: 2,
    renewalWindowDays: 45,
  });
  await screen.findByText('Ayarlar kaydedildi. Güncel değerler doğrulandı.');
});
it('rejects fractional days and invalid timezone locally with associated errors and focused controls', async () => {
  const f = fixture();
  render(<AgencySettingsPanel />);
  const days = await screen.findByLabelText('Takibe başlama süresi');
  fireEvent.change(days, { target: { value: '1.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  expect(screen.getByRole('alert').textContent).toContain('tam gün');
  expect(document.activeElement).toBe(days);
  expect(days.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(days, { target: { value: '45' } });
  const tz = screen.getByLabelText('Saat dilimi');
  fireEvent.change(tz, { target: { value: 'Mars/Mayi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  expect(document.activeElement).toBe(tz);
  expect(document.getElementById(tz.getAttribute('aria-describedby')!)?.textContent).toContain(
    'Geçerli bir IANA',
  );
  expect(
    f.mock.calls.some(
      (args: unknown[]) => (args[1] as RequestInit | undefined)?.method === 'PATCH',
    ),
  ).toBe(false);
});
it('freezes an uncertain write and retries identical body/key without leaking unsafe server text', async () => {
  const base = fixture(),
    writes: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        writes.push(init);
        if (writes.length === 1)
          return new Response(JSON.stringify({ error: { message: 'unsafe SQL secret' } }), {
            status: 503,
          });
        return reply(settings);
      }
      return base(path);
    }),
  );
  render(<AgencySettingsPanel />);
  const days = await screen.findByLabelText('Takibe başlama süresi');
  fireEvent.change(days, { target: { value: '45' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı isteği yeniden dene' });
  expect((days as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByText(/unsafe SQL/)).toBeNull();
  fireEvent.click(retry);
  await screen.findByText('Ayarlar kaydedildi. Güncel değerler doğrulandı.');
  expect(writes).toHaveLength(2);
  expect(writes[0]!.body).toBe(writes[1]!.body);
  expect(writes[0]!.headers).toEqual(writes[1]!.headers);
  expect(JSON.parse(writes[0]!.body as string)).toEqual({
    expectedVersion: 1,
    renewalWindowDays: 45,
  });
});
it('blocks route navigation for a draft and preserves it when staying', async () => {
  fixture();
  render(
    <>
      <a href="/policies">Poliçelere git</a>
      <AgencySettingsPanel />
    </>,
  );
  const days = await screen.findByLabelText('Takibe başlama süresi');
  fireEvent.change(days, { target: { value: '45' } });
  fireEvent.click(screen.getByRole('link', { name: 'Poliçelere git' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect((days as HTMLInputElement).value).toBe('45');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('rechecks current permission before saving and retains the denied draft as readable text', async () => {
  const base = fixture();
  let revoked = false;
  const writes: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') writes.push(init);
      return path.endsWith('/capabilities') && revoked ? reply({ canManage: false }) : base(path);
    }),
  );
  render(<AgencySettingsPanel />);
  fireEvent.change(await screen.findByLabelText('Takibe başlama süresi'), {
    target: { value: '45' },
  });
  revoked = true;
  fireEvent.click(screen.getByRole('button', { name: 'Ayarları kaydet' }));
  await screen.findByText('Salt okunur');
  expect(screen.getByText('45 gün')).toBeTruthy();
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(writes).toHaveLength(0);
});
it('fails closed on capability loading failure and offers an explicit read retry', async () => {
  const base = fixture();
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path.endsWith('/capabilities') && fail ? new Response(null, { status: 503 }) : base(path),
    ),
  );
  render(<AgencySettingsPanel />);
  const retry = await screen.findByRole('button', { name: 'Yeniden yükle' });
  expect(screen.queryByRole('spinbutton')).toBeNull();
  fail = false;
  fireEvent.click(retry);
  await screen.findByLabelText('Takibe başlama süresi');
});
it('revokes editable controls on window focus without discarding the draft', async () => {
  const base = fixture();
  let revoked = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path.endsWith('/capabilities') && revoked ? reply({ canManage: false }) : base(path),
    ),
  );
  render(<AgencySettingsPanel />);
  fireEvent.change(await screen.findByLabelText('Takibe başlama süresi'), {
    target: { value: '52' },
  });
  revoked = true;
  fireEvent.focus(window);
  await screen.findByText('Salt okunur');
  expect(screen.getByText('52 gün')).toBeTruthy();
});
it('does not restore editable controls when an older focus permission response arrives after revocation', async () => {
  const base = fixture();
  let focusRequests = 0;
  let start = false;
  let release!: (r: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (start && path.endsWith('/capabilities'))
        return ++focusRequests === 1 ? delayed : reply({ canManage: false });
      return base(path);
    }),
  );
  render(<AgencySettingsPanel />);
  await screen.findByLabelText('Takibe başlama süresi');
  start = true;
  fireEvent.focus(window);
  fireEvent.focus(window);
  await screen.findByText('Salt okunur');
  await act(async () => {
    release(reply({ canManage: true }));
  });
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.getByText('Salt okunur')).toBeTruthy();
});

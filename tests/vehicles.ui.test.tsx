// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router';
import type { CustomerDetailDto } from '../src/shared/types';
import { policyDetailFixture } from './support/policy-detail-fixture';
import { CustomerVehicles } from '../src/app/pages/customers/CustomerVehicles';
import { PolicyVehicleSection } from '../src/app/pages/policies/PolicyVehicleSection';
vi.mock('../src/app/csrf', () => ({
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: vi.fn(),
}));
const details = {
  plate: '34 ABC 001',
  brand: 'Örnek Marka',
  model: 'Eski model',
  modelYear: 2020,
  vin: null,
  engineNumber: '000123',
  registrationSerial: null,
};
const vehicle = {
  id: 'v1',
  customerId: 'c1',
  version: 2,
  status: 'ACTIVE',
  details: { ...details, model: 'Yeni model' },
};
const customer = { id: 'c1', version: 3, archivedAt: null } as CustomerDetailDto;
const policy = policyDetailFixture('p1', {
  version: 3,
  vehicle: { vehicleId: 'v1', vehicleVersion: 1, details },
  branch: {
    id: 'b1',
    name: 'Kasko',
    status: 'ACTIVE',
    dataClassification: 'GENERAL',
    supportsVehicleDetails: true,
  },
});
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('does not require a plate or other vehicle field and submits explicit unknowns', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    reply(init?.method ? { ...vehicle, version: 1 } : { items: [], nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Araç ekle' }));
  expect((screen.getByLabelText('Plaka (isteğe bağlı)') as HTMLInputElement).required).toBe(false);
  for (const input of screen.getByRole('form', { name: 'Araç kaydı' }).querySelectorAll('input'))
    expect(input.required).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Aracı kaydet' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const body = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body;
  expect(JSON.parse(String(body)).details).toEqual({
    plate: null,
    brand: null,
    model: null,
    modelYear: null,
    vin: null,
    engineNumber: null,
    registrationSerial: null,
  });
});
function mount(reload = vi.fn(async () => {})) {
  return render(
    <MemoryRouter>
      <CustomerVehicles customer={customer} onReload={reload} visible />
      <Link to="/customers/c2">Diğer müşteri</Link>
    </MemoryRouter>,
  );
}
it('saves typed optional vehicle details and leading zeros using both parent and vehicle versions', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    reply(init?.method ? { ...vehicle, version: 3 } : { items: [vehicle], nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  const reload = vi.fn(async () => {});
  mount(reload);
  fireEvent.click(await screen.findByRole('button', { name: '34 ABC 001 aracını düzenle' }));
  const number = screen.getByLabelText('Motor no (isteğe bağlı)') as HTMLInputElement;
  expect(number.type).toBe('text');
  expect(number.value).toBe('000123');
  fireEvent.click(screen.getByRole('button', { name: 'Aracı kaydet' }));
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  const [url, init] = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(url).toBe('/api/customers/c1/vehicles/v1');
  expect(JSON.parse(String(init?.body))).toMatchObject({
    expectedVersion: 3,
    expectedVehicleVersion: 2,
    details: { engineNumber: '000123' },
  });
});
it('keeps uncertain vehicle writes on the same customer and retries only the exact body/key', async () => {
  let fail = true;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method) {
      if (fail) throw new Error('NETWORK');
      return reply({ ...vehicle, version: 3 });
    }
    return reply({ items: [vehicle], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '34 ABC 001 aracını düzenle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Aracı kaydet' }));
  await screen.findByRole('button', { name: 'Aynı araç kaydını yeniden dene' });
  fireEvent.click(screen.getByRole('link', { name: 'Diğer müşteri' }));
  expect(await screen.findByText(/Araç bilgisi kaydı henüz doğrulanmadı/)).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Aynı araç kaydını yeniden dene' }));
  await screen.findByText('Araç bilgisi kaydedildi ve güncel kayıt doğrulandı.');
  const calls = fetcher.mock.calls
    .filter(([, init]) => init?.method)
    .map(([url, init]) => ({ url, body: init?.body, headers: init?.headers }));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
});
it('shows the frozen policy snapshot and explicitly previews current vehicle details before replacing it', async () => {
  const fresh = {
    ...policy,
    version: 4,
    vehicle: { vehicleId: 'v1', vehicleVersion: 2, details: vehicle.details },
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    reply(
      init?.method
        ? { policyId: 'p1', version: 4, vehicle: fresh.vehicle }
        : url.startsWith('/api/policies/')
          ? fresh
          : { items: [vehicle], nextCursor: null },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const onUpdated = vi.fn();
  render(
    <MemoryRouter>
      <PolicyVehicleSection policy={policy} onUpdated={onUpdated} visible />
    </MemoryRouter>,
  );
  expect(screen.getByText('Eski model')).toBeTruthy();
  expect(screen.queryByText('Yeni model')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Araç seç / değiştir' }));
  await screen.findByRole('option', { name: /Yeni model/ });
  expect(
    await within(screen.getByRole('form', { name: 'Poliçe aracı seçimi' })).findByText(
      'Yeni model',
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Poliçenin aracını kaydet' }));
  await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(fresh));
  const init = fetcher.mock.calls.find(([, init]) => init?.method)?.[1];
  expect(JSON.parse(String(init?.body))).toEqual({
    expectedVersion: 3,
    vehicleId: 'v1',
    vehicleVersion: 2,
  });
});
it('retries only readback after confirmed writes and suppresses late401 after unmount', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    reply(init?.method ? { ...vehicle, version: 3 } : { items: [vehicle], nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  const reload = vi
    .fn()
    .mockRejectedValueOnce(new Error('GET_FAILED'))
    .mockResolvedValue(undefined);
  mount(reload);
  fireEvent.click(await screen.findByRole('button', { name: '34 ABC 001 aracını düzenle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Aracı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel araç bilgilerini yükle' }));
  await screen.findByText('Araç bilgisi kaydedildi ve güncel kayıt doğrulandı.');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  cleanup();
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((yes) => {
    resolve = yes;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method ? pending : reply({ items: [vehicle], nextCursor: null }),
    ),
  );
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const page = mount();
    fireEvent.click(await screen.findByRole('button', { name: '34 ABC 001 aracını düzenle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aracı kaydet' }));
    await screen.findByText('Araç bilgileri işleniyor…');
    page.unmount();
    await act(async () => resolve(reply(null, 401)));
    expect(ended).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});

it('keeps an existing policy vehicle visible and read-only when its branch setting is off', () => {
  const blocked = { ...policy, branch: { ...policy.branch, supportsVehicleDetails: false } };
  const props = { onUpdated: vi.fn(), visible: true };
  const { rerender } = render(
    <MemoryRouter>
      <PolicyVehicleSection policy={blocked} {...props} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Eski model')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Araç seç / değiştir' })).toBeNull();
  rerender(
    <MemoryRouter>
      <PolicyVehicleSection policy={{ ...blocked, vehicle: null }} {...props} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('heading', { name: 'Poliçenin aracı' })).toBeNull();
});

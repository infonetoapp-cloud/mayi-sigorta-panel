// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router';
import { CustomerInsurerNumbers } from '../src/app/pages/customers/CustomerInsurerNumbers';
import type { CustomerDetailDto } from '../src/shared/types';
vi.mock('../src/app/csrf', () => ({
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: vi.fn(),
}));
const customer = { id: 'c1', agencyId: 'a', version: 3, archivedAt: null } as CustomerDetailDto;
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
const numbers = [{ insurerId: 'i1', insurerName: 'Anadolu Sigorta', customerNumber: '000123' }];
const options = {
  items: [
    { id: 'i1', name: 'Anadolu Sigorta' },
    { id: 'i2', name: 'Allianz' },
  ],
  nextCursor: null,
};
function mount(reload = vi.fn(async () => {})) {
  return render(
    <MemoryRouter initialEntries={['/customers/c1']}>
      <CustomerInsurerNumbers customer={customer} onCustomerReload={reload} visible />
      <Link to="/customers/c2">Diğer müşteri</Link>
    </MemoryRouter>,
  );
}
async function edit() {
  await screen.findByText('000123');
  fireEvent.click(screen.getByRole('button', { name: 'Müşteri numarası ekle / düzelt' }));
  await screen.findByRole('option', { name: 'Anadolu Sigorta' });
  fireEvent.change(screen.getByLabelText('Sigorta şirketi (zorunlu)'), { target: { value: 'i1' } });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('corrects the selected company, retains leading zeros and sends an exact versioned write before readback', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    reply(
      init?.method === 'PUT'
        ? { customerId: 'c1', sourceNamespace: 'insurer:i1', externalKey: '000987' }
        : url.includes('options')
          ? options
          : numbers,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const reload = vi.fn(async () => {});
  mount(reload);
  await edit();
  const input = screen.getByLabelText('Şirket müşteri no (zorunlu)') as HTMLInputElement;
  expect(input.type).toBe('text');
  expect(input.value).toBe('000123');
  fireEvent.change(input, { target: { value: '000987' } });
  fireEvent.click(screen.getByRole('button', { name: 'Numarayı kaydet' }));
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  const [url, init] = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(url).toBe('/api/customers/c1/insurer-numbers/i1');
  expect(init?.body).toBe(JSON.stringify({ expectedVersion: 3, customerNumber: '000987' }));
  expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  await screen.findByText('Şirket müşteri numarası kaydedildi ve bilgiler yenilendi.');
});
it('keeps the exact retry after an uncertain response and blocks navigation to another customer', async () => {
  let fail = true;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (fail) throw new Error('NETWORK');
      return reply({ customerId: 'c1', sourceNamespace: 'insurer:i1', externalKey: '000123' });
    }
    return reply(url.includes('options') ? options : numbers);
  });
  vi.stubGlobal('fetch', fetcher);
  mount();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Numarayı kaydet' }));
  await screen.findByRole('button', { name: 'Aynı kaydı yeniden dene' });
  fireEvent.click(screen.getByRole('link', { name: 'Diğer müşteri' }));
  expect(await screen.findByText(/Müşteri numarası kaydı henüz doğrulanmadı/)).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Aynı kaydı yeniden dene' }));
  await screen.findByText('Şirket müşteri numarası kaydedildi ve bilgiler yenilendi.');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes).toHaveLength(2);
  const attempts = writes.map(([url, init]) => ({
    url,
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  }));
  expect(attempts[1]).toEqual(attempts[0]);
});
it('retries only readback after a confirmed write and never repeats PUT for a failed customer refresh', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    reply(
      init?.method === 'PUT'
        ? { customerId: 'c1', sourceNamespace: 'insurer:i1', externalKey: '000123' }
        : url.includes('options')
          ? options
          : numbers,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const reload = vi
    .fn()
    .mockRejectedValueOnce(new Error('READ_FAILED'))
    .mockResolvedValue(undefined);
  mount(reload);
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Numarayı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Kayıtlı bilgileri doğrula' }));
  await screen.findByText('Şirket müşteri numarası kaydedildi ve bilgiler yenilendi.');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});
it('rejects a malformed number row or options page and reloads each with GET', async () => {
  let broken = true;
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
    url.includes('options')
      ? reply(broken ? { ...options, nextCursor: 7 } : options)
      : broken
        ? new Response('Cannot read numbers')
        : reply(numbers),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Müşteri numarası ekle / düzelt' }));
  await screen.findByText('Sunucudan beklenen bilgiler alınamadı. Yeniden deneyin.');
  await screen.findByText('Şirket listesi alınamadı. Şirket listesini yeniden yükleyin.');
  expect(screen.queryByRole('option', { name: 'Anadolu Sigorta' })).toBeNull();
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Numaraları yeniden yükle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Şirket listesini yeniden yükle' }));
  await screen.findByText('000123');
  await screen.findByRole('option', { name: 'Anadolu Sigorta' });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher.mock.calls).toHaveLength(4);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('keeps a confirmed write locked until the company number list can be read again', async () => {
  let readbackFails = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      readbackFails = true;
      return reply({ customerId: 'c1', sourceNamespace: 'insurer:i1', externalKey: '000123' });
    }
    return reply(
      url.includes('options')
        ? options
        : readbackFails
          ? [{ ...numbers[0], customerNumber: 123 }]
          : numbers,
    );
  });
  vi.stubGlobal('fetch', fetcher);
  mount();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Numarayı kaydet' }));
  await screen.findByText(
    'Güncel müşteri kartı veya şirket numaraları yüklenemedi. Yeniden deneyin.',
  );
  expect(
    screen.queryByText('Şirket müşteri numarası kaydedildi ve bilgiler yenilendi.'),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Aynı kaydı yeniden dene' })).toBeNull();
  readbackFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Kayıtlı bilgileri doğrula' }));
  await screen.findByText('Şirket müşteri numarası kaydedildi ve bilgiler yenilendi.');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});
it('does not end the current session for a late response after the customer workspace unmounts', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((yes) => {
    resolve = yes;
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === 'PUT' ? pending : reply(url.includes('options') ? options : numbers),
  );
  vi.stubGlobal('fetch', fetcher);
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const page = mount();
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Numarayı kaydet' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    );
    page.unmount();
    await act(async () => resolve(reply(null, 401)));
    expect(ended).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PolicyPartiesSection } from '../src/app/pages/policies/PolicyPartiesSection';
import { invalidateCsrfToken } from '../src/app/csrf';
import { policyDetailFixture } from './support/policy-detail-fixture';
const policy = policyDetailFixture('a', { version: 8 });
const party = {
  id: 'p',
  policyId: 'a',
  customerId: 'linked',
  customerDisplayName: 'Yetkili Taraf',
  role: 'INSURED',
  status: 'ACTIVE',
  version: 2,
  identityValue: 'PROTECTED-IDENTITY',
};
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'VALIDATION_ERROR', message: 'unsafe SQL' } },
    ),
    { status },
  );
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const updated = vi.fn();
  const fetcher = vi.fn(
    async (url: string, init?: RequestInit) =>
      override?.(url, init) ??
      (url.endsWith('csrf-token')
        ? response({ token: 'csrf' })
        : url.startsWith('/api/customers?')
          ? response({
              items: [{ id: 'chosen', displayName: 'Seçilen Müşteri', archivedAt: null }],
              hasMore: true,
              nextCursor: 'not-fetched',
            })
          : url.startsWith('/api/customers/')
            ? response({
                id: 'chosen',
                displayName: 'Seçilen Müşteri',
                archivedAt: null,
                identityValue: 'PROTECTED-IDENTITY',
              })
            : init?.method
              ? response(party, 201)
              : url.endsWith('/parties')
                ? response([
                    party,
                    { ...party, id: 'old', role: 'BENEFICIARY', status: 'INACTIVE' },
                  ])
                : response({ ...policy, version: 9 })),
  );
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, updated };
}
async function add() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Taraf ekle' }).hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Taraf ekle' }));
  fireEvent.change(screen.getByLabelText('Müşteri ara'), { target: { value: 'Seçilen' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşterileri ara' }));
  await screen.findByRole('option', { name: 'Seçilen Müşteri' });
  fireEvent.change(screen.getByLabelText('Müşteri seçimi'), { target: { value: 'chosen' } });
  await screen.findByText('Doğrulanan müşteri: Seçilen Müşteri');
  fireEvent.change(screen.getByLabelText('Taraf rolü'), { target: { value: 'BENEFICIARY' } });
}
it('shows active/inactive history without granting linked customer navigation and creates using parent-policy CAS', async () => {
  const { fetcher, updated } = fixture();
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  await screen.findByText('Sigortalı · Aktif');
  expect(screen.getByText('Lehtar · Pasif')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Yetkili Taraf' })).toBeNull();
  expect(document.body.textContent).not.toContain('PROTECTED-');
  await add();
  fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
  await screen.findByText('Poliçe tarafı eklendi.');
  const attempt = fetcher.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(attempt[0]).toBe('/api/policies/a/parties');
  expect(JSON.parse(String(attempt[1]!.body))).toEqual({
    customerId: 'chosen',
    role: 'BENEFICIARY',
    expectedVersion: 8,
  });
  expect(updated).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.some(([url]) => url.includes('limit=20'))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => url.includes('cursor='))).toBe(false);
});
it.each(['csrf', 'csrf401', 'write', 'readback', 'readback401', 'customer401'])(
  'suppresses late %s across keyed policy navigation',
  async (stage) => {
    let release!: (r: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const { fetcher, updated } = fixture((url, init) => {
        if (
          (stage.startsWith('csrf') && url.endsWith('csrf-token')) ||
          (stage === 'write' && init?.method) ||
          (stage.startsWith('readback') && url === '/api/policies/a') ||
          (stage === 'customer401' && url === '/api/customers/chosen')
        ) {
          waiting = true;
          return deferred;
        }
        return undefined;
      });
      const view = render(<PolicyPartiesSection key="a" policy={policy} onUpdated={updated} />);
      if (stage === 'customer401') {
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Taraf ekle' }).hasAttribute('disabled')).toBe(
            false,
          ),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Taraf ekle' }));
        await screen.findByRole('option', { name: 'Seçilen Müşteri' });
        fireEvent.change(screen.getByLabelText('Müşteri seçimi'), { target: { value: 'chosen' } });
      } else {
        await add();
        fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
      }
      await waitFor(() => expect(waiting).toBe(true));
      view.rerender(
        <PolicyPartiesSection key="b" policy={{ ...policy, id: 'b' }} onUpdated={updated} />,
      );
      await screen.findByRole('button', { name: 'Taraf ekle' });
      await act(async () =>
        release(
          stage.startsWith('csrf')
            ? response({ token: 'csrf' }, stage === 'csrf401' ? 401 : 200)
            : stage === 'write'
              ? response(party, 201)
              : response({ ...policy, version: 9 }, stage.endsWith('401') ? 401 : 200),
        ),
      );
      expect(updated).not.toHaveBeenCalled();
      expect(ended).not.toHaveBeenCalled();
      expect(screen.queryByText('Poliçe tarafı eklendi.')).toBeNull();
      expect(fetcher.mock.calls.some(([url, init]) => url.includes('/b/') && !!init?.method)).toBe(
        false,
      );
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('requires explicit customer and role selection without substituting the first option', async () => {
  const { fetcher, updated } = fixture();
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Taraf ekle' }).hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Taraf ekle' }));
  await screen.findByRole('option', { name: 'Seçilen Müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
  await screen.findByRole('alert');
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  expect(fetcher.mock.calls.some(([url]) => url === '/api/customers/chosen')).toBe(false);
});
it('deactivates only after explicit confirmation using child version instead of policy version', async () => {
  const { fetcher, updated } = fixture();
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  fireEvent.click(
    within(await screen.findByRole('region', { name: 'Yetkili Taraf Sigortalı' })).getByRole(
      'button',
      { name: 'Tarafı pasifleştir' },
    ),
  );
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Pasifleştirmeyi onayla' }));
  await screen.findByText('Poliçe tarafı pasifleştirildi.');
  const attempt = fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(attempt[0]).toBe('/api/policies/a/parties/p/deactivate');
  expect(JSON.parse(String(attempt[1]!.body))).toEqual({ expectedVersion: 2 });
});
it('pins the create parent CAS to the draft opening even when parent props refresh', async () => {
  const { fetcher, updated } = fixture();
  const view = render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  await add();
  view.rerender(<PolicyPartiesSection policy={{ ...policy, version: 15 }} onUpdated={updated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
  await screen.findByText('Poliçe tarafı eklendi.');
  expect(
    JSON.parse(String(fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body)).expectedVersion,
  ).toBe(8);
});
it('prevents double-submit and retries only an immutable request after a lost response', async () => {
  let release!: (r: Response) => void;
  let posts = 0;
  const { fetcher, updated } = fixture((_url, init) =>
    init?.method
      ? ++posts === 1
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : response(party, 201)
      : undefined,
  );
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  await add();
  const form = screen.getByRole('form', { name: 'Poliçe tarafı işlemi' });
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(posts).toBe(1));
  await act(async () => release(response(null, 503)));
  expect(screen.getByRole('button', { name: 'Tarafı kaydet' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene' }));
  await screen.findByText('Poliçe tarafı eklendi.');
  const attempts = fetcher.mock.calls.filter(([, i]) => i?.method);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]![1]).toEqual(attempts[1]![1]);
});
it('requires explicit comparison after create409 and preserves selected customer and role at refreshed CAS', async () => {
  let posts = 0;
  const { fetcher, updated } = fixture((url, init) =>
    init?.method
      ? ++posts === 1
        ? response(null, 409)
        : response(party, 201)
      : url === '/api/policies/a'
        ? response({ ...policy, version: 20 })
        : undefined,
  );
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  await add();
  fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel tarafları karşılaştır' }));
  await screen.findByText('Karşılaştırılan poliçe sürümü: 20');
  expect((screen.getByLabelText('Taraf rolü') as unknown as HTMLSelectElement).value).toBe(
    'BENEFICIARY',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, işlemi onayla' }));
  await screen.findByText('Poliçe tarafı eklendi.');
  expect(JSON.parse(String(fetcher.mock.calls.filter(([, i]) => i?.method)[1]![1]!.body))).toEqual({
    customerId: 'chosen',
    role: 'BENEFICIARY',
    expectedVersion: 20,
  });
});
it('compares child version after deactivation409 separately from parent CAS', async () => {
  let posts = 0;
  const { fetcher, updated } = fixture((url, init) =>
    init?.method
      ? ++posts === 1
        ? response(null, 409)
        : response(party)
      : url.endsWith('/parties') && posts
        ? response([{ ...party, version: 4 }])
        : url === '/api/policies/a'
          ? response({ ...policy, version: 20 })
          : undefined,
  );
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  fireEvent.click(
    within(await screen.findByRole('region', { name: 'Yetkili Taraf Sigortalı' })).getByRole(
      'button',
      { name: 'Tarafı pasifleştir' },
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pasifleştirmeyi onayla' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel tarafları karşılaştır' }));
  await screen.findByText('Karşılaştırılan poliçe sürümü: 20');
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, işlemi onayla' }));
  await screen.findByText('Poliçe tarafı pasifleştirildi.');
  expect(JSON.parse(String(fetcher.mock.calls.filter(([, i]) => i?.method)[1]![1]!.body))).toEqual({
    expectedVersion: 4,
  });
});
it('retries only authorized policy/list GETs when the write committed but readback failed', async () => {
  let reads = 0;
  const { fetcher, updated } = fixture((url) =>
    url === '/api/policies/a' && ++reads === 1 ? response(null, 503) : undefined,
  );
  render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
  await add();
  fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Kaydedilen tarafları yeniden oku' }));
  await screen.findByText('Poliçe tarafı eklendi.');
  expect(fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each([403, 404, 'archived'])(
  'rejects an inaccessible or archived selected customer %s',
  async (status) => {
    const { fetcher, updated } = fixture((url) =>
      url === '/api/customers/chosen'
        ? status === 'archived'
          ? response({ id: 'chosen', displayName: 'DO-NOT-SHOW', archivedAt: '2026-01-01' })
          : response(null, status as number)
        : undefined,
    );
    render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Taraf ekle' }));
    await screen.findByRole('option', { name: 'Seçilen Müşteri' });
    fireEvent.change(screen.getByLabelText('Müşteri seçimi'), { target: { value: 'chosen' } });
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Taraf rolü'), { target: { value: 'INSURED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
    expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
    expect(document.body.textContent).not.toContain('DO-NOT-SHOW');
    expect(document.body.textContent).not.toContain('unsafe SQL');
  },
);
it('preserves read-only archived policy history without actions', async () => {
  const { updated } = fixture();
  render(
    <PolicyPartiesSection policy={{ ...policy, archivedAt: '2026-01-01' }} onUpdated={updated} />,
  );
  await screen.findByText('Sigortalı · Aktif');
  expect(screen.queryByRole('button', { name: 'Taraf ekle' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tarafı pasifleştir' })).toBeNull();
});
it.each([401, 403, 404])('hides protected party state after write denial %i', async (status) => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const { updated } = fixture((_url, init) =>
      init?.method ? response(null, status) : undefined,
    );
    render(<PolicyPartiesSection policy={policy} onUpdated={updated} />);
    await add();
    fireEvent.click(screen.getByRole('button', { name: 'Tarafı kaydet' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByText('Sigortalı · Aktif')).toBeNull();
    expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});

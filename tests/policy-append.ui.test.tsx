import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { policyDetailFixture } from './support/policy-detail-fixture';
import { PolicyAppendSection } from '../src/app/pages/policies/PolicyAppendSection';
import { invalidateCsrfToken } from '../src/app/csrf';
const policy = policyDetailFixture('a', { version: 4 });
const amendment = {
  id: 'am',
  policyId: 'a',
  externalReference: 'OLD-ZEYL',
  effectiveDate: '2026-01-01',
  description: 'Tarihsel açıklama',
  premiumDifferenceMinor: -50,
  currency: 'TRY',
  identityValue: 'DO-NOT-SHOW',
};
const reference = {
  id: 'ref',
  policyId: 'a',
  sourceNamespace: 'Old Source',
  externalKey: 'OLD-REF',
  identityValue: 'DO-NOT-SHOW',
};
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'VALIDATION_ERROR', message: 'unsafe SQL diagnostic' } },
    ),
    { status },
  );
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(
  kind: 'amendments' | 'external-references',
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const updated = vi.fn();
  const item = kind === 'amendments' ? amendment : reference;
  const fetcher = vi.fn(
    async (url: string, init?: RequestInit) =>
      override?.(url, init) ??
      (url.endsWith('csrf-token')
        ? response({ token: 'csrf' })
        : init?.method
          ? response(item, 201)
          : url.endsWith('/' + kind)
            ? response([item])
            : response({ ...policy, version: 5 })),
  );
  vi.stubGlobal('fetch', fetcher);
  return { updated, fetcher, item };
}
async function fill(kind: 'amendments' | 'external-references') {
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: kind === 'amendments' ? 'Zeyil ekle' : 'Dış referans ekle' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: kind === 'amendments' ? 'Zeyil ekle' : 'Dış referans ekle',
    }),
  );
  if (kind === 'amendments') {
    fireEvent.change(screen.getByLabelText('Dış zeyil referansı'), {
      target: { value: 'NEW-ZEYL' },
    });
    fireEvent.change(screen.getByLabelText('Geçerlilik tarihi'), {
      target: { value: '2026-05-01' },
    });
    fireEvent.change(screen.getByLabelText('Açıklama'), { target: { value: 'Yeni açıklama' } });
  } else {
    fireEvent.change(screen.getByLabelText('Kaynak ad alanı'), { target: { value: 'synthetic' } });
    fireEvent.change(screen.getByLabelText('Dış anahtar'), { target: { value: 'NEW-REF' } });
  }
}
const save = (kind: string) => (kind === 'amendments' ? 'Zeyili kaydet' : 'Referansı kaydet');
it.each(['-12500,50', '-12.500,50'])(
  'canonicalizes signed Turkish amendment input %s without changing the base policy',
  async (value) => {
    const { updated, fetcher } = fixture('amendments');
    render(<PolicyAppendSection kind="amendments" policy={policy} onUpdated={updated} />);
    await fill('amendments');
    fireEvent.change(screen.getByLabelText('Prim farkı'), { target: { value } });
    fireEvent.change(screen.getByLabelText('ISO para birimi'), { target: { value: 'TRY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zeyili kaydet' }));
    await screen.findByText(success('amendments'));
    expect(
      JSON.parse(String(fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body)).premiumDifference,
    ).toBe('-12500.50');
  },
);
it.each(['12.34', '-0.50', '0', '90071992547409.91', '-90071992547409.91'])(
  'accepts canonical signed difference %s without floating-point conversion',
  async (value) => {
    const { updated, fetcher } = fixture('amendments');
    render(<PolicyAppendSection kind="amendments" policy={policy} onUpdated={updated} />);
    await fill('amendments');
    fireEvent.change(screen.getByLabelText('Prim farkı'), { target: { value } });
    fireEvent.change(screen.getByLabelText('ISO para birimi'), { target: { value: 'TRY' } });
    fireEvent.click(screen.getByRole('button', { name: save('amendments') }));
    await screen.findByText(success('amendments'));
    expect(
      JSON.parse(String(fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body)).premiumDifference,
    ).toBe(value === '0' ? '0.00' : value);
  },
);
it.each([
  ['1.00', ''],
  ['', 'TRY'],
  ['1,000', 'TRY'],
  ['+1.00', 'TRY'],
  ['1.234', 'TRY'],
  ['90071992547409.92', 'TRY'],
  ['-90071992547409.92', 'TRY'],
  ['0', 'ZZZ'],
])('rejects invalid paired decimal %s / %s without POST', async (value, currency) => {
  const { updated, fetcher } = fixture('amendments');
  render(<PolicyAppendSection kind="amendments" policy={policy} onUpdated={updated} />);
  await fill('amendments');
  fireEvent.change(screen.getByLabelText('Prim farkı'), { target: { value } });
  fireEvent.change(screen.getByLabelText('ISO para birimi'), { target: { value: currency } });
  fireEvent.click(screen.getByRole('button', { name: save('amendments') }));
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  expect(
    screen.getByLabelText('Prim farkı').getAttribute('aria-invalid') === 'true' ||
      screen.getByLabelText('ISO para birimi').getAttribute('aria-invalid') === 'true',
  ).toBe(true);
});
it.each(['amendments', 'external-references'] as const)(
  'pins %s opening CAS against unrelated parent refresh',
  async (kind) => {
    const { updated, fetcher } = fixture(kind);
    const view = render(<PolicyAppendSection kind={kind} policy={policy} onUpdated={updated} />);
    await fill(kind);
    view.rerender(
      <PolicyAppendSection kind={kind} policy={{ ...policy, version: 22 }} onUpdated={updated} />,
    );
    fireEvent.click(screen.getByRole('button', { name: save(kind) }));
    await screen.findByText(success(kind));
    expect(
      JSON.parse(String(fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body)).expectedVersion,
    ).toBe(4);
  },
);
it.each(['amendments', 'external-references'] as const)(
  'prevents double submit for %s and retries only the same immutable request',
  async (kind) => {
    let release!: (r: Response) => void,
      posts = 0;
    const { updated, fetcher, item } = fixture(kind, (_url, i) =>
      i?.method
        ? ++posts === 1
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : response(kind === 'amendments' ? amendment : reference, 201)
        : undefined,
    );
    render(<PolicyAppendSection kind={kind} policy={policy} onUpdated={updated} />);
    await fill(kind);
    const form = screen.getByRole('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toBe(1));
    await act(async () => release(response(null, 503)));
    expect(screen.getByRole('button', { name: save(kind) }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene' }));
    await screen.findByText(success(kind));
    const attempts = fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]![1]).toEqual(attempts[1]![1]);
    expect(item.policyId).toBe('a');
  },
);
it.each(['amendments', 'external-references'] as const)(
  'requires explicit refreshed comparison after %s 409, retaining draft and using pinned compared CAS',
  async (kind) => {
    let posts = 0;
    const { updated, fetcher } = fixture(kind, (url, i) =>
      i?.method
        ? ++posts === 1
          ? response(null, 409)
          : response(kind === 'amendments' ? amendment : reference, 201)
        : url === '/api/policies/a'
          ? response({ ...policy, version: 12 })
          : undefined,
    );
    const view = render(<PolicyAppendSection kind={kind} policy={policy} onUpdated={updated} />);
    await fill(kind);
    fireEvent.click(screen.getByRole('button', { name: save(kind) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Güncel kayıtları karşılaştır' }));
    await screen.findByText('Karşılaştırılan poliçe sürümü: 12');
    view.rerender(
      <PolicyAppendSection kind={kind} policy={{ ...policy, version: 20 }} onUpdated={updated} />,
    );
    expect(
      (
        screen.getByLabelText(
          kind === 'amendments' ? 'Dış zeyil referansı' : 'Dış anahtar',
        ) as HTMLInputElement
      ).value,
    ).toBe(kind === 'amendments' ? 'NEW-ZEYL' : 'NEW-REF');
    fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, kaydet' }));
    await screen.findByText(success(kind));
    expect(
      JSON.parse(String(fetcher.mock.calls.filter(([, i]) => i?.method)[1]![1]!.body))
        .expectedVersion,
    ).toBe(12);
  },
);
it('does not resend an external reference already found in the refreshed comparison list', async () => {
  let posts = 0;
  const { updated, fetcher } = fixture('external-references', (url, i) =>
    i?.method
      ? (posts++, response(null, 409))
      : url.endsWith('/external-references') && posts
        ? response([{ ...reference, sourceNamespace: 'synthetic', externalKey: 'NEW-REF' }])
        : undefined,
  );
  render(<PolicyAppendSection kind="external-references" policy={policy} onUpdated={updated} />);
  await fill('external-references');
  fireEvent.click(screen.getByRole('button', { name: save('external-references') }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel kayıtları karşılaştır' }));
  await screen.findByText('Karşılaştırılan poliçe sürümü: 5');
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, kaydet' }));
  await screen.findByText(/İkinci kayıt gönderilmedi/);
  expect(fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each(['amendments', 'external-references'] as const)(
  'retries only policy and %s GET after committed write/readback failure',
  async (kind) => {
    let reads = 0;
    const { updated, fetcher } = fixture(kind, (url) =>
      url === '/api/policies/a' && ++reads === 1 ? response(null, 503) : undefined,
    );
    render(<PolicyAppendSection kind={kind} policy={policy} onUpdated={updated} />);
    await fill(kind);
    fireEvent.click(screen.getByRole('button', { name: save(kind) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Kaydedilen listeyi yeniden oku' }));
    await screen.findByText(success(kind));
    expect(fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it.each(['amendments', 'external-references'] as const)(
  'keeps archived %s historical data read-only',
  async (kind) => {
    const { updated } = fixture(kind);
    render(
      <PolicyAppendSection
        kind={kind}
        policy={{ ...policy, archivedAt: '2026-01-01' }}
        onUpdated={updated}
      />,
    );
    await screen.findByText(kind === 'amendments' ? 'OLD-ZEYL' : 'OLD-REF');
    expect(
      screen.queryByRole('button', {
        name: kind === 'amendments' ? 'Zeyil ekle' : 'Dış referans ekle',
      }),
    ).toBeNull();
  },
);
it.each([401, 403, 404])('hides protected state on a live write denial %i', async (status) => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const { updated } = fixture('amendments', (_url, i) =>
      i?.method ? response(null, status) : undefined,
    );
    render(<PolicyAppendSection kind="amendments" policy={policy} onUpdated={updated} />);
    await fill('amendments');
    fireEvent.click(screen.getByRole('button', { name: save('amendments') }));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Dış zeyil referansı')).toBeNull();
    expect(screen.queryByText('OLD-ZEYL')).toBeNull();
    expect(document.body.textContent).not.toContain('unsafe SQL');
    expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
it.each(['csrf401', 'write', 'readback401'])(
  'suppresses late %s across policy or section keyed navigation',
  async (stage) => {
    let release!: (r: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const { updated, fetcher } = fixture('amendments', (url, i) => {
        if (
          (stage === 'csrf401' && url.endsWith('csrf-token')) ||
          (stage === 'write' && i?.method) ||
          (stage === 'readback401' && url === '/api/policies/a')
        ) {
          waiting = true;
          return deferred;
        }
        if (url.endsWith('/external-references')) return response([reference]);
        return undefined;
      });
      const view = render(
        <PolicyAppendSection
          key="a:amendments"
          kind="amendments"
          policy={policy}
          onUpdated={updated}
        />,
      );
      await fill('amendments');
      fireEvent.click(screen.getByRole('button', { name: save('amendments') }));
      await waitFor(() => expect(waiting).toBe(true));
      view.rerender(
        <PolicyAppendSection
          key="b:external-references"
          kind="external-references"
          policy={{ ...policy, id: 'b' }}
          onUpdated={updated}
        />,
      );
      await screen.findByText('OLD-REF');
      await act(async () =>
        release(
          stage === 'write'
            ? response(amendment, 201)
            : response(stage === 'csrf401' ? { token: 'csrf' } : policy, 401),
        ),
      );
      expect(ended).not.toHaveBeenCalled();
      expect(updated).not.toHaveBeenCalled();
      expect(screen.queryByText('Zeyil eklendi.')).toBeNull();
      expect(fetcher.mock.calls.some(([url, i]) => url.includes('/b/') && !!i?.method)).toBe(false);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
const success = (kind: string) =>
  kind === 'amendments' ? 'Zeyil eklendi.' : 'Dış referans eklendi.';
it.each(['amendments', 'external-references'] as const)(
  'keeps %s history and appends only canonical fields at the opened parent version',
  async (kind) => {
    const { updated, fetcher } = fixture(kind);
    render(<PolicyAppendSection key={kind} kind={kind} policy={policy} onUpdated={updated} />);
    await fill(kind);
    fireEvent.click(screen.getByRole('button', { name: save(kind) }));
    await screen.findByText(success(kind));
    const attempt = fetcher.mock.calls.find(([, i]) => i?.method)!;
    expect(attempt[0]).toBe('/api/policies/a/' + kind);
    expect(JSON.parse(String(attempt[1]!.body))).toEqual(
      kind === 'amendments'
        ? {
            expectedVersion: 4,
            externalReference: 'NEW-ZEYL',
            effectiveDate: '2026-05-01',
            description: 'Yeni açıklama',
            premiumDifference: null,
            currency: null,
          }
        : { expectedVersion: 4, sourceNamespace: 'synthetic', externalKey: 'NEW-REF' },
    );
    expect(updated).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('DO-NOT-SHOW');
  },
);

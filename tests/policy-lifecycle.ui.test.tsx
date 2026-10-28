import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render as renderUI,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { PolicyManagementSection } from '../src/app/pages/policies/PolicyManagementSection';
import { invalidateCsrfToken } from '../src/app/csrf';
import type { PolicyDetailDto } from '../src/shared/types';
import { MemoryRouter } from 'react-router';
function render(ui: Parameters<typeof renderUI>[0]) {
  return renderUI(ui, { wrapper: MemoryRouter });
}
const archiveLabel = 'Poliçe arşivleme';
it.each(['csrf401', 'write', 'readback401', 'directory401'])(
  'ignores late %s after changing policy management pages',
  async (stage) => {
    let release!: (r: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let waiting = false,
      optionReads = 0;
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const { fetcher, updated } = fixture((url, i) => {
        if (
          (stage === 'csrf401' && url.endsWith('csrf-token')) ||
          (stage === 'write' && i?.method) ||
          (stage === 'readback401' && url === '/api/policies/a') ||
          (stage === 'directory401' &&
            url === '/api/policies/a/assignment-options' &&
            ++optionReads > 1)
        ) {
          waiting = true;
          return deferred;
        }
        return undefined;
      });
      const view = render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
      if (stage === 'directory401') {
        await assign();
        fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
      } else {
        archive();
        fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }));
      }
      await waitFor(() => expect(waiting).toBe(true));
      view.rerender(
        <PolicyManagementSection policy={{ ...policy, id: 'b' }} onUpdated={updated} />,
      );
      await screen.findByRole('button', { name: 'Sorumluyu değiştir' });
      await act(async () =>
        release(
          stage === 'write'
            ? response({ ...policy, version: 4, archivedAt: '2026-10-01' })
            : response(
                stage === 'csrf401'
                  ? { token: 'csrf' }
                  : stage === 'directory401'
                    ? options
                    : policy,
                401,
              ),
        ),
      );
      expect(updated).not.toHaveBeenCalled();
      expect(ended).not.toHaveBeenCalled();
      expect(screen.queryByText('Poliçe arşivlendi.')).toBeNull();
      expect(fetcher.mock.calls.some(([url, i]) => url.includes('/b/') && !!i?.method)).toBe(false);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it.each([401, 403, 404])(
  'removes protected archive confirmation after a live denial %i',
  async (status) => {
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const { updated } = fixture((_url, i) => (i?.method ? response(null, status) : undefined));
      render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
      archive();
      fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }));
      await screen.findByRole('alert');
      expect(
        within(screen.getByRole('region', { name: archiveLabel })).queryByRole('form'),
      ).toBeNull();
      expect(screen.queryByText('POL-A')).toBeNull();
      expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
const policy = {
  id: 'a',
  version: 3,
  policyNumber: 'POL-A',
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  grossPremiumMinor: 123456,
  currency: 'TRY',
  status: 'ACTIVE',
  assigneeMembershipId: 'm1',
  archivedAt: null,
} as PolicyDetailDto;
const options = [
  { membershipId: 'm1', label: 'Sorumlu Bir', membershipType: 'OWNER' },
  { membershipId: 'm2', label: 'Sorumlu İki', membershipType: 'MEMBER' },
];
const response = (data: unknown, status = 200, code = 'VALIDATION_ERROR') =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code, message: 'unsafe SQL diagnostic' } },
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
  let current = policy;
  const updated = vi.fn();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url.endsWith('/assignment-options')) return response(options);
    if (init?.method) {
      const b = JSON.parse(String(init.body));
      current = {
        ...current,
        version: current.version + 1,
        ...(url.endsWith('/assign')
          ? { assigneeMembershipId: b.assigneeMembershipId }
          : { archivedAt: '2026-10-01T00:00:00Z', archiveReason: b.reasonCode }),
      };
      return response(current);
    }
    return response(current);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, updated };
}
async function assign() {
  fireEvent.click(await screen.findByRole('button', { name: 'Sorumluyu değiştir' }));
  fireEvent.change(screen.getByLabelText('Yeni poliçe sorumlusu'), { target: { value: 'm2' } });
  fireEvent.click(screen.getByLabelText('Sorumlu değişikliğini onaylıyorum'));
}
function archive() {
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi arşivle' }));
  fireEvent.change(screen.getByLabelText('Arşiv nedeni'), {
    target: { value: 'HISTORICAL_RECORD' },
  });
  fireEvent.click(screen.getByLabelText('Bu poliçeyi arşivlemek istediğimi onaylıyorum'));
}
it('loads the authorized directory and assigns only after explicit choice/confirmation with policy CAS', async () => {
  const { fetcher, updated } = fixture();
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  await screen.findByText('Mevcut sorumlu: Sorumlu Bir');
  await assign();
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
  await screen.findByText('Poliçe sorumlusu güncellendi.');
  const req = fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(req[0]).toBe('/api/policies/a/assign');
  expect(JSON.parse(String(req[1]!.body))).toEqual({
    expectedVersion: 3,
    assigneeMembershipId: 'm2',
  });
  expect(updated).toHaveBeenCalledOnce();
});
it('archives only after reason/confirmation and refreshes historical read-only detail', async () => {
  const { fetcher, updated } = fixture();
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  archive();
  expect(screen.getByText('POL-A')).toBeTruthy();
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }));
  await screen.findByText('Poliçe arşivlendi.');
  const req = fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(req[0]).toBe('/api/policies/a/archive');
  expect(JSON.parse(String(req[1]!.body))).toEqual({
    expectedVersion: 3,
    reasonCode: 'HISTORICAL_RECORD',
  });
  expect(updated).toHaveBeenCalledOnce();
});
it('hides the assignment directory completely when AGENCY assignment permission is denied', async () => {
  const { updated, fetcher } = fixture((url) =>
    url.endsWith('/assignment-options') ? response(null, 403) : undefined,
  );
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Sorumlu Bir')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sorumluyu değiştir' })).toBeNull();
  expect(document.body.textContent).not.toContain('unsafe SQL');
  expect(fetcher.mock.calls.some(([url]) => url.includes('/personnel'))).toBe(false);
});
it('preserves an unknown/inactive current association without inventing a name or selecting a replacement', async () => {
  const { updated, fetcher } = fixture();
  render(
    <PolicyManagementSection
      policy={{ ...policy, assigneeMembershipId: 'historical-inactive' }}
      onUpdated={updated}
    />,
  );
  await screen.findByText(/Tarihsel bağlantı korunuyor/);
  fireEvent.click(screen.getByRole('button', { name: 'Sorumluyu değiştir' }));
  expect(
    (screen.getByLabelText('Yeni poliçe sorumlusu') as unknown as HTMLSelectElement).value,
  ).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
  await screen.findByRole('alert');
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
});
it.each(['assign', 'archive'])(
  'pins %s CAS to its opening snapshot despite new parent props',
  async (kind) => {
    const { updated, fetcher } = fixture();
    const view = render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
    if (kind === 'assign') await assign();
    else archive();
    view.rerender(
      <PolicyManagementSection policy={{ ...policy, version: 30 }} onUpdated={updated} />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: kind === 'assign' ? 'Atamayı kaydet' : 'Arşivlemeyi onayla',
      }),
    );
    await screen.findByText(
      kind === 'assign' ? 'Poliçe sorumlusu güncellendi.' : 'Poliçe arşivlendi.',
    );
    expect(
      JSON.parse(String(fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body)).expectedVersion,
    ).toBe(3);
  },
);
it('keeps independent assignment and archive drafts while one has an uncertain result', async () => {
  let release!: (r: Response) => void;
  const { updated } = fixture((_url, i) =>
    i?.method
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : undefined,
  );
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  await assign();
  archive();
  fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  await act(async () => release(response(null, 503)));
  expect((screen.getByLabelText('Arşiv nedeni') as unknown as HTMLSelectElement).value).toBe(
    'HISTORICAL_RECORD',
  );
  expect(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(screen.getByRole('button', { name: 'Atamayı kaydet' }).hasAttribute('disabled')).toBe(
    true,
  );
});
it.each(['assign', 'archive'])(
  'prevents %s double submit and retries the original body/key after lost response',
  async (kind) => {
    let writes = 0;
    const result = {
      ...policy,
      version: 4,
      assigneeMembershipId: kind === 'assign' ? 'm2' : 'm1',
      archivedAt: kind === 'archive' ? '2026-10-01' : null,
    };
    const { updated, fetcher } = fixture((url, i) =>
      i?.method
        ? ++writes === 1
          ? response(null, 503)
          : response(result)
        : url === '/api/policies/a' && writes
          ? response(result)
          : undefined,
    );
    render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
    if (kind === 'assign') await assign();
    else archive();
    const form = screen.getByRole('form', {
      name: kind === 'assign' ? 'Poliçe sorumlusu atama formu' : 'Poliçe arşiv onayı',
    });
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(await screen.findByRole('button', { name: 'Aynı işlemi yeniden dene' }));
    await screen.findByText(
      kind === 'assign' ? 'Poliçe sorumlusu güncellendi.' : 'Poliçe arşivlendi.',
    );
    const attempts = fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]![1]).toEqual(attempts[1]![1]);
  },
);
it.each(['assign', 'archive'])(
  'retries only GET after %s commits but authorized readback fails',
  async (kind) => {
    let reads = 0;
    const { updated, fetcher } = fixture((url) =>
      url === '/api/policies/a' && ++reads === 1 ? response(null, 503) : undefined,
    );
    render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
    if (kind === 'assign') await assign();
    else archive();
    fireEvent.click(
      screen.getByRole('button', {
        name: kind === 'assign' ? 'Atamayı kaydet' : 'Arşivlemeyi onayla',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Kaydedilen poliçeyi yeniden oku' }));
    await screen.findByText(
      kind === 'assign' ? 'Poliçe sorumlusu güncellendi.' : 'Poliçe arşivlendi.',
    );
    expect(fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it('handles OPEN_DEPENDENCIES with explicit refreshed comparison and a new confirmation, never closing tasks', async () => {
  let writes = 0;
  let live = { ...policy };
  const { updated, fetcher } = fixture((url, i) => {
    if (i?.method) {
      if (++writes === 1) return response(null, 409, 'OPEN_DEPENDENCIES');
      live = { ...policy, version: 11, archivedAt: '2026-10-01' } as typeof policy;
      return response(live);
    }
    return url === '/api/policies/a'
      ? response(writes === 1 ? { ...policy, version: 10 } : live)
      : undefined;
  });
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  archive();
  fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }));
  await screen.findByText(/Açık yenileme veya takip görevi bulundu/);
  fireEvent.click(screen.getByRole('button', { name: 'Güncel poliçeyi karşılaştır' }));
  await screen.findByText('Karşılaştırılan poliçe sürümü: 10');
  expect((screen.getByLabelText('Arşiv nedeni') as unknown as HTMLSelectElement).value).toBe(
    'HISTORICAL_RECORD',
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Bu poliçeyi arşivlemek istediğimi onaylıyorum') as HTMLInputElement)
        .checked,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, arşivlemeyi onayla' }));
  expect(writes).toBe(1);
  fireEvent.click(screen.getByLabelText('Bu poliçeyi arşivlemek istediğimi onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, arşivlemeyi onayla' }));
  await screen.findByText('Poliçe arşivlendi.');
  expect(JSON.parse(String(fetcher.mock.calls.filter(([, i]) => i?.method)[1]![1]!.body))).toEqual({
    expectedVersion: 10,
    reasonCode: 'HISTORICAL_RECORD',
  });
  expect(
    fetcher.mock.calls.some(([url]) => url.includes('/tasks') || url.includes('/renewals')),
  ).toBe(false);
});
it('does not replace a selection that becomes inactive in refreshed assignment options', async () => {
  let writes = 0;
  const { updated, fetcher } = fixture((url, i) =>
    i?.method
      ? (writes++, response(null, 409))
      : url.endsWith('/assignment-options') && writes
        ? response([options[0]])
        : url === '/api/policies/a'
          ? response({ ...policy, version: 10 })
          : undefined,
  );
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  await assign();
  fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel poliçeyi karşılaştır' }));
  await screen.findByText('Karşılaştırılan poliçe sürümü: 10');
  expect(
    (screen.getByLabelText('Yeni poliçe sorumlusu') as unknown as HTMLSelectElement).value,
  ).toBe('m2');
  fireEvent.click(screen.getByLabelText('Sorumlu değişikliğini onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, atamayı kaydet' }));
  expect(fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it('requires a compatible explicit reason code and final checkbox', async () => {
  const { updated, fetcher } = fixture();
  render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi arşivle' }));
  fireEvent.change(screen.getByLabelText('Arşiv nedeni'), {
    target: { value: 'lower case' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }));
  await screen.findByRole('alert');
  expect(fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
});
it('renders archived policy management read-only without replacing its assignee', async () => {
  const { updated } = fixture();
  render(
    <PolicyManagementSection
      policy={{ ...policy, archivedAt: '2026-01-01' }}
      onUpdated={updated}
    />,
  );
  await screen.findByText('Mevcut sorumlu: Sorumlu Bir');
  expect(screen.queryByRole('button', { name: 'Sorumluyu değiştir' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Poliçeyi arşivle' })).toBeNull();
});
it('reflects a newer authorized parent assignee after an earlier successful readback', async () => {
  const { updated } = fixture();
  const view = render(<PolicyManagementSection policy={policy} onUpdated={updated} />);
  await assign();
  fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
  await screen.findByText('Mevcut sorumlu: Sorumlu İki');
  view.rerender(
    <PolicyManagementSection
      policy={{ ...policy, version: 20, assigneeMembershipId: 'm1' }}
      onUpdated={updated}
    />,
  );
  await screen.findByText('Mevcut sorumlu: Sorumlu Bir');
});

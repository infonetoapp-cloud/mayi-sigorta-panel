import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceSection } from '../src/app/pages/today-work/WorkspaceSection';
import { MemoryRouter } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('starts with a compact workspace and never collapses a real communication draft', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            success: true,
            data: url.startsWith('/api/tasks/today')
              ? {
                  items: [
                    {
                      taskId: 't',
                      renewalId: 'r',
                      customerId: 'c',
                      customerDisplayName: 'Deneme',
                      policyId: 'p',
                      policyNumber: 'P-1',
                      title: 'Takip',
                      dueAt: '2026-10-20T09:00:00.000Z',
                      taskVersion: 1,
                      renewalVersion: 1,
                      assigneeMembershipId: 'm',
                      renewalAssigneeMembershipId: 'm',
                      renewalState: 'CONTACT_PENDING',
                      bucket: 'TODAY',
                      isUnassigned: false,
                    },
                  ],
                  unassignedItems: [],
                  hasMore: false,
                  timezone: 'Europe/Istanbul',
                  todayLocalDate: '2026-10-20',
                  now: '2026-10-20T09:00:00.000Z',
                }
              : {
                  interactions: [],
                  lastContactAt: null,
                  lastAttemptAt: null,
                  customerType: 'INDIVIDUAL',
                  companyContacts: [],
                },
          }),
          { status: 200 },
        ),
    ),
  );
  render(
    <MemoryRouter>
      <TodayWorkPage owner />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Deneme/ }));
  expect(screen.queryByRole('button', { name: 'Teklif geçmişini aç' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Yeni takip planını aç' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim' }));
  fireEvent.click(await screen.findByRole('button', { name: 'İletişim kaydı ekle' }));
  fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
  fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Kaybolmayan taslak' } });
  const disclosure = screen.getByRole('button', { name: 'İletişim' });
  fireEvent.click(disclosure);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Kaybolmayan taslak');
  fireEvent.click(screen.getByRole('button', { name: 'Görev işlemleri' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
  fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul)'), {
    target: { value: '2099-01-01T11:15' },
  });
  fireEvent.click(
    screen.getByLabelText('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Takibi tamamla ve planla' }));
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Kaybolmayan taslak');
});
it('keeps children mounted and field values intact across clean disclosure changes', () => {
  const mounted = vi.fn(),
    unmounted = vi.fn();
  function Child() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return (
      <label>
        Deneme alanı
        <input defaultValue="" />
      </label>
    );
  }
  render(
    <WorkspaceSection title="Teklifler" description="Teklif geçmişi">
      <Child />
    </WorkspaceSection>,
  );
  const toggle = screen.getByRole('button', { name: 'Teklifler' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(toggle);
  const field = screen.getByRole('textbox');
  fireEvent.change(field, { target: { value: 'Saklanan değer' } });
  fireEvent.click(toggle);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole('textbox')).toBe(field);
  expect((field as HTMLInputElement).value).toBe('Saklanan değer');
  expect(mounted).toHaveBeenCalledOnce();
  expect(unmounted).not.toHaveBeenCalled();
});
it.each(['dirty draft', 'uncertain write', 'confirmed write pending readback'])(
  'does not hide a pinned %s and stays open after risk clears',
  () => {
    const view = render(
      <WorkspaceSection title="Yenileme sonucu" description="Sonuç" pinned>
        <button>Özgün isteği yeniden dene</button>
      </WorkspaceSection>,
    );
    const toggle = screen.getByRole('button', { name: 'Yenileme sonucu' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Özgün isteği yeniden dene' })).toBeTruthy();
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    view.rerender(
      <WorkspaceSection title="Yenileme sonucu" description="Sonuç" pinned={false}>
        <button>Doğrulandı</button>
      </WorkspaceSection>,
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  },
);

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthShell } from '../src/app/AuthShell';

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
let owner = false;
let state = 'NORMAL';
const workPage = {
  items: [],
  unassignedItems: [],
  nextCursor: null,
  hasMore: false,
  unassignedNextCursor: null,
  unassignedHasMore: false,
  canSeeUnassigned: false,
  canAssign: false,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-11-21',
  now: '2026-11-21T09:00:00Z',
};
const fetcher = vi.fn(async (path: string) => {
  if (path === '/api/auth/session')
    return reply({ state, email: 'staff@demo.invalid', isOwner: owner });
  if (path.endsWith('csrf-token')) return reply({ token: 'synthetic-csrf' });
  if (path.startsWith('/api/tasks/today')) return reply(workPage);
  if (path.startsWith('/api/customers'))
    return reply({ items: [], hasMore: false, nextCursor: null });
  if (path.startsWith('/api/personnel')) return reply({ personnel: [], nextCursor: null });
  return reply({});
});
beforeEach(() => {
  owner = false;
  state = 'NORMAL';
  window.history.replaceState(null, '', '/');
  fetcher.mockClear();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('opens an operational overview with one bounded authorized queue request', async () => {
  render(<AuthShell />);
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  expect((await screen.findByRole('link', { name: 'Müşterilere git' })).getAttribute('href')).toBe(
    '/customers',
  );
  expect(screen.getByRole('link', { name: 'Bugünkü işleri aç' }).getAttribute('href')).toBe(
    '/today-work',
  );
  expect(screen.queryByText(/M1-T01|FAIL-CLOSED|INDIVIDUAL|Sistem Temeli/)).toBeNull();
  await screen.findByText('Gecikmiş veya bugün yapılacak takip görünmüyor.');
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    '/api/auth/session',
    '/api/tasks/today?limit=20',
  ]);
  expect(screen.queryByRole('menuitem', { name: 'Çıkış Yap' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Hesap menüsü' }));
  expect(screen.getByText('staff@demo.invalid')).toBeTruthy();
});
it('shows a recoverable overview failure and retries the same bounded owner queue', async () => {
  owner = true;
  fetcher.mockImplementationOnce(async () =>
    reply({ state, email: 'owner@demo.invalid', isOwner: true }),
  );
  fetcher.mockImplementationOnce(async () => reply({}, 503));
  render(<AuthShell />);
  await screen.findByText('Takipler yüklenemedi.');
  fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
  await screen.findByText('Gecikmiş veya bugün yapılacak takip görünmüyor.');
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    '/api/auth/session',
    '/api/tasks/today?limit=20&unified=true',
    '/api/tasks/today?limit=20&unified=true',
  ]);
});
it('navigates the existing customer workflow with browser history and direct-link refresh', async () => {
  window.history.replaceState(null, '', '/customers');
  render(<AuthShell />);
  await screen.findByRole('link', { name: 'Yeni Müşteri' });
  fireEvent.click(screen.getByRole('link', { name: 'Genel Bakış' }));
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  expect(window.location.pathname).toBe('/');
  await act(async () => {
    window.history.back();
  });
  await screen.findByRole('link', { name: 'Yeni Müşteri' });
  expect(window.location.pathname).toBe('/customers');
  await act(async () => {
    window.history.forward();
  });
  await screen.findByRole('heading', { name: 'Genel Bakış' });
});
it('names the quote workspace when opened directly', async () => {
  window.history.replaceState(null, '', '/sales-cases/test-case');
  render(<AuthShell />);
  await waitFor(() => expect(document.title).toBe('Teklif çalışması · Mayı Sigorta'));
});
it('denies employee personnel deep links without fetching management APIs', async () => {
  window.history.replaceState(null, '', '/personnel');
  render(<AuthShell />);
  await screen.findByRole('heading', { name: 'Bu sayfaya erişiminiz yok' });
  expect(screen.queryByRole('link', { name: 'Personel ve İzinler' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Acente Ayarları' })).toBeTruthy();
  expect(fetcher.mock.calls.some((call) => call[0].startsWith('/api/personnel'))).toBe(false);
});
it('provides separate OWNER management navigation and real personnel page', async () => {
  owner = true;
  render(<AuthShell />);
  fireEvent.click(await screen.findByRole('link', { name: 'Personel ve İzinler' }));
  await screen.findByRole('button', { name: 'Personel oluştur' });
  expect(window.location.pathname).toBe('/personnel');
});
it('has accessible collapse/mobile disclosure, closes on Escape and navigation', async () => {
  render(<AuthShell />);
  const collapse = await screen.findByRole('button', { name: 'Menüyü daralt' });
  fireEvent.click(collapse);
  expect(
    screen.getByRole('button', { name: 'Menüyü genişlet' }).getAttribute('aria-expanded'),
  ).toBe('false');
  const toggle = screen.getByRole('button', { name: 'Menüyü aç' });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('region', { name: 'Hesap işlemleri' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Çıkış Yap' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Şifremi değiştir' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('region', { name: 'Hesap işlemleri' })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('link', { name: 'Müşteriler' }));
  await screen.findByRole('link', { name: 'Yeni Müşteri' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
it('removes the shell immediately on session end and never exposes activation navigation', async () => {
  render(<AuthShell />);
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  act(() => document.dispatchEvent(new Event('mayi-session-ended')));
  await screen.findByRole('button', { name: 'Giriş Yap' });
  expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull();
  cleanup();
  state = 'ACTIVATION';
  render(<AuthShell />);
  await screen.findByRole('heading', { name: 'Yeni şifrenizi belirleyin' });
  expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull();
});
it('keeps logout CSRF protocol and clears the shell', async () => {
  render(<AuthShell />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hesap menüsü' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Çıkış Yap' }));
  await screen.findByRole('button', { name: 'Giriş Yap' });
  await waitFor(() =>
    expect(fetcher.mock.calls.some((call) => call[0] === '/api/auth/logout')).toBe(true),
  );
  expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull();
});

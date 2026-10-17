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
const fetcher = vi.fn(async (path: string) => {
  if (path === '/api/auth/session')
    return reply({ state, email: 'staff@demo.invalid', isOwner: owner });
  if (path.endsWith('csrf-token')) return reply({ token: 'synthetic-csrf' });
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
it('opens a nontechnical overview with real links without domain data requests', async () => {
  render(<AuthShell />);
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  expect(screen.getByRole('link', { name: 'Müşterilere git' }).getAttribute('href')).toBe(
    '/customers',
  );
  expect(screen.getByRole('link', { name: 'Bugünkü işleri aç' }).getAttribute('href')).toBe(
    '/today-work',
  );
  expect(screen.queryByText(/M1-T01|FAIL-CLOSED|INDIVIDUAL|Sistem Temeli/)).toBeNull();
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/auth/session']);
  expect(screen.getByText('staff@demo.invalid')).toBeTruthy();
});
it('navigates the existing customer workflow with browser history and direct-link refresh', async () => {
  window.history.replaceState(null, '', '/customers');
  render(<AuthShell />);
  await screen.findByRole('button', { name: '+ Yeni Müşteri' });
  fireEvent.click(screen.getByRole('link', { name: 'Genel Bakış' }));
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  expect(window.location.pathname).toBe('/');
  await act(async () => {
    window.history.back();
  });
  await screen.findByRole('button', { name: '+ Yeni Müşteri' });
  expect(window.location.pathname).toBe('/customers');
  await act(async () => {
    window.history.forward();
  });
  await screen.findByRole('heading', { name: 'Genel Bakış' });
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
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('link', { name: 'Müşteriler' }));
  await screen.findByRole('button', { name: '+ Yeni Müşteri' });
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
  fireEvent.click(await screen.findByRole('button', { name: 'Çıkış Yap' }));
  await screen.findByRole('button', { name: 'Giriş Yap' });
  await waitFor(() =>
    expect(fetcher.mock.calls.some((call) => call[0] === '/api/auth/logout')).toBe(true),
  );
  expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull();
});

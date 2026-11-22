// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AccountMenu } from '../src/app/components/layout/AccountMenu';
afterEach(cleanup);
it('keeps account commands hidden until opened, supports keyboard and restores focus on Escape', () => {
  const onLogout = vi.fn(),
    onReauth = vi.fn();
  render(
    <MemoryRouter>
      <AccountMenu
        session={{ state: 'NORMAL', email: 'synthetic@example.invalid', isOwner: true }}
        busy={false}
        onLogout={onLogout}
        onReauth={onReauth}
      />
    </MemoryRouter>,
  );
  const trigger = screen.getByRole('button', { name: 'Hesap menüsü' });
  expect(screen.queryByRole('menuitem', { name: 'Çıkış Yap' })).toBeNull();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Şifremi değiştir' }));
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Çıkış Yap' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(onLogout).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Şifremi doğrula' }));
  expect(onReauth).toHaveBeenCalledOnce();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
it('does not submit logout while busy and closes the fallback on an outside pointer', () => {
  const onLogout = vi.fn();
  render(
    <MemoryRouter>
      <AccountMenu
        session={{ state: 'NORMAL', email: 'synthetic@example.invalid', isOwner: false }}
        busy
        onLogout={onLogout}
        onReauth={() => {}}
      />
    </MemoryRouter>,
  );
  const trigger = screen.getByRole('button', { name: 'Hesap menüsü' });
  fireEvent.click(trigger);
  expect((screen.getByRole('menuitem', { name: 'Çıkış Yap' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menuitem', { name: 'Çıkış Yap' })).toBeNull();
  expect(onLogout).not.toHaveBeenCalled();
});

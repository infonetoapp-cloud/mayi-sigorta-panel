import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Header } from '../src/app/components/layout/Header';
afterEach(cleanup);
it('names the current daily work context instead of a generic workspace without duplicating search', () => {
  render(
    <MemoryRouter initialEntries={['/today-work']}>
      <Header
        session={{ email: 'sentetik@demo.invalid', isOwner: false, state: 'NORMAL' }}
        busy={false}
        mobileOpen={false}
        toggleRef={{ current: null }}
        onToggle={vi.fn()}
        onReauth={vi.fn()}
        onLogout={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('navigation', { name: 'Bulunduğunuz alan' }).textContent).toContain(
    'Bugünkü İşler',
  );
  expect(screen.getByRole('button', { name: 'Şifremi doğrula' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Çıkış Yap' })).toBeTruthy();
  expect(screen.queryAllByRole('searchbox')).toHaveLength(0);
});

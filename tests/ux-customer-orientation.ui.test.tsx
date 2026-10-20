import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import CompatibilityPage from '../src/app/pages/CompatibilityPage';
vi.mock('../src/app/App', () => ({
  App: ({ initialCustomerId }: { initialCustomerId?: string }) => (
    <div>Korunan işlem motoru: {initialCustomerId}</div>
  ),
}));
afterEach(cleanup);
it('orients advanced customer operations without replacing the existing engine or losing the profile return', () => {
  render(
    <MemoryRouter initialEntries={['/customers/customer-1/advanced']}>
      <Routes>
        <Route
          path="/customers/:customerId/advanced"
          element={<CompatibilityPage page="customers" customerMode="advanced" />}
        />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByRole('heading', { name: 'Atama, arşiv ve kimlik işlemleri' })).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Modern müşteri profiline dön' }).getAttribute('href'),
  ).toBe('/customers/customer-1');
  expect(screen.getByRole('link', { name: 'İletişim bilgilerine git' }).getAttribute('href')).toBe(
    '/customers/customer-1?section=contact',
  );
  expect(screen.getByText('Korunan işlem motoru: customer-1')).toBeTruthy();
});

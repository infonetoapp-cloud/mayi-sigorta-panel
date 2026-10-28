import { createRef } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { Sidebar } from '../src/app/components/layout/Sidebar';
afterEach(cleanup);
function Shell() {
  const location = useLocation();
  return (
    <>
      <Sidebar
        owner
        collapsed={false}
        mobileOpen={false}
        onClose={() => {}}
        onCollapse={() => {}}
        sidebarRef={createRef<HTMLElement>()}
      />
      <output aria-label="Konum">{location.pathname + location.search}</output>
    </>
  );
}
it('preserves server filters and exact cursor when switching modules without retaining protected page data', () => {
  render(
    <MemoryRouter initialEntries={['/policies?search=TEST&searchMode=prefix&cursor=opaque']}>
      <Shell />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Müşteriler' }));
  fireEvent.click(screen.getByRole('link', { name: 'Poliçeler' }));
  expect(screen.getByLabelText('Konum').textContent).toBe(
    '/policies?search=TEST&searchMode=prefix&cursor=opaque',
  );
});
it('discards remembered targets when the authenticated shell is replaced', () => {
  const view = render(
    <MemoryRouter initialEntries={['/policies?preview=record-A']}>
      <Shell key="user-a" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Müşteriler' }));
  view.rerender(
    <MemoryRouter>
      <Shell key="user-b" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Poliçeler' }));
  expect(screen.getByLabelText('Konum').textContent).toBe('/policies');
});

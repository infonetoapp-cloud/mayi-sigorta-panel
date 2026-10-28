import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { CustomerNoteWorkspace } from '../src/app/pages/customers/CustomerNoteWorkspace';
afterEach(cleanup);
function Destination() {
  const route = useLocation();
  return <output aria-label="Hedef bağlamı">{JSON.stringify(route.state)}</output>;
}
function setup(unresolved = false) {
  const proceed = vi.fn(),
    clicked = vi.fn();
  const risk = { current: { contact: { dirty: true, unresolved } } };
  render(
    <MemoryRouter initialEntries={['/customers/a']}>
      <Routes>
        <Route
          path="/customers/a"
          element={
            <>
              <button
                onClick={() =>
                  document.dispatchEvent(
                    new CustomEvent('mayi-logout-requested', {
                      cancelable: true,
                      detail: { proceed },
                    }),
                  )
                }
              >
                Çıkış Yap
              </button>
              <Link
                to="/done"
                state={{ workContext: 'saved-task-context', other: 'preserve-me' }}
                onClick={clicked}
              >
                Seçili takibe dön
              </Link>
              <CustomerNoteWorkspace
                customerId="a"
                archived={false}
                visible={false}
                loadNotes={false}
                externalRisk={risk}
              />
            </>
          }
        />
        <Route path="/done" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  return { proceed, clicked };
}
it('asks before user logout and invokes the original command only after explicit discard', async () => {
  const { proceed } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  await screen.findByRole('dialog');
  expect(proceed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect(proceed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Taslağı bırak ve ayrıl' }));
  expect(proceed).toHaveBeenCalledTimes(1);
});
it('does not offer logout discard while any customer write is uncertain', async () => {
  const { proceed } = setup(true);
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  await screen.findByText(/İşlemin sonucu henüz kesinleşmedi/);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(proceed).not.toHaveBeenCalled();
});
it('replays the original Link once so route state and contextual onClick survive discard approval', async () => {
  const { clicked } = setup();
  fireEvent.click(screen.getByRole('link', { name: 'Seçili takibe dön' }));
  await screen.findByRole('dialog');
  expect(clicked).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Taslağı bırak ve ayrıl' }));
  expect((await screen.findByLabelText('Hedef bağlamı')).textContent).toBe(
    JSON.stringify({ workContext: 'saved-task-context', other: 'preserve-me' }),
  );
  expect(clicked).toHaveBeenCalledTimes(1);
});

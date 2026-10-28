import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import CompatibilityPage from '../src/app/pages/CompatibilityPage';
import PolicyLegacyPage from '../src/app/pages/policies/PolicyLegacyPage';
vi.mock('../src/app/App', () => ({ App: () => null }));
vi.mock('../src/app/components/PolicyPanel', () => ({ PolicyPanel: () => null }));
afterEach(cleanup);
const state = {
  workReturn: 'saved-work',
  policyListReturn: '/policies?search=V4&cursor=page-two&preview=p1',
};
function Destination() {
  const route = useLocation();
  return (
    <output aria-label="Legacy dönüşü">
      {JSON.stringify({ url: route.pathname + route.search, state: route.state })}
    </output>
  );
}
it('preserves work and portfolio context when leaving advanced customer operations', async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/customers/c1/advanced', state }]}>
      <Routes>
        <Route
          path="/customers/:customerId/advanced"
          element={<CompatibilityPage page="customers" customerMode="advanced" />}
        />
        <Route path="/customers/:customerId" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Modern müşteri profiline dön' }));
  expect(JSON.parse((await screen.findByLabelText('Legacy dönüşü')).textContent!).state).toEqual(
    state,
  );
});
it('returns from classic policy operations to the exact authorized portfolio location and context', async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/policies/legacy', state }]}>
      <Routes>
        <Route path="/policies/legacy" element={<PolicyLegacyPage />} />
        <Route path="/policies" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Modern poliçe listesine dön' }));
  expect(JSON.parse((await screen.findByLabelText('Legacy dönüşü')).textContent!)).toEqual({
    url: state.policyListReturn,
    state,
  });
});

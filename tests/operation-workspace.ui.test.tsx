// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  OperationSelector,
  OperationPanel,
} from '../src/app/components/workspace/OperationWorkspace';
afterEach(cleanup);
it('replaces the visible region while retaining an inactive risky draft and its exact DOM', () => {
  function Example() {
    const [active, setActive] = useState('communication');
    return (
      <>
        <OperationSelector
          active={active}
          onChange={setActive}
          items={[
            { id: 'communication', label: 'İletişim', risk: true },
            { id: 'quotes', label: 'Teklifler' },
          ]}
        />
        <OperationPanel id="communication" title="İletişim" active={active === 'communication'}>
          <label>
            Korunan not
            <input defaultValue="taslak" />
          </label>
        </OperationPanel>
        <OperationPanel id="quotes" title="Teklifler" active={active === 'quotes'}>
          <p>Teklif alanı</p>
        </OperationPanel>
      </>
    );
  }
  render(<Example />);
  const field = screen.getByLabelText('Korunan not');
  fireEvent.change(field, { target: { value: 'A müşterisinin taslağı' } });
  fireEvent.click(screen.getByRole('button', { name: 'Teklifler' }));
  expect(screen.queryByRole('textbox', { name: 'Korunan not' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Teklifler' })).toBeTruthy();
  expect(screen.getByText('İşlem korunuyor')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim' }));
  expect(screen.getByLabelText('Korunan not')).toBe(field);
  expect((field as HTMLInputElement).value).toBe('A müşterisinin taslağı');
});
it('provides keyboard focus movement without changing the operation until activation', () => {
  const change = vi.fn();
  render(
    <OperationSelector
      active="a"
      onChange={change}
      items={[
        { id: 'a', label: 'İletişim' },
        { id: 'b', label: 'Teklifler' },
      ]}
    />,
  );
  const first = screen.getByRole('button', { name: 'İletişim' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Teklifler' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Teklifler' }));
  expect(change).toHaveBeenCalledWith('b');
});

import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import {
  LegacyCustomerBoundary,
  useLegacyCustomerRisk,
  requestLegacyCustomerClose,
} from '../src/app/components/LegacyCustomerBoundary';
afterEach(cleanup);
function Probe({ held = false }: { held?: boolean }) {
  const [value, setValue] = useState('');
  useLegacyCustomerRisk(value !== '', held);
  return (
    <>
      <input
        aria-label="Müşteri taslağı"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button onClick={requestLegacyCustomerClose}>Kapat</button>
    </>
  );
}
it('names the legacy dialog, traps Tab and closes cleanly on Escape', () => {
  const close = vi.fn();
  render(
    <LegacyCustomerBoundary title="Sentetik müşteri" onClose={close}>
      <Probe />
    </LegacyCustomerBoundary>,
  );
  const d = screen.getByRole('dialog', { name: 'Sentetik müşteri' });
  expect(document.activeElement).toBe(d);
  fireEvent.keyDown(d, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByLabelText('Müşteri taslağı'));
  screen.getByRole('button', { name: 'Kapat' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByLabelText('Müşteri taslağı'));
  fireEvent.keyDown(d, { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
});
it('retains dirty nested drafts until the explicit leave decision', async () => {
  const close = vi.fn();
  render(
    <LegacyCustomerBoundary title="Sentetik müşteri" onClose={close}>
      <Probe />
    </LegacyCustomerBoundary>,
  );
  fireEvent.change(screen.getByLabelText('Müşteri taslağı'), { target: { value: 'taslak' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
  await screen.findByRole('button', { name: 'Bu ekranda kal' });
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect((screen.getByLabelText('Müşteri taslağı') as HTMLInputElement).value).toBe('taslak');
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Sentetik müşteri' }), { key: 'Escape' });
  fireEvent.click(await screen.findByRole('button', { name: 'Taslakları bırak ve ayrıl' }));
  expect(close).toHaveBeenCalledTimes(1);
});
it('blocks both parent close and Escape for an unresolved nested request', async () => {
  const close = vi.fn();
  render(
    <LegacyCustomerBoundary title="Sentetik müşteri" onClose={close}>
      <Probe held />
    </LegacyCustomerBoundary>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
  await screen.findByRole('alert');
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Sentetik müşteri' }), { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Taslakları bırak ve ayrıl' })).toBeNull();
});
it('protects a root company-contact write as well as nested sections', async () => {
  const close = vi.fn();
  render(
    <LegacyCustomerBoundary
      title="Şirket"
      onClose={close}
      externalRisk={{ dirty: false, unresolved: true }}
    >
      <Probe />
    </LegacyCustomerBoundary>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
  await screen.findByRole('alert');
  expect(close).not.toHaveBeenCalled();
});

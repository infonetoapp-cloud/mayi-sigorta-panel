// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RecordDetails } from '../src/app/components/workspace/RecordDetails';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('opens a dedicated record view, retains its DOM and returns focus to its trigger', () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
  render(
    <RecordDetails title="Teklif geçmişi">
      <p>Değişmez sürüm</p>
    </RecordDetails>,
  );
  const original = screen.getByText('Değişmez sürüm');
  const trigger = screen.getByRole('button', { name: 'Teklif geçmişi' });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Teklif geçmişi' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ayrıntıları kapat' }));
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(screen.getByText('Değişmez sürüm')).toBe(original);
});

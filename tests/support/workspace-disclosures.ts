import { fireEvent, screen } from '@testing-library/react';

// jsdom lacks the browser's dialog methods; real focus trapping is checked in Edge.
if (!HTMLDialogElement.prototype.showModal)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
if (!HTMLDialogElement.prototype.close)
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });

export function openWorkspaceSection(title: string) {
  const control = screen.getByRole('button', { name: title });
  if (control.getAttribute('aria-pressed') !== 'true') fireEvent.click(control);
}

/** Existing terminal fixtures start at outcomes; no eager tour through other operations. */
export function openWorkspaceSections() {
  openWorkspaceSection('Yenileme sonucu');
}

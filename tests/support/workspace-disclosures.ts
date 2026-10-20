import { fireEvent, screen } from '@testing-library/react';

/** Explicit user disclosure actions before the existing protocol/guard regressions. */
export function openWorkspaceSections() {
  for (const title of ['Görev işlemleri', 'Teklifler', 'Yenileme sonucu']) {
    const control = screen.queryByRole('button', { name: title });
    if (control?.getAttribute('aria-expanded') === 'false') fireEvent.click(control);
  }
  const advanced = screen.queryByText('Diğer yenileme işlemleri', { selector: 'summary' });
  if (advanced && !advanced.closest('details')?.open) fireEvent.click(advanced);
}

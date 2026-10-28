import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthShell } from '../src/app/AuthShell';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('offers an accessible password visibility control without changing the credential or exposing signup', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 401 })),
  );
  render(<AuthShell />);
  const password = (await screen.findByLabelText('Şifre', { exact: true })) as HTMLInputElement;
  fireEvent.change(password, { target: { value: 'synthetic visibility fixture' } });
  const toggle = screen.getByRole('button', { name: 'Şifreyi göster' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  expect(password.type).toBe('text');
  expect(password.value).toBe('synthetic visibility fixture');
  fireEvent.click(screen.getByRole('button', { name: 'Şifreyi gizle' }));
  expect(password.type).toBe('password');
  expect(password.autocomplete).toBe('current-password');
  expect(screen.queryByRole('link', { name: /kayıt ol|google|apple|şifremi unuttum/i })).toBeNull();
});

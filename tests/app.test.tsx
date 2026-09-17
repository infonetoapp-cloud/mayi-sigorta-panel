import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../src/app/App';

describe('İstemci Temel Bileşeni (Client Baseline Component Tests)', () => {
  it('App bileşeni sorunsuz render olmalı ve sistem başlığını göstermelidir', () => {
    render(<App />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe('Mayı Sigorta CRM');

    const statusBadge = screen.getByText('Sistem Temeli Aktif (M1-T01)');
    expect(statusBadge).toBeDefined();
  });
});

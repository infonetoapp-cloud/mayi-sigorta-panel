import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthShell } from './AuthShell';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Kök HTML elementi bulunamadı (#root).');
}

const root = createRoot(container);

root.render(
  <StrictMode>
    <AuthShell />
  </StrictMode>,
);

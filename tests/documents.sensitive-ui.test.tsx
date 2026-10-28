import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { DocumentSection } from '../src/app/components/DocumentSection';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const reply = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'content-type': 'application/json' },
  });
it('downloads a normal document through the authorized endpoint without a sensitive grant', async () => {
  const seen: string[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:synthetic'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      seen.push(path);
      if (path.startsWith('/api/documents?'))
        return reply({
          documents: [
            {
              documentId: 'normal-id',
              fileName: 'normal.pdf',
              classification: 'GENERAL',
              status: 'READY',
              createdAt: '2026-10-13T18:00:00.000Z',
              sizeBytes: 4,
              downloadMode: 'NORMAL',
            },
          ],
          nextCursor: null,
        });
      if (path === '/api/auth/csrf-token') return reply({ token: 'synthetic-csrf' });
      if (path === '/api/documents/normal-id/download') return new Response('synthetic');
      throw Error('unexpected');
    }),
  );
  render(<DocumentSection ownerType="CUSTOMER" ownerId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'İndir' }));
  await screen.findByText('İndirme başlatıldı.');
  expect(seen.filter((p) => p.endsWith('/download'))).toHaveLength(1);
  expect(
    seen.some((p) => p.includes('/secure/') || p.includes('grant') || p.includes('reauth')),
  ).toBe(false);
});
it('reauthenticates then requires explicit confirmation before a sensitive single-use download', async () => {
  const sequence: string[] = [];
  let grants = 0;
  const token = 'a'.repeat(64),
    hash = 'b'.repeat(64);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:synthetic'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      sequence.push(path);
      if (path.startsWith('/api/documents?'))
        return reply({
          documents: [
            {
              documentId: 'sensitive-id',
              fileName: 'sensitive.pdf',
              classification: 'IDENTITY',
              status: 'READY',
              createdAt: '2026-10-13T18:00:00.000Z',
              sizeBytes: 4,
              downloadMode: 'SENSITIVE',
            },
          ],
          nextCursor: null,
        });
      if (path === '/api/auth/csrf-token') return reply({ token: 'csrf-' + sequence.length });
      if (path === '/api/auth/reauth') return reply({ state: 'NORMAL' });
      if (path.endsWith('/download-confirmation'))
        return reply({
          documentId: 'sensitive-id',
          expectedVersion: 2,
          versionId: 'internal-version',
          checksum: hash,
          classification: 'IDENTITY',
          parentHealth: false,
          confirmationText: 'Bu belgeyi yalnız yetkili iş amacı için indiriyorum.',
        });
      if (path.endsWith('/download-grants')) {
        grants++;
        expect(JSON.parse(String(init?.body)).confirmation).toBe('DOWNLOAD_SENSITIVE_DOCUMENT');
        return reply({ grantEvidenceToken: token });
      }
      if (path.endsWith('/download')) {
        expect(JSON.parse(String(init?.body)).grantEvidenceToken === token).toBe(true);
        return new Response('synthetic', { headers: { 'content-type': 'application/pdf' } });
      }
      throw Error('unexpected');
    }),
  );
  render(<DocumentSection ownerType="CUSTOMER" ownerId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'İndir' }));
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: 'synthetic passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
  await screen.findByRole('dialog', { name: 'Hassas belge indirme onayı' });
  expect(grants).toBe(0);
  expect(document.body.textContent?.includes(hash)).toBe(false);
  expect(document.body.textContent?.includes(token)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Onaylıyorum, indir' }));
  await screen.findByText('İndirme başlatıldı.');
  expect(grants).toBe(1);
  expect(sequence.filter((p) => p.endsWith('/download'))).toHaveLength(1);
});

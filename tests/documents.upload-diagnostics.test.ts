import { afterEach, expect, it, vi } from 'vitest';
import { emitDocumentUploadDiagnostic } from '../src/server/documents/upload-diagnostics';

afterEach(() => vi.restoreAllMocks());
it('identifies the fixed timestamp-order constraint without emitting timestamps or SQL', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  emitDocumentUploadDiagnostic(
    'FINALIZE_BATCH',
    'FAIL',
    new Error('D1_ERROR: CHECK constraint failed: updated_at >= created_at'),
  );
  expect(log.mock.calls[0]?.[0]).toEqual({
    kind: 'document_upload_phase_v1',
    phase: 'FINALIZE_BATCH',
    event: 'FAIL',
    code: 'TIMESTAMP_ORDER',
  });
});
it('retains only fixed phase/event/code, never raw exception or nested sensitive data', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  emitDocumentUploadDiagnostic(
    'FINALIZE_BATCH',
    'FAIL',
    new Error('D1_ERROR: UNIQUE constraint failed: private-secret'),
  );
  expect(log).toHaveBeenCalledExactlyOnceWith({
    kind: 'document_upload_phase_v1',
    phase: 'FINALIZE_BATCH',
    event: 'FAIL',
    code: 'SQLITE_UNIQUE',
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-secret');
});
it('reports a nested D1 cause without forwarding arbitrary fields', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  emitDocumentUploadDiagnostic(
    'FINALIZE_BATCH',
    'FAIL',
    new Error('D1_ERROR', { cause: new Error('DOCUMENT_UPLOAD_VERSION_STATE_RACE opaque') }),
  );
  expect(log.mock.calls[0]?.[0]).toEqual({
    kind: 'document_upload_phase_v1',
    phase: 'FINALIZE_BATCH',
    event: 'FAIL',
    code: 'UPLOAD_VERSION_RACE',
  });
});
it('cannot change control flow when hostile errors or logging fail', () => {
  vi.spyOn(console, 'info').mockImplementation(() => {
    throw new Error('logger failure');
  });
  const error = new Proxy(
    {},
    {
      get() {
        throw new Error('private');
      },
    },
  );
  expect(() => emitDocumentUploadDiagnostic('DO_RUNTIME', 'FAIL', error)).not.toThrow();
});
it('uses a closed allowlist even for oversized attacker-controlled messages', () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  emitDocumentUploadDiagnostic('R2_PUT', 'FAIL', new Error('secret'.repeat(2000)));
  expect(log.mock.calls[0]?.[0]).toEqual({
    kind: 'document_upload_phase_v1',
    phase: 'R2_PUT',
    event: 'FAIL',
    code: 'UNKNOWN',
  });
});

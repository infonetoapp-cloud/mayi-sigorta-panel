export type UploadDiagnosticPhase =
  | 'PREPARE'
  | 'RESERVE_BATCH'
  | 'R2_CHECKSUM'
  | 'R2_PUT'
  | 'FINALIZE_BATCH'
  | 'DO_RUNTIME'
  | 'EDGE_DISPATCH';
export type UploadDiagnosticEvent = 'START' | 'OK' | 'FAIL';

function safeCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 3; depth++) {
    try {
      if (!(current instanceof Error)) break;
      const message = current.message.slice(0, 2048);
      const codes = [
        ['CHECK constraint failed: updated_at >= created_at', 'TIMESTAMP_ORDER'],
        ['DOCUMENT_UPLOAD_AUTHORIZATION_RACE', 'UPLOAD_AUTHORITY_RACE'],
        ['DOCUMENT_UPLOAD_VERSION_STATE_RACE', 'UPLOAD_VERSION_RACE'],
        ['DOCUMENT_UPLOAD_RECEIPT_RACE', 'UPLOAD_RECEIPT_RACE'],
        ['UNIQUE constraint failed', 'SQLITE_UNIQUE'],
        ['CHECK constraint failed', 'SQLITE_CHECK'],
        ['FOREIGN KEY constraint failed', 'SQLITE_FOREIGN_KEY'],
        ['too many SQL variables', 'SQL_PARAMETER_LIMIT'],
        ['Too many API requests', 'SUBREQUEST_LIMIT'],
        ['overloaded', 'PROVIDER_OVERLOADED'],
        ['DOCUMENT_ADMISSION_CLOSED', 'ADMISSION_CLOSED'],
        ['DOCUMENT_UPLOAD_CLOSED', 'RUNTIME_CLOSED'],
      ] as const;
      for (const [needle, code] of codes) if (message.includes(needle)) return code;
      current = current.cause;
    } catch {
      break;
    }
  }
  return 'UNKNOWN';
}

/** Fixed enum-only custody. Never emit exceptions, SQL, IDs, headers or payloads. */
export function emitDocumentUploadDiagnostic(
  phase: UploadDiagnosticPhase,
  event: UploadDiagnosticEvent,
  error?: unknown,
): void {
  try {
    console.info({
      kind: 'document_upload_phase_v1',
      phase,
      event,
      code: event === 'FAIL' ? safeCode(error) : 'NONE',
    });
  } catch {
    // Observability must not change authorization, finalization or error behavior.
  }
}

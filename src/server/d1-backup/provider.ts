export type DiagnosticStage =
  | 'export-start'
  | 'export-poll'
  | 'download'
  | 'storage-write'
  | 'storage-verify'
  | 'workflow-step'
  | 'cron-create';
export type Classification =
  | 'progress'
  | 'complete'
  | 'api-error'
  | 'http-error'
  | 'malformed'
  | 'missing-bookmark'
  | 'missing-url'
  | 'transport'
  | 'unexpected-redirect'
  | 'invalid-json'
  | 'provider-error'
  | 'poll-limit'
  | 'invalid-url'
  | 'invalid-length'
  | 'sql-size-limit-exceeded'
  | 'gzip-size-limit-exceeded'
  | 'verification-failed'
  | 'local-failure';
export interface SafeDiagnostic {
  errorName?: string;
  transportClass?: string;
  stage: DiagnosticStage;
  httpStatus: number | null;
  success: boolean | null;
  errorCodes: number[];
  classification: Classification;
  attempt: number;
  elapsedMs: number;
}
export class BackupFailure extends Error {
  constructor(readonly diagnostic: SafeDiagnostic) {
    super('BACKUP_FAILED ' + JSON.stringify(diagnostic));
    this.name = 'BackupFailure';
  }
}
export function safeFailure(
  stage: DiagnosticStage,
  classification: Classification,
  attempt = 1,
  elapsedMs = 0,
  httpStatus: number | null = null,
  success: boolean | null = null,
  errorCodes: number[] = [],
): BackupFailure {
  return new BackupFailure({
    stage,
    classification,
    attempt,
    elapsedMs: Math.max(0, elapsedMs),
    httpStatus,
    success,
    errorCodes,
  });
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function bookmark(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : undefined;
}
export type ExportState =
  | { kind: 'progress'; bookmark: string }
  | { kind: 'complete'; bookmark: string | undefined; signedUrl: string };
// Official API: status is optional; Wrangler carries response.at_bookmark into the next request.
// Provider messages/error strings are deliberately never copied: they can echo URLs or credentials.
export function parseExportResponse(
  body: unknown,
  httpStatus: number,
  stage: 'export-start' | 'export-poll',
  attempt: number,
  elapsedMs: number,
  previousBookmark?: string,
): ExportState {
  const envelope = object(body),
    result = object(envelope?.result);
  const success = typeof envelope?.success === 'boolean' ? envelope.success : null;
  const codes = Array.isArray(envelope?.errors)
    ? envelope.errors
        .slice(0, 8)
        .map(object)
        .map((e) => e?.code)
        .filter((c): c is number => typeof c === 'number' && Number.isSafeInteger(c) && c >= 0)
    : [];
  const fail = (classification: Classification): never => {
    throw safeFailure(stage, classification, attempt, elapsedMs, httpStatus, success, codes);
  };
  if (httpStatus < 200 || httpStatus >= 300) fail('http-error');
  if (envelope?.errors !== undefined && !Array.isArray(envelope.errors)) fail('malformed');
  if (
    success === false ||
    result?.success === false ||
    (Array.isArray(envelope?.errors) && envelope.errors.length > 0)
  )
    fail('api-error');
  if (success !== true || !result) return fail('malformed');
  if (result.success !== undefined && typeof result.success !== 'boolean') fail('malformed');
  if (result.status === 'error') fail('provider-error');
  if (result.status !== undefined && result.status !== 'complete' && result.status !== 'active')
    fail('malformed');
  const next = bookmark(result.at_bookmark) ?? bookmark(result.current_bookmark);
  if (result.status === 'complete') {
    const signedUrl = object(result.result)?.signed_url;
    if (typeof signedUrl !== 'string' || signedUrl.length === 0) return fail('missing-url');
    const completedBookmark = next ?? bookmark(previousBookmark);

    return { kind: 'complete', bookmark: completedBookmark, signedUrl };
  }
  if (!next) return fail('missing-bookmark');
  return { kind: 'progress', bookmark: next };
}

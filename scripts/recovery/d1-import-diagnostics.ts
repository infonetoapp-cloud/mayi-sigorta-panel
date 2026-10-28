import { createHash } from 'node:crypto';

// Passive recovery diagnostics only: no HTTP client, credentials, target, SQL
// executor or retry capability. Sanitize BEFORE persistence or agent output.
export class ImportDiagnosticFailure extends Error {}
const fail = (code: string): never => {
  throw new ImportDiagnosticFailure(code);
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const keywords = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'TABLE',
  'INDEX',
  'TRIGGER',
  'VIEW',
  'PRAGMA',
  'VALUES',
  'WITH',
  'FROM',
  'WHERE',
  'BEGIN',
  'END',
  'COMMIT',
  'ROLLBACK',
  'DEFAULT',
  'ON',
  'OFF',
  'FOREIGN',
  'KEY',
  'IF',
  'NOT',
  'EXISTS',
  'AS',
  'CASE',
  'UNIQUE',
  'AUTOINCREMENT',
]);
export interface SafeImportDiagnostic {
  rawDiagnosticSha256: string;
  category: string;
  safeText: string | null;
  objectIdentifier: string | null;
  statementOrdinal: number | null;
  redacted: boolean;
}
export function sanitizeImportDiagnostic(
  raw: string,
  knownIdentifiers: ReadonlySet<string> = new Set(),
): SafeImportDiagnostic {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536)
    return fail('DIAGNOSTIC_TEXT_LIMIT');
  const result: SafeImportDiagnostic = {
    rawDiagnosticSha256: sha(raw),
    category: 'REDACTED_PROVIDER_MESSAGE',
    safeText: null,
    objectIdentifier: null,
    statementOrdinal: null,
    redacted: true,
  };
  try {
    const flags = object(JSON.parse(raw));
    if (flags && Object.keys(flags).length === 1 && flags.D1_RESET_DO === true)
      return {
        ...result,
        category: 'D1_RESET_DO',
        safeText: '{"D1_RESET_DO":true}',
        redacted: false,
      };
  } catch {
    /* Only this observed machine flag is an approved Boolean envelope. */
  }
  const patterns: Array<[string, RegExp]> = [
    ['MISSING_TABLE', /no such table: ((?:main\.)?[a-z_][a-z0-9_]*)/iu],
    ['MISSING_COLUMN', /no such column: ((?:main\.)?[a-z_][a-z0-9_.]*)/iu],
    ['FOREIGN_KEY_MISMATCH', /foreign key mismatch/iu],
    ['FOREIGN_KEY', /FOREIGN KEY constraint failed/iu],
    ['UNIQUE_CONSTRAINT', /UNIQUE constraint failed/iu],
    ['CHECK_CONSTRAINT', /CHECK constraint failed/iu],
    ['STATEMENT_TOO_LONG', /statement too long/iu],
    ['SYNTAX', /near ["']([A-Za-z_]+)["']: syntax error/iu],
    ['NOT_AUTHORIZED', /not authorized/iu],
    ['SQLITE_AUTH', /SQLITE_AUTH/u],
    ['SQLITE_ERROR', /SQLITE_ERROR/u],
  ];
  for (const [category, pattern] of patterns) {
    const m = pattern.exec(raw);
    if (!m) continue;
    result.category = category;
    if (category === 'MISSING_TABLE' || category === 'MISSING_COLUMN') {
      const name = m[1]!;
      if (!knownIdentifiers.has(name.replace(/^main\./u, ''))) break;
      result.objectIdentifier = name;
    }
    if (category === 'SYNTAX' && !keywords.has(m[1]!.toUpperCase())) break;
    // Closed error grammar substring only, never the original SQL/literal suffix.
    result.safeText = m[0];
    result.redacted = raw.trim() !== m[0];
    break;
  }
  const ordinal = /\b(?:statement|query)\s*(?:number|#|ordinal)?\s*[:=]?\s*(\d{1,7})\b/iu.exec(raw);
  if (ordinal) result.statementOrdinal = Number(ordinal[1]);
  return result;
}
const bookmark = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(v)) return fail('BOOKMARK_INVALID');
  return v;
};
export interface SafeImportResponse {
  phase: 'init' | 'ingest' | 'poll';
  httpStatus: number;
  topSuccess: boolean;
  providerCodes: number[];
  providerStatus: string | null;
  terminal: 'complete' | 'error' | null;
  terminalEvidence: 'PROVIDER_STATUS' | 'RESULT_FAILURE_WITH_ERROR' | null;
  resultSuccess: boolean | null;
  atBookmark: string | null;
  finalBookmark: string | null;
  error: SafeImportDiagnostic | null;
  messages: SafeImportDiagnostic[];
  topDiagnostics: SafeImportDiagnostic[];
  numQueries: number | null;
  meta: Record<string, number | boolean>;
}
export function parseD1ImportResponse(
  httpStatus: number,
  payload: unknown,
  phase: SafeImportResponse['phase'],
  knownIdentifiers: ReadonlySet<string> = new Set(),
): SafeImportResponse {
  const p = object(payload);
  if (
    !p ||
    typeof p.success !== 'boolean' ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 100 ||
    httpStatus > 599
  )
    return fail('PROVIDER_RESPONSE_INVALID');
  const r: SafeImportResponse = {
    phase,
    httpStatus,
    topSuccess: p.success,
    providerCodes: [],
    providerStatus: null,
    terminal: null,
    terminalEvidence: null,
    resultSuccess: null,
    atBookmark: null,
    finalBookmark: null,
    error: null,
    messages: [],
    topDiagnostics: [],
    numQueries: null,
    meta: {},
  };
  for (const field of ['errors', 'messages']) {
    const entries = p[field] ?? [];
    if (!Array.isArray(entries) || entries.length > 100) return fail('PROVIDER_RESPONSE_INVALID');
    for (const entry of entries) {
      if (typeof entry === 'string') {
        r.topDiagnostics.push(sanitizeImportDiagnostic(entry, knownIdentifiers));
        continue;
      }
      const e = object(entry);
      if (!e) return fail('PROVIDER_RESPONSE_INVALID');
      if (e.code !== undefined) {
        if (typeof e.code !== 'number' || !Number.isSafeInteger(e.code))
          return fail('PROVIDER_RESPONSE_INVALID');
        r.providerCodes.push(e.code);
      }
      if (e.message !== undefined) {
        if (typeof e.message !== 'string') return fail('PROVIDER_RESPONSE_INVALID');
        r.topDiagnostics.push(sanitizeImportDiagnostic(e.message, knownIdentifiers));
      }
    }
  }
  if (p.result === null && p.success === false) return r; // Preserve HTTP rejection diagnostics.
  const value = object(p.result);
  if (!value) return fail('PROVIDER_RESPONSE_INVALID');
  const state = value.status;
  if (
    state !== undefined &&
    state !== null &&
    !['complete', 'error', 'active', 'running', 'processing', 'uploading'].includes(String(state))
  )
    return fail('PROVIDER_RESPONSE_INVALID');
  if (value.success !== undefined && typeof value.success !== 'boolean')
    return fail('PROVIDER_RESPONSE_INVALID');
  r.providerStatus = typeof state === 'string' ? state : null;
  r.resultSuccess = typeof value.success === 'boolean' ? value.success : null;
  r.atBookmark = bookmark(value.at_bookmark);
  if (value.error !== undefined) {
    if (typeof value.error !== 'string') return fail('PROVIDER_RESPONSE_INVALID');
    r.error = sanitizeImportDiagnostic(value.error, knownIdentifiers);
  }
  const messages = value.messages ?? [];
  if (
    !Array.isArray(messages) ||
    messages.length > 100 ||
    messages.some((v) => typeof v !== 'string')
  )
    return fail('PROVIDER_RESPONSE_INVALID');
  r.messages = messages.map((v) => sanitizeImportDiagnostic(v, knownIdentifiers));
  const nested = value.result === undefined ? {} : object(value.result);
  if (!nested) return fail('PROVIDER_RESPONSE_INVALID');
  r.finalBookmark = bookmark(nested.final_bookmark);
  const meta = nested.meta === undefined ? {} : object(nested.meta);
  if (!meta) return fail('PROVIDER_RESPONSE_INVALID');
  for (const k of [
    'changed_db',
    'changes',
    'duration',
    'rows_read',
    'rows_written',
    'size_after',
  ]) {
    const v = meta[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) r.meta[k] = v;
  }
  if (nested.num_queries !== undefined) {
    if (
      typeof nested.num_queries !== 'number' ||
      !Number.isSafeInteger(nested.num_queries) ||
      nested.num_queries < 0
    )
      return fail('PROVIDER_RESPONSE_INVALID');
    r.numQueries = nested.num_queries;
  }
  if (state === 'complete') {
    if (
      value.success !== true ||
      r.error !== null ||
      (Array.isArray(p.errors) && p.errors.length > 0) ||
      r.numQueries === null ||
      !p.success ||
      httpStatus < 200 ||
      httpStatus >= 300
    )
      return fail('TERMINAL_COMPLETE_INVALID');
    r.terminal = 'complete';
    r.terminalEvidence = 'PROVIDER_STATUS';
  } else if (state === 'error') {
    if (value.success === true) return fail('TERMINAL_ERROR_INVALID');
    if (!r.error) return fail('TERMINAL_ERROR_MISSING');
    r.terminal = 'error';
    r.terminalEvidence = 'PROVIDER_STATUS';
  } else if (r.providerStatus === null && value.success === false && r.error) {
    // Observed real API variant: status/bookmark absent, failure/error present.
    // Do not fabricate status=error or a bookmark; record the inference explicitly.
    r.terminal = 'error';
    r.terminalEvidence = 'RESULT_FAILURE_WITH_ERROR';
  } else if (phase !== 'init' && r.providerStatus === null) return fail('IMPORT_STATUS_MISSING');
  return r;
}
export function requirePollBookmark(
  record: SafeImportResponse,
  now: number,
  pollCount: number,
  deadline: number,
): string {
  if (record.terminal) return fail('IMPORT_ALREADY_TERMINAL');
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(deadline) ||
    !Number.isInteger(pollCount) ||
    pollCount < 0 ||
    now > deadline ||
    pollCount >= 60
  )
    return fail('POLL_TIMEOUT');
  if (!record.atBookmark) return fail('POLL_BOOKMARK_MISSING');
  return record.atBookmark;
}
export function verifyD1UploadEtag(expectedMD5: string, received: unknown) {
  if (
    !/^[a-f0-9]{32}$/u.test(expectedMD5) ||
    typeof received !== 'string' ||
    received.replace(/^"|"$/gu, '').toLowerCase() !== expectedMD5
  )
    return fail('UPLOAD_ETAG_MISMATCH');
}

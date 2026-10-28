// @vitest-environment node
import { expect, it } from 'vitest';
import {
  parseD1ImportResponse,
  sanitizeImportDiagnostic,
  requirePollBookmark,
  verifyD1UploadEtag,
} from '../scripts/recovery/d1-import-diagnostics';
const envelope = (result: unknown) => ({ success: true, errors: [], messages: [], result });

it('captures the real statusless D1_RESET_DO failure without inventing a provider status or bookmark', () => {
  const raw = JSON.stringify({ D1_RESET_DO: true });
  const record = parseD1ImportResponse(200, envelope({ success: false, error: raw }), 'ingest');
  expect(record.terminal).toBe('error');
  expect(record.providerStatus).toBe(null);
  expect(record.terminalEvidence).toBe('RESULT_FAILURE_WITH_ERROR');
  expect(record.error?.category).toBe('D1_RESET_DO');
  expect(record.error?.safeText === raw).toBe(true);
  expect(record.atBookmark).toBe(null);
  expect(() => requirePollBookmark(record, 0, 0, 1)).toThrow('IMPORT_ALREADY_TERMINAL');
});
it('validates a complete result and keeps safe counts/meta separate from diagnostics', () => {
  const r = parseD1ImportResponse(
    200,
    envelope({
      status: 'complete',
      success: true,
      messages: [],
      result: {
        num_queries: 12,
        final_bookmark: 'safe-bookmark',
        meta: { rows_written: 4, size_after: 1000, private_field: 'not-output' },
      },
    }),
    'poll',
  );
  expect(r.terminal).toBe('complete');
  expect(r.numQueries).toBe(12);
  expect(Object.keys(r.meta)).toEqual(['rows_written', 'size_after']);
});
it('preserves exact known missing-table and FK messages', () => {
  expect(sanitizeImportDiagnostic('no such table: main.users', new Set(['users'])).safeText).toBe(
    'no such table: main.users',
  );
  expect(sanitizeImportDiagnostic('FOREIGN KEY constraint failed').safeText).toBe(
    'FOREIGN KEY constraint failed',
  );
});
it('redacts SQL VALUES while retaining a safe category and raw diagnostic fingerprint', () => {
  const opaque = ['fixture', 'only', 'value'].join('-');
  const raw = `no such table: main.users; INSERT INTO users VALUES('${opaque}')`;
  const r = sanitizeImportDiagnostic(raw, new Set(['users']));
  expect(r.category).toBe('MISSING_TABLE');
  expect(r.redacted).toBe(true);
  expect(JSON.stringify(r).includes(opaque)).toBe(false);
  expect(JSON.stringify(r).includes('INSERT INTO')).toBe(false);
  expect(r.rawDiagnosticSha256.length).toBe(64);
});
it('never stores long hex, blob-like material, signed URL or unknown quoted literals', () => {
  const material = 'ab'.repeat(64);
  for (const raw of [
    material,
    `X'${material}'`,
    'https://storage.example/object?signature=fixture-only',
    `near "${material}": syntax error`,
  ]) {
    const r = sanitizeImportDiagnostic(raw);
    expect(r.redacted).toBe(true);
    expect(JSON.stringify(r).includes(raw)).toBe(false);
    expect(JSON.stringify(r).includes(material)).toBe(false);
  }
});
it('does not mistake unknown Boolean JSON diagnostics for approved machine flags', () => {
  const r = sanitizeImportDiagnostic(JSON.stringify({ privateUnknown: true }));
  expect(r.safeText).toBe(null);
  expect(r.redacted).toBe(true);
});
it('captures HTTP API errors even when result is null', () => {
  const r = parseD1ImportResponse(
    400,
    {
      success: false,
      errors: [{ code: 7500, message: 'FOREIGN KEY constraint failed' }],
      messages: [],
      result: null,
    },
    'ingest',
  );
  expect(r.httpStatus).toBe(400);
  expect(r.providerCodes).toEqual([7500]);
  expect(r.topDiagnostics[0]?.category).toBe('FOREIGN_KEY');
  expect(r.terminal).toBe(null);
});
it('rejects malformed envelopes and non-boolean success', () => {
  for (const raw of [
    { success: 1, result: {} },
    envelope([]),
    envelope({ status: 'unknown' }),
    envelope({ status: 'error', success: false }),
    envelope({ status: 'complete', success: true, result: { num_queries: '12' } }),
  ])
    expect(() => parseD1ImportResponse(200, raw, 'ingest')).toThrow();
});
it('never accepts contradictory transport/envelope or error success as terminal completion', () => {
  const result = { status: 'complete', success: true, result: { num_queries: 1 } };
  expect(() => parseD1ImportResponse(500, envelope(result), 'poll')).toThrow(
    'TERMINAL_COMPLETE_INVALID',
  );
  expect(() =>
    parseD1ImportResponse(200, { success: false, errors: [], messages: [], result }, 'poll'),
  ).toThrow('TERMINAL_COMPLETE_INVALID');
  expect(() =>
    parseD1ImportResponse(
      200,
      envelope({ status: 'error', success: true, error: 'FOREIGN KEY constraint failed' }),
      'poll',
    ),
  ).toThrow('TERMINAL_ERROR_INVALID');
});

it('rejects complete with a contradictory result.error', () => {
  expect(() =>
    parseD1ImportResponse(
      200,
      envelope({
        status: 'complete',
        success: true,
        error: 'FOREIGN KEY constraint failed',
        result: { num_queries: 1 },
      }),
      'poll',
    ),
  ).toThrow('TERMINAL_COMPLETE_INVALID');
});
it('rejects complete with contradictory top-level errors', () => {
  const response = envelope({ status: 'complete', success: true, result: { num_queries: 1 } });
  expect(() =>
    parseD1ImportResponse(
      200,
      { ...response, errors: [{ code: 7500, message: 'FOREIGN KEY constraint failed' }] },
      'poll',
    ),
  ).toThrow('TERMINAL_COMPLETE_INVALID');
});

it('requires the actual bookmark for in-progress imports', () => {
  const r = parseD1ImportResponse(
    200,
    envelope({ status: 'active', success: true, at_bookmark: 'actual-provider-bookmark' }),
    'poll',
  );
  expect(requirePollBookmark(r, 1, 0, 100)).toBe('actual-provider-bookmark');
  const missing = parseD1ImportResponse(200, envelope({ status: 'active', success: true }), 'poll');
  expect(() => requirePollBookmark(missing, 1, 0, 100)).toThrow('POLL_BOOKMARK_MISSING');
});
it('fails polling closed on deadline or count bound', () => {
  const r = parseD1ImportResponse(
    200,
    envelope({ status: 'active', success: true, at_bookmark: 'actual-provider-bookmark' }),
    'poll',
  );
  expect(() => requirePollBookmark(r, 101, 0, 100)).toThrow('POLL_TIMEOUT');
  expect(() => requirePollBookmark(r, 1, 60, 100)).toThrow('POLL_TIMEOUT');
});
it('rejects upload ETag mismatch and accepts the exact quoted MD5', () => {
  expect(() => verifyD1UploadEtag('a'.repeat(32), 'b'.repeat(32))).toThrow('UPLOAD_ETAG_MISMATCH');
  expect(() => verifyD1UploadEtag('a'.repeat(32), '"' + 'a'.repeat(32) + '"')).not.toThrow();
});
it('bounds diagnostic strings and rejects bookmark content outside the metadata grammar', () => {
  expect(() => sanitizeImportDiagnostic(' '.repeat(65537))).toThrow('DIAGNOSTIC_TEXT_LIMIT');
  expect(() =>
    parseD1ImportResponse(
      200,
      envelope({ status: 'active', success: true, at_bookmark: 'https://invalid.example' }),
      'poll',
    ),
  ).toThrow('BOOKMARK_INVALID');
});

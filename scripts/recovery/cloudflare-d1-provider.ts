import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireProof, canonical, type Row } from './executor-bundle';
import { splitNativeExportStatements } from './ordered-d1-import';
import {
  parseD1ImportResponse,
  verifyD1UploadEtag,
  type SafeImportResponse,
} from './d1-import-diagnostics';
import { assertWire, type ProviderWire, type ProviderRequest } from './provider-wire';

export const PROVIDER_ACCOUNT = 'af9fc98cb8d5f5508d58057bc794d863';
export const PROVIDER_NAME = 'mayisigorta-ops001-restore-gatec-44c314b-03';
const identitySchema = z.object({
  uuid: z
    .string()
    .uuid()
    .refine((id) => id !== '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d'),
  name: z.literal(PROVIDER_NAME),
  jurisdiction: z.literal('eu'),
  created_at: z.iso.datetime(),
  read_replication: z.object({ mode: z.literal('disabled') }).optional(),
});
export type OwnedDatabase = z.infer<typeof identitySchema>;
export const importEtag = (sql: string) => createHash('md5').update(sql).digest('hex');
export interface ImportStatus {
  record: SafeImportResponse;
  uploadUrl?: string;
  filename?: string;
}
export class CloudflareD1Provider {
  readonly mode: ProviderWire['mode'];
  private owned: OwnedDatabase | undefined;
  private deleteAttempted = false;
  constructor(
    private readonly wire: ProviderWire,
    private readonly event: (
      kind: string,
      status: number,
      meta?: Record<string, number | boolean>,
    ) => void,
  ) {
    assertWire(wire);
    this.mode = wire.mode;
  }
  bindOwned(value: unknown, deleteAttempted = false) {
    this.owned = identitySchema.parse(value);
    this.deleteAttempted = deleteAttempted;
  }
  private path(suffix = '') {
    return `https://api.cloudflare.com/client/v4/accounts/${PROVIDER_ACCOUNT}${suffix}`;
  }
  private dbPath(suffix = '') {
    requireProof(this.owned, 'OWNED_DATABASE_REQUIRED');
    return this.path(`/d1/database/${this.owned.uuid}${suffix}`);
  }
  private async send(kind: string, request: ProviderRequest) {
    const started = performance.now();
    this.event(kind, 0);
    const response = await this.wire.request(request);
    this.event(kind, response.status, { adapter_elapsed_ms: performance.now() - started });
    requireProof(Buffer.byteLength(response.body) <= 2 * 1024 * 1024, 'PROVIDER_RESPONSE_LIMIT');
    const data = JSON.parse(response.body) as {
      success: boolean;
      result: unknown;
      errors?: unknown[];
      result_info?: { page?: number; per_page?: number; count?: number; total_count?: number };
    };
    requireProof(data && typeof data.success === 'boolean', 'PROVIDER_RESPONSE_INVALID');
    requireProof(
      !data.success ||
        data.errors == null ||
        (Array.isArray(data.errors) && data.errors.length === 0),
      'PROVIDER_RESPONSE_INVALID',
    );
    return { response, data };
  }
  async account() {
    const { response, data } = await this.send('account', {
      url: this.path(),
      method: 'GET',
      readOnly: true,
    });
    requireProof(
      response.status === 200 &&
        data.success &&
        (data.result as { id?: string })?.id === PROVIDER_ACCOUNT,
      'ACCOUNT_IDENTITY_MISMATCH',
    );
  }
  async list(): Promise<
    Array<{ uuid: string; name: string; created_at: string; jurisdiction?: string }>
  > {
    const rows: Array<{ uuid: string; name: string; created_at: string; jurisdiction?: string }> =
      [];
    for (let page = 1; page <= 10; page++) {
      const { response, data } = await this.send('list', {
        url: this.path(`/d1/database?page=${page}&per_page=100`),
        method: 'GET',
        readOnly: true,
      });
      requireProof(
        response.status === 200 &&
          data.success &&
          Array.isArray(data.result) &&
          data.result.length <= 100,
        'INVENTORY_INCOMPLETE',
      );
      for (const item of data.result)
        rows.push(
          z
            .object({
              uuid: z.string().uuid(),
              name: z.string(),
              created_at: z.string(),
              jurisdiction: z.string().optional(),
            })
            .parse(item),
        );
      requireProof(new Set(rows.map((r) => r.uuid)).size === rows.length, 'INVENTORY_INCOMPLETE');
      requireProof(
        data.result_info &&
          data.result_info.page === page &&
          data.result_info.per_page === 100 &&
          data.result_info.count === data.result.length &&
          Number.isSafeInteger(data.result_info.total_count) &&
          data.result_info.total_count! >= rows.length,
        'INVENTORY_INCOMPLETE',
      );
      if (data.result.length < 100) {
        if (data.result_info?.total_count !== undefined)
          requireProof(data.result_info.total_count === rows.length, 'INVENTORY_INCOMPLETE');
        return rows;
      }
    }
    throw new Error('INVENTORY_INCOMPLETE');
  }
  async create(): Promise<OwnedDatabase> {
    const { response, data } = await this.send('create', {
      url: this.path('/d1/database'),
      method: 'POST',
      readOnly: false,
      body: JSON.stringify({
        name: PROVIDER_NAME,
        jurisdiction: 'eu',
        read_replication: { mode: 'disabled' },
      }),
    });
    requireProof(
      response.status >= 200 && response.status < 300 && data.success,
      'CREATE_RESPONSE_UNKNOWN',
    );
    return identitySchema.parse(data.result);
  }
  async detail(afterOwnedDelete = false): Promise<OwnedDatabase | null> {
    const { response, data } = await this.send('detail', {
      url: this.dbPath(),
      method: 'GET',
      readOnly: true,
    });
    if (
      response.status === 404 &&
      data.success === false &&
      Array.isArray(data.errors) &&
      data.errors.length > 0 &&
      data.errors.every((error) => {
        const e = error as { code?: unknown; message?: unknown };
        return (
          typeof e.code === 'number' &&
          typeof e.message === 'string' &&
          e.message.length <= 512 &&
          (/database.*(?:not found|does not exist)|could not find.*database/i.test(e.message) ||
            (afterOwnedDelete && this.deleteAttempted && data.result === null && e.code === 7404))
        );
      })
    )
      return null;
    requireProof(response.status === 200 && data.success, 'OWNERSHIP_READBACK_FAILED');
    const identity = identitySchema.parse(data.result);
    const stable = (row: OwnedDatabase) => ({
      uuid: row.uuid,
      name: row.name,
      jurisdiction: row.jurisdiction,
      created_at: row.created_at,
    });
    requireProof(
      canonical(stable(identity)) === canonical(stable(this.owned!)),
      'TARGET_IDENTITY_MISMATCH',
    );
    return identity;
  }
  async requireOwned() {
    requireProof(await this.detail(), 'OWNED_DATABASE_ABSENT');
  }
  async init(sql: string): Promise<ImportStatus> {
    const { response, data } = await this.send('import-init', {
      url: this.dbPath('/import'),
      method: 'POST',
      readOnly: true,
      body: JSON.stringify({ action: 'init', etag: importEtag(sql) }),
    });
    const record = parseD1ImportResponse(response.status, data, 'init');
    this.event('import-meta', response.status, record.meta);
    requireProof(
      record.topSuccess && response.status >= 200 && response.status < 300,
      'IMPORT_RESPONSE_UNKNOWN',
    );
    const value = data.result as Record<string, unknown>;
    if (value.upload_url !== undefined) {
      requireProof(
        typeof value.upload_url === 'string' &&
          typeof value.filename === 'string' &&
          /^[A-Za-z0-9_./-]{1,512}$/.test(value.filename),
        'IMPORT_RESPONSE_UNKNOWN',
      );
      return { record, uploadUrl: value.upload_url, filename: value.filename };
    }
    return { record };
  }
  async upload(url: string, sql: string) {
    const started = performance.now();
    this.event('upload', 0);
    const response = await this.wire.request({
      url,
      method: 'PUT',
      body: sql,
      readOnly: false,
      upload: true,
    });
    this.event('upload', response.status, { adapter_elapsed_ms: performance.now() - started });
    requireProof(response.status === 200, 'UPLOAD_RESPONSE_UNKNOWN');
    verifyD1UploadEtag(importEtag(sql), response.etag);
  }
  async ingest(sql: string, filename: string): Promise<SafeImportResponse> {
    const { response, data } = await this.send('import-ingest', {
      url: this.dbPath('/import'),
      method: 'POST',
      readOnly: false,
      body: JSON.stringify({ action: 'ingest', filename, etag: importEtag(sql) }),
    });
    const record = parseD1ImportResponse(response.status, data, 'ingest');
    this.event('import-meta', response.status, record.meta);
    return record;
  }
  async poll(bookmark: string): Promise<SafeImportResponse> {
    requireProof(/^[A-Za-z0-9_-]{1,256}$/.test(bookmark), 'POLL_BOOKMARK_INVALID');
    const { response, data } = await this.send('import-poll', {
      url: this.dbPath('/import'),
      method: 'POST',
      readOnly: true,
      body: JSON.stringify({ action: 'poll', current_bookmark: bookmark }),
    });
    const record = parseD1ImportResponse(response.status, data, 'poll');
    this.event('import-meta', response.status, record.meta);
    return record;
  }
  async query(sql: string): Promise<Row[]> {
    const text = sql.trim().replace(/;\s*$/, '') + ';';
    const statements = splitNativeExportStatements(text);
    requireProof(
      statements.length === 1 &&
        (statements[0]!.tokens[0]?.toUpperCase() === 'SELECT' ||
          /^PRAGMA (?:foreign_key_check|quick_check);$/i.test(text)),
      'READ_ONLY_QUERY_REQUIRED',
    );
    const { response, data } = await this.send('query', {
      url: this.dbPath('/query'),
      method: 'POST',
      readOnly: true,
      body: JSON.stringify({ sql }),
    });
    requireProof(
      response.status === 200 &&
        data.success &&
        Array.isArray(data.result) &&
        data.result.length === 1,
      'QUERY_RESPONSE_INVALID',
    );
    const result = z
      .object({
        success: z.literal(true),
        results: z.array(z.record(z.string(), z.unknown())).max(1000),
        meta: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(data.result[0]);
    const meta: Record<string, number | boolean> = {};
    for (const key of ['rows_read', 'rows_written', 'size_after']) {
      const value = result.meta?.[key];
      if (typeof value === 'number') {
        requireProof(Number.isFinite(value) && value >= 0, 'PROVIDER_META_INVALID');
        meta[key] = value;
      }
    }
    this.event('query-meta', 200, meta);
    return result.results;
  }
  async queryBatch(batch: readonly { sql: string }[]) {
    requireProof(batch.length > 0 && batch.length <= 256, 'QUERY_BATCH_LIMIT');
    for (const row of batch)
      requireProof(
        typeof row.sql === 'string' &&
          Buffer.byteLength(row.sql) <= 100000 &&
          splitNativeExportStatements(row.sql).length === 1,
        'QUERY_BATCH_STATEMENT_DENIED',
      );
    const body = JSON.stringify({ batch });
    requireProof(Buffer.byteLength(body) <= 2 * 1024 * 1024, 'QUERY_BATCH_LIMIT');
    await this.requireOwned();
    const { response, data } = await this.send('query-batch', {
      url: this.dbPath('/query'),
      method: 'POST',
      readOnly: false,
      body,
    });
    requireProof(
      response.status === 200 &&
        data.success &&
        Array.isArray(data.result) &&
        data.result.length > 0 &&
        data.result.length <= 1000,
      'QUERY_BATCH_RESPONSE_INVALID',
    );
    const meta: Record<string, number> = { rows_read: 0, rows_written: 0, size_after: 0 };
    for (const row of data.result) {
      const result = z
        .object({ success: z.literal(true), meta: z.record(z.string(), z.unknown()).optional() })
        .parse(row);
      for (const key of ['rows_read', 'rows_written', 'size_after']) {
        const value = result.meta?.[key];
        if (value !== undefined) {
          requireProof(
            typeof value === 'number' && Number.isFinite(value) && value >= 0,
            'PROVIDER_META_INVALID',
          );
          meta[key] = key === 'size_after' ? Math.max(meta[key]!, value) : meta[key]! + value;
        }
      }
    }
    this.event('query-meta', 200, meta);
  }
  async deleteOwned() {
    await this.requireOwned();
    this.deleteAttempted = true;
    const { response, data } = await this.send('delete', {
      url: this.dbPath(),
      method: 'DELETE',
      readOnly: false,
    });
    requireProof(
      response.status >= 200 && response.status < 300 && data.success,
      'DELETE_RESPONSE_UNKNOWN',
    );
  }
  async verifyAbsent() {
    requireProof(this.deleteAttempted, 'DELETE_ATTEMPT_REQUIRED');
    requireProof((await this.detail(true)) === null, 'DELETE_RESULT_UNKNOWN');
    const rows = await this.list();
    requireProof(
      !rows.some((row) => row.uuid === this.owned!.uuid || row.name === PROVIDER_NAME),
      'DELETE_RESULT_UNKNOWN',
    );
    return { state: 'VERIFIED_ABSENT' as const, uuid: this.owned!.uuid };
  }
}

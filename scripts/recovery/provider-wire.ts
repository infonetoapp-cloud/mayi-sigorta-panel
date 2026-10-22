import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { requireProof } from './executor-bundle';
import { nodeHttpsUpload } from './node-https-upload';

export interface ProviderRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  readOnly: boolean;
  upload?: boolean;
}
export interface ProviderResponse {
  status: number;
  body: string;
  etag?: string;
}
export interface ProviderWire {
  readonly mode: 'LIVE' | 'OFFLINE_PROCESS';
  request(input: ProviderRequest): Promise<ProviderResponse>;
}
export interface TransportDiagnostic {
  operation: 'UPLOAD' | 'API';
  phase: 'REQUEST' | 'RESPONSE_BODY';
  category: 'NETWORK' | 'TIMEOUT' | 'BODY_STREAM' | 'RESPONSE_LIMIT';
  systemCode: string;
  faultClass: 'DNS' | 'TLS' | 'CONNECTION' | 'CONSTRUCTION' | 'UNKNOWN';
  outcome: 'UNKNOWN';
  elapsedMs: number;
  httpStatus?: number;
}
export class ProviderTransportError extends Error {
  constructor(readonly diagnostic: Readonly<TransportDiagnostic>) {
    super('PROVIDER_RESPONSE_LOST');
    Object.freeze(diagnostic);
  }
}
const systemCodes = new Set([
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_URL',
  'ERR_INVALID_CHAR',
  'UND_ERR_INVALID_ARG',
  'ERR_OUT_OF_RANGE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
]);
function safeSystemCode(error: unknown): string {
  const pending = [error],
    seen = new Set<object>();
  for (let depth = 0; depth < 16 && pending.length; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && systemCodes.has(value.code)) return value.code;
    pending.push(value.cause);
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 8));
  }
  return 'UNCLASSIFIED';
}
function faultClass(code: string): TransportDiagnostic['faultClass'] {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS';
  if (/TLS|CERT|ISSUER|SIGNATURE/.test(code)) return 'TLS';
  if (/INVALID|OUT_OF_RANGE|CONTENT_LENGTH/.test(code)) return 'CONSTRUCTION';
  return code === 'UNCLASSIFIED' ? 'UNKNOWN' : 'CONNECTION';
}
const wires = new WeakSet<object>(),
  permits = new WeakMap<object, string>(),
  bindings = new WeakMap<object, string>();
const account = 'af9fc98cb8d5f5508d58057bc794d863';
const requestSchema = z.strictObject({
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  body: z.string().optional(),
  readOnly: z.boolean(),
  upload: z.boolean().optional(),
});
export function assertWire(wire: ProviderWire, binding?: string) {
  requireProof(wires.has(wire), 'UNREGISTERED_PROVIDER_TRANSPORT');
  if (wire.mode === 'LIVE' && binding)
    requireProof(bindings.get(wire) === binding, 'LIVE_CAPABILITY_BINDING_INVALID');
}
export function validateProviderUrl(input: ProviderRequest) {
  const url = new URL(input.url);
  requireProof(
    url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port,
    'PROVIDER_ORIGIN_DENIED',
  );
  if (input.upload)
    requireProof(
      input.method === 'PUT' && /^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname),
      'UPLOAD_ORIGIN_DENIED',
    );
  else {
    requireProof(
      url.origin === 'https://api.cloudflare.com' &&
        url.pathname.startsWith(`/client/v4/accounts/${account}`),
      'PROVIDER_ORIGIN_DENIED',
    );
    requireProof(
      !url.pathname.includes('1dd3b04e-14b8-459c-86d0-5c3c3ed8127d'),
      'PRODUCTION_TARGET_FORBIDDEN',
    );
    requireProof(
      new RegExp(
        `^/client/v4/accounts/${account}(?:/d1/database(?:/[a-f0-9-]{36}(?:/(?:query|import))?)?)?$`,
      ).test(url.pathname),
      'PROVIDER_PATH_DENIED',
    );
  }
  requireProof(Buffer.byteLength(input.body ?? '') <= 16 * 1024 * 1024, 'PROVIDER_REQUEST_LIMIT');
}
export function fakeProcessWire(directory: string): ProviderWire {
  const path = resolve(directory);
  const wire: ProviderWire = Object.freeze({
    mode: 'OFFLINE_PROCESS' as const,
    async request(input: ProviderRequest) {
      input = Object.freeze(requestSchema.parse(input));
      validateProviderUrl(input);
      const child = spawnSync(
        process.execPath,
        ['--no-warnings', resolve('tests/support/ops001-fake-provider.mjs'), path],
        {
          input: JSON.stringify(input),
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024 + 65536,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !/^(?:CLOUDFLARE_|NODE_OPTIONS$)/.test(key),
            ),
          ),
        },
      );
      requireProof(!child.error && child.status === 0, 'PROVIDER_RESPONSE_LOST');
      requireProof(Buffer.byteLength(child.stdout) <= 2 * 1024 * 1024, 'PROVIDER_RESPONSE_LIMIT');
      const response = JSON.parse(child.stdout) as ProviderResponse;
      requireProof(
        Number.isInteger(response.status) && typeof response.body === 'string',
        'PROVIDER_RESPONSE_INVALID',
      );
      return response;
    },
  });
  wires.add(wire);
  return wire;
}
// A file is data, never a live capability. Only this deliberate TTY ceremony can
// mint the opaque in-process capability; nothing is read from credentials here.
export async function confirmLiveProvider(binding: string, challenge: string): Promise<object> {
  requireProof(stdin.isTTY && stdout.isTTY, 'LIVE_TTY_CONFIRMATION_REQUIRED');
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    requireProof(
      (await readline.question(
        `Remote D1 actions require separate OWNER authorization.\nType exactly: ${challenge}\n> `,
      )) === challenge,
      'LIVE_CONFIRMATION_DENIED',
    );
  } finally {
    readline.close();
  }
  const permit = Object.freeze({});
  permits.set(permit, binding);
  return permit;
}
export function liveProviderWire(
  permit: object,
  binding: string,
  apiToken: string,
  uploadTransport: 'FETCH' | 'NODE_HTTPS' = 'FETCH',
): ProviderWire {
  requireProof(permits.get(permit) === binding, 'LIVE_CAPABILITY_REQUIRED');
  permits.delete(permit);
  requireProof(
    typeof apiToken === 'string' && apiToken.length > 0 && !/[\r\n]/.test(apiToken),
    'PROVIDER_CREDENTIAL_REQUIRED',
  );
  requireProof(
    JSON.parse(readFileSync(resolve('node_modules/wrangler/package.json'), 'utf8')).version ===
      '4.133.0',
    'WRANGLER_VERSION_MISMATCH',
  );
  const fetcher = globalThis.fetch.bind(globalThis);
  let pending = false;
  const wire: ProviderWire = Object.freeze({
    mode: 'LIVE' as const,
    async request(input: ProviderRequest) {
      input = Object.freeze(requestSchema.parse(input));
      validateProviderUrl(input);
      requireProof(!pending, 'PROVIDER_WRITE_SETTLEMENT_PENDING');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = performance.now();
      const observation: { phase: TransportDiagnostic['phase']; httpStatus?: number } = {
        phase: 'REQUEST',
      };
      let timedOut = false;
      const actual = (async () => {
        if (input.upload && uploadTransport === 'NODE_HTTPS')
          return nodeHttpsUpload(input.url, input.body ?? '', controller.signal, (status) => {
            observation.phase = 'RESPONSE_BODY';
            observation.httpStatus = status;
          });
        const response = await fetcher(input.url, {
          method: input.method,
          redirect: 'error',
          signal: controller.signal,
          headers: input.upload
            ? { 'content-length': String(Buffer.byteLength(input.body ?? '')) }
            : { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
          ...(input.body === undefined
            ? {}
            : { body: input.upload ? Buffer.from(input.body, 'utf8') : input.body }),
        });
        observation.phase = 'RESPONSE_BODY';
        observation.httpStatus = response.status;
        const reader = response.body?.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          if (reader)
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              requireProof(size <= 2 * 1024 * 1024, 'PROVIDER_RESPONSE_LIMIT');
              chunks.push(value);
            }
        } finally {
          if (reader) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        return {
          status: response.status,
          body: Buffer.concat(chunks).toString('utf8'),
          etag: response.headers.get('etag') ?? undefined,
        };
      })();
      pending = true;
      void actual.then(
        () => {
          pending = false;
        },
        () => {
          pending = false;
        },
      );
      try {
        return await Promise.race([
          actual,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                timedOut = true;
                controller.abort();
                reject(new Error('PROVIDER_TIMEOUT_UNKNOWN'));
              },
              input.upload ? 60000 : 30000,
            );
          }),
        ]);
      } catch (error) {
        throw new ProviderTransportError({
          operation: input.upload ? 'UPLOAD' : 'API',
          phase: observation.phase,
          category: timedOut
            ? 'TIMEOUT'
            : error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT'
              ? 'RESPONSE_LIMIT'
              : observation.phase === 'RESPONSE_BODY'
                ? 'BODY_STREAM'
                : 'NETWORK',
          systemCode: safeSystemCode(error),
          faultClass: faultClass(safeSystemCode(error)),
          outcome: 'UNKNOWN',
          elapsedMs: performance.now() - started,
          ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus }),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
  wires.add(wire);
  bindings.set(wire, binding);
  return wire;
}

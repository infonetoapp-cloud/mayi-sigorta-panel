export function classifyTransport(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const errorName = [
    'Error',
    'TypeError',
    'RangeError',
    'DOMException',
    'AbortError',
    'NetworkError',
  ].includes(name)
    ? name
    : 'UnknownError';
  const transportClass = /illegal invocation|request context|outside.*request|IoContext/i.test(
    message,
  )
    ? 'request-context'
    : /header|invalid character/i.test(message)
      ? 'invalid-header'
      : /connection.*lost/i.test(message)
        ? 'network-connection-lost'
        : /tls|certificate/i.test(message)
          ? 'tls'
          : /redirect/i.test(message)
            ? 'redirect-runtime'
            : /fetch failed|failed to fetch/i.test(message)
              ? 'fetch-failed'
              : 'unknown-transport';
  return { errorName, transportClass };
}
const ACCOUNT = 'af9fc98cb8d5f5508d58057bc794d863';
const REAL = '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d';
const FAKE = '00000000-0000-0000-0000-000000000000';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/`;
type SecretEnv = { CLOUDFLARE_EMAIL: string; CLOUDFLARE_API_KEY: string };
type Probe = {
  responseObtained: boolean;
  httpStatus: number | null;
  elapsedMs: number;
  success?: boolean | null;
  errorCodes?: number[];
  errorName?: string;
  transportClass?: string;
};
export async function runTransportDiagnostic(
  env: SecretEnv,
  fetcher: typeof fetch = globalThis.fetch,
) {
  const shape = (value: unknown) => ({
    present: typeof value === 'string' && value.length > 0,
    whitespace: typeof value === 'string' && value.trim() !== value,
    cr: typeof value === 'string' && value.includes('\r'),
    lf: typeof value === 'string' && value.includes('\n'),
    controls:
      typeof value === 'string' &&
      Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  });
  const email = shape(env.CLOUDFLARE_EMAIL),
    key = shape(env.CLOUDFLARE_API_KEY);
  let headers: Headers;
  let headerError: ReturnType<typeof classifyTransport> | undefined;
  try {
    headers = new Headers({
      'X-Auth-Email': env.CLOUDFLARE_EMAIL,
      'X-Auth-Key': env.CLOUDFLARE_API_KEY,
    });
  } catch (error) {
    headerError = classifyTransport(error);
  }
  const shapeValid =
    email.present &&
    key.present &&
    ![email, key].some((s) => s.whitespace || s.controls) &&
    !headerError;
  const output: {
    A: {
      email: typeof email;
      key: typeof key;
      headersConstructed: boolean;
      shapeValid: boolean;
      headerError?: ReturnType<typeof classifyTransport>;
    };
    B?: Probe;
    C?: Probe;
    fakeVerification?: Probe;
    D?: Probe;
  } = {
    A: {
      email,
      key,
      headersConstructed: !headerError,
      shapeValid,
      ...(headerError ? { headerError } : {}),
    },
  };
  if (!shapeValid) return output;
  // Deliberately same fetch receiver pattern as backup runtime; diagnostic must not silently fix it.
  const runtime = { fetch: fetcher };
  const probe = async (url: string, init: RequestInit, parse: boolean): Promise<Probe> => {
    const start = Date.now();
    let response: Response;
    try {
      response = await runtime.fetch(url, { ...init, redirect: 'manual' });
    } catch (error) {
      return {
        responseObtained: false,
        httpStatus: null,
        elapsedMs: Date.now() - start,
        ...classifyTransport(error),
      };
    }
    const result: Probe = {
      responseObtained: true,
      httpStatus: response.status,
      elapsedMs: Date.now() - start,
    };
    if (parse && !(response.status >= 300 && response.status < 400)) {
      try {
        const body = (await response.json()) as {
          success?: unknown;
          errors?: Array<{ code?: unknown }>;
        };
        result.success = typeof body.success === 'boolean' ? body.success : null;
        result.errorCodes = Array.isArray(body.errors)
          ? body.errors
              .slice(0, 8)
              .map((e) => e?.code)
              .filter(
                (code): code is number =>
                  typeof code === 'number' && Number.isSafeInteger(code) && code >= 0,
              )
          : [];
      } catch {
        result.success = null;
        result.errorCodes = [];
      }
    }
    return result;
  };
  output.B = await probe('https://api.cloudflare.com/client/v4/ips', { method: 'GET' }, false);
  if (!output.B.responseObtained || (output.B.httpStatus! >= 300 && output.B.httpStatus! < 400))
    return output;
  output.C = await probe(BASE + REAL, { method: 'GET', headers: headers! }, true);
  if (!output.C.responseObtained || (output.C.httpStatus! >= 300 && output.C.httpStatus! < 400))
    return output;
  output.fakeVerification = await probe(BASE + FAKE, { method: 'GET', headers: headers! }, true);
  // Only explicit 404+unsuccessful confirms nonexistent fake ID; no fallback or real export.
  if (output.fakeVerification.httpStatus !== 404 || output.fakeVerification.success !== false)
    return output;
  const postHeaders = new Headers(headers!);
  postHeaders.set('Content-Type', 'application/json');
  output.D = await probe(
    BASE + FAKE + '/export',
    { method: 'POST', headers: postHeaders, body: JSON.stringify({ output_format: 'polling' }) },
    true,
  );
  return output;
}

import { expect, it } from 'vitest';
import { readCommandJson } from '../src/server/security/command-json';

function bodyRequest(
  chunks: string[],
  headers: HeadersInit = { 'Content-Type': 'application/json' },
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const init = { method: 'POST', headers, body, duplex: 'half' };
  return new Request('https://example.invalid/api/commands', init);
}

it('counts UTF-8 bytes across chunks without relying on Content-Length', async () => {
  const chunks = ['{"text":"', 'ş'.repeat(5), '"}'];
  await expect(readCommandJson(bodyRequest(chunks), 21)).resolves.toEqual({ text: 'şşşşş' });
  await expect(readCommandJson(bodyRequest(chunks), 20)).rejects.toMatchObject({
    status: 413,
    code: 'BODY_TOO_LARGE',
  });
});

it('distinguishes malformed JSON from unsupported media types and content encodings', async () => {
  await expect(readCommandJson(bodyRequest(['{"text":']))).rejects.toMatchObject({
    status: 400,
    code: 'INVALID_JSON',
  });
  const unsupported: HeadersInit[] = [
    { 'Content-Type': 'application/jsonp' },
    { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
  ];
  for (const headers of unsupported) {
    await expect(readCommandJson(bodyRequest(['{}'], headers))).rejects.toMatchObject({
      status: 415,
      code: 'JSON_REQUIRED',
    });
  }
});

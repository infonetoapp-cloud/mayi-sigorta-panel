// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let mf: Miniflare, bucket: R2Bucket;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import {writeRawQuarantine} from './src/server/documents/raw-stream';export default {async fetch(r,e){try{const result=await writeRawQuarantine(r,e.Q,{objectKey:'quarantine/'+r.headers.get('x-key'),sizeBytes:Number(r.headers.get('x-size')),expectedSha256:r.headers.get('x-sha'),fileName:'synthetic.png',contentType:'image/png'});return Response.json({size:result.sizeBytes,checksumVerified:true},{status:202});}catch(error){return new Response(null,{status:error.status??500});}}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles![0]!.text,
      compatibilityDate: '2026-09-01',
      r2Buckets: { Q: crypto.randomUUID() },
    }),
  );
  bucket = (await mf.getR2Bucket('Q')) as unknown as R2Bucket;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});
async function digest(b: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', b.buffer as ArrayBuffer)),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('');
}
async function send(key: string, bytes: Uint8Array, size = bytes.length, sha?: string) {
  return mf.dispatchFetch('https://synthetic.invalid', {
    method: 'POST',
    headers: { 'x-key': key, 'x-size': String(size), 'x-sha': sha ?? (await digest(bytes)) },
    body: bytes,
  });
}
it('native exact length and R2 checksum accept the exact20MiB quarantine object', async () => {
  const key = crypto.randomUUID(),
    bytes = new Uint8Array(20971520);
  const response = await send(key, bytes);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ size: 20971520, checksumVerified: true });
  const stored = await bucket.get('quarantine/' + key);
  expect(stored!.size).toBe(20971520);
  expect(
    (await digest(new Uint8Array(await stored!.arrayBuffer()))) === (await digest(bytes)),
  ).toBe(true);
});
it.each(['short', 'long', 'checksum', 'oversize'])(
  'never stores a %s mismatched stream',
  async (kind) => {
    const key = crypto.randomUUID(),
      bytes = new Uint8Array([1, 2, 3]);
    const size = kind === 'short' ? 4 : kind === 'long' ? 2 : kind === 'oversize' ? 20971521 : 3;
    const response = await send(key, bytes, size, kind === 'checksum' ? '0'.repeat(64) : undefined);
    expect(response.status).toBe(kind === 'oversize' ? 413 : 400);
    expect(await bucket.head('quarantine/' + key)).toBeNull();
  },
);
it('conditional create never overwrites previously stored bytes', async () => {
  const key = crypto.randomUUID();
  expect((await send(key, new Uint8Array([1, 2, 3]))).status).toBe(202);
  expect((await send(key, new Uint8Array([4, 5, 6]))).status).toBe(409);
  expect(
    Array.from(new Uint8Array(await (await bucket.get('quarantine/' + key))!.arrayBuffer())),
  ).toEqual([1, 2, 3]);
});

// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import miniflare from 'miniflare';
it('native production wrapper preserves malformed JSON and immutable replay without D1/auth access', async () => {
  const compiled = await build({
    stdin: {
      contents: `import worker from './src/server/worker';export default {async fetch(request,env){let acks=0,retries=0;const body=await request.json();const id=Object.hasOwn(body,'invalidId')?(body.invalidId==='missing'?undefined:body.invalidId):'synthetic-native';await worker.queue({queue:'mayisigorta-document-jobs-v2',messages:[{id,timestamp:new Date(0),body,ack(){acks++},retry(){retries++}}]},{APP_ENV:'production',DOCUMENTS_ENABLED:'false',DOCUMENT_JOBS_ENABLED:'true',DOCUMENT_QUEUE_CUSTODY:env.ARCHIVE,DB:{prepare(){throw Error('UNEXPECTED_DB')}}});return Response.json({acks,retries})}}`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: ['node:*', 'cloudflare:workers'],
    write: false,
  });
  const runtime = new miniflare.Miniflare(
    miniflare.convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'custody',
          modules: true,
          compatibilityDate: '2026-09-01',
          compatibilityFlags: ['nodejs_compat'],
          script: compiled.outputFiles![0]!.text,
          r2Buckets: ['ARCHIVE'],
        },
      ],
    }),
  );
  try {
    for (const body of [
      { malformed: 'synthetic' },
      { malformed: 'synthetic' },
      { malformed: 'changed' },
    ]) {
      const response = await runtime.dispatchFetch('http://local.test', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(await response.json()).toEqual({
        acks: body.malformed === 'changed' ? 0 : 1,
        retries: body.malformed === 'changed' ? 1 : 0,
      });
    }
    for (const invalidId of ['missing', null, 123]) {
      const response = await runtime.dispatchFetch('http://local.test', {
        method: 'POST',
        body: JSON.stringify({ invalidId }),
      });
      expect(await response.json()).toEqual({ acks: 0, retries: 1 });
    }
    const bucket = await runtime.getR2Bucket('ARCHIVE');
    const inventory = await bucket.list();
    expect(inventory.truncated).toBe(false);
    expect(inventory.objects).toHaveLength(1);
    const stored = await bucket.get(inventory.objects[0]!.key);
    expect(JSON.parse(await stored!.text()).body).toEqual({ malformed: 'synthetic' });
  } finally {
    await runtime.dispose();
  }
}, 60000);

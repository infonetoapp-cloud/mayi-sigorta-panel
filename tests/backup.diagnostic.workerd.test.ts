// @vitest-environment node
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
it('native local workerd proves raw stored fetch fails and exact production wrapper succeeds', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end('synthetic');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  let mf: Miniflare | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('LOCAL_SERVER');
    const b = await build({
      stdin: {
        contents: `import {classifyTransport} from './src/server/d1-backup/diagnostic.ts';import {nativeBackupFetch} from './src/server/d1-backup/core.ts';export default {async fetch(){const runtime={fetch:globalThis.fetch};let receiver;try{const r=await runtime.fetch('http://127.0.0.1:${address.port}',{redirect:'manual'});receiver={status:r.status};}catch(e){receiver=classifyTransport(e);}const wrapped={fetch:nativeBackupFetch};const direct=await wrapped.fetch('http://127.0.0.1:${address.port}',{redirect:'manual'});return Response.json({receiver,directStatus:direct.status});}};`,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
    });
    mf = new Miniflare({
      workers: [
        {
          config: {
            type: 'worker',
            name: 'synthetic-receiver',
            compatibilityDate: '2026-09-01',
            manifest: {
              mainModule: 'probe.js',
              modules: { 'probe.js': { type: 'esm', contents: b.outputFiles[0]!.text } },
            },
          },
        },
      ],
    });
    expect(await (await mf.dispatchFetch('http://synthetic.invalid')).json()).toEqual({
      receiver: { errorName: 'TypeError', transportClass: 'request-context' },
      directStatus: 200,
    });
    expect(hits).toBe(1);
  } finally {
    await mf?.dispose();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}, 60000);

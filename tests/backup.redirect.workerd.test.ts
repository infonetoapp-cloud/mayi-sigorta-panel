// @vitest-environment node
import { createServer } from 'node:http';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
it('local native workerd: error throws before Response, manual returns 302 without following', async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(302, { Location: '/target' });
    response.end('synthetic local only');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let runtime: Miniflare | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('LOCAL_SERVER_FAILED');
    const script = `export default {async fetch(request){const mode=new URL(request.url).pathname.slice(1);try{const response=await fetch('http://127.0.0.1:${address.port}/redirect',{redirect:mode});return Response.json({mode,status:response.status});}catch(error){return Response.json({mode,threw:true,name:error.name,message:error.message});}}};`;
    runtime = new Miniflare({
      workers: [
        {
          config: {
            type: 'worker',
            name: 'synthetic-redirect-proof',
            compatibilityDate: '2026-09-01',
            manifest: {
              mainModule: 'probe.js',
              modules: { 'probe.js': { type: 'esm', contents: script } },
            },
          },
        },
      ],
    });
    const errorResult = (await (
      await runtime.dispatchFetch('http://synthetic.invalid/error')
    ).json()) as { threw: boolean; message: string };
    const manualResult = await (
      await runtime.dispatchFetch('http://synthetic.invalid/manual')
    ).json();
    expect(errorResult.threw).toBe(true);
    expect(errorResult.message).toMatch(/redirect/i);
    expect(manualResult).toEqual({ mode: 'manual', status: 302 });
    expect(hits).toEqual(['/redirect']);
  } finally {
    await runtime?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60000);

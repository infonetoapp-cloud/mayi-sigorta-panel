// @vitest-environment node
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { expect, it } from 'vitest';

it('constructs a native Siteverify request without forwarding a redirect', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { verifyLoginTurnstile } from './src/server/auth/turnstile';
        export default {
          async fetch(request) {
            globalThis.fetch = async (url, init) => {
              const outbound = new Request(url, init);
              if (outbound.redirect !== 'manual') throw new Error('UNSAFE_REDIRECT_MODE');
              if (new URL(request.url).pathname === '/redirect')
                return Response.redirect('https://another.example');
              return Response.json({success:true, hostname:'panel.mayisigorta.com', action:'crm_login'});
            };
            try {
              const allowed = await verifyLoginTurnstile(
                {siteKey:'synthetic', secret:'synthetic', hostname:'panel.mayisigorta.com'},
                'synthetic'
              );
              return Response.json({allowed});
            } catch {
              return new Response(null, {status:503});
            }
          }
        };
      `,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-09-01',
      modules: true,
      script: bundle.outputFiles[0]!.text,
    }),
  );
  try {
    const accepted = await runtime.dispatchFetch('https://fixture.test/accept');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ allowed: true });
    const rejected = await runtime.dispatchFetch('https://fixture.test/redirect');
    expect(rejected.status).toBe(503);
  } finally {
    await runtime.dispose();
  }
});

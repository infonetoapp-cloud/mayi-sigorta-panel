// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Profiler } from 'node:inspector';
import { localAuthFixture } from './support/local-auth-fixture';

it.skipIf(process.env.RUN_CSRF_LOCAL_PROFILE !== '1')(
  'records bounded full-worker local V8 profiles without provider calls or native CPU claims',
  async () => {
    const results: unknown[] = [];
    for (const candidate of [false, true]) {
      const bundle = await build({
        stdin: {
          contents:
            "import worker from './src/server/worker';export default {fetch(r,e,c){const local=new Request(r);local.headers.delete('host');return worker.fetch(local,e,c)}}",
          resolveDir: process.cwd(),
          loader: 'ts',
        },
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        write: false,
        external: ['node:*', 'cloudflare:workers'],
        plugins: candidate
          ? [
              {
                name: 'local-candidate-only',
                setup(builder) {
                  builder.onLoad({ filter: /src[\\/]server[\\/]config\.ts$/ }, (args) => {
                    const source = readFileSync(args.path, 'utf8');
                    const original = /export function parseCsrfConfig\([\s\S]*?\n\}/g;
                    expect(source.match(original)).toHaveLength(1);
                    return {
                      contents: source.replace(
                        original,
                        "export {parseCsrfConfigCandidate as parseCsrfConfig} from '../../engineering-drafts/m4-csrf-local/config-candidate';",
                      ),
                      loader: 'ts',
                    };
                  });
                },
              },
            ]
          : [],
      });
      const mf = new miniflare.Miniflare(
        miniflare.convertV4MiniflareOptions({
          modules: true,
          script: bundle.outputFiles[0]!.text,
          compatibilityDate: '2026-09-01',
          compatibilityFlags: ['nodejs_compat'],
          inspectorPort: 0,
          d1Databases: { DB: '00000000-0000-0000-0000-000000000027' },
          bindings: {
            APP_ENV: 'test',
            PANEL_ORIGIN: 'https://panel.mayisigorta.com',
            DOCUMENTS_ENABLED: 'false',
            CSRF_SECRET: crypto.randomUUID(),
          },
        }),
      );
      let socket: WebSocket | undefined;
      try {
        const f = await localAuthFixture(mf);
        const a = await f.seed(crypto.randomUUID(), 'OWNER');
        const session = await f.session(a.id);
        const inspector = await mf.getInspectorURL();
        inspector.protocol = 'http:';
        const targets = (await (await fetch(new URL('/json', inspector))).json()) as {
          id: string;
          title: string;
          webSocketDebuggerUrl: string;
        }[];
        const target = targets.find(
          (x) => x.id.includes('core:user:') || x.title.includes('core:user:'),
        );
        expect(!!target).toBe(true);
        socket = new WebSocket(target!.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          socket!.addEventListener('open', () => resolve(), { once: true });
          socket!.addEventListener('error', () => reject(new Error('LOCAL_INSPECTOR_CONNECT')), {
            once: true,
          });
        });
        let id = 0;
        const pending = new Map<
          number,
          { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
        >();
        socket.addEventListener('message', (event) => {
          const r = JSON.parse(String(event.data)) as {
            id?: number;
            result?: Record<string, unknown>;
            error?: unknown;
          };
          if (r.id) {
            const p = pending.get(r.id);
            if (p) {
              pending.delete(r.id);
              if (r.error) p.reject(new Error('LOCAL_CDP_ERROR'));
              else p.resolve(r.result ?? {});
            }
          }
        });
        const command = (method: string, params: Record<string, unknown> = {}) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const n = ++id;
            const timer = setTimeout(() => {
              pending.delete(n);
              reject(new Error('LOCAL_CDP_DEADLINE'));
            }, 5000);
            pending.set(n, {
              resolve(value) {
                clearTimeout(timer);
                resolve(value);
              },
              reject(error) {
                clearTimeout(timer);
                reject(error);
              },
            });
            socket!.send(JSON.stringify({ id: n, method, params }));
          });
        await command('Profiler.enable');
        await command('Profiler.setSamplingInterval', { interval: 100 });
        await command('Profiler.start');
        const started = performance.now();
        for (let i = 0; i < 80; i++) {
          const r = await mf.dispatchFetch('https://panel.mayisigorta.com/api/auth/csrf-token', {
            headers: { Cookie: session.cookie, Origin: 'https://panel.mayisigorta.com' },
          });
          expect(r.status).toBe(200);
          const b = (await r.json()) as { data: { token: string } };
          expect(typeof b.data?.token).toBe('string');
        }
        const elapsedLocalWallMs = performance.now() - started;
        const profile = (await command('Profiler.stop')).profile as Profiler.Profile;
        expect(profile.nodes.length).toBeGreaterThan(0);
        const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
        const samples = new Map<number, number>();
        for (const n of profile.samples ?? []) samples.set(n, (samples.get(n) ?? 0) + 1);
        const top = [...samples]
          .map(([id, count]) => ({
            function: nodes.get(id)?.callFrame.functionName,
            file: nodes.get(id)?.callFrame.url,
            count,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);
        const file = join(
          tmpdir(),
          candidate
            ? 'mayi-f45-workerd-candidate.cpuprofile'
            : 'mayi-f45-workerd-baseline.cpuprofile',
        );
        writeFileSync(file, JSON.stringify(profile));
        results.push({
          candidate,
          requests: 80,
          scope: 'LOCAL_WORKERD_V8_SAMPLES_NOT_PROVIDER_NATIVE_CPU',
          elapsedLocalWallMs,
          samples: profile.samples?.length ?? 0,
          top,
          profilePath: file,
        });
      } finally {
        socket?.close();
        await mf.dispose();
      }
    }
    writeFileSync(
      join(tmpdir(), 'mayi-f45-workerd-profile.json'),
      JSON.stringify(results, null, 2),
    );
  },
  180000,
);

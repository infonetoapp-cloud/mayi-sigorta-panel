import { build } from 'esbuild';
import miniflare from 'miniflare';
import {
  createDurableObjectPasswordHasher,
  PASSWORD_KDF_INSTANCE,
} from '../../src/server/auth/password-do-adapter';
import type { PasswordVerification } from '../../src/server/auth/password';
/** Test-only in-memory bridge to the actual SQLite DO and actual Worker-side adapter. */
export async function openLocalKdfAdapter() {
  const bundle = await build({
    stdin: {
      contents: `import {PasswordKdfDurableObject} from './src/server/auth/password-do';import {createDurableObjectPasswordHasher} from './src/server/auth/password-do-adapter';export {PasswordKdfDurableObject};export default {async fetch(request,env){const input=await request.json();const hasher=createDurableObjectPasswordHasher(env.PASSWORD_KDF);if(input.kind==='hash')return Response.json({value:await hasher.hash(input.password)});return Response.json(await hasher.verify(input.password,input.verifier));}};`,
      resolveDir: process.cwd(),
      sourcefile: 'local-kdf-bridge.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['node:crypto', 'cloudflare:workers'],
    write: false,
  });
  const { Miniflare, convertV4MiniflareOptions } = miniflare;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      durableObjects: { PASSWORD_KDF: { className: 'PasswordKdfDurableObject', useSQLite: true } },
    }),
  );
  async function call(body: unknown) {
    const response = await runtime.dispatchFetch('https://local.invalid/', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw Error('LOCAL_KDF_BRIDGE_FAILED');
    return response.json() as Promise<Record<string, unknown>>;
  }
  const hasher = createDurableObjectPasswordHasher({
    getByName(name: string) {
      if (name !== PASSWORD_KDF_INSTANCE) throw Error('CANONICAL_ID_REQUIRED');
      return {
        async hash(password: string) {
          const result = await call({ kind: 'hash', password });
          return result.value as string;
        },
        async verify(password: string, verifier: string) {
          return (await call({
            kind: 'verify',
            password,
            verifier,
          })) as unknown as PasswordVerification;
        },
      };
    },
  });
  return { hasher, dispose: () => runtime.dispose() };
}

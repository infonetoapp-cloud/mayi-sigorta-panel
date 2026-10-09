// @vitest-environment node
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import miniflare from 'miniflare';
import { localAdminPasswordHasher } from '../src/server/auth/password-admin';
import {
  isSupportedPasswordVerifier,
  parsePasswordEnvelope,
} from '../src/server/auth/password-envelope';
it('interoperates exact selected admin scrypt with actual local SQLite DO RPC without material output', async () => {
  const bundle = await build({
    stdin: {
      contents: `import {PasswordKdfDurableObject} from './src/server/auth/password-do';export {PasswordKdfDurableObject};export default {async fetch(request,env){const input=await request.json();const object=env.PASSWORD_KDF.getByName('mayi-password-kdf-v2');if(input.kind==='hash')return Response.json({value:await object.hash(input.password)});return Response.json(await object.verify(input.password,input.verifier));}};`,
      resolveDir: process.cwd(),
      sourcefile: 'local-kdf-rpc-test.ts',
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
      durableObjects: { PASSWORD_KDF: { className: 'PasswordKdfDurableObject', useSQLite: true } },
    }),
  );
  const password = crypto.randomUUID();
  try {
    const adminVerifier = await localAdminPasswordHasher.hash(password);
    const call = async (body: unknown) => {
      const r = await runtime.dispatchFetch('https://local.invalid/', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
      return r.json() as Promise<Record<string, unknown>>;
    };
    const good = await call({ kind: 'verify', password, verifier: adminVerifier });
    expect(good).toEqual({ matches: true, needsRehash: false });
    const wrong = await call({
      kind: 'verify',
      password: crypto.randomUUID(),
      verifier: adminVerifier,
    });
    expect(wrong).toEqual({ matches: false, needsRehash: false });
    const generated = await call({ kind: 'hash', password });
    expect(isSupportedPasswordVerifier(generated.value)).toBe(true);
    const value = generated.value as string;
    expect((await localAdminPasswordHasher.verify(password, value)).matches).toBe(true);
    expect(
      Buffer.from(parsePasswordEnvelope(value)!.salt).equals(
        Buffer.from(parsePasswordEnvelope(adminVerifier)!.salt),
      ),
    ).toBe(false);
    const malformed = await call({ kind: 'verify', password, verifier: 'invalid' });
    expect(malformed).toEqual({ matches: false, needsRehash: false });
    expect(Object.keys(good).sort()).toEqual(['matches', 'needsRehash']);
  } finally {
    await runtime.dispose();
  }
}, 180000);

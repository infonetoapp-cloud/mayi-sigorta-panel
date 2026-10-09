// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

/** Historical PBKDF2 checkpoint only; superseded by real runtime NO_GO and v2 DO tests. */
describe.skip('historical native local PBKDF2 checkpoint (not current runtime support)', () => {
  it('supports fixed 600000-iteration PBKDF2 and native full-byte comparison without returning secrets', async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import {productionPasswordHasher, generateTemporaryPassword} from './src/server/auth/password.ts';
          export default {async fetch() {
            const password = 'synthetic workerd test phrase 🧪';
            const first = await productionPasswordHasher.hash(password);
            const second = await productionPasswordHasher.hash(password);
            const valid = await productionPasswordHasher.verify(password, first);
            const wrong = await productionPasswordHasher.verify(password + 'wrong', first);
            const last = first.endsWith('0') ? '1' : '0';
            const changed = await productionPasswordHasher.verify(password, first.slice(0,-1) + last);
            const malformed = await productionPasswordHasher.verify(password, 'unsupported');
            const temporary = generateTemporaryPassword();
            return Response.json({
              valid: valid.matches, wrong: wrong.matches, changed: changed.matches,
              malformed: malformed.matches, uniqueSalt: first.split('$')[3] !== second.split('$')[3],
              serialized: /^mayi-pbkdf2-sha256\\$v=1\\$i=600000\\$[a-f0-9]{32}\\$[a-f0-9]{64}$/.test(first),
              temporaryShape: /^(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/.test(temporary)
            });
          }};
        `,
        resolveDir: process.cwd(),
        sourcefile: 'synthetic-password-probe.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      external: ['node:crypto'],
      write: false,
    });
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            type: 'worker',
            name: 'synthetic-password-primitive',
            compatibilityDate: '2026-09-01',
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: 'probe.js',
              modules: {
                'probe.js': { type: 'esm', contents: bundle.outputFiles![0]!.text },
              },
            },
          },
        },
      ],
    });
    try {
      const response = await runtime.dispatchFetch('https://synthetic.invalid/');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        valid: true,
        wrong: false,
        changed: false,
        malformed: false,
        uniqueSalt: true,
        serialized: true,
        temporaryShape: true,
      });
    } finally {
      await runtime.dispose();
    }
  }, 180_000);
});

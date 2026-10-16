// @vitest-environment node
import { expect, it } from 'vitest';
import { CsrfConfigSchema, parseCsrfConfig } from '../src/server/config';
import { parseCsrfConfigCandidate } from '../engineering-drafts/m4-csrf-local/config-candidate';

it('snapshots a valid secret and strips unrelated fields without caching', () => {
  const secret = crypto.randomUUID();
  expect(parseCsrfConfigCandidate({ CSRF_SECRET: secret, unrelated: true })).toEqual({
    CSRF_SECRET: secret,
  });
});

it('matches the normative schema on root types, UTF16 boundaries and malformed values', () => {
  const values: unknown[] = [undefined, null, false, 0, '', [], () => null, new String('x')];
  for (const secret of [
    undefined,
    null,
    true,
    32,
    {},
    [],
    ...[0, 1, 31, 32, 33, 1000].map((n) => 'x'.repeat(n)),
    ' '.repeat(32),
    '😀'.repeat(16),
    '😀'.repeat(31),
    '😀'.repeat(31) + 'x',
    '😀'.repeat(32),
    '\ud800'.repeat(32),
  ]) {
    values.push({ CSRF_SECRET: secret }, Object.assign([], { CSRF_SECRET: secret }));
  }
  values.push(Object.create({ CSRF_SECRET: 'x'.repeat(32) }));
  for (const [index, value] of values.entries()) {
    const oracle = CsrfConfigSchema.safeParse(value);
    let candidateSuccess = true;
    try {
      parseCsrfConfigCandidate(value);
    } catch {
      candidateSuccess = false;
    }
    expect(candidateSuccess, `matrix-index ${index}`).toBe(oracle.success);
    if (oracle.success) expect(parseCsrfConfigCandidate(value)).toEqual(oracle.data);
    else
      expect(() => parseCsrfConfigCandidate(value)).toThrow(
        '[Geçersiz CSRF Yapılandırması] CSRF secret eksik veya geçersiz.',
      );
  }
});

it('reads getters once and observes secret changes on every call', () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  let reads = 0;
  const env = {
    get CSRF_SECRET() {
      return ++reads === 1 ? first : second;
    },
  };
  expect(parseCsrfConfigCandidate(env).CSRF_SECRET === first).toBe(true);
  expect(reads).toBe(1);
  expect(parseCsrfConfigCandidate(env).CSRF_SECRET === second).toBe(true);
  const changing: Record<string, unknown> = { CSRF_SECRET: first };
  parseCsrfConfigCandidate(changing);
  changing.CSRF_SECRET = null;
  expect(() => parseCsrfConfigCandidate(changing)).toThrow();
  const trapped = {
    get CSRF_SECRET(): string {
      throw new Error('CONFIG_READ_TRAP');
    },
  };
  expect(() => parseCsrfConfig(trapped)).toThrow('CONFIG_READ_TRAP');
  expect(() => parseCsrfConfigCandidate(trapped)).toThrow('CONFIG_READ_TRAP');
});

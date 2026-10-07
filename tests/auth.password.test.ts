// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  generateTemporaryPassword,
  normalizeLoginEmail,
  normalizePassword,
  PASSWORD_KDF_ITERATIONS,
  PASSWORD_KDF_VERSION,
  PASSWORD_SALT_BYTES,
  PASSWORD_VERIFIER_BYTES,
  productionPasswordHasher,
  validatePermanentPassword,
} from '../src/server/auth/password';

const syntheticPassword = 'synthetic fixture passphrase 🧪';

describe('local password policy primitives (not an active authentication composition)', () => {
  it('pins production KDF and output constants without an environment knob', () => {
    expect(PASSWORD_KDF_VERSION).toBe(1);
    expect(PASSWORD_KDF_ITERATIONS).toBe(600_000);
    expect(PASSWORD_SALT_BYTES).toBe(16);
    expect(PASSWORD_VERIFIER_BYTES).toBe(32);
    expect(Object.isFrozen(productionPasswordHasher)).toBe(true);
  });
  it('normalizes login email by trim and case only', () => {
    expect(normalizeLoginEmail('  Synthetic.Owner@EXAMPLE.INVALID  ')).toBe(
      'synthetic.owner@example.invalid',
    );
    expect(() => normalizeLoginEmail('not an email')).toThrow();
    expect(() => normalizeLoginEmail('a'.repeat(321))).toThrow();
  });
  it.each([14, 129])('rejects %i Unicode codepoints', (count) => {
    expect(() => normalizePassword('🧪'.repeat(count))).toThrow();
  });
  it.each([15, 64, 128])(
    'accepts %i Unicode codepoints including supplementary characters',
    (count) => {
      expect(normalizePassword('🧪'.repeat(count))).toBe('🧪'.repeat(count));
    },
  );
  it('NFC-normalizes without trimming spaces or imposing composition', () => {
    expect(normalizePassword('e\u0301'.repeat(15))).toBe('é'.repeat(15));
    expect(normalizePassword('   a long phrase   ')).toBe('   a long phrase   ');
    expect(validatePermanentPassword('a calm river in winter', 'test@example.invalid')).toBe(
      'a calm river in winter',
    );
  });
  it('rejects raw input bounds and ill-formed Unicode before KDF', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      await expect(productionPasswordHasher.hash('x'.repeat(257))).rejects.toThrow();
      await expect(productionPasswordHasher.hash('a'.repeat(15) + '\ud800')).rejects.toThrow();
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  });
  it.each([
    'passwordpassword',
    'password123456789',
    '1234567890123456',
    'MayiSigorta123456',
    'MayiSigortaCRM2026',
    'Mayı Sigorta CRM 2026!',
    'syntheticowner12345',
    'synthetic.owner@example.invalid',
  ])('rejects a synthetic common/contextual blocklist value without disclosure', (value) => {
    expect(() => validatePermanentPassword(value, 'synthetic.owner@example.invalid')).toThrow();
  });
  it('generates grouped unambiguous uniformly sampled temporary passwords without logging them', () => {
    const values = new Set(Array.from({ length: 100 }, () => generateTemporaryPassword()));
    expect(values.size).toBe(100);
    expect(
      Array.from(values).every((value) =>
        /^(?:[A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/.test(value),
      ),
    ).toBe(true);
    expect(Math.log2(32) * 20).toBe(100);
  });
  it('does not overblock a legitimate passphrase merely containing product words', () => {
    expect(
      validatePermanentPassword(
        'mayi sigorta crm yanında sakin nehir',
        'synthetic.owner@example.invalid',
      ),
    ).toBe('mayi sigorta crm yanında sakin nehir');
  });
});

describe('real production PBKDF2 hasher', () => {
  it('serializes version/work factor/salt/full verifier and creates unique salts', async () => {
    const first = await productionPasswordHasher.hash(syntheticPassword);
    const second = await productionPasswordHasher.hash(syntheticPassword);
    expect(/^mayi-pbkdf2-sha256\$v=1\$i=600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(first)).toBe(
      true,
    );
    expect(first === second).toBe(false);
    expect(first.split('$')[3] === second.split('$')[3]).toBe(false);
    expect(await productionPasswordHasher.verify(syntheticPassword, first)).toEqual({
      matches: true,
      needsRehash: false,
    });
    expect(await productionPasswordHasher.verify(syntheticPassword + 'wrong', first)).toEqual({
      matches: false,
      needsRehash: false,
    });
  });
  it('hashes and verifies NFC-equivalent complete input, preserving spaces and suffixes', async () => {
    const serialized = await productionPasswordHasher.hash('e\u0301'.repeat(15) + '  ');
    expect((await productionPasswordHasher.verify('é'.repeat(15) + '  ', serialized)).matches).toBe(
      true,
    );
    expect((await productionPasswordHasher.verify('é'.repeat(15), serialized)).matches).toBe(false);
  });
  it('compares the entire 32-byte derived value including its final byte', async () => {
    const serialized = await productionPasswordHasher.hash(syntheticPassword);
    const last = serialized.at(-1) === '0' ? '1' : '0';
    expect(
      (await productionPasswordHasher.verify(syntheticPassword, serialized.slice(0, -1) + last))
        .matches,
    ).toBe(false);
  });
  it.each([
    '',
    'a'.repeat(64),
    'sha256$' + 'a'.repeat(64),
    'mayi-pbkdf2-sha256$v=2$i=600000$' + 'a'.repeat(32) + '$' + 'b'.repeat(64),
    'mayi-pbkdf2-sha256$v=1$i=100000$' + 'a'.repeat(32) + '$' + 'b'.repeat(64),
    'mayi-pbkdf2-sha256$v=1$i=999999999$' + 'a'.repeat(32) + '$' + 'b'.repeat(64),
    'mayi-pbkdf2-sha256$v=1$i=600000$' + 'A'.repeat(32) + '$' + 'b'.repeat(64),
    'mayi-pbkdf2-sha256$v=1$i=600000$' + 'a'.repeat(31) + '$' + 'b'.repeat(64),
  ])('fails closed malformed/unsupported metadata before KDF', async (serialized) => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      expect(await productionPasswordHasher.verify(syntheticPassword, serialized)).toEqual({
        matches: false,
        needsRehash: false,
      });
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
  });
});

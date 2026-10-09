// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DUMMY_PASSWORD_VERIFIER,
  PASSWORD_SCRYPT_N,
  PASSWORD_SCRYPT_R,
  PASSWORD_SCRYPT_P,
  PASSWORD_SCRYPT_MAXMEM,
  parsePasswordEnvelope,
  serializePasswordEnvelope,
  isSupportedPasswordVerifier,
} from '../src/server/auth/password-envelope';
import { createScryptPasswordHasher } from '../src/server/auth/password-scrypt';
import { PasswordKdfService } from '../src/server/auth/password-kdf-service';
import {
  createDurableObjectPasswordHasher,
  PASSWORD_KDF_INSTANCE,
} from '../src/server/auth/password-do-adapter';
import { PasswordKdfUnavailableError } from '../src/server/auth/password-kdf-error';
import { normalizePassword } from '../src/server/auth/password';
const password = () => crypto.randomUUID();
describe('canonical selected scrypt envelope', () => {
  it('pins parameters and exact roundtrip without crypto', () => {
    expect([
      PASSWORD_SCRYPT_N,
      PASSWORD_SCRYPT_R,
      PASSWORD_SCRYPT_P,
      PASSWORD_SCRYPT_MAXMEM,
    ]).toEqual([32768, 8, 3, 64 * 1024 * 1024]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = crypto.getRandomValues(new Uint8Array(32));
    const value = serializePasswordEnvelope(salt, key);
    const parsed = parsePasswordEnvelope(value)!;
    expect(parsed.salt.length).toBe(16);
    expect(parsed.verifier.length).toBe(32);
    expect(serializePasswordEnvelope(parsed.salt, parsed.verifier) === value).toBe(true);
    expect(parsed.needsRehash).toBe(false);
  });
  it('rejects noncanonical algorithms, versions, work factors, sizes, casing and suffixes', () => {
    const valid = DUMMY_PASSWORD_VERIFIER;
    const invalid = [
      valid.replace('scrypt', 'pbkdf2-sha256'),
      valid.replace('v=2', 'v=1'),
      valid.replace('32768', '65536'),
      valid.replace('r=8', 'r=9'),
      valid.replace('p=3', 'p=2'),
      valid.toUpperCase(),
      valid + '\n',
      valid + '$extra',
      valid.slice(0, -1),
      valid + '0',
      ' '.repeat(10000),
      null,
      {},
      valid.replace('$' + '0'.repeat(32) + '$', '$' + 'A'.repeat(32) + '$'),
    ];
    expect(invalid.every((v) => !isSupportedPasswordVerifier(v))).toBe(true);
    expect(isSupportedPasswordVerifier(valid)).toBe(true);
  });
});
describe('private service and adapter control flow', () => {
  it('serializes concurrent work FIFO and releases after rejection', async () => {
    let active = 0,
      maxActive = 0,
      calls = 0;
    const starts: number[] = [];
    const service = new PasswordKdfService(async () => {
      const id = ++calls;
      starts.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (id === 2) throw Error('SAFE_TEST_FAILURE');
        return new Uint8Array(32);
      } finally {
        active--;
      }
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.hash(password())),
    );
    expect(maxActive).toBe(1);
    expect(starts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(outcomes.filter((r) => r.status === 'rejected').length).toBe(1);
    expect(isSupportedPasswordVerifier(await service.hash(password()))).toBe(true);
  });
  it('bounds outstanding work and recovers from saturation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new PasswordKdfService(async () => {
      await gate;
      return new Uint8Array(32);
    });
    const work = Array.from({ length: 32 }, () => service.hash(password()));
    await expect(service.hash(password())).rejects.toBeInstanceOf(PasswordKdfUnavailableError);
    release();
    await Promise.all(work);
    expect(isSupportedPasswordVerifier(await service.hash(password()))).toBe(true);
  });
  it('supports is local; malformed verify never calls the RPC', async () => {
    let calls = 0;
    let name = '';
    const adapter = createDurableObjectPasswordHasher({
      getByName(value: string) {
        calls++;
        name = value;
        return {
          async hash() {
            return DUMMY_PASSWORD_VERIFIER;
          },
          async verify() {
            return { matches: false, needsRehash: false };
          },
        };
      },
    });
    expect(adapter.supports!(DUMMY_PASSWORD_VERIFIER)).toBe(true);
    expect(calls).toBe(0);
    await adapter.verify(password(), 'invalid');
    expect(calls).toBe(0);
    await adapter.verify(password(), DUMMY_PASSWORD_VERIFIER);
    expect(calls).toBe(1);
    expect(name).toBe(PASSWORD_KDF_INSTANCE);
  });
  it('fails closed on absent bindings and unsafe RPC shapes without fallback', async () => {
    for (const binding of [undefined, null, {}, { getByName: 1 }])
      expect(() => createDurableObjectPasswordHasher(binding)).toThrow(PasswordKdfUnavailableError);
    const bad = createDurableObjectPasswordHasher({
      getByName() {
        return {
          async hash() {
            return 'invalid';
          },
          async verify() {
            return { matches: true, needsRehash: false, extra: 1 };
          },
        };
      },
    });
    await expect(bad.hash(password())).rejects.toBeInstanceOf(PasswordKdfUnavailableError);
    await expect(bad.verify(password(), DUMMY_PASSWORD_VERIFIER)).rejects.toBeInstanceOf(
      PasswordKdfUnavailableError,
    );
  });
  it('uses full native comparison, validates input before deriving, and no KDF options from caller', async () => {
    let calls = 0;
    const hasher = createScryptPasswordHasher(async () => {
      calls++;
      return new Uint8Array(32);
    });
    const value = await hasher.hash(password());
    const suffix = value.at(-1) === '0' ? '1' : '0';
    expect((await hasher.verify(password(), value.slice(0, -1) + suffix)).matches).toBe(false);
    const before = calls;
    await hasher.verify(password(), 'invalid');
    await expect(hasher.hash('x'.repeat(257))).rejects.toThrow();
    expect(calls).toBe(before);
    expect(() => normalizePassword('x'.repeat(15) + '\uD800')).toThrow();
  });
});

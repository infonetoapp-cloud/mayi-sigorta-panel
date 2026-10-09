// @vitest-environment node
import { expect, it } from 'vitest';
import { PASSWORD_KDF_VERSION } from '../src/server/auth/password';
it('pins the newly selected live scrypt version', () => {
  expect(PASSWORD_KDF_VERSION === 2).toBe(true);
});

it('provides an explicit administrative scrypt hasher instead of a Worker fallback', async () => {
  const path = '../src/server/auth/password-admin';
  const module = await import(path).catch(() => null);
  expect(typeof module?.localAdminPasswordHasher?.hash === 'function').toBe(true);
});

it('requires explicit serialized service and private Worker adapter modules', async () => {
  const servicePath = '../src/server/auth/password-kdf-service';
  const adapterPath = '../src/server/auth/password-do-adapter';
  const service = await import(servicePath).catch(() => null);
  const adapter = await import(adapterPath).catch(() => null);
  expect(typeof service?.PasswordKdfService === 'function').toBe(true);
  expect(typeof adapter?.createDurableObjectPasswordHasher === 'function').toBe(true);
});

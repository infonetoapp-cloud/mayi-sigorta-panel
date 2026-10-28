import { createScryptPasswordHasher } from '../../src/server/auth/password-scrypt';
/** Explicit cheap derivation seam for policy/control-flow tests; NOT interoperability evidence. */
export const fixturePasswordHasher = createScryptPasswordHasher(async (password, salt) => {
  const bytes = new TextEncoder().encode(password);
  const input = new Uint8Array(salt.length + bytes.length);
  input.set(salt);
  input.set(bytes, salt.length);
  try {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  } finally {
    input.fill(0);
    bytes.fill(0);
  }
});

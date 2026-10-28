import type { PasswordHasher, PasswordVerification } from './password';
import { normalizePassword } from './password';
import { isSupportedPasswordVerifier } from './password-envelope';
import { PasswordKdfUnavailableError } from './password-kdf-error';
export const PASSWORD_KDF_INSTANCE = 'mayi-password-kdf-v2';
interface PasswordKdfRpc {
  hash(password: string): Promise<string>;
  verify(password: string, verifier: string): Promise<PasswordVerification>;
}
export function createDurableObjectPasswordHasher(binding: unknown): PasswordHasher {
  if (!binding || typeof (binding as { getByName?: unknown }).getByName !== 'function')
    throw new PasswordKdfUnavailableError();
  const namespace = binding as { getByName(name: string): PasswordKdfRpc };
  function stub(): PasswordKdfRpc {
    const value = namespace.getByName(PASSWORD_KDF_INSTANCE);
    if (!value || typeof value.hash !== 'function' || typeof value.verify !== 'function')
      throw new PasswordKdfUnavailableError();
    return value;
  }
  return Object.freeze({
    supports: isSupportedPasswordVerifier,
    async hash(password: string) {
      const normalized = normalizePassword(password);
      try {
        const result = await stub().hash(normalized);
        if (!isSupportedPasswordVerifier(result)) throw new PasswordKdfUnavailableError();
        return result;
      } catch {
        throw new PasswordKdfUnavailableError();
      }
    },
    async verify(password: string, verifier: string) {
      if (!isSupportedPasswordVerifier(verifier)) return { matches: false, needsRehash: false };
      let normalized: string;
      try {
        normalized = normalizePassword(password);
      } catch {
        return { matches: false, needsRehash: false };
      }
      try {
        const result: unknown = await stub().verify(normalized, verifier);
        if (
          !result ||
          typeof result !== 'object' ||
          Object.keys(result).sort().join(',') !== 'matches,needsRehash'
        )
          throw new PasswordKdfUnavailableError();
        const value = result as PasswordVerification;
        if (
          typeof value.matches !== 'boolean' ||
          typeof value.needsRehash !== 'boolean' ||
          (!value.matches && value.needsRehash)
        )
          throw new PasswordKdfUnavailableError();
        return { matches: value.matches, needsRehash: value.needsRehash };
      } catch {
        throw new PasswordKdfUnavailableError();
      }
    },
  });
}

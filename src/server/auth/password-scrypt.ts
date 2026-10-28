import { scrypt, timingSafeEqual } from 'node:crypto';
import { normalizePassword, type PasswordHasher } from './password';
import {
  PASSWORD_SCRYPT_N,
  PASSWORD_SCRYPT_R,
  PASSWORD_SCRYPT_P,
  PASSWORD_SCRYPT_MAXMEM,
  PASSWORD_SALT_BYTES,
  PASSWORD_VERIFIER_BYTES,
  isSupportedPasswordVerifier,
  parsePasswordEnvelope,
  serializePasswordEnvelope,
} from './password-envelope';
import { PasswordKdfUnavailableError } from './password-kdf-error';
/** Trusted server/test seam only; parameters are never supplied by RPC or environment. */
export type ScryptDerivation = (password: string, salt: Uint8Array) => Promise<Uint8Array>;
const options = Object.freeze({
  N: PASSWORD_SCRYPT_N,
  r: PASSWORD_SCRYPT_R,
  p: PASSWORD_SCRYPT_P,
  maxmem: PASSWORD_SCRYPT_MAXMEM,
});
export const deriveScrypt: ScryptDerivation = (password, salt) =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_VERIFIER_BYTES, options, (error, key) => {
      if (error) reject(new PasswordKdfUnavailableError());
      else resolve(key);
    });
  });
export function createScryptPasswordHasher(
  derive: ScryptDerivation = deriveScrypt,
): PasswordHasher {
  return Object.freeze({
    supports: isSupportedPasswordVerifier,
    async hash(password: string): Promise<string> {
      const normalized = normalizePassword(password);
      const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
      let key: Uint8Array | undefined;
      try {
        key = await derive(normalized, salt);
        return serializePasswordEnvelope(salt, key);
      } finally {
        key?.fill(0);
        salt.fill(0);
      }
    },
    async verify(password: string, serialized: string) {
      const envelope = parsePasswordEnvelope(serialized);
      if (!envelope) return { matches: false, needsRehash: false };
      let normalized: string;
      try {
        normalized = normalizePassword(password);
      } catch {
        return { matches: false, needsRehash: false };
      }
      let key: Uint8Array | undefined;
      try {
        key = await derive(normalized, envelope.salt);
        if (key.length !== PASSWORD_VERIFIER_BYTES) throw new PasswordKdfUnavailableError();
        const matches = timingSafeEqual(key, envelope.verifier);
        return { matches, needsRehash: matches && envelope.needsRehash };
      } finally {
        key?.fill(0);
        envelope.salt.fill(0);
        envelope.verifier.fill(0);
      }
    },
  });
}

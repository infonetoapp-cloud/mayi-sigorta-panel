/** One fixed supported live envelope; future upgrades must add explicit supported profiles. */
export const PASSWORD_KDF_VERSION = 2;
export const PASSWORD_SCRYPT_N = 32768;
export const PASSWORD_SCRYPT_R = 8;
export const PASSWORD_SCRYPT_P = 3;
export const PASSWORD_SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_VERIFIER_BYTES = 32;
export const PASSWORD_ENVELOPE_PREFIX = 'mayi-scrypt$v=2$n=32768$r=8$p=3$';
export const PASSWORD_ENVELOPE_LENGTH = PASSWORD_ENVELOPE_PREFIX.length + 32 + 1 + 64;
export interface ScryptEnvelope {
  readonly salt: Uint8Array;
  readonly verifier: Uint8Array;
  readonly needsRehash: boolean;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function unhex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}
export function parsePasswordEnvelope(value: unknown): ScryptEnvelope | null {
  if (typeof value !== 'string' || value.length !== PASSWORD_ENVELOPE_LENGTH) return null;
  const match = /^mayi-scrypt\$v=2\$n=32768\$r=8\$p=3\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(value);
  if (!match) return null;
  return { salt: unhex(match[1]!), verifier: unhex(match[2]!), needsRehash: false };
}
export function isSupportedPasswordVerifier(value: unknown): boolean {
  return parsePasswordEnvelope(value) !== null;
}
export function serializePasswordEnvelope(salt: Uint8Array, verifier: Uint8Array): string {
  if (salt.length !== PASSWORD_SALT_BYTES || verifier.length !== PASSWORD_VERIFIER_BYTES)
    throw new Error('INVALID_KDF_OUTPUT');
  return `${PASSWORD_ENVELOPE_PREFIX}${hex(salt)}$${hex(verifier)}`;
}
/** Noncredential deterministic representation; unknown login still performs the real KDF. */
export const DUMMY_PASSWORD_VERIFIER = serializePasswordEnvelope(
  new Uint8Array(PASSWORD_SALT_BYTES),
  new Uint8Array(PASSWORD_VERIFIER_BYTES),
);

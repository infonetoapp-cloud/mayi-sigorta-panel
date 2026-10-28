import { normalizeBoundedPassword } from '../../shared/password-input';
export { PASSWORD_MIN_CODEPOINTS, PASSWORD_MAX_CODEPOINTS } from '../../shared/password-input';
export {
  PASSWORD_KDF_VERSION,
  PASSWORD_SALT_BYTES,
  PASSWORD_VERIFIER_BYTES,
  isSupportedPasswordVerifier,
} from './password-envelope';

export interface PasswordVerification {
  readonly matches: boolean;
  readonly needsRehash: boolean;
}

/** Injectable only through explicit server/test composition, never an Env selector. */
export interface PasswordHasher {
  readonly supports?: (serialized: string) => boolean;
  hash(password: string): Promise<string>;
  verify(password: string, serialized: string): Promise<PasswordVerification>;
}

export class PasswordInputError extends Error {
  constructor() {
    super('Parola 15–128 Unicode karakteri olmalıdır.');
    this.name = 'PasswordInputError';
  }
}

/**
 * Bound before normalization/encoding/KDF, then count Unicode scalar values after NFC.
 * Do not trim, case-fold or truncate passwords. Reject ill-formed UTF-16 instead of
 * silently replacing an unpaired surrogate with U+FFFD during UTF-8 encoding.
 */
export function normalizePassword(password: unknown): string {
  const normalized = normalizeBoundedPassword(password);
  if (normalized === null) throw new PasswordInputError();
  return normalized;
}

export function normalizeLoginEmail(email: unknown): string {
  if (typeof email !== 'string' || email.length > 320) {
    throw new Error('INVALID_LOGIN_EMAIL');
  }
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ||
    /[\uD800-\uDFFF]/u.test(normalized)
  ) {
    throw new Error('INVALID_LOGIN_EMAIL');
  }
  return normalized;
}

const COMMON_PASSWORDS = new Set([
  'passwordpassword',
  'password123456789',
  '123456789012345',
  '1234567890123456',
  'qwertyuiopasdfgh',
  'letmeinletmeinletmein',
  'iloveyouiloveyou',
  'adminadminadminadmin',
]);

/** Whole-value local blocklist; no breach API, composition or periodic-change rule. */
export function validatePermanentPassword(password: unknown, loginEmail: string): string {
  const normalized = normalizePassword(password);
  const folded = normalized.toLowerCase();
  const compact = folded.replace(/[\s._@!-]/gu, '');
  const email = normalizeLoginEmail(loginEmail);
  const local = email.slice(0, email.indexOf('@'));
  const contextual = [
    'mayisigorta',
    'mayısigorta',
    'mayisigortacrm',
    'mayısigortacrm',
    'mayicrm',
    'mayıcrm',
    email,
    local,
  ];
  const trivialSuffix = /^(?:\d{0,12}|password|sifre|şifre)$/u;
  if (
    COMMON_PASSWORDS.has(folded) ||
    /^(?:password|şifre|sifre|123456)+[\d!._-]*$/u.test(folded) ||
    /^(?:1234567890)+\d*$/u.test(folded) ||
    /^(.)\1+$/u.test(folded) ||
    contextual.some((word) => {
      const base = word.replace(/[\s._@!-]/gu, '');
      return compact.startsWith(base) && trivialSuffix.test(compact.slice(base.length));
    })
  ) {
    throw new Error('Bu parola kolay tahmin edilebilir. Daha uzun, farklı bir parola seçin.');
  }
  return normalized;
}

/** 32 uniformly selected symbols × 20 characters = 100 bits; separators add no entropy. */
const TEMPORARY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generateTemporaryPassword(): string {
  // Rejection sampling also keeps the entropy statement valid if the alphabet changes.
  const cutoff = Math.floor(256 / TEMPORARY_ALPHABET.length) * TEMPORARY_ALPHABET.length;
  const symbols: string[] = [];
  while (symbols.length < 20) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) {
      if (byte >= cutoff) continue;
      symbols.push(TEMPORARY_ALPHABET[byte % TEMPORARY_ALPHABET.length]!);
      if (symbols.length === 20) break;
    }
  }
  return [0, 5, 10, 15].map((offset) => symbols.slice(offset, offset + 5).join('')).join('-');
}

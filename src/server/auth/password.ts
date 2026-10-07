import { timingSafeEqual } from 'node:crypto';
import { normalizeBoundedPassword } from '../../shared/password-input';
export { PASSWORD_MIN_CODEPOINTS, PASSWORD_MAX_CODEPOINTS } from '../../shared/password-input';

/** Server-only credential primitive. No runtime-configurable work factor. */
export const PASSWORD_KDF_VERSION = 1;
export const PASSWORD_KDF_ITERATIONS = 600_000;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_VERIFIER_BYTES = 32;

const encoder = new TextEncoder();

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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}

interface CredentialEnvelope {
  readonly iterations: number;
  readonly salt: Uint8Array<ArrayBuffer>;
  readonly verifier: Uint8Array<ArrayBuffer>;
}

/** Exact, canonical and bounded parser. No legacy raw-SHA or arbitrary KDF fallback. */
function parseEnvelope(serialized: unknown): CredentialEnvelope | null {
  if (typeof serialized !== 'string' || serialized.length > 160) return null;
  const match = /^mayi-pbkdf2-sha256\$v=1\$i=600000\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(
    serialized,
  );
  if (!match) return null;
  return {
    iterations: PASSWORD_KDF_ITERATIONS,
    salt: unhex(match[1]!),
    verifier: unhex(match[2]!),
  };
}

export function isSupportedPasswordVerifier(serialized: unknown): boolean {
  return parseEnvelope(serialized) !== null;
}

async function derive(
  normalized: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(normalized), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const result = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    PASSWORD_VERIFIER_BYTES * 8,
  );
  return new Uint8Array(result);
}

export const productionPasswordHasher: PasswordHasher = Object.freeze({
  supports: isSupportedPasswordVerifier,
  async hash(password: string): Promise<string> {
    const normalized = normalizePassword(password);
    const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
    const verifier = await derive(normalized, salt, PASSWORD_KDF_ITERATIONS);
    return `mayi-pbkdf2-sha256$v=${PASSWORD_KDF_VERSION}$i=${PASSWORD_KDF_ITERATIONS}$${hex(salt)}$${hex(verifier)}`;
  },
  async verify(password: string, serialized: string): Promise<PasswordVerification> {
    const envelope = parseEnvelope(serialized);
    if (!envelope) return { matches: false, needsRehash: false };
    let normalized: string;
    try {
      normalized = normalizePassword(password);
    } catch {
      return { matches: false, needsRehash: false };
    }
    const candidate = await derive(normalized, envelope.salt, envelope.iterations);
    // Native constant-time comparison of all 32 bytes, never string/prefix comparison.
    const matches = timingSafeEqual(candidate, envelope.verifier);
    return {
      matches,
      // A future fixed work-factor increase must explicitly add the old supported envelope.
      needsRehash: matches && envelope.iterations < PASSWORD_KDF_ITERATIONS,
    };
  },
});

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

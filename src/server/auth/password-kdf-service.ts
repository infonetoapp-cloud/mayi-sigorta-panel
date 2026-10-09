import type { PasswordHasher } from './password';
import { normalizePassword } from './password';
import { isSupportedPasswordVerifier } from './password-envelope';
import { createScryptPasswordHasher, type ScryptDerivation } from './password-scrypt';
import { PasswordKdfUnavailableError } from './password-kdf-error';
/** One service per canonical DO. FIFO exclusivity covers asynchronous native allocations. */
export class PasswordKdfService implements PasswordHasher {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly core: PasswordHasher;
  constructor(derive?: ScryptDerivation) {
    this.core = createScryptPasswordHasher(derive);
  }
  supports = isSupportedPasswordVerifier;
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 32) throw new PasswordKdfUnavailableError();
    this.pending++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await operation();
    } catch {
      throw new PasswordKdfUnavailableError();
    } finally {
      this.pending--;
      release();
    }
  }
  hash(password: string): Promise<string> {
    const normalized = normalizePassword(password);
    return this.exclusive(() => this.core.hash(normalized));
  }
  verify(password: string, verifier: string) {
    if (!isSupportedPasswordVerifier(verifier))
      return Promise.resolve({ matches: false, needsRehash: false });
    let normalized: string;
    try {
      normalized = normalizePassword(password);
    } catch {
      return Promise.resolve({ matches: false, needsRehash: false });
    }
    return this.exclusive(() => this.core.verify(normalized, verifier));
  }
}

export class PasswordKdfUnavailableError extends Error {
  constructor() {
    super('PASSWORD_KDF_UNAVAILABLE');
    this.name = 'PasswordKdfUnavailableError';
  }
}

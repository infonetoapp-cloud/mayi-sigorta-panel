export type SessionVerificationErrorCode =
  | 'SESSION_MISSING'
  | 'SESSION_INVALID'
  | 'SESSION_EXPIRED'
  | 'REAUTH_REQUIRED'
  | 'CONFIGURATION_ERROR';
export class SessionVerificationError extends Error {
  readonly isPublicSafe = true;
  constructor(readonly code: SessionVerificationErrorCode) {
    super('Oturum veya kimlik doğrulaması kullanılamıyor.');
    this.name = 'SessionVerificationError';
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

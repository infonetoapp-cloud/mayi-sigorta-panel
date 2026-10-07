/** Server-authenticated local session identity, never authorization claims. */
export type AuthenticationAssurance = 'NORMAL' | 'SECURE';
export interface AuthenticatedPrincipal {
  readonly issuer: string;
  readonly subject: string;
  readonly assurance: AuthenticationAssurance;
  readonly expiresAt: number;
  readonly issuedAt?: number;
  readonly notBefore?: number;
  /** Informational OWNER-provisioned email, not cryptographically verified mailbox ownership. */
  readonly email?: string;
  /** Safe server-only session hash binding, never the opaque browser cookie secret. */
  readonly sessionHash?: string;
}

import type { CsrfConfig } from '../../src/server/config';

/** Local-only candidate. Not imported by production; no authority or key caching. */
export function parseCsrfConfigCandidate(env: unknown = {}): CsrfConfig {
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    const secret = (env as Record<string, unknown>).CSRF_SECRET;
    // Zod 4.6.5 .min() counts code points, not merely UTF16 code units.
    // Only the bounded 32..63-unit range needs exact counting.
    if (
      typeof secret === 'string' &&
      secret.length >= 32 &&
      (secret.length >= 64 || Array.from(secret).length >= 32)
    )
      return { CSRF_SECRET: secret };
  }
  throw new Error('[Geçersiz CSRF Yapılandırması] CSRF secret eksik veya geçersiz.');
}

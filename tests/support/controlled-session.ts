import { randomSessionToken } from '../../src/server/auth/session';

// Explicit domain authorization composition. Cookie secrets are random/opaque even in fixtures.
// No Access extraction, JWT verifier, Env selector, registration or runtime import of this module.
const secrets = new Map<string, string>();
export function controlledSessionCookie(label: string): string {
  const secret = randomSessionToken();
  secrets.set(secret, label);
  return `__Host-mayi-session=${secret}`;
}
export function controlledSessionLabel(request: Request | Headers): string | null {
  const headers = request instanceof Headers ? request : request.headers;
  const parts = (headers.get('cookie') ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.startsWith('__Host-mayi-session='));
  if (parts.length !== 1) return null;
  return secrets.get(parts[0]!.slice('__Host-mayi-session='.length)) ?? null;
}

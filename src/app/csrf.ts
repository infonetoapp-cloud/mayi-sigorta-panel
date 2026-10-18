import type { ApiResponse } from '../shared/types';

// Session-bound, memory-only cache. Keep the public App re-exports for legacy
// screens while allowing the authentication shell to load without those screens.
let inMemoryCsrfToken: string | null = null;
export async function getCsrfToken(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (inMemoryCsrfToken) return inMemoryCsrfToken;
  const res = signal ? await fetch('/api/csrf-token', { signal }) : await fetch('/api/csrf-token');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (res.status === 401) {
    invalidateCsrfToken();
    document.dispatchEvent(new Event('mayi-session-ended'));
  }
  if (!res.ok) throw new Error(`CSRF belirteci alınamadı (${res.status})`);
  const json = (await res.json()) as ApiResponse<{ token: string }>;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!json.success || !json.data?.token)
    throw new Error(json.success === false ? json.error.message : 'CSRF belirteci alınamadı');
  inMemoryCsrfToken = json.data.token;
  return inMemoryCsrfToken;
}
export function invalidateCsrfToken(): void {
  inMemoryCsrfToken = null;
}

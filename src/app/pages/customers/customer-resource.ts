import { useEffect, useState } from 'react';
import type { ApiResponse } from '../../../shared/types';
import { invalidateCsrfToken } from '../../csrf';

export class CustomerReadError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? 'Oturum sona erdi. Yeniden giriş yapın.'
        : status === 403
          ? 'Bu kayıtları görüntüleme yetkiniz yok.'
          : status === 404
            ? 'Kayıt kullanılamıyor veya bu kaydı görme yetkiniz yok.'
            : 'Bilgiler yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin.',
    );
  }
}
export async function readCustomerResource<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (response.status === 401) {
    invalidateCsrfToken();
    document.dispatchEvent(new Event('mayi-session-ended'));
  }
  if (!response.ok) throw new CustomerReadError(response.status);
  const result = (await response.json()) as ApiResponse<T>;
  if (!result.success) throw new CustomerReadError(500);
  return result.data;
}
/** URL-tagged state hides old data synchronously on navigation, before effects.
 * Abort + live guards also cover fetch implementations that don't honor abort. */
export function useCustomerResource<T>(url: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    revision: number;
    data?: T;
    error?: CustomerReadError;
  }>();
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    void readCustomerResource<T>(url, controller.signal)
      .then((data) => {
        if (live) setResult({ url, revision, data });
      })
      .catch((error) => {
        if (live)
          setResult({
            url,
            revision,
            error: error instanceof CustomerReadError ? error : new CustomerReadError(500),
          });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [url, revision]);
  const current = result?.url === url && result.revision === revision ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !current,
    reload: () => setRevision((value) => value + 1),
  };
}
